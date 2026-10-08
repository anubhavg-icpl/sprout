// Sprout app controller: chat, agent-activity timeline, avatar choreography.
//
// Data flow: composer -> POST /api/chat -> SSE events (vocabulary owned by
// src/agents.ts: run_started, text_delta, step_started, step_finished,
// tool_call, sources, plan, emote, error, run_finished, done) -> handlers below
// update (a) the transcript, (b) the activity timeline, (c) the 3D robot avatar (robot.js).
// Invariants:
//   - The avatar state is derived ONLY from lifecycle events via `mood()`
//     (min dwell avoids flicker); the rig itself never picks a state.
//   - Model text is rendered exclusively through renderMarkdown (no innerHTML).
//   - Persistence: localStorage key STORE_KEY holds {v, messages}; every access
//     is try/catch so private mode / blocked storage degrades to in-memory.
//   - Only the lead's text (stepId === null) becomes the reply; specialist text
//     streams into its step card.
//
// === SECTIONS === dom · prefs · store · avatar · sound/voice · render ·
//                  activity · run · composer · settings · boot

import { createRobot } from "./robot.js";
import { renderMarkdown } from "./markdown.js";

// === DOM ===
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const icon = (name) => el("i", `ic ic-${name}`);
const log = $("log"), input = $("composer-input"), sendBtn = $("btn-send"), stopBtn = $("btn-stop");

// === PREFS ===
const PREF_KEY = "sprout.prefs.v1", STORE_KEY = "sprout.chat.v1";
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: keep in memory */ } };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const prefs = Object.assign({ intensity: 70, bones: false, blink: true, meditate: true, sounds: true, tts: false, voice: "", theme: null }, load(PREF_KEY, {}));
const savePrefs = () => save(PREF_KEY, prefs);

// === STORE ===
/** @type {{role:'user'|'assistant', content:string, sources?:{title:string,url:string}[], steps?:number, stopped?:boolean}[]} */
let messages = load(STORE_KEY, { v: 1, messages: [] }).messages ?? [];
const persist = () => save(STORE_KEY, { v: 1, messages: messages.slice(-80) });

// === AVATAR ===
// Until the 3D model loads (or if WebGL is unavailable) a no-op stand-in keeps
// every caller working; `rig.state` still tracks the requested state.
let rig = { state: "idle", setState(s) { this.state = s; }, setMouth() {}, setIntensity() {}, setBones() {}, setBlink() {} };
const applyMotion = () => rig.setIntensity(reduceMotion.matches ? 0 : prefs.intensity / 100);
createRobot($("avatar")).then((robot) => {
  robot.setState(rig.state); rig = robot;
  applyMotion(); rig.setBones(prefs.bones);
  $("avatar").dataset.ready = "true";
}).catch((e) => {
  console.warn("3D avatar unavailable:", e);
  $("state-detail").textContent = "3D avatar unavailable in this browser";
});
reduceMotion.addEventListener("change", applyMotion);

const MOOD_TEXT = {
  idle: ["Idle", "Waiting for you"], listening: ["Listening", "I'm all ears"], thinking: ["Thinking", "Working it out"],
  talking: ["Talking", "Answering you"], happy: ["Happy", "Reply finished"], celebrating: ["Celebrating", "Team finished the task"],
  meditating: ["Resting", "Type to wake Sprout"],
};
let moodSince = 0, moodTimer = 0, idleTimer = 0, busy = false;
/** Set avatar state; `hold` returns to idle after ms. Min dwell 350ms prevents strobing on fast streams. */
function mood(state, detail, hold = 0) {
  clearTimeout(moodTimer);
  const go = () => {
    rig.setState(state); moodSince = performance.now();
    $("state-name").textContent = MOOD_TEXT[state][0];
    $("state-detail").textContent = detail ?? MOOD_TEXT[state][1];
    if (hold) moodTimer = setTimeout(() => !busy && mood("idle"), hold);
    armIdle();
  };
  const wait = 350 - (performance.now() - moodSince);
  wait > 0 && rig.state !== state ? (moodTimer = setTimeout(go, wait)) : go();
}
function armIdle() {
  clearTimeout(idleTimer);
  if (prefs.meditate) idleTimer = setTimeout(() => { if (!busy && document.activeElement !== input) mood("meditating"); }, 60_000);
}

// Lip motion from text cadence: each delta opens the mouth by its vowel density,
// then it decays shut ~140ms after the stream pauses. Purely visual.
let mouthDecay = 0;
function mouthPulse(text) {
  const vowels = (text.match(/[aeiouy]/gi) || []).length;
  rig.setMouth(Math.min(1, 0.25 + vowels / Math.max(4, text.length) * 1.6));
  clearTimeout(mouthDecay);
  mouthDecay = setTimeout(() => rig.setMouth(speaking ? 0.15 : null), 140);
}

// === SOUND / VOICE ===
const sounds = Object.fromEntries(["send", "receive", "click"].map((n) => [n, Object.assign(new Audio(`assets/sounds/${n}.ogg`), { volume: 0.35, preload: "auto" })]));
const play = (n) => { if (!prefs.sounds) return; const a = sounds[n]; a.currentTime = 0; a.play().catch(() => {}); };

const synth = "speechSynthesis" in window ? speechSynthesis : null;
let speaking = false;
function speak(markdown) {
  if (!synth || !prefs.tts) return;
  const text = markdown.replace(/```[\s\S]*?```/g, " (code block) ").replace(/[#*_`>|~-]+/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 2400);
  if (!text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = synth.getVoices().find((x) => x.voiceURI === prefs.voice); if (v) u.voice = v;
  // Some (remote) voices never fire `boundary`; the interval keeps the mouth moving anyway.
  let lastBoundary = 0, fallback = 0;
  u.onstart = () => { speaking = true; mood("talking", "Speaking"); fallback = setInterval(() => { if (performance.now() - lastBoundary > 400) mouthPulse("ae"); }, 180); };
  u.onboundary = (e) => { lastBoundary = performance.now(); mouthPulse(text.substr(e.charIndex, e.charLength || 5)); };
  u.onend = u.onerror = () => { speaking = false; clearInterval(fallback); rig.setMouth(null); if (!busy) mood("happy", undefined, 1800); };
  synth.speak(u);
}
function fillVoices() {
  if (!synth) return;
  const sel = $("opt-voice"); const keep = prefs.voice;
  sel.replaceChildren(new Option("System default", ""));
  for (const v of synth.getVoices()) sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  sel.value = keep;
}
synth?.addEventListener?.("voiceschanged", fillVoices);

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
if (Recognition) {
  const mic = $("btn-mic"); mic.hidden = false;
  mic.addEventListener("click", () => {
    if (recog) { recog.stop(); return; }
    recog = new Recognition(); recog.interimResults = true; recog.continuous = false; recog.lang = navigator.language || "en-US";
    const base = input.value ? input.value.trimEnd() + " " : "";
    recog.onresult = (e) => { input.value = base + [...e.results].map((r) => r[0].transcript).join(""); autosize(); };
    recog.onstart = () => { mic.setAttribute("aria-pressed", "true"); mood("listening", "Listening to your voice"); };
    recog.onerror = (e) => { if (e.error !== "aborted" && e.error !== "no-speech") toast(`Microphone: ${e.error}`, "bad"); };
    recog.onend = () => { mic.setAttribute("aria-pressed", "false"); recog = null; if (input.value.trim()) input.focus(); else if (!busy) mood("idle"); };
    recog.start();
  });
}

// === RENDER ===
// Toasts (UEC Law 16): severity decides duration, not the caller. Info and
// success 4000ms; errors never auto-dismiss. Close is always visible; at most
// three are shown, the oldest is dropped when a fourth arrives.
function toast(text, tone) {
  const box = $("toasts"), t = el("div", "toast"); if (tone) t.dataset.tone = tone;
  const close = el("button", "icon-btn"); close.type = "button"; close.setAttribute("aria-label", "Dismiss notification"); close.append(icon("x"));
  close.onclick = () => t.remove();
  t.append(el("span", "", text), close); box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  if (tone !== "bad") setTimeout(() => t.remove(), 4000);
}

function msgShell(role) {
  const wrap = el("div", `msg ${role === "user" ? "user" : "bot"}`);
  const dot = el("div", "avatar-dot"); dot.append(icon(role === "user" ? "user" : "sparkles"));
  const body = el("div", "msg-body");
  wrap.append(dot, body); return { wrap, body };
}
function sourcesNode(items) {
  const box = el("div", "sources");
  for (const s of dedupe(items).slice(0, 8)) {
    let host = ""; try { host = new URL(s.url).hostname.replace(/^www\./, ""); } catch { continue; }
    if (!/^https?:/.test(s.url)) continue;
    const a = el("a", "source"); a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = s.title;
    a.append(icon("external-link"), el("span", "", host)); box.append(a);
  }
  return box;
}
const dedupe = (items) => [...new Map(items.map((s) => [s.url, s])).values()];

/** Render one stored message. Returns handles for live updates on the newest bot message. */
function renderMessage(m, idx) {
  $("empty").hidden = true;
  const { wrap, body } = msgShell(m.role);
  const bubble = el("div", m.role === "user" ? "bubble" : "bubble md");
  if (m.role === "user") bubble.textContent = m.content;
  else bubble.append(renderMarkdown(m.content));
  const col = el("div"); col.append(bubble); body.append(col);
  if (m.role === "assistant") {
    if (m.sources?.length) col.append(sourcesNode(m.sources));
    col.append(metaBar(m, idx));
  }
  log.append(wrap);
  return { wrap, bubble, col };
}
function metaBar(m, idx) {
  const meta = el("div", "msg-meta");
  const copy = el("button", "icon-btn"); copy.type = "button"; copy.title = "Copy reply"; copy.append(icon("copy"), el("span", "sr", "Copy reply"));
  copy.onclick = () => copyText(m.content, copy);
  const say = el("button", "icon-btn"); say.type = "button"; say.title = "Read aloud"; say.append(icon("volume-2"), el("span", "sr", "Read aloud"));
  say.onclick = () => { const was = prefs.tts; prefs.tts = true; speak(m.content); prefs.tts = was; };
  meta.append(copy, say);
  if (idx === messages.length - 1) {
    const retry = el("button", "icon-btn"); retry.type = "button"; retry.title = "Regenerate"; retry.append(icon("refresh-cw"), el("span", "sr", "Regenerate"));
    retry.onclick = () => { if (busy) return; messages.pop(); persist(); redraw(); run(); };
    meta.append(retry);
  }
  const notes = [m.steps ? `${m.steps} sub-agent step${m.steps > 1 ? "s" : ""}` : "", m.stopped ? "stopped" : ""].filter(Boolean).join(" · ");
  if (notes) meta.append(el("span", "note", notes));
  if (!synth) say.hidden = true;
  return meta;
}
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const i = btn.querySelector(".ic"); if (i) { i.className = "ic ic-check"; setTimeout(() => (i.className = "ic ic-copy"), 1400); }
    else { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1400); }
  }, () => toast("Clipboard unavailable", "bad"));
}
log.addEventListener("click", (e) => {
  const b = e.target.closest(".copy-code"); if (b) copyText(b.closest(".code").querySelector("code").textContent, b);
});
function redraw() {
  log.querySelectorAll(".msg").forEach((n) => n.remove());
  $("empty").hidden = messages.length > 0;
  messages.forEach((m, i) => renderMessage(m, i));
  scrollDown(true);
}
let stick = true;
log.addEventListener("scroll", () => { stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80; });
const scrollDown = (force) => { if (force || stick) log.scrollTop = log.scrollHeight; };

// === ACTIVITY ===
const AGENT_ICON = { researcher: "globe", coder: "terminal", writer: "pen-line", planner: "list-checks" };
const steps = new Map(); let runs = 0;
function resetActivity() { steps.clear(); $("timeline").replaceChildren(); $("plan").hidden = true; $("plan").replaceChildren(); $("activity-empty").hidden = false; }
function stepStarted(ev) {
  $("activity-empty").hidden = true;
  const li = el("li", "step"); li.dataset.agent = ev.agent; li.dataset.status = "running";
  const head = el("div", "step-head");
  const badge = el("span", "step-badge"); badge.append(icon(AGENT_ICON[ev.agent] ?? "bot"));
  const title = el("div", "step-title"); const strong = el("strong", "", ev.label); title.append(strong, el("p", "", ev.task));
  const state = statusNode("pending", "Working");
  head.append(badge, title, state);
  const tools = el("ul", "tools");
  const det = el("details"); const sum = el("summary"); sum.append(icon("chevron-down"), el("span", "", "Live output"));
  const out = el("div", "step-out md"); det.append(sum, out);
  li.append(head, tools, det); $("timeline").append(li);
  steps.set(ev.stepId, { li, state, tools, out, text: "", sources: [], label: ev.label, flush: 0 });
  li.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" });
}
function stepText(s, text) {
  s.text += text;
  if (!s.flush) s.flush = requestAnimationFrame(() => { s.flush = 0; s.out.replaceChildren(renderMarkdown(s.text)); s.out.scrollTop = s.out.scrollHeight; });
}
function toolRow(s, ev) {
  const li = el("li"); const n = ev.name === "web_search" ? "search" : ev.name === "web_fetch" ? "globe" : "terminal";
  const label = ev.name === "web_search" ? `Searching “${ev.detail}”` : ev.name === "web_fetch" ? `Reading ${ev.detail}` : `Running code${ev.detail && ev.detail !== "running code" ? `: ${ev.detail}` : ""}`;
  li.append(icon(n), el("span", "", label)); s.tools.append(li);
}
// One resolver for every status word + tone (UEC Law 17). A dot always ships
// beside its word (Law 7); only failures pulse.
const STATUS = {
  pending: ["idle", "Pending"], active: ["pending", "In progress"], running: ["pending", "Working"],
  done: ["ok", "Done"], ok: ["ok", "Done"], failed: ["error", "Failed"],
};
function canonicalStatus(key) { return STATUS[key] ?? ["idle", "Pending"]; }
function statusNode(tone, word) { const s = el("span", "status"); const d = el("span", "dot"); d.dataset.tone = tone; s.append(d, el("span", "", word)); return s; }
function setStepStatus(s, key, detail) { const [tone, word] = canonicalStatus(key); const n = statusNode(tone, word); if (detail) n.title = detail; s.state.replaceWith(n); s.state = n; s.li.dataset.status = key === "ok" ? "ok" : key; }
function renderPlan(stepsIn) {
  const ol = $("plan"); ol.hidden = false; ol.replaceChildren();
  for (const st of stepsIn) { const li = el("li"); const [tone, word] = canonicalStatus(st.status); li.append(el("span", "", st.title), statusNode(tone, word)); ol.append(li); }
  $("activity-empty").hidden = true;
}

// === RUN ===
let controller = null;
function setBusy(b) {
  busy = b; sendBtn.hidden = b; stopBtn.hidden = !b;
  setStatus(b ? "pending" : health?.provider ? "ok" : "offline", b ? "Working" : health?.provider ? "Ready" : "Offline");
}
function setStatus(tone, text) { $("status-dot").dataset.tone = tone; $("status-text").textContent = text; }

async function run() {
  if (busy || !messages.length) return;
  resetActivity(); runs++;
  $("activity-count").textContent = `Run ${runs}`;
  setBusy(true); synth?.cancel();
  mood("thinking", "Reading your message");

  const live = { role: "assistant", content: "", sources: [], steps: 0 };
  const { wrap, bubble, col } = renderMessage({ role: "assistant", content: "" }, -1);
  col.querySelector(".msg-meta")?.remove();
  const typing = el("span", "typing"); typing.append(el("i"), el("i"), el("i")); bubble.append(typing);
  scrollDown(true);

  let flush = 0, failed = null;
  const paint = () => { flush = 0; bubble.replaceChildren(renderMarkdown(live.content)); scrollDown(); };
  controller = new AbortController();
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ messages: messages.map(({ role, content }) => ({ role, content })) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Server error ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        const ev = JSON.parse(data);
        switch (ev.type) {
          case "text_delta":
            if (ev.stepId) { const s = steps.get(ev.stepId); if (s) stepText(s, ev.text); break; }
            live.content += ev.text; mouthPulse(ev.text);
            if (rig.state !== "talking") mood("talking", "Answering you");
            if (!flush) flush = requestAnimationFrame(paint);
            break;
          case "step_started": live.steps++; stepStarted(ev); mood("thinking", `${ev.label} is on it`); break;
          case "tool_call": { const s = steps.get(ev.stepId); if (s) toolRow(s, ev); if (ev.name === "web_search") mood("thinking", `Searching: ${ev.detail}`); break; }
          case "sources": live.sources.push(...ev.items); if (ev.stepId) steps.get(ev.stepId)?.sources.push(...ev.items); break;
          case "step_finished": {
            const s = steps.get(ev.stepId); if (!s) break;
            setStepStatus(s, ev.status === "ok" ? "ok" : "failed", ev.error);
            if (![...steps.values()].some((x) => x.li.dataset.status === "running")) mood("thinking", "Pulling it together");
            break;
          }
          case "plan": renderPlan(ev.steps); break;
          case "emote": mood(ev.state, undefined, 2600); break;
          case "error": failed = ev.message; break;
          case "run_finished": case "run_started": case "done": break;
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") failed = e.message;
  }
  cancelAnimationFrame(flush);
  const stopped = controller.signal.aborted; controller = null;
  wrap.remove();

  if (live.content.trim()) {
    messages.push({ role: "assistant", content: live.content, sources: dedupe(live.sources), steps: live.steps, ...(stopped && { stopped: true }) });
    persist();
    renderMessage(messages.at(-1), messages.length - 1);
    play("receive");
  }
  if (failed) {
    const { wrap: w, body } = msgShell("assistant"); w.classList.add("error");
    const b = el("div", "bubble"); b.append(icon("circle-alert"), el("span", "", failed));
    const retry = el("button", "btn ghost"); retry.type = "button"; retry.append(icon("refresh-cw"), el("span", "", "Retry"));
    retry.onclick = () => { w.remove(); run(); };
    const meta = el("div", "msg-meta always"); meta.append(retry);
    body.append(b, meta); log.append(w); toast(failed, "bad");
  }
  setBusy(false); scrollDown();
  if (failed) mood("idle", "Something went wrong");
  else if (stopped) mood("idle", "Stopped");
  else if (prefs.tts && synth) speak(live.content);
  else mood(live.steps >= 2 ? "celebrating" : "happy", undefined, live.steps >= 2 ? 3200 : 2400);
  rig.setMouth(null);
  input.focus();
}

// === COMPOSER ===
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
function submit(text) {
  text = (text ?? input.value).trim();
  if (!text || busy) return;
  if (!health?.provider) { toast("No model provider is configured. Follow the setup note at the top of the page.", "bad"); return; }
  messages.push({ role: "user", content: text }); persist();
  renderMessage(messages.at(-1), messages.length - 1);
  input.value = ""; autosize(); play("send"); scrollDown(true);
  run();
}
$("composer").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
input.addEventListener("input", () => { autosize(); if (!busy && input.value) mood("listening", "Reading as you type"); });
input.addEventListener("focus", () => { if (!busy && rig.state === "meditating") mood("idle", "Ready"); });
input.addEventListener("blur", () => { if (!busy && rig.state === "listening" && !input.value) mood("idle"); });
stopBtn.addEventListener("click", () => controller?.abort());
$("samples").addEventListener("click", (e) => { const c = e.target.closest("[data-prompt]"); if (c) { play("click"); submit(c.dataset.prompt); } });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && busy) { controller?.abort(); e.preventDefault(); }
  else if (e.key === "Escape" && synth?.speaking) synth.cancel();
  else if (e.key === "/" && document.activeElement !== input && !(e.target instanceof HTMLInputElement) && !$("settings").open) { e.preventDefault(); input.focus(); }
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); newChat(); }
});
function newChat() {
  if (busy) controller?.abort();
  messages = []; persist(); redraw(); resetActivity(); synth?.cancel();
  $("activity-count").textContent = "No runs yet"; mood("happy", "New chat started", 1500); input.focus();
}
$("btn-new").addEventListener("click", newChat);

// === SETTINGS ===
const dlg = $("settings");
$("btn-settings").addEventListener("click", () => { fillVoices(); dlg.showModal(); });
const bind = (id, key, apply, prop = "checked") => {
  const n = $(id); n[prop] = prop === "value" ? String(prefs[key]) : prefs[key];
  n.addEventListener(prop === "value" ? "input" : "change", () => { prefs[key] = prop === "value" ? (n.type === "range" ? +n.value : n.value) : n.checked; savePrefs(); apply?.(); });
};
bind("opt-intensity", "intensity", () => { $("intensity-out").textContent = prefs.intensity + "%"; applyMotion(); }, "value");
$("intensity-out").textContent = prefs.intensity + "%";
bind("opt-bones", "bones", () => rig.setBones(prefs.bones));
bind("opt-meditate", "meditate", armIdle);
bind("opt-sounds", "sounds");
bind("opt-tts", "tts", syncVoiceBtn);
bind("opt-voice", "voice", null, "value");
if (!synth) { $("opt-tts").disabled = true; $("btn-voice").hidden = true; }
function syncVoiceBtn() { const b = $("btn-voice"); b.setAttribute("aria-pressed", String(prefs.tts)); b.querySelector(".ic").className = `ic ic-${prefs.tts ? "volume-2" : "volume-x"}`; $("opt-tts").checked = prefs.tts; }
$("btn-voice").addEventListener("click", () => { prefs.tts = !prefs.tts; if (!prefs.tts) synth?.cancel(); savePrefs(); syncVoiceBtn(); toast(prefs.tts ? "Spoken replies turned on" : "Spoken replies turned off"); });
syncVoiceBtn();

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = (t ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")) === "dark";
  $("btn-theme").querySelector(".ic").className = `ic ic-${dark ? "sun" : "moon"}`;
  return dark;
}
$("btn-theme").addEventListener("click", () => {
  const current = prefs.theme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  prefs.theme = current === "dark" ? "light" : "dark"; setTheme(prefs.theme); savePrefs();
});
setTheme(prefs.theme);

$("btn-clear").addEventListener("click", () => { if (confirm("Delete all messages stored in this browser?")) { newChat(); dlg.close(); toast("Chat history cleared"); } });
$("btn-export").addEventListener("click", () => {
  const md = messages.map((m) => `### ${m.role === "user" ? "You" : "Sprout"}\n\n${m.content}\n`).join("\n");
  const a = el("a"); a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" })); a.download = `sprout-chat-${new Date().toISOString().slice(0, 10)}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// === BOOT ===
let health = null;
async function checkHealth() {
  try {
    health = await (await fetch("/api/health")).json();
  } catch { health = null; }
  const p = health?.provider, banner = $("banner");
  if (p) {
    $("provider-line").textContent = p.team ? `Lead agent + 4 specialists · ${p.model}${p.webSearch ? " · web search" : ""}` : `Solo mode · ${p.name} / ${p.model}`;
    banner.hidden = true; setStatus(busy ? "pending" : "ok", busy ? "Working" : "Ready");
  } else {
    $("provider-line").textContent = health ? "No model provider configured" : "Server unreachable";
    banner.hidden = false; banner.replaceChildren();
    const msg = health
      ? ["No model provider is configured. Set ", ["ANTHROPIC_API_KEY"], " for the full agent team with web search, or ", ["XAI_API_KEY"], ", or start Ollama, then restart the server."]
      : ["The Sprout server is not reachable. Start it with ", ["bun run start"], "."];
    const text = el("span");
    for (const part of msg) text.append(Array.isArray(part) ? el("code", "", part[0]) : document.createTextNode(part));
    banner.append(icon("circle-alert"), text);
    setStatus("offline", "Offline");
  }
}

redraw();
mood("idle");
checkHealth();
setInterval(() => { if (!busy) checkHealth(); }, 30_000);
input.focus();

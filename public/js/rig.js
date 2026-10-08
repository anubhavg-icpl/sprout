// Sprout rig — articulated 2D skeletal human drawn entirely in Canvas 2D.
//
// Derived from prototype/human-v0.1.html (kept verbatim for provenance).
// Contract:
//   createRig(canvas) -> { setState(name), setMouth(0..1|null), setIntensity(0..1),
//                          setBones(bool), setBlink(bool), state }
//   States: idle | listening | thinking | talking | happy | celebrating | meditating.
//   The app drives states from the agent lifecycle (see app.js); the rig never
//   decides its own state. Poses blend over TRANSITION_S with smoothstep so a
//   state change never snaps.
// Conventions (do not "fix"):
//   - Angles: 0 hangs straight down; positive swings toward screen-left, so the
//     L limbs open outward with positive values and the R limbs with negative.
//   - Intensity scales only oscillation (S()), so held poses such as hand-on-chin
//     still land at intensity 0 — that is what makes reduced-motion work.
//   - Pose channels are plain numbers in `KEYS`; adding a channel means adding
//     it to KEYS *and* BASE or blending silently skips it.
//   - setMouth(v) overrides the procedural talking mouth so speech/text cadence
//     drives lip motion; setMouth(null) returns to procedural.

const KEYS = ["bob", "lean", "head", "eye", "squint", "gazeX", "gazeY", "brow", "mouth", "armL", "elbL", "armR", "elbR", "legL", "kneeL", "legR", "kneeR", "lotus", "squash", "bodyY"];
const BASE = { bob: 0, lean: 0, head: 0, eye: 1, squint: 0, gazeX: 0, gazeY: 0, brow: 0, mouth: 0, armL: 0.1, elbL: 0.12, armR: -0.1, elbR: -0.12, legL: 0, kneeL: 0, legR: 0, kneeR: 0, lotus: 0, squash: 1, bodyY: 0 };
const TRANSITION_S = 0.5;
export const STATES = ["idle", "listening", "thinking", "talking", "happy", "celebrating", "meditating"];

const COLORS = { skin: "#f9c99a", skinShade: "#eba77c", line: "#1c1c1c", hair: "#3b3b3b", tee: "#23e24b", teeLight: "#8df59f", pants: "#b7d62b", shoe: "#3a3a3a", accent: "#1fae3d" };

const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const mix = (a, b, t) => a + (b - a) * t;
// Forward kinematics: end point of a bone of length l leaving p at angle a.
const J = (p, a, l) => [p[0] - Math.sin(a) * l, p[1] + Math.cos(a) * l];

export function createRig(canvas) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  let state = "idle", phase = 0, last = performance.now(), transitionStart = last, elapsed = 0;
  let intensity = 0.7, showBones = false, autoBlink = true, mouthOverride = null;
  let current = { ...BASE }, from = { ...BASE };
  let blinkAt = 1.8, blinkProgress = -1;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // === POSES ===
  function target(s, t) {
    const p = { ...BASE }, S = (x) => Math.sin(x) * intensity;
    switch (s) {
      case "idle": p.bob = S(t * 2.1) * 1.5; p.head = S(t * 0.85) * 0.04; p.lean = S(t * 0.9) * 0.012; p.armL = 0.1 + S(t * 1.4) * 0.03; p.armR = -0.1 - S(t * 1.4) * 0.03; p.gazeX = S(t * 0.35) * 2.5; break;
      case "thinking": p.head = -0.13 + S(t * 0.8) * 0.03; p.gazeX = 4; p.gazeY = -4; p.brow = 0.7; p.armL = -0.55; p.elbL = 3.75 + S(t * 1.5) * 0.04; p.armR = -0.5; p.elbR = 1; p.lean = 0.02; p.bob = S(t * 1.2); break;
      case "listening": p.lean = 0.045; p.head = 0.1 + S(t * 0.9) * 0.025; p.brow = 0.6; p.eye = 1.15; p.armL = 0.3; p.elbL = -1.3; p.armR = -0.3; p.elbR = 1.3; p.bob = S(t * 2); break;
      case "talking": p.mouth = 0.3 + Math.abs(S(t * 10)) * 0.7; p.head = S(t * 4) * 0.05; p.brow = 0.3; p.armL = 0.35; p.elbL = -2.14 + S(t * 3) * 0.06; p.armR = -0.3 + S(t * 4.1) * 0.14; p.elbR = -2.1 + S(t * 5) * 0.28; p.bob = S(t * 4) * 1.5; break;
      case "happy": p.mouth = 0.7; p.squint = 1; p.brow = 0.5; p.bob = Math.abs(S(t * 4.2)) * 10; p.head = S(t * 3) * 0.09; p.armL = 0.5; p.elbL = 2.2 + S(t * 8.4) * 0.2; p.armR = -0.5; p.elbR = -2.2 - S(t * 8.4) * 0.2; p.squash = 1 + S(t * 8.4) * 0.02; break;
      case "celebrating": p.mouth = 1; p.squint = 1; p.brow = 0.8; p.bob = Math.pow(Math.max(0, S(t * 4.9)), 1.1) * 46; p.armL = 2.6 + S(t * 9) * 0.25; p.elbL = 0.3; p.armR = -2.6 + S(t * 9 + 1) * 0.25; p.elbR = -0.3; p.legL = 0.2; p.kneeL = -0.15; p.legR = -0.2; p.kneeR = 0.15; p.head = S(t * 6) * 0.1; p.squash = 1 + S(t * 9.8) * 0.03; break;
      case "meditating": p.eye = 0; p.lotus = 1; p.legL = 1.35; p.kneeL = -2.5; p.legR = -1.35; p.kneeR = 2.5; p.armL = 0.42; p.elbL = 0.05; p.armR = -0.42; p.elbR = -0.05; p.bodyY = 50; p.bob = S(t * 1.25) * 6; p.head = S(t * 0.7) * 0.02; break;
    }
    return p;
  }

  // === DRAWING PRIMITIVES ===
  function ellipse(x, y, rx, ry, color, stroke) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); if (stroke) { ctx.lineWidth = 2.5; ctx.strokeStyle = stroke; ctx.stroke(); } }
  function rrect(x, y, w, h, r, fill) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
  function part(x, y, rot, draw) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot); draw(); ctx.restore(); }
  function bone(a, b) { if (!showBones) return; ctx.strokeStyle = "#e0339bd0"; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ellipse(a[0], a[1], 3, 3, "#c2187f"); ellipse(b[0], b[1], 3, 3, "#c2187f"); }
  function limb(pts, w, fill) { ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.strokeStyle = COLORS.line; ctx.lineWidth = w + 5; ctx.stroke(); ctx.strokeStyle = fill; ctx.lineWidth = w; ctx.stroke(); }

  // === BODY ===
  function leg(side, a, k, lotus) {
    const hip = [side * 15, 4], knee = J(hip, a, 58), foot = J(knee, a + k, 70);
    part(foot[0], foot[1], a + k, () => { ctx.globalAlpha = lotus; ellipse(0, 12, 8, 15, COLORS.skin, COLORS.line); ctx.globalAlpha = 1 - lotus; ellipse(side * 7, 9, 20, 10.5, COLORS.shoe, COLORS.line); ctx.globalAlpha = 1; });
    limb([hip, knee, foot], 25, COLORS.pants); bone(hip, knee); bone(knee, foot);
  }
  function arm(side, a, e) {
    const sh = [side * 34, -86], el = J(sh, a, 46), ha = J(el, a + e, 48);
    limb([sh, el, ha], 13, COLORS.skin); limb([sh, J(sh, a, 20)], 19, COLORS.tee); ellipse(ha[0], ha[1], 9.5, 9.5, COLORS.skin, COLORS.line); bone(sh, el); bone(el, ha);
  }
  function head(p) {
    const { skin, skinShade, line, hair } = COLORS;
    for (const s of [-1, 1]) { ellipse(s * 45, -62, 11, 17, skin, line); ellipse(s * 46, -61, 5, 10, skinShade); }
    ctx.beginPath(); ctx.moveTo(-43, -66); ctx.bezierCurveTo(-43, -125, 43, -125, 43, -66); ctx.bezierCurveTo(43, -30, 18, -6, 0, -6); ctx.bezierCurveTo(-18, -6, -43, -30, -43, -66); ctx.fillStyle = skin; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = line; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-47, -60); ctx.quadraticCurveTo(-60, -100, -38, -116); ctx.lineTo(-48, -128); ctx.quadraticCurveTo(-10, -146, 18, -130); ctx.lineTo(32, -138); ctx.quadraticCurveTo(58, -118, 48, -60); ctx.quadraticCurveTo(44, -90, 30, -98); ctx.quadraticCurveTo(0, -88, -28, -99); ctx.quadraticCurveTo(-43, -90, -47, -60); ctx.closePath(); ctx.fillStyle = hair; ctx.fill(); ctx.lineJoin = "round"; ctx.lineWidth = 2.5; ctx.strokeStyle = line; ctx.stroke();
    // Cheeks: a touch of warmth that scales with happiness.
    ctx.globalAlpha = 0.18 + p.squint * 0.25; for (const s of [-1, 1]) ellipse(s * 27, -44, 8, 5, "#ff7a8a"); ctx.globalAlpha = 1;
    const eye = Math.max(0, p.eye); ctx.lineCap = "round";
    for (const s of [-1, 1]) {
      const x = s * 16, by = -84 - p.brow * 5;
      ctx.strokeStyle = line; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x - 9, by + 2 + s * p.brow * 1.5); ctx.quadraticCurveTo(x, by - 5, x + 9, by + 2 - s * p.brow * 1.5); ctx.stroke(); ctx.lineWidth = 2.6;
      if (p.squint > 0.5) { ctx.beginPath(); ctx.moveTo(x - 8, -65); ctx.quadraticCurveTo(x, -76, x + 8, -65); ctx.stroke(); }
      else if (eye < 0.14) { ctx.beginPath(); ctx.moveTo(x - 8, -69); ctx.quadraticCurveTo(x, -61, x + 8, -69); ctx.stroke(); }
      else { ctx.beginPath(); ctx.ellipse(x, -68, 7, Math.max(0.8, 8.5 * Math.min(eye, 1.3)), 0, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 1.8; ctx.stroke(); ellipse(x + p.gazeX * 0.6, -68 + p.gazeY * 0.6, 3.6, Math.min(3.6, 7 * eye), line); ellipse(x + p.gazeX * 0.6 - 1.2, -69.5 + p.gazeY * 0.6, 1.2, 1.2, "#fff"); }
    }
    ellipse(0, -46, 9, 7, "#ea917a"); ctx.strokeStyle = line; ctx.lineWidth = 2.4;
    if (p.mouth > 0.08) { ctx.beginPath(); ctx.moveTo(-12, -30); ctx.quadraticCurveTo(0, -27, 12, -30); ctx.quadraticCurveTo(0, -30 + p.mouth * 24, -12, -30); ctx.closePath(); ctx.fillStyle = "#6b1f24"; ctx.fill(); ctx.stroke(); ellipse(0, -27 + p.mouth * 7, 5, p.mouth * 3, "#e9707a"); }
    else { ctx.beginPath(); ctx.moveTo(-11, -30); ctx.quadraticCurveTo(0, -20, 11, -30); ctx.stroke(); }
    bone([0, 0], [0, -66]);
  }

  // === PROPS & FX ===
  function prop(s, a, t) {
    if (a <= 0) return; ctx.save(); ctx.globalAlpha = a; ctx.lineCap = "round"; const S = Math.sin;
    switch (s) {
      case "thinking": ellipse(52, -212, 4, 4, "#c9d6cb"); ellipse(64, -226, 6, 6, "#c9d6cb"); part(92, -250 + S(t * 2) * 3, 0, () => { ellipse(0, 0, 24, 19, "#fff", "#b4c4b7"); for (let i = 0; i < 3; i++) ellipse(-10 + i * 10, S(t * 6 - i) * 2, 3, 3, COLORS.accent); }); break;
      case "listening": ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 4; for (let i = 0; i < 3; i++) { ctx.globalAlpha = a * (0.25 + 0.75 * Math.max(0, S(t * 5 + i * 0.9))); ctx.beginPath(); ctx.arc(-66, -160, 14 + i * 11, Math.PI * 0.78, Math.PI * 1.22); ctx.stroke(); } break;
      case "talking": part(98, -212, 0, () => { ctx.fillStyle = COLORS.accent; ctx.beginPath(); ctx.moveTo(-22, 12); ctx.lineTo(-32, 30); ctx.lineTo(-8, 14); ctx.closePath(); ctx.fill(); rrect(-36, -16, 72, 30, 9, COLORS.accent); for (let i = 0; i < 3; i++) ellipse(-18 + i * 18, -1 + S(t * 7 - i * 1.1) * 3, 4.5, 4.5, "#fff"); }); break;
      case "happy": for (const [x, y, r, o] of [[-92, -190, 10, 0], [96, -214, 13, 1.4], [86, -120, 8, 2.6]]) { const k = r * (0.6 + 0.4 * S(t * 5 + o)); ctx.fillStyle = "#f5b623"; ctx.beginPath(); ctx.moveTo(x, y - k); ctx.quadraticCurveTo(x, y, x + k, y); ctx.quadraticCurveTo(x, y, x, y + k); ctx.quadraticCurveTo(x, y, x - k, y); ctx.quadraticCurveTo(x, y, x, y - k); ctx.fill(); } break;
    }
    ctx.restore();
  }
  function aura(a, t) { if (a <= 0) return; for (let i = 0; i < 3; i++) { const k = (t * 0.22 + i / 3) % 1; ctx.globalAlpha = a * (1 - k) * 0.5; ctx.strokeStyle = "#39d65c"; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(0, -70, 70 + k * 90, 90 + k * 90, 0, 0, Math.PI * 2); ctx.stroke(); } ctx.globalAlpha = 1; }
  function confetti(a, t) { if (a <= 0) return; const cols = ["#23e24b", "#b7d62b", "#f5b623", "#ff7a8a", "#4aa8ff"]; ctx.save(); for (let i = 0; i < 26; i++) { const k = (t * 0.5 + i * 0.137) % 1, x = W / 2 + (((i * 97) % 300) - 150) * (0.5 + k * 0.9), y = H * 0.12 + k * H * 0.65; ctx.globalAlpha = a * (1 - k) * 0.9; part(x, y, t * 4 + i, () => rrect(-4, -2.5, 8, 5, 1.5, cols[i % 5])); } ctx.restore(); }

  function human(p, t, u) {
    ctx.save();
    const scale = Math.min(W / 440, H / 520, 1.1);
    ctx.translate(W / 2, H * 0.88 - 138 * scale - p.bob + p.bodyY * scale);
    ctx.scale(scale, scale); ctx.scale(p.squash, 2 - p.squash);
    aura(p.lotus, t);
    leg(-1, p.legL, p.kneeL, p.lotus); leg(1, p.legR, p.kneeR, p.lotus); ellipse(0, 6, 27, 13, COLORS.pants);
    part(0, 4, p.lean, () => {
      ctx.translate(0, -4);
      rrect(-9, -108, 18, 20, 5, COLORS.line); rrect(-6.5, -108, 13, 20, 4, COLORS.skinShade);
      ctx.beginPath(); ctx.moveTo(-38, -90); ctx.quadraticCurveTo(0, -104, 38, -90); ctx.lineTo(31, 4); ctx.quadraticCurveTo(0, 11, -31, 4); ctx.closePath(); ctx.fillStyle = COLORS.tee; ctx.fill(); ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.strokeStyle = COLORS.line; ctx.stroke();
      ctx.strokeStyle = COLORS.teeLight; ctx.lineWidth = 5; ctx.lineCap = "round"; for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 14, -94); ctx.quadraticCurveTo(s * 27, -90, s * 30, -76); ctx.stroke(); }
      bone([0, 4], [0, -98]);
      part(0, -98, p.head, () => head(p));
      arm(-1, p.armL, p.elbL); arm(1, p.armR, p.elbR);
      prop(state, u, t);
    });
    ctx.restore();
  }
  function ground(p) {
    const ground = H * 0.88, lift = p.bob + p.lotus * 30;
    ellipse(W / 2, ground + 2, Math.max(40, 78 - lift * 0.5), Math.max(5, 10 - lift * 0.07), `rgba(40,70,45,${Math.max(0.07, 0.2 - lift * 0.0025)})`);
  }

  // === LOOP ===
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now; elapsed += dt; phase += dt;
    const u = ease((now - transitionStart) / 1000 / TRANSITION_S);
    const desired = target(state, phase);
    if (mouthOverride !== null) desired.mouth = mouthOverride;
    for (const k of KEYS) current[k] = mix(from[k], desired[k], u);
    if (autoBlink && state !== "meditating") {
      blinkAt -= dt;
      if (blinkAt <= 0) { blinkProgress = 0; blinkAt = 2.5 + Math.random() * 2.6; }
      if (blinkProgress >= 0) { blinkProgress += dt; const b = Math.max(0, 1 - Math.sin(Math.min(1, blinkProgress / 0.19) * Math.PI)); current.eye = Math.min(current.eye, b); if (blinkProgress > 0.19) blinkProgress = -1; }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ground(current); human(current, elapsed, u);
    if (state === "celebrating") confetti(u, elapsed);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return {
    get state() { return state; },
    setState(next) { if (!STATES.includes(next) || next === state) return; from = { ...current }; state = next; transitionStart = performance.now(); phase = 0; },
    setMouth(v) { mouthOverride = v === null ? null : Math.max(0, Math.min(1, v)); },
    setIntensity(v) { intensity = v; },
    setBones(v) { showBones = v; },
    setBlink(v) { autoBlink = v; },
  };
}

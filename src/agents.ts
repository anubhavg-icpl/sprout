// Sprout orchestrator — one lead agent that delegates to specialist sub-agents.
//
// Pattern: orchestrator-workers on the Claude Messages API (manual tool loop).
//   Orchestrator tools (client-side, executed here): delegate, plan, emote.
//   Specialists are plain configs { system, tools, effort } run as their own
//   streamed calls; they cannot delegate (depth cap = 1). A specialist returns
//   only its final text to the orchestrator; its live stream goes to the UI via
//   `emit` (step_* / text_delta tagged with stepId), never into the lead's context.
// Guard rails adapted from CopilotKit/OpenBot (MIT, docs/coworkers.md): caps
// REFUSE rather than truncate, run/step ids are server-assigned (the model
// cannot set them), and handoffs are typed (task + success_criteria).
// Invariants:
//   - Message history is append-only: assistant `content` is pushed back
//     unchanged (Opus 5.5 binds thinking blocks to the conversation).
//   - All tool_results for one assistant turn go back in ONE user message.
//   - stop_reason is checked (refusal / max_tokens) before tools run.
//   - eager_input_streaming is on, so tool inputs are validated by hand here.
// Event vocabulary (SSE, see public/js/app.js): run_started, text_delta,
// step_started, step_finished, tool_call, sources, plan, emote, error,
// run_finished. Names follow AG-UI (docs.ag-ui.com) where an equivalent exists.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, type ChatTurn } from "./providers";

export type Emit = (ev: Record<string, unknown>) => void;

const MAX_DELEGATIONS = 8; // per run
const MAX_LEAD_ROUNDS = 10; // orchestrator tool-loop iterations per run
const MAX_PAUSE_RESUMES = 3; // server-tool pause_turn continuations per call
const AVATAR_STATES = ["thinking", "happy", "celebrating", "listening", "meditating"] as const;

const env = (k: string) => process.env[k]?.trim() || undefined;
const model = () => env("ANTHROPIC_MODEL") ?? "claude-opus-5-5";
const webOn = () => env("WEB_SEARCH") !== "0";

// === SPECIALISTS ===
// Tool narrowing on purpose: each specialist gets only what it needs.
// Server tools run on Anthropic's infrastructure — nothing executes locally.
export const SPECIALISTS: Record<string, { label: string; blurb: string; effort: string; system: string; tools: () => any[] }> = {
  researcher: {
    label: "Researcher",
    blurb: "searches and reads the live web, returns cited findings",
    effort: "medium",
    system: "You are the Researcher sub-agent. Investigate the task using web search and web fetch. Prefer primary and recent sources. Return a compact brief: key findings as bullets, each with its source URL, then open questions. No preamble.",
    tools: () => (webOn() ? [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 }] : []),
  },
  coder: {
    label: "Coder",
    blurb: "writes, explains and runs code in a sandbox",
    effort: "medium",
    system: "You are the Coder sub-agent. Produce correct, idiomatic, minimal code with brief reasoning. When running code would verify an answer (math, data, parsing), use the code execution sandbox and report the real output. Return the final code in fenced blocks with a language tag.",
    tools: () => [{ type: "code_execution_20260521", name: "code_execution" }],
  },
  writer: {
    label: "Writer",
    blurb: "drafts and polishes prose: emails, docs, summaries",
    effort: "low",
    system: "You are the Writer sub-agent. Write clear, vivid, well-structured prose that matches the requested tone and length. Return only the deliverable.",
    tools: () => [],
  },
  planner: {
    label: "Planner",
    blurb: "breaks big goals into concrete, ordered steps",
    effort: "medium",
    system: "You are the Planner sub-agent. Turn the goal into a short ordered plan: numbered steps, each with a concrete outcome, plus key risks. Be decisive; no preamble.",
    tools: () => [],
  },
};

const LEAD_SYSTEM = `${SYSTEM_PROMPT}

You are also the LEAD of a small team of specialist sub-agents and you appear to the user as an animated avatar.
Specialists (call with the \`delegate\` tool):
${Object.entries(SPECIALISTS).map(([k, s]) => `- ${k}: ${s.blurb}`).join("\n")}

How to work:
- Simple chat, quick facts you are sure of, or opinions: answer yourself, no delegation.
- Anything needing current information, sources, code that should be run, long-form writing, or multi-step work: delegate. Give each delegation a self-contained task and explicit success_criteria — specialists cannot see the conversation.
- Independent delegations should be issued in the SAME turn so they run in parallel.
- For work with 3+ steps, call \`plan\` first, then call it again as steps complete.
- Specialists' output is not shown to the user directly: synthesise it into one final answer, keep their source links, and say plainly if a specialist failed.
- If the request is ambiguous in a way that changes the answer, ask the user one short question instead of guessing.
- Optionally call \`emote\` for a celebratory or reflective moment; never more than once per reply.`;

const LEAD_TOOLS = [
  {
    name: "delegate",
    description: "Hand a self-contained task to a specialist sub-agent and receive its result. Issue several in one turn to run them in parallel.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["agent", "task", "success_criteria"],
      properties: {
        agent: { type: "string", enum: Object.keys(SPECIALISTS) },
        task: { type: "string", description: "Complete, standalone instructions including all needed context." },
        success_criteria: { type: "string", description: "What a good result must contain." },
      },
    },
  },
  {
    name: "plan",
    description: "Show or update the visible plan checklist for multi-step work.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "status"],
            properties: { title: { type: "string" }, status: { type: "string", enum: ["pending", "active", "done", "failed"] } },
          },
        },
      },
    },
  },
  {
    name: "emote",
    description: "Make the avatar perform an expressive animation.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: { state: { type: "string", enum: [...AVATAR_STATES] } },
    },
  },
];

let client: Anthropic | null = null;
const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

/**
 * One streamed Messages call (with pause_turn resumes for server tools).
 * Forwards text and server-tool activity to `emit`, tagged with stepId (null = lead).
 * Returns the final assistant message.
 */
async function streamCall(
  params: { system: string; messages: any[]; tools: any[]; effort: string },
  emit: Emit,
  stepId: string | null,
  signal: AbortSignal,
): Promise<any> {
  client ??= new Anthropic();
  const messages = [...params.messages];
  let final: any;
  for (let resume = 0; resume <= MAX_PAUSE_RESUMES; resume++) {
    const s = client.beta.messages.stream(
      {
        model: model(),
        max_tokens: 64000,
        system: params.system,
        messages,
        ...(params.tools.length && { tools: params.tools }),
        output_config: { effort: params.effort },
        // Server-side refusal fallback: a policy decline is retried on another
        // model inside the same call. "default" routes by refusal category.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as any,
      { signal },
    );
    const toolInputs = new Map<number, { name: string; json: string }>();
    for await (const ev of s as AsyncIterable<any>) {
      if (ev.type === "content_block_start") {
        const b = ev.content_block;
        if (b.type === "server_tool_use") toolInputs.set(ev.index, { name: b.name, json: "" });
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          emit({ type: "sources", stepId, items: b.content.filter((r: any) => r.url).slice(0, 8).map((r: any) => ({ title: r.title || r.url, url: r.url })) });
        }
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") emit({ type: "text_delta", stepId, text: ev.delta.text });
        else if (ev.delta.type === "input_json_delta" && toolInputs.has(ev.index)) toolInputs.get(ev.index)!.json += ev.delta.partial_json;
      } else if (ev.type === "content_block_stop" && toolInputs.has(ev.index)) {
        const t = toolInputs.get(ev.index)!;
        let input: any = {};
        try { input = JSON.parse(t.json || "{}"); } catch { /* partial — still show the call */ }
        emit({ type: "tool_call", stepId, name: t.name, detail: input.query ?? input.url ?? (input.code ? "running code" : "") });
      }
    }
    final = await s.finalMessage();
    if (final.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: final.content });
  }
  return final;
}

const textOf = (msg: any) => msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();

async function runSpecialist(agent: string, task: string, criteria: string, emit: Emit, signal: AbortSignal) {
  const spec = SPECIALISTS[agent];
  const stepId = id("step");
  emit({ type: "step_started", stepId, agent, label: spec.label, task });
  try {
    const final = await streamCall(
      { system: spec.system, effort: spec.effort, tools: spec.tools(), messages: [{ role: "user", content: `Task:\n${task}\n\nSuccess criteria:\n${criteria}` }] },
      emit, stepId, signal,
    );
    if (final.stop_reason === "refusal") throw new Error("the specialist declined this task");
    const out = textOf(final) || "(no output)";
    emit({ type: "step_finished", stepId, status: "ok" });
    return { ok: true, text: out };
  } catch (e: any) {
    if (signal.aborted) throw e;
    emit({ type: "step_finished", stepId, status: "failed", error: String(e?.message ?? e).slice(0, 200) });
    return { ok: false, text: `Specialist ${agent} failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

/** Run one user turn through the lead agent. Emits events; throws only on abort/transport errors. */
export async function runOrchestrator(history: ChatTurn[], emit: Emit, signal: AbortSignal): Promise<void> {
  const runId = id("run");
  emit({ type: "run_started", runId, mode: "team" });
  const messages: any[] = history.map((t) => ({ role: t.role, content: t.content }));
  let delegations = 0;

  let finished = false;
  for (let round = 0; round < MAX_LEAD_ROUNDS; round++) {
    const final = await streamCall({ system: LEAD_SYSTEM, messages, tools: LEAD_TOOLS, effort: env("CLAUDE_EFFORT") ?? "medium" }, emit, null, signal);
    if (final.stop_reason === "refusal") { emit({ type: "error", message: "The model declined this request." }); finished = true; break; }
    if (final.stop_reason === "max_tokens") { emit({ type: "error", message: "The answer hit the length limit." }); finished = true; break; }
    const calls = final.content.filter((b: any) => b.type === "tool_use");
    if (final.stop_reason !== "tool_use" || !calls.length) { finished = true; break; }
    messages.push({ role: "assistant", content: final.content });

    const results = await Promise.all(calls.map(async (c: any) => {
      const input = c.input ?? {};
      const fail = (msg: string) => ({ type: "tool_result", tool_use_id: c.id, is_error: true, content: msg });
      const ok = (msg: string) => ({ type: "tool_result", tool_use_id: c.id, content: msg });
      if (c.name === "delegate") {
        if (!SPECIALISTS[input.agent] || typeof input.task !== "string" || !input.task.trim()) return fail("INVALID_INPUT: agent must be one of the listed specialists and task must be non-empty.");
        if (++delegations > MAX_DELEGATIONS) return fail(`REFUSED: delegation cap (${MAX_DELEGATIONS} per reply) reached. Answer with what you have.`);
        const r = await runSpecialist(input.agent, input.task, String(input.success_criteria ?? ""), emit, signal);
        return r.ok ? ok(r.text) : fail(r.text);
      }
      if (c.name === "plan") {
        if (!Array.isArray(input.steps)) return fail("INVALID_INPUT: steps must be an array.");
        emit({ type: "plan", steps: input.steps.slice(0, 12).map((s: any) => ({ title: String(s?.title ?? "").slice(0, 120), status: String(s?.status ?? "pending") })) });
        return ok("Plan shown to the user.");
      }
      if (c.name === "emote") {
        if (!AVATAR_STATES.includes(input.state)) return fail("INVALID_INPUT: unknown state.");
        emit({ type: "emote", state: input.state });
        return ok("Done.");
      }
      return fail(`Unknown tool ${c.name}.`);
    }));
    messages.push({ role: "user", content: results });
  }
  // Say failures out loud: hitting the round cap mid-task must not end silently.
  if (!finished) emit({ type: "error", message: `Stopped after ${MAX_LEAD_ROUNDS} planning rounds without a final answer. Try narrowing the request.` });
  emit({ type: "run_finished", runId, delegations });
}

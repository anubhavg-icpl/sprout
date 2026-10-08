// Provider resolution + single-agent adapters (xAI, Ollama).
//
// Contract: Anthropic powers the full multi-agent team (agents.ts). xAI and
// Ollama run "solo mode": one streamed answer, no sub-agents, no web search;
// the UI shows which mode is active via /api/health.
// Invariants:
//   - API keys are read from env here and never leave the server process.
//   - The client never chooses an upstream URL or model (SSRF / cost guard):
//     provider + model come from env only.
//   - `signal` is forwarded upstream so "Stop" in the UI cancels billing.
// Wire formats verified 2026-10-08 against:
//   Anthropic  https://platform.claude.com/docs/en/build-with-claude/streaming
//   xAI        https://docs.x.ai/docs/guides/chat-completions (OpenAI-style SSE)
//   Ollama     https://github.com/ollama/ollama/blob/main/docs/api.md (NDJSON)

export type Role = "user" | "assistant";
export interface ChatTurn { role: Role; content: string }

export type BotEvent = { type: "text"; text: string };

export type ProviderName = "anthropic" | "xai" | "ollama";
export interface ProviderInfo { name: ProviderName; model: string; webSearch: boolean; team: boolean }

export const SYSTEM_PROMPT = `You are Sprout, a warm, sharp and concise assistant who lives inside an animated mascot on the user's screen.
Answer accurately and directly. Use GitHub-flavoured Markdown (headings, lists, fenced code with a language tag) when it helps readability; keep casual replies short.
If you are unsure, say so instead of guessing. When you use web search, cite the sources you relied on.`;

const env = (k: string) => process.env[k]?.trim() || undefined;

const OLLAMA_URL = env("OLLAMA_URL") ?? "http://127.0.0.1:11434";

async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Resolve the active provider. Order: explicit PROVIDER, then whichever key exists, then a reachable Ollama. */
export async function resolveProvider(): Promise<ProviderInfo | null> {
  const forced = env("PROVIDER") as ProviderName | undefined;
  const pick = (name: ProviderName): ProviderInfo => ({
    name,
    model:
      name === "anthropic" ? env("ANTHROPIC_MODEL") ?? "claude-opus-5-5"
      : name === "xai" ? env("XAI_MODEL") ?? "grok-4.7"
      : env("OLLAMA_MODEL") ?? "llama3.2",
    webSearch: name === "anthropic" && env("WEB_SEARCH") !== "0",
    team: name === "anthropic",
  });
  if (forced) return pick(forced);
  if (env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN")) return pick("anthropic");
  if (env("XAI_API_KEY")) return pick("xai");
  if (await ollamaUp()) return pick("ollama");
  return null;
}

/** Single-agent text stream for xAI / Ollama. Anthropic runs the multi-agent team in agents.ts. */
export function soloStream(p: ProviderInfo, history: ChatTurn[], signal: AbortSignal): AsyncGenerator<BotEvent> {
  return p.name === "xai" ? xaiStream(p, history, signal) : ollamaStream(p, history, signal);
}

// === XAI (OpenAI-compatible chat completions, SSE `data:` lines, ends with [DONE]) ===
async function* xaiStream(p: ProviderInfo, history: ChatTurn[], signal: AbortSignal): AsyncGenerator<BotEvent> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${env("XAI_API_KEY")}` },
    body: JSON.stringify({
      model: p.model,
      stream: true,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  for await (const line of lines(res.body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    const text = JSON.parse(data).choices?.[0]?.delta?.content;
    if (text) yield { type: "text", text };
  }
}

// === OLLAMA (/api/chat, NDJSON, final object has done:true) ===
async function* ollamaStream(p: ProviderInfo, history: ChatTurn[], signal: AbortSignal): AsyncGenerator<BotEvent> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: p.model, stream: true, messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history] }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  for await (const line of lines(res.body)) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.error) throw new Error(`Ollama: ${obj.error}`);
    if (obj.message?.content) yield { type: "text", text: obj.message.content };
    if (obj.done) return;
  }
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

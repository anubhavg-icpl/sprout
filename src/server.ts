// Sprout HTTP server — static files + a streaming chat proxy. Zero framework.
//
// Routes:
//   GET  /api/health  -> { provider: {name, model, webSearch} | null }
//   POST /api/chat    -> text/event-stream of agent events (`data: {...}\n\n`, see
//                        src/agents.ts for the vocabulary), always terminated by
//                        `data: {"type":"done"}`.
//   GET  /*           -> files under public/ (path-traversal guarded).
// Trust boundary: the browser is untrusted. Request bodies are size-capped and
// shape-validated, a per-IP token bucket limits /api/chat, and every response
// carries a strict CSP (no inline script/style — see public/index.html).
// Binds 127.0.0.1 by default; set HOST=0.0.0.0 only behind your own auth.
import { join, normalize } from "node:path";
import { resolveProvider, soloStream, type ChatTurn } from "./providers";
import { runOrchestrator } from "./agents";

const PUBLIC = join(import.meta.dir, "..", "public");
const MAX_BODY = 64 * 1024; // bytes
const MAX_TURNS = 40;
const MAX_TURN_CHARS = 8000;
const RATE = { capacity: 10, refillPerSec: 10 / 60 }; // 10 burst, 10/min sustained

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), geolocation=(), microphone=(self)",
};

const buckets = new Map<string, { tokens: number; at: number }>();
function allow(ip: string): boolean {
  const now = Date.now() / 1000;
  const b = buckets.get(ip) ?? { tokens: RATE.capacity, at: now };
  b.tokens = Math.min(RATE.capacity, b.tokens + (now - b.at) * RATE.refillPerSec);
  b.at = now;
  buckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, "content-type": "application/json" } });

/** Validate untrusted history; returns null when malformed. Last turn must be the user's. */
export function parseHistory(body: unknown): ChatTurn[] | null {
  const msgs = (body as any)?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > MAX_TURNS) return null;
  const out: ChatTurn[] = [];
  for (const m of msgs) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.content !== "string") return null;
    const content = m.content.slice(0, MAX_TURN_CHARS);
    if (!content.trim()) continue; // a stopped-empty assistant turn would 400 upstream
    out.push({ role: m.role, content });
  }
  return out.length && out[out.length - 1].role === "user" ? out : null;
}

async function chat(req: Request, ip: string): Promise<Response> {
  if (!allow(ip)) return json({ error: "Slow down — rate limit reached. Try again in a few seconds." }, 429);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return json({ error: "Request too large." }, 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "Request too large." }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON." }, 400); }
  const history = parseHistory(body);
  if (!history) return json({ error: "Invalid conversation payload." }, 400);
  const provider = await resolveProvider();
  if (!provider) return json({ error: "No model provider configured. See README → Configure." }, 503);

  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController, ev: object) => c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
  const upstream = new AbortController();
  req.signal.addEventListener("abort", () => upstream.abort());

  const body$ = new ReadableStream({
    async start(c) {
      const emit = (ev: object) => { try { send(c, ev); } catch { upstream.abort(); } };
      try {
        if (provider.team) await runOrchestrator(history, emit, upstream.signal);
        else {
          emit({ type: "run_started", mode: "solo" });
          for await (const ev of soloStream(provider, history, upstream.signal)) emit({ type: "text_delta", stepId: null, text: ev.text });
          emit({ type: "run_finished" });
        }
      } catch (e: any) {
        if (!upstream.signal.aborted) {
          console.error("[chat]", e?.message ?? e);
          send(c, { type: "error", message: friendlyError(e) });
        }
      }
      try { send(c, { type: "done" }); c.close(); } catch { /* client gone */ }
    },
    cancel() { upstream.abort(); },
  });
  return new Response(body$, {
    headers: { ...SECURITY_HEADERS, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
}

function friendlyError(e: any): string {
  const s = e?.status ?? 0;
  if (s === 401 || s === 403) return "The model provider rejected the API key.";
  if (s === 429) return "The model provider is rate limiting us. Try again shortly.";
  if (s >= 500) return "The model provider is having trouble. Try again.";
  return String(e?.message ?? "Something went wrong.").slice(0, 300);
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
  const path = join(PUBLIC, rel);
  if (!path.startsWith(PUBLIC + "/")) return new Response("Forbidden", { status: 403, headers: SECURITY_HEADERS });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  const cache = rel.startsWith("/assets/") ? "public, max-age=86400" : "no-cache";
  return new Response(file, { headers: { ...SECURITY_HEADERS, "cache-control": cache } });
}

export function startServer(port = Number(process.env.PORT ?? 8787), hostname = process.env.HOST ?? "127.0.0.1") {
  return Bun.serve({
    port,
    hostname,
    idleTimeout: 255, // seconds; Bun's 10s default kills quiet SSE streams while a model thinks
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return json({ provider: await resolveProvider() });
      if (url.pathname === "/api/chat") {
        if (req.method !== "POST") return json({ error: "POST only." }, 405);
        return chat(req, server.requestIP(req)?.address ?? "?");
      }
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed." }, 405);
      return serveStatic(url.pathname);
    },
  });
}

if (import.meta.main) {
  const s = startServer();
  const p = await resolveProvider();
  console.log(`Sprout → http://${s.hostname}:${s.port}  (provider: ${p ? `${p.name}/${p.model}` : "none — see README"})`);
}

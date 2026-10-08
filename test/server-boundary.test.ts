// Trust-boundary tests for src/server.ts, exercised over real HTTP:
// no provider -> 503 (never a fake answer), size cap, payload validation,
// path traversal, and the CSP header on every response.
import { afterAll, expect, test } from "bun:test";
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "XAI_API_KEY", "PROVIDER"]) delete process.env[k];
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // closed port -> no Ollama
const { startServer, parseHistory } = await import("../src/server");
const server = startServer(0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));
const post = (body: string) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body });

test("chat_returns_503_when_no_provider_configured", async () => {
  const r = await post(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
  expect(r.status).toBe(503);
  expect((await fetch(`${base}/api/health`).then((x) => x.json())).provider).toBeNull();
});

test("oversized_body_rejected_413", async () => {
  expect((await post("x".repeat(70 * 1024))).status).toBe(413);
});

test("history_must_end_with_user_and_use_known_roles", () => {
  expect(parseHistory({ messages: [{ role: "system", content: "x" }] })).toBeNull();
  expect(parseHistory({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] })).toBeNull();
  expect(parseHistory({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "" }, { role: "user", content: "c" }] })).toEqual([{ role: "user", content: "a" }, { role: "user", content: "c" }]);
});

test("path_traversal_outside_public_is_forbidden", async () => {
  const r = await fetch(`${base}/..%2fsrc%2fserver.ts`);
  expect([403, 404]).toContain(r.status);
  expect(await r.text()).not.toContain("startServer");
});

test("every_response_carries_csp", async () => {
  const r = await fetch(`${base}/`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
});

// Visual E2E: drives the real UI in Chromium and writes screenshots to
// docs/screenshots/. Run against a live server:
//   PORT=8191 bun src/server.ts &   then   PLAYWRIGHT_PATH=$(npm root -g)/playwright node test/e2e/screens.mjs
// The browser-side /api/health and /api/chat are replaced by page.route() with
// a scripted event sequence that uses the real SSE vocabulary from
// src/agents.ts, so the layout can be checked without an API key. This stub is
// test-only; the product itself never fabricates answers.
import { createRequire } from "node:module";
// Playwright is a global install (not a project dep); ESM ignores NODE_PATH, so resolve via require.
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? "playwright");
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8191";
const OUT = new URL("../../docs/screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const sse = (evs) => evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const REPLY = "Here's what the team found:\n\n### Highlights\n- **Researcher** pulled three fresh sources.\n- **Coder** verified the numbers in a sandbox.\n\n```python\nprint(sum(range(10)))  # 45\n```\n\n| Item | Status |\n|---|---|\n| Research | done |\n| Code | done |\n\nWant me to go deeper on any of these?";
const SCRIPT = [
  { type: "run_started", runId: "run_demo", mode: "team" },
  { type: "plan", steps: [{ title: "Research recent sources", status: "done" }, { title: "Verify with code", status: "done" }, { title: "Synthesise answer", status: "active" }] },
  { type: "step_started", stepId: "s1", agent: "researcher", label: "Researcher", task: "Find the three most important AI announcements this week with sources." },
  { type: "tool_call", stepId: "s1", name: "web_search", detail: "AI announcements this week" },
  { type: "sources", stepId: "s1", items: [{ title: "Example News", url: "https://example.com/a" }, { title: "Docs", url: "https://docs.example.org/b" }] },
  { type: "text_delta", stepId: "s1", text: "- Finding one\n- Finding two" },
  { type: "step_finished", stepId: "s1", status: "ok" },
  { type: "step_started", stepId: "s2", agent: "coder", label: "Coder", task: "Verify the summary statistics." },
  { type: "tool_call", stepId: "s2", name: "code_execution", detail: "running code" },
  { type: "step_finished", stepId: "s2", status: "ok" },
  ...REPLY.match(/[\s\S]{1,24}/g).map((text) => ({ type: "text_delta", stepId: null, text })),
  { type: "run_finished", runId: "run_demo", delegations: 2 },
  { type: "done" },
];

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
async function shoot(name, { width, height, theme, live = true, stage }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  if (live) {
    await page.route("**/api/health", (r) => r.fulfill({ json: { provider: { name: "anthropic", model: "claude-opus-5-5", webSearch: true, team: true } } }));
    await page.route("**/api/chat", async (r) => {
      // Hold the stream open for "mid-run" shots by serving only part of the script.
      const evs = stage === "mid" ? SCRIPT.slice(0, 9) : SCRIPT;
      await r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse(evs) });
    });
  }
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  if (stage) {
    await page.click(".chip >> nth=0");
    await page.waitForTimeout(stage === "mid" ? 900 : 1600);
  }
  await page.screenshot({ path: `${OUT}${name}.png` });
  const state = await page.textContent("#state-name");
  await ctx.close();
  return state;
}

const results = {
  "desktop-empty-dark": await shoot("desktop-empty-dark", { width: 1440, height: 900, theme: "dark" }),
  "desktop-run-dark": await shoot("desktop-run-dark", { width: 1440, height: 900, theme: "dark", stage: "done" }),
  "desktop-run-light": await shoot("desktop-run-light", { width: 1440, height: 900, theme: "light", stage: "done" }),
  "mobile-run-dark": await shoot("mobile-run-dark", { width: 390, height: 844, theme: "dark", stage: "done" }),
  "desktop-no-provider": await shoot("desktop-no-provider", { width: 1280, height: 800, theme: "dark", live: false }),
};
await browser.close();
console.log(JSON.stringify({ avatarStateAtShot: results, consoleErrors: errors }, null, 2));
process.exit(errors.length ? 1 : 0);

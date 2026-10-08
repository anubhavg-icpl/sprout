# Sprout

Animated 2D avatar fronting a Claude-powered **lead agent that delegates to specialist
sub-agents** (Researcher, Coder, Writer, Planner). Bun server + vanilla JS, one runtime
dependency (`@anthropic-ai/sdk`, pinned). Grew out of `prototype/human-v0.1.html`.

## Commands

| Task | Command |
|---|---|
| Install | `bun install` (lifecycle scripts disabled via `bunfig.toml`) |
| Run | `bun run start` → http://127.0.0.1:8787 |
| Dev (watch) | `bun run dev` |
| **Gate** | `bun run check` (bundle-compiles server + `bun test`) |
| Visual E2E | server on 8191, then `CHROME_PATH=<chromium> PLAYWRIGHT_PATH=$(npm root -g)/playwright node test/e2e/screens.mjs` → `docs/screenshots/` |

## Map

| Path | Owns |
|---|---|
| `src/agents.ts` | Orchestrator loop, specialist configs, guard-rail caps, **SSE event vocabulary** |
| `src/providers.ts` | Provider resolution (env only) + solo-mode xAI/Ollama adapters |
| `src/server.ts` | Static files, `/api/health`, `/api/chat`, CSP, rate limit, body caps |
| `public/js/app.js` | Event → transcript / timeline / avatar mood mapping, voice, persistence |
| `public/js/rig.js` | Canvas skeletal rig; states + pose channels |
| `public/js/markdown.js` | XSS-safe Markdown → DOM |
| `public/assets/` | Vendored Lucide icons, Inter/JetBrains Mono, Kenney sounds — licenses in `assets/licenses/` |

## Conventions

- Avatar state is driven only by lifecycle events in `app.js` (`mood()`); the rig never picks its own state.
- New SSE event types: add the emitter in `src/agents.ts`, the `case` in `app.js run()`, and list it in both contract blocks.
- New icons: copy the SVG from Lucide tag `0.544.0` into `public/assets/icons/` and add one `.ic-<name>` rule.
- Commits: Conventional Commits.

## Landmines

- **No inline script/style anywhere** — CSP is `script-src 'self'; style-src 'self'`. Inline code silently does nothing.
- **Never `innerHTML` model output.** `markdown.js` builds text nodes; `test/markdown-xss.test.ts` guards it.
- **Anthropic history is append-only.** `agents.ts` pushes assistant `content` back unchanged (Opus 5.5 binds thinking blocks); all tool_results for a turn go in one user message.
- **Opus 5.5 rejects** `thinking: disabled`, `budget_tokens`, and forced `tool_choice` — don't add them.
- **Rig pose channels**: a new channel must be added to both `KEYS` and `BASE` or blending silently skips it.
- **Bun `idleTimeout: 255`** in `server.ts` keeps quiet SSE streams alive while the model thinks; the 10 s default kills them.
- In this dev shell `curl` is aliased to `curlie` (different flags) — use `/usr/bin/curl` for scripted checks.
- `docs/screenshots/` are captured from the E2E run; regenerate, don't hand-edit.

// Invariant gate (run by `bun run check`). Turns two AGENTS.md landmines into
// a mechanical check so prose rules can't rot:
//   1. CSP: no inline <script> bodies, inline event handlers or style="" in public/*.html
//      (server CSP is script-src/style-src 'self' — inline code silently dies).
//   2. XSS: no innerHTML/outerHTML/insertAdjacentHTML/document.write in public/js
//      (model output must reach the DOM as text nodes; see markdown.js).
// Exit 1 with file:line on any violation.
import { Glob } from "bun";

const rules: [string, RegExp, string][] = [
  ["public/**/*.html", /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i, "inline <script> body (CSP blocks it)"],
  ["public/**/*.html", /\son[a-z]+\s*=/i, "inline event handler attribute (CSP blocks it)"],
  ["public/**/*.html", /\sstyle\s*=/i, "style= attribute (CSP blocks it)"],
  ["public/js/**/*.js", /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, "raw HTML sink (XSS risk) — build text nodes"],
];
let bad = 0;
for (const [pattern, re, why] of rules) {
  for await (const file of new Glob(pattern).scan(".")) {
    (await Bun.file(file).text()).split("\n").forEach((line, i) => {
      if (re.test(line)) { console.error(`${file}:${i + 1}: ${why}`); bad++; }
    });
  }
}
if (bad) process.exit(1);

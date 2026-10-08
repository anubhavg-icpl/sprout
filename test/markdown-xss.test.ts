// Guards public/js/markdown.js's security invariant: untrusted model output can
// never create markup or executable links. Uses a tiny fake DOM (renderMarkdown
// takes `doc` as a parameter) so no DOM library is needed.
import { expect, test } from "bun:test";
import { renderMarkdown } from "../public/js/markdown.js";

type N = { tag: string; text?: string; children: N[]; [k: string]: any };
const node = (tag: string, text?: string): N => {
  const n: N = { tag, text, children: [], append: (...c: N[]) => n.children.push(...c), setAttribute: (k: string, v: string) => (n[k] = v) };
  Object.defineProperty(n, "textContent", { set: (v) => (n.text = v), get: () => n.text });
  return n;
};
const doc = { createElement: (t: string) => node(t), createTextNode: (t: string) => node("#text", t), createDocumentFragment: () => node("#frag") } as any;
const walk = (n: N, out: N[] = []) => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };
const render = (src: string) => walk(renderMarkdown(src, doc));

test("raw html in model output stays text, never becomes an element", () => {
  const nodes = render('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
  expect(nodes.some((n) => n.tag === "img" || n.tag === "script")).toBe(false);
  expect(nodes.filter((n) => n.tag === "#text").map((n) => n.text).join("")).toContain("<script>");
});

test("javascript: and data: links are dropped to plain text", () => {
  const nodes = render("[click](javascript:alert(1)) [x](data:text/html,hi) [ok](https://example.com)");
  const links = nodes.filter((n) => n.tag === "a");
  expect(links.map((a) => a.href)).toEqual(["https://example.com"]);
  expect(links[0].rel).toBe("noopener noreferrer");
});

test("unterminated code fence while streaming renders as an open code block", () => {
  const nodes = render("intro\n```js\nconst a = 1;");
  expect(nodes.find((n) => n.tag === "code")?.text).toBe("const a = 1;");
});

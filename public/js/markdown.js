// Minimal, XSS-safe Markdown -> DOM renderer for model output.
//
// Security invariant: model output is untrusted. This module NEVER assigns
// innerHTML; every string reaches the DOM through createTextNode/textContent,
// and links are restricted to http(s)/mailto with rel=noopener. test/markdown
// asserts this, keep it that way when adding syntax.
// Supported: fenced code (```lang), inline code, **bold**, *italic*, ~~strike~~,
// [links](url), bare URLs, headings, ul/ol lists, blockquotes, tables, hr.
// Streaming-friendly: an unterminated ``` fence renders as an open code block.

const SAFE_URL = /^(https?:|mailto:)/i;

/** @param {Document} doc @param {string} src @returns {DocumentFragment} */
export function renderMarkdown(src, doc = document) {
  const frag = doc.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const el = (tag, cls) => { const n = doc.createElement(tag); if (cls) n.className = cls; return n; };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // skip closing fence (or run past end while streaming)
      const wrap = el("div", "code");
      const bar = el("div", "code-bar");
      const lang = el("span"); lang.textContent = fence[1] || "text";
      const copy = el("button", "copy-code"); copy.type = "button"; copy.textContent = "Copy"; copy.setAttribute("aria-label", "Copy code");
      bar.append(lang, copy);
      const pre = el("pre"), c = el("code");
      c.textContent = code.join("\n");
      pre.append(c); wrap.append(bar, pre); frag.append(wrap);
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { const n = el("h" + Math.min(6, h[1].length + 2)); inline(n, h[2], doc); frag.append(n); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { frag.append(el("hr")); i++; continue; }
    if (/^\s*>/.test(line)) {
      const q = el("blockquote"), buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      q.append(renderMarkdown(buf.join("\n"), doc)); frag.append(q); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
      const table = el("table"), cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
      const thead = el("thead"), tr = el("tr");
      for (const c of cells(line)) { const th = el("th"); inline(th, c, doc); tr.append(th); }
      thead.append(tr); table.append(thead); i += 2;
      const tbody = el("tbody");
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const r = el("tr"); for (const c of cells(lines[i++])) { const td = el("td"); inline(td, c, doc); r.append(td); } tbody.append(r); }
      table.append(tbody); const scroll = el("div", "table-wrap"); scroll.append(table); frag.append(scroll); continue;
    }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (li) {
      const ordered = /\d/.test(li[1]), list = el(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const item = el("li"); inline(item, lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""), doc); list.append(item);
      }
      frag.append(list); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]); // defensive: never loop forever
    const p = el("p"); inline(p, para.join("\n"), doc); frag.append(p);
  }
  return frag;
}

// Inline grammar, first match wins at each position.
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\n)/g;

function inline(parent, text, doc) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parent.append(doc.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (m[1]) { const c = doc.createElement("code"); c.textContent = t.slice(1, -1); parent.append(c); }
    else if (m[2]) { const b = doc.createElement("strong"); inline(b, t.slice(2, -2), doc); parent.append(b); }
    else if (m[3]) { const s = doc.createElement("del"); inline(s, t.slice(2, -2), doc); parent.append(s); }
    else if (m[4]) { const e = doc.createElement("em"); inline(e, t.slice(1, -1), doc); parent.append(e); }
    else if (m[5]) { const [, label, url] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/); parent.append(link(label, url, doc)); }
    else if (m[6]) parent.append(link(t, t, doc));
    else if (m[7]) parent.append(doc.createElement("br"));
    last = m.index + t.length;
  }
  if (last < text.length) parent.append(doc.createTextNode(text.slice(last)));
}

function link(label, url, doc) {
  if (!SAFE_URL.test(url)) return doc.createTextNode(label);
  const a = doc.createElement("a");
  a.href = url; a.textContent = label; a.target = "_blank"; a.rel = "noopener noreferrer";
  return a;
}

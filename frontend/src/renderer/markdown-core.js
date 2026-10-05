"use strict";

// Parses markdown into a simple tree of blocks. No DOM and no backend, so
// every rule is tested without a window. The tree then becomes page nodes
// only through textContent — the agent's text never becomes
// page markup.
//
// It supports what agents write their answers with: headings, paragraphs, lists, tables,
// code blocks, quotes, horizontal rules; inline — code, bold, italic, link. Anything that
// is not recognized stays plain text.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module !== null && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis === "undefined" ? this : globalThis, function () {
  // Code, **bold**, __bold__, *italic*, [text](url). Underscore as
  // italic is not parsed: it occurs more often in paths and file names.
  const INLINE = /(`+)([\s\S]+?)\1|\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|\*(?=[^\s*])([^*\n]+?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

  function parseInline(source) {
    const text = String(source ?? "");
    const out = [];
    let last = 0;
    const plain = (value) => {
      if (value !== "") out.push({ kind: "text", text: value });
    };
    for (const match of text.matchAll(INLINE)) {
      plain(text.slice(last, match.index));
      if (match[1] !== undefined) out.push({ kind: "code", text: match[2].replace(/^ (.*) $/s, "$1") });
      else if (match[3] !== undefined) out.push({ kind: "strong", children: parseInline(match[3]) });
      else if (match[4] !== undefined) out.push({ kind: "strong", children: parseInline(match[4]) });
      else if (match[5] !== undefined) out.push({ kind: "em", children: parseInline(match[5]) });
      else out.push({ kind: "link", href: match[7], children: parseInline(match[6]) });
      last = match.index + match[0].length;
    }
    plain(text.slice(last));
    return out;
  }

  const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const QUOTE = /^\s{0,3}>\s?/;
  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isTableRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/)
    .map((cell) => parseInline(cell.trim().replace(/\\\|/g, "|")));

  function parseMarkdown(source) {
    const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    const startsBlock = (index) => {
      const line = lines[index];
      return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST.test(line) || QUOTE.test(line)
        || (isTableRow(line) && index + 1 < lines.length && isTableRule(lines[index + 1]));
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        i += 1;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence !== null) {
        const body = [];
        i += 1;
        // A code block without a closing fence (the answer is still being written) runs to the end.
        while (i < lines.length && !(lines[i].trim().startsWith(fence[1]) && /^\s*[`~]+\s*$/.test(lines[i]))) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        blocks.push({ kind: "code", language: fence[2], text: body.join("\n") });
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading !== null) {
        blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
        i += 1;
        continue;
      }
      if (RULE.test(line)) {
        blocks.push({ kind: "rule" });
        i += 1;
        continue;
      }
      if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
        const head = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && isTableRow(lines[i])) {
          rows.push(cells(lines[i]));
          i += 1;
        }
        blocks.push({ kind: "table", head, rows });
        continue;
      }
      if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          inner.push(lines[i].replace(QUOTE, ""));
          i += 1;
        }
        blocks.push({ kind: "quote", blocks: parseMarkdown(inner.join("\n")) });
        continue;
      }
      if (LIST.test(line)) {
        const items = [];
        while (i < lines.length) {
          const item = LIST.exec(lines[i]);
          if (item !== null) {
            const numbered = /\d/.test(item[2]);
            items.push({
              depth: Math.min(3, Math.floor(item[1].replace(/\t/g, "  ").length / 2)),
              marker: numbered ? item[2].replace(")", ".") : "•", text: item[3],
            });
          } else if (lines[i].trim() !== "" && /^\s+/.test(lines[i])) {
            // An indented line continues the previous item.
            items[items.length - 1].text += `\n${lines[i].trim()}`;
          } else {
            break;
          }
          i += 1;
        }
        blocks.push({ kind: "list", items: items.map(({ text, ...item }) => ({ ...item, inline: parseInline(text) })) });
        continue;
      }
      const paragraph = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "" && !startsBlock(i)) {
        paragraph.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
    }
    return blocks;
  }

  /** The first meaningful line without markup, for the collapsed action line. */
  function firstPlainLine(source) {
    const flat = (tokens) => tokens.map((token) => (token.kind === "text" || token.kind === "code" ? token.text : flat(token.children))).join("");
    for (const block of parseMarkdown(source)) {
      if (block.kind === "paragraph" || block.kind === "heading") return flat(block.inline).split("\n")[0];
      if (block.kind === "list") return flat(block.items[0].inline).split("\n")[0];
      if (block.kind === "code") return block.text.split("\n")[0];
    }
    return "";
  }

  return { parseMarkdown, parseInline, firstPlainLine };
}));

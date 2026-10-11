// WSK-45 (owner ruling WSK-D49) — the Markdown <-> ProseMirror codec behind the visual editor for `markdown` fields.
//
// THE OBLIGATION. A body that the user did not change must save BYTE-IDENTICAL. Otherwise every save is a spurious
// version and the page-for-page parity gate of a migrated site breaks. Two rules keep it:
//   1. The editor never re-serialises an unchanged document (MarkdownField / WysiwygEditor compare ProseMirror docs and
//      emit the ORIGINAL string when they are equal). That alone covers every untouched field.
//   2. A field opens visually ONLY if `roundTrips(text)` — parse then serialise gives back exactly the same bytes. If it
//      does not, the field opens as source (the Markdown textarea) and says why. The goal of this file is to make that
//      test pass for as much real content as possible by CONFIGURING the parser and serialiser (line endings, marker
//      styles, table layout, blank-line runs, raw HTML kept verbatim …). Content is never altered to force a match.
//
// WHAT THIS FILE IS. Pure: no React, no DOM. `markdownExtensions` is the TipTap schema (the editor uses the same list),
// `parseMarkdown` builds a ProseMirror doc from markdown-it tokens, `serializeDoc` writes a doc back. It is also loaded
// directly by `scripts/check-markdown-roundtrip.mjs` under Node's native TypeScript stripping, so it must stay "erasable"
// TypeScript (no enums / namespaces / parameter properties) and import ONLY packages — never `@/…` or a relative path.
// It must also stay out of anything `platform-nest` tests import (nothing in `src/lib/webdeskContent*.ts` pulls it).
//
// PLACEHOLDERS. A body can carry lint placeholders (`{{token}}`, `[CONFIRM: …]`, declared by the composition). They are
// ordinary text to Markdown, and this serialiser writes text verbatim by default. When an edit makes raw text re-parse
// differently (the user typed a literal `*`), the affected BLOCK is re-written in "safe" mode, which backslash-escapes
// specials but copies every placeholder span through untouched. A placeholder is never escaped, never re-spelled.

import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItInstance, Token } from "markdown-it";
import { Extension, Mark as TipTapMark, Node as TipTapNode, getSchema } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
import { Mark } from "@tiptap/pm/model";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { Code } from "@tiptap/extension-code";
import { Link } from "@tiptap/extension-link";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";

// ── The schema ────────────────────────────────────────────────────────────────────────────────────────────────────

const BLOCK_TYPES = ["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule", "htmlBlock", "table"];

/** `gap`: how many BLANK lines sat before this top-level block in the source (1 is the usual "\n\n"). Kept so a body that
 *  used no blank line, or two, still round-trips. `tight`: a list without blank lines between its items. */
const MarkdownLayout = Extension.create({
  name: "mdLayout",
  addGlobalAttributes() {
    return [
      { types: BLOCK_TYPES, attributes: { gap: { default: 1, rendered: false, keepOnSplit: false } } },
      { types: ["bulletList", "orderedList"], attributes: { tight: { default: true, rendered: false, keepOnSplit: false } } },
    ];
  },
});

/** A block of raw HTML. Markdown carries HTML through verbatim; so does this editor — shown as a chip, edited in source. */
const HtmlBlock = TipTapNode.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() { return { raw: { default: "" } }; },
  parseHTML() { return [{ tag: "div[data-md-html-block]" }]; },
  renderHTML({ node }) {
    return ["div", { "data-md-html-block": "", class: "wc-md-html", title: "Raw HTML. It is kept exactly as written; edit it in the Source tab." }, ["code", {}, String(node.attrs.raw)]];
  },
});

const HtmlInline = TipTapNode.create({
  name: "htmlInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { raw: { default: "" } }; },
  parseHTML() { return [{ tag: "span[data-md-html-inline]" }]; },
  renderHTML({ node }) {
    return ["span", { "data-md-html-inline": "", class: "wc-md-htmlinline", title: "Raw HTML. Edit it in the Source tab." }, String(node.attrs.raw)];
  },
});

/** A line break inside a paragraph (a newline in the source that does not start a new paragraph). */
const SoftBreak = TipTapNode.create({
  name: "softBreak",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  parseHTML() { return [{ tag: "span[data-md-softbreak]" }]; },
  renderHTML() { return ["span", { "data-md-softbreak": "", class: "wc-md-softbreak" }, " "]; },
});

/** An image. Rendered as a label, never as an <img>: the editor must not fetch whatever URL a document names. */
const MdImage = TipTapNode.create({
  name: "mdImage",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { src: { default: "" }, alt: { default: "" }, title: { default: null } }; },
  parseHTML() { return [{ tag: "span[data-md-image]" }]; },
  renderHTML({ node }) {
    return ["span", { "data-md-image": "", class: "wc-md-image", title: String(node.attrs.src) }, `Image: ${String(node.attrs.alt) || "(no alt text)"}`];
  },
});

/** Ranked so that, when two marks cover exactly the same text, bold/italic/strike sit OUTSIDE a link and a link sits
 *  outside code: `**[a](u)**` (the way the corpus is written), not `[**a**](u)`. Longer spans always win over rank. */
const MdLink = Link.extend({
  priority: 50,
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return { ...parent, title: { default: null } };
  },
}).configure({ openOnClick: false, autolink: false, linkOnPaste: false, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } });

/** TipTap's `code` excludes every other mark; Markdown does not (`**`x`**`). Rank last: innermost. */
const MdCode = Code.extend({ excludes: "", priority: 10 });

const ALIGNS = ["left", "right", "center"];
const alignAttr = { align: { default: null, rendered: false, parseHTML: (el: HTMLElement) => (ALIGNS.includes(el.style.textAlign) ? el.style.textAlign : null) } };
/** A markdown table cell holds ONE line of inline content. */
const MdCell = TableCell.extend({ content: "paragraph", addAttributes() { return { ...(this.parent?.() ?? {}), ...alignAttr }; } });
const MdHeader = TableHeader.extend({ content: "paragraph", addAttributes() { return { ...(this.parent?.() ?? {}), ...alignAttr }; } });

export const markdownExtensions: Extensions = [
  StarterKit.configure({ link: false, underline: false, code: false, trailingNode: false }),
  MdCode,
  MdLink,
  Table.configure({ resizable: false }),
  TableRow,
  MdHeader,
  MdCell,
  HtmlBlock,
  HtmlInline,
  SoftBreak,
  MdImage,
  MarkdownLayout,
];

let schemaCache: Schema | null = null;
export function markdownSchema(): Schema {
  if (!schemaCache) schemaCache = getSchema(markdownExtensions);
  return schemaCache;
}

// ── Placeholders ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface PlaceholderSyntax { open: string; close: string }

/** Reads `composition.lint.placeholders` (declared per collection): every entry with a string `open` and `close`. */
export function placeholderSyntaxes(raw: unknown): PlaceholderSyntax[] {
  if (!Array.isArray(raw)) return [];
  const out: PlaceholderSyntax[] = [];
  for (const p of raw) {
    if (typeof p !== "object" || p === null) continue;
    const o = p as Record<string, unknown>;
    if (typeof o.open === "string" && o.open !== "" && typeof o.close === "string" && o.close !== "") out.push({ open: o.open, close: o.close });
  }
  return out;
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function placeholderRegex(ph: PlaceholderSyntax[]): RegExp | null {
  if (ph.length === 0) return null;
  return new RegExp(ph.map((p) => `${escRe(p.open)}[^\\n]*?${escRe(p.close)}`).join("|"), "g");
}

// ── The envelope: what lives OUTSIDE the block tree ──────────────────────────────────────────────────────────────

export interface Envelope {
  /** The line ending the text uses throughout. */
  eol: "\n" | "\r\n";
  /** Blank lines before the first block, and the newline run after the last. Kept verbatim. */
  lead: string;
  tail: string;
}

export interface Parsed { doc: PMNode; env: Envelope }

/** A reason a text cannot be held by the visual editor at all (before any serialising is tried). */
export class Unrepresentable extends Error {
  construct: string;
  /** The underlying error text (a ProseMirror RangeError names the node that did not fit). No document content. */
  detail: string;
  constructor(construct: string, detail = "") { super(construct); this.construct = construct; this.detail = detail; }
}

function splitEnvelope(text: string): { body: string; env: Envelope } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  const bareCr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (bareCr > 0) throw new Unrepresentable("line-endings:bare-CR");
  if (crlf > 0 && lfOnly > 0) throw new Unrepresentable("line-endings:mixed");
  const eol: "\n" | "\r\n" = crlf > 0 ? "\r\n" : "\n";
  const lf = eol === "\r\n" ? text.replace(/\r\n/g, "\n") : text;
  const lead = /^\n*/.exec(lf)?.[0] ?? "";
  const rest = lf.slice(lead.length);
  const tail = /\n*$/.exec(rest)?.[0] ?? "";
  return { body: rest.slice(0, rest.length - tail.length), env: { eol, lead, tail } };
}

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────────────────────────

let mdCache: MarkdownItInstance | null = null;
function md(): MarkdownItInstance {
  if (!mdCache) {
    const m = new MarkdownIt("commonmark", { html: true, linkify: false, typographer: false });
    m.enable(["table", "strikethrough"]);
    // Keep link destinations as written (no percent-encoding, no scheme filtering here): the serialiser writes them back
    // as they came, and the editor's Link mark refuses to RENDER an unsafe scheme.
    m.normalizeLink = (u: string) => u;
    m.normalizeLinkText = (u: string) => u;
    m.validateLink = () => true;
    mdCache = m;
  }
  return mdCache;
}

function alignOf(t: Token): string | null {
  const style = String(t.attrGet("style") ?? "");
  const m = /text-align:\s*(left|right|center)/.exec(style);
  return m ? m[1] : null;
}

function inlineNodes(children: Token[], schema: Schema): PMNode[] {
  const out: PMNode[] = [];
  const active: Mark[] = [];
  const marks = (): readonly Mark[] => Mark.setFrom(active);
  const text = (s: string) => { if (s !== "") out.push(schema.text(s, marks())); };
  for (const t of children) {
    switch (t.type) {
      case "text":
      case "text_special":
        text(t.content); break;
      case "softbreak": out.push(schema.nodes.softBreak.create(null, null, marks())); break;
      case "hardbreak": out.push(schema.nodes.hardBreak.create(null, null, marks())); break;
      case "code_inline": out.push(schema.text(t.content, Mark.setFrom([...active, schema.marks.code.create()]))); break;
      case "em_open": active.push(schema.marks.italic.create()); break;
      case "strong_open": active.push(schema.marks.bold.create()); break;
      case "s_open": active.push(schema.marks.strike.create()); break;
      case "link_open": active.push(schema.marks.link.create({ href: t.attrGet("href") ?? "", title: t.attrGet("title") })); break;
      case "em_close": case "strong_close": case "s_close": case "link_close": {
        const name = t.type === "em_close" ? "italic" : t.type === "strong_close" ? "bold" : t.type === "s_close" ? "strike" : "link";
        const at = active.map((m) => m.type.name).lastIndexOf(name);
        if (at >= 0) active.splice(at, 1);
        break;
      }
      case "image": {
        const alt = (t.children ?? []).map((c) => c.content).join("");
        out.push(schema.nodes.mdImage.create({ src: t.attrGet("src") ?? "", alt, title: t.attrGet("title") }, null, marks()));
        break;
      }
      case "html_inline": out.push(schema.nodes.htmlInline.create({ raw: t.content }, null, marks())); break;
      default: throw new Unrepresentable(`inline:${t.type}`);
    }
  }
  return out;
}

interface Frame { token: Token | null; kids: PMNode[]; gap?: number }

/** Builds the document. Throws `Unrepresentable` for a construct the schema cannot hold. */
function buildDoc(body: string, schema: Schema): PMNode {
  const tokens = md().parse(body, {});
  const stack: Frame[] = [{ token: null, kids: [] }];
  const top = () => stack[stack.length - 1];
  const lines = body.split("\n");
  let firstTop = true;

  // Blank lines between this block and the one before it: counted backwards from the block's first line (a list's own
  // end line swallows trailing blanks in markdown-it, so the previous block's `map` cannot be trusted for this).
  const topGap = (t: Token): number => {
    if (!t.map) return 1;
    let gap = 0;
    if (firstTop) { firstTop = false; return 1; }
    for (let k = t.map[0] - 1; k >= 0 && lines[k].trim() === ""; k--) gap++;
    return gap;
  };
  const leafGap = (t: Token): number => (stack.length === 1 ? topGap(t) : 1);
  const push = (n: PMNode) => top().kids.push(n);
  const mk = (name: string, attrs: Record<string, unknown> | null, kids: PMNode[]) => schema.nodes[name].createChecked(attrs, kids);

  for (const t of tokens) {
    const atTop = stack.length === 1 && t.level === 0;
    switch (t.type) {
      case "paragraph_open": case "heading_open": case "blockquote_open": case "bullet_list_open": case "ordered_list_open":
      case "list_item_open": case "table_open": case "thead_open": case "tbody_open": case "tr_open": case "th_open": case "td_open":
        stack.push({ token: t, kids: [], gap: atTop ? topGap(t) : undefined });
        break;
      case "inline": {
        const f = top();
        const nodes = inlineNodes(t.children ?? [], schema);
        if (f.token?.type === "th_open" || f.token?.type === "td_open") f.kids.push(mk("paragraph", null, nodes));
        else f.kids.push(...nodes);
        break;
      }
      case "paragraph_close": case "heading_close": case "blockquote_close": case "bullet_list_close": case "ordered_list_close":
      case "list_item_close": case "table_close": case "thead_close": case "tbody_close": case "tr_close": case "th_close": case "td_close": {
        const f = stack.pop() as Frame;
        const o = f.token as Token;
        const g = f.gap === undefined ? {} : { gap: f.gap };
        switch (o.type) {
          case "paragraph_open": push(mk("paragraph", g, f.kids)); break;
          case "heading_open": {
            if (o.markup !== "#".repeat(o.markup.length)) throw new Unrepresentable("heading:setext");
            push(mk("heading", { ...g, level: Number(o.tag.slice(1)) }, f.kids)); break;
          }
          case "blockquote_open": push(mk("blockquote", g, f.kids.length ? f.kids : [mk("paragraph", null, [])])); break;
          case "bullet_list_open": case "ordered_list_open": {
            const items = f.kids;
            // markdown-it hides the paragraphs of a tight list; one visible paragraph makes the list loose.
            let tight = true;
            for (let i = tokens.indexOf(o) + 1; i < tokens.length; i++) {
              const x = tokens[i];
              if (x === undefined || (x.type === o.type.replace("_open", "_close") && x.level === o.level)) break;
              if (x.type === "paragraph_open" && x.level === o.level + 2) { tight = x.hidden; break; }
            }
            if (o.type === "bullet_list_open") push(mk("bulletList", { ...g, tight }, items));
            else push(mk("orderedList", { ...g, tight, start: Number(o.attrGet("start") ?? 1) }, items));
            break;
          }
          case "list_item_open": push(mk("listItem", null, f.kids.length ? f.kids : [mk("paragraph", null, [])])); break;
          case "table_open": {
            const rows = f.kids; // header row(s) then body rows (thead/tbody frames flatten into this list)
            const width = Math.max(1, ...rows.map((r) => r.childCount));
            const padded = rows.map((r, ri) => {
              if (r.childCount === width) return r;
              const cells: PMNode[] = [];
              r.forEach((c) => cells.push(c));
              while (cells.length < width) cells.push(mk(ri === 0 ? "tableHeader" : "tableCell", null, [mk("paragraph", null, [])]));
              return mk("tableRow", null, cells);
            });
            push(mk("table", g, padded));
            break;
          }
          case "thead_open": case "tbody_open": top().kids.push(...f.kids); break;
          case "tr_open": push(mk("tableRow", null, f.kids)); break;
          case "th_open": push(mk("tableHeader", { align: alignOf(o) }, f.kids)); break;
          case "td_open": push(mk("tableCell", { align: alignOf(o) }, f.kids)); break;
        }
        break;
      }
      case "fence": {
        if (t.markup !== "`".repeat(t.markup.length)) throw new Unrepresentable("code:tilde-fence");
        const content = t.content.endsWith("\n") ? t.content.slice(0, -1) : t.content;
        push(mk("codeBlock", { gap: leafGap(t), language: t.info.trim() || null }, content === "" ? [] : [schema.text(content)]));
        break;
      }
      case "code_block": throw new Unrepresentable("code:indented");
      case "hr": {
        if (t.markup !== "---") throw new Unrepresentable("rule:style");
        push(mk("horizontalRule", { gap: leafGap(t) }, []));
        break;
      }
      case "html_block": {
        const raw = t.content.endsWith("\n") ? t.content.slice(0, -1) : t.content;
        push(mk("htmlBlock", { gap: leafGap(t), raw }, []));
        break;
      }
      default: throw new Unrepresentable(`block:${t.type}`);
    }
  }
  const kids = stack[0].kids;
  return schema.nodes.doc.createChecked(null, kids.length ? kids : [mk("paragraph", null, [])]);
}

export function parseMarkdown(text: string): Parsed {
  const { body, env } = splitEnvelope(text);
  try {
    const doc = buildDoc(body, markdownSchema());
    return { doc, env };
  } catch (e) {
    if (e instanceof Unrepresentable) throw e;
    // A ProseMirror RangeError: the schema cannot hold what the parser found (a list item that starts with a heading …).
    throw new Unrepresentable("structure:not-representable", e instanceof Error ? e.message.slice(0, 120) : "");
  }
}

// ── Serialising ───────────────────────────────────────────────────────────────────────────────────────────────────

type Mode = "raw" | "safe";

/** A character range [from, to) of one text node. */
type Span = [number, number];

/** Backslash-escapes what Markdown would act on, EXCEPT the `keep` ranges (placeholders), which are copied through untouched. */
function escapeText(s: string, atLineStart: boolean, keep: Span[]): string {
  const esc = (part: string, start: boolean): string => {
    let o = part.replace(/([\\`*_[\]<~|])/g, "\\$1").replace(/&(?=#?\w+;)/g, "\\&");
    if (start) o = o.replace(/^(\s*)([-+=#>])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2");
    return o;
  };
  let out = "";
  let at = 0;
  for (const [from, to] of keep) {
    out += esc(s.slice(at, from), atLineStart && at === 0) + s.slice(from, to);
    at = to;
  }
  return out + esc(s.slice(at), atLineStart && at === 0);
}

interface Ctx { mode: Mode; ph: RegExp | null; inCell: boolean }

function codeDelimiter(text: string): { open: string; close: string } {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return { open: fence + pad, close: pad + fence };
}

function linkClose(href: string, title: string | null): string {
  const dest = /[\s()<>]/.test(href) || href === "" ? `<${href}>` : href;
  return `](${dest}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
}

/** Splits leading/trailing whitespace of a marked run off, so a delimiter never sits next to a space (it would stop being one). */
function normaliseEdges(kids: PMNode[], schema: Schema): PMNode[] {
  const out: PMNode[] = [];
  const shared = (a: readonly Mark[], b: readonly Mark[] | undefined): readonly Mark[] => (b ? a.filter((m) => m.isInSet(b)) : []);
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (!n.isText || n.marks.length === 0 || n.marks.some((m) => m.type.name === "code")) { out.push(n); continue; }
    const s = n.text as string;
    const lead = /^\s*/.exec(s)?.[0] ?? "";
    const trail = lead.length === s.length ? "" : (/\s*$/.exec(s)?.[0] ?? "");
    if (!lead && !trail) { out.push(n); continue; }
    const core = s.slice(lead.length, s.length - trail.length);
    if (lead) out.push(schema.text(lead, shared(n.marks, kids[i - 1]?.marks)));
    if (core) out.push(schema.text(core, n.marks));
    if (trail) out.push(schema.text(trail, shared(n.marks, kids[i + 1]?.marks)));
  }
  return out;
}

interface Open { mark: Mark; close: string }

/** `starts` (raw mode only) receives, per node, where its text begins in the output: the safe mode uses it to find placeholders
 *  that straddle formatting (`[CONFIRM: pick *one* of …]`) in the RAW text and keep them as they are. */
function inlineToMd(parent: PMNode, ctx: Ctx, starts?: number[]): string {
  const kids: PMNode[] = [];
  parent.forEach((c) => kids.push(c));
  // The document may belong to the EDITOR's schema (TipTap builds its own); nodes made here must come from the same one.
  const nodes = normaliseEdges(kids, parent.type.schema);
  let out = "";
  let lineStart = true;
  const stack: Open[] = [];

  let keep: Span[][] = [];
  if (ctx.mode === "safe" && ctx.ph) {
    const rawStarts: number[] = [];
    const raw = inlineToMd(parent, { ...ctx, mode: "raw" }, rawStarts);
    const spans: Span[] = [];
    const re = ctx.ph;
    re.lastIndex = 0;
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      if (m[0] === "") { re.lastIndex++; continue; }
      spans.push([m.index, m.index + m[0].length]);
    }
    keep = nodes.map((n, i) => {
      const from = rawStarts[i];
      if (from === undefined || !n.isText) return [];
      const to = from + (n.text as string).length;
      return spans.filter(([a, b]) => a < to && b > from).map(([a, b]): Span => [Math.max(a, from) - from, Math.min(b, to) - from]);
    });
  }

  /** How many consecutive nodes from `from` carry `m`: the longer span is opened first, so nesting stays well formed. */
  const span = (from: number, m: Mark): number => {
    let n = 0;
    while (from + n < nodes.length && m.isInSet(nodes[from + n].marks)) n++;
    return n;
  };
  const open = (m: Mark, from: number): { text: string; entry: Open } => {
    switch (m.type.name) {
      case "bold": return { text: "**", entry: { mark: m, close: "**" } };
      case "italic": return { text: "*", entry: { mark: m, close: "*" } };
      case "strike": return { text: "~~", entry: { mark: m, close: "~~" } };
      case "code": {
        let t = "";
        for (let j = from; j < nodes.length && m.isInSet(nodes[j].marks); j++) t += nodes[j].isText ? nodes[j].text : "";
        const d = codeDelimiter(t);
        return { text: d.open, entry: { mark: m, close: d.close } };
      }
      default: return { text: "[", entry: { mark: m, close: linkClose(String(m.attrs.href ?? ""), (m.attrs.title as string | null) ?? null) } };
    }
  };

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    // close what no longer applies (and whatever was opened after it, to keep the nesting well formed; it reopens below)
    const cut = stack.findIndex((o) => !o.mark.isInSet(n.marks));
    if (cut >= 0) while (stack.length > cut) out += (stack.pop() as Open).close;
    // open what is new: the longest span outermost, schema rank breaking ties
    const ranked = n.marks
      .filter((m) => !stack.some((o) => o.mark.eq(m)))
      .map((m, rank) => ({ m, rank, len: span(i, m) }))
      .sort((x, y) => y.len - x.len || x.rank - y.rank);
    for (const { m } of ranked) {
      const o = open(m, i);
      out += o.text;
      stack.push(o.entry);
    }

    const isCode = n.marks.some((m) => m.type.name === "code");
    switch (n.type.name) {
      case "text": {
        const s = n.text as string;
        if (starts && !isCode) starts[i] = out.length;
        out += isCode || ctx.mode === "raw" ? s : escapeText(s, lineStart, keep[i] ?? []);
        lineStart = false;
        break;
      }
      case "softBreak": out += ctx.inCell ? " " : "\n"; lineStart = true; break;
      case "hardBreak": out += ctx.inCell ? " " : "\\\n"; lineStart = true; break;
      case "htmlInline": out += String(n.attrs.raw); lineStart = false; break;
      case "mdImage": {
        const alt = String(n.attrs.alt ?? "");
        const title = n.attrs.title as string | null;
        const src = String(n.attrs.src ?? "");
        const dest = /[\s()<>]/.test(src) || src === "" ? `<${src}>` : src;
        out += `![${ctx.mode === "safe" ? alt.replace(/([\\[\]])/g, "\\$1") : alt}](${dest}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
        lineStart = false;
        break;
      }
      default: out += n.textContent; lineStart = false;
    }
  }
  while (stack.length) out += (stack.pop() as Open).close;
  return out;
}

/** `first` before the first line, `rest` before every later non-blank line (blank lines stay empty: no trailing spaces). */
function indentLines(s: string, first: string, rest: string): string {
  return s.split("\n").map((l, i) => (i === 0 ? first + l : l === "" ? "" : rest + l)).join("\n");
}

function blockToMd(node: PMNode, ctx: Ctx): string {
  switch (node.type.name) {
    case "paragraph": return inlineToMd(node, ctx);
    case "heading": {
      const inner = inlineToMd(node, ctx);
      return "#".repeat(Number(node.attrs.level)) + (inner ? ` ${inner}` : "");
    }
    case "bulletList": case "orderedList": {
      const tight = node.attrs.tight !== false;
      const ordered = node.type.name === "orderedList";
      const start = Number(node.attrs.start ?? 1);
      const items: string[] = [];
      node.forEach((item, _o, idx) => {
        const parts: string[] = [];
        item.forEach((b) => parts.push(blockToMd(b, ctx)));
        const marker = ordered ? `${start + idx}. ` : "- ";
        const inner = parts.join(tight ? "\n" : "\n\n");
        items.push(inner === "" ? marker.trimEnd() : indentLines(inner, marker, " ".repeat(marker.length)));
      });
      return items.join(tight ? "\n" : "\n\n");
    }
    case "blockquote": {
      const parts: string[] = [];
      node.forEach((b) => parts.push(blockToMd(b, ctx)));
      return parts.join("\n\n").split("\n").map((l) => (l === "" ? ">" : `> ${l}`)).join("\n");
    }
    case "codeBlock": {
      const text = node.textContent;
      const longest = (text.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 0);
      const fence = "`".repeat(Math.max(3, longest + 1));
      const lang = (node.attrs.language as string | null) ?? "";
      return text === "" ? `${fence}${lang}\n${fence}` : `${fence}${lang}\n${text}\n${fence}`;
    }
    case "horizontalRule": return "---";
    case "htmlBlock": return String(node.attrs.raw);
    case "table": {
      const rows: string[] = [];
      let aligns: (string | null)[] = [];
      node.forEach((row, _o, ri) => {
        const cells: string[] = [];
        row.forEach((cell) => {
          const c = inlineToMd(cell.firstChild as PMNode, { ...ctx, inCell: true }).replace(/\|/g, "\\|");
          cells.push(c);
          if (ri === 0) aligns.push((cell.attrs.align as string | null) ?? null);
        });
        rows.push(`| ${cells.join(" | ")} |`);
        if (ri === 0) {
          const sep = aligns.map((a) => (a === "left" ? ":---" : a === "right" ? "---:" : a === "center" ? ":---:" : "---"));
          rows.push(`|${sep.join("|")}|`);
        }
      });
      aligns = [];
      return rows.join("\n");
    }
    default: return node.textContent;
  }
}

// A block's text depends only on the block and the mode: PM shares unchanged subtrees, so re-serialising after an edit
// only re-does what changed. (Keyed by the placeholder signature, since "safe" output depends on it.)
const caches = new Map<string, WeakMap<PMNode, { text: string; verified: boolean }>>();

function stripGap(j: unknown): unknown {
  if (Array.isArray(j)) return j.map(stripGap);
  if (typeof j === "object" && j !== null) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (k === "gap") continue;
      o[k] = stripGap(v);
    }
    return o;
  }
  return j;
}
const sameBlock = (a: PMNode, b: PMNode): boolean => JSON.stringify(stripGap(a.toJSON())) === JSON.stringify(stripGap(b.toJSON()));

function reparses(text: string, block: PMNode): boolean {
  try {
    const { doc } = parseMarkdown(text);
    return doc.childCount === 1 && sameBlock(doc.firstChild as PMNode, block);
  } catch {
    return false;
  }
}

function blockText(block: PMNode, ph: PlaceholderSyntax[], cache: WeakMap<PMNode, { text: string; verified: boolean }>, forceSafe: boolean): { text: string; verified: boolean } {
  const hit = cache.get(block);
  if (hit) return hit;
  const re = placeholderRegex(ph);
  const raw = forceSafe ? "" : blockToMd(block, { mode: "raw", ph: null, inCell: false });
  let res: { text: string; verified: boolean };
  if (!forceSafe && reparses(raw, block)) res = { text: raw, verified: true };
  else {
    const safe = blockToMd(block, { mode: "safe", ph: re, inCell: false });
    res = { text: safe, verified: reparses(safe, block) };
  }
  cache.set(block, res);
  return res;
}

export interface Serialized {
  text: string;
  /** False when some block could not be proven to re-parse to what the editor shows (it was still written, in safe mode). */
  verified: boolean;
}

/** `forceSafe` writes EVERY block in the escaping mode (used to prove placeholders survive it); normal saves never need it. */
export function serializeDoc(doc: PMNode, env: Envelope, placeholders: PlaceholderSyntax[] = [], opts: { forceSafe?: boolean } = {}): Serialized {
  const sig = JSON.stringify(placeholders) + (opts.forceSafe ? "!safe" : "");
  let cache = caches.get(sig);
  if (!cache) { cache = new WeakMap(); caches.set(sig, cache); }
  let body = "";
  let verified = true;
  doc.forEach((block, _o, i) => {
    const { text, verified: v } = blockText(block, placeholders, cache as WeakMap<PMNode, { text: string; verified: boolean }>, opts.forceSafe === true);
    if (!v) verified = false;
    const gap = Number(block.attrs.gap ?? 1);
    body += (i === 0 ? "" : "\n".repeat(gap + 1)) + text;
  });
  // A document that is one empty paragraph is the empty string.
  if (doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && doc.firstChild.childCount === 0) body = "";
  const lf = env.lead + body + env.tail;
  return { text: env.eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf, verified };
}

// ── The gate ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type RoundTrip =
  | { ok: true; parsed: Parsed }
  | { ok: false; reason: string; parsed: Parsed | null; out: string | null };

/** Does `text` survive parse then serialise with the exact same bytes? */
export function roundTrip(text: string, placeholders: PlaceholderSyntax[] = []): RoundTrip {
  let parsed: Parsed;
  try {
    parsed = parseMarkdown(text);
  } catch (e) {
    return { ok: false, reason: e instanceof Unrepresentable ? e.construct : "parse-error", parsed: null, out: null };
  }
  const out = serializeDoc(parsed.doc, parsed.env, placeholders).text;
  if (out === text) return { ok: true, parsed };
  return { ok: false, reason: "differs", parsed, out };
}

export const roundTrips = (text: string, placeholders: PlaceholderSyntax[] = []): boolean => roundTrip(text, placeholders).ok;

// ── Diagnosis (measurement only: names a construct, never echoes content) ────────────────────────────────────────

export interface Difference {
  /** A construct name such as `table:cell-spacing` or `paragraph:leading-space`. Never document text. */
  construct: string;
  /** 1-based line of the first difference in the source, or null when the text could not be parsed at all. */
  line: number | null;
}

const isTableLine = (s: string): boolean => /^\s*\|/.test(s);
const indentOf = (s: string): number => s.length - s.trimStart().length;

function classify(a: string[], b: string[], d: number): string {
  const sa = a[d];
  const sb = b[d];
  if (sa === undefined) return "document:output-has-extra-lines";
  if (sb === undefined) return "document:output-lacks-lines";
  if (sa === "" || sb === "") return sa === "" ? "blank-line:extra-in-source" : "blank-line:missing-in-source";
  if (isTableLine(sa) && isTableLine(sb)) {
    if (sa.replace(/\s+/g, "") === sb.replace(/\s+/g, "")) return "table:cell-spacing";
    if (/^[\s|:-]+$/.test(sa) || /^[\s|:-]+$/.test(sb)) return "table:delimiter-row";
    if (sa.split("|").length !== sb.split("|").length) return "table:column-count";
    return "table:cell-content";
  }
  if (isTableLine(sa) !== isTableLine(sb)) return "table:row-shape";
  if (/^\s*\d+[.)] /.test(sa) && /^\s*\d+[.)] /.test(sb) && sa.replace(/^\s*\d+/, "") === sb.replace(/^\s*\d+/, "")) return "list:ordered-numbering";
  if (sa.trim() === sb.trim()) {
    const prevBlank = d === 0 || a[d - 1] === "" || /^#{1,6}( |$)/.test(a[d - 1]);
    if (indentOf(sa) > indentOf(sb)) return prevBlank ? "paragraph:leading-space" : "paragraph:continuation-indent";
    return prevBlank ? "paragraph:indentation" : "list:lazy-continuation";
  }
  if (sa.trimEnd() === sb) return "line:trailing-space";
  if (sa.replace(/_/g, "*") === sb.replace(/_/g, "*")) return "emphasis:underscore-marker";
  if (sa.includes("\\")) return "escape:backslash-sequence";
  if (/&(#\d+|#x[0-9a-f]+|\w+);/i.test(sa)) return "entity:character-reference";
  if (/^\s*[*+] /.test(sa) && /^\s*- /.test(sb)) return "list:bullet-marker";
  if (/^\s*(~~~|```)/.test(sa) || /^\s*(~~~|```)/.test(sb)) return "code:fence";
  if (/^\s*>/.test(sa) !== /^\s*>/.test(sb)) return "blockquote:layout";
  return "other";
}

/** Why `text` is not byte-identical after parse + serialise: the FIRST difference, as a construct name and a line number. */
export function diagnose(text: string, placeholders: PlaceholderSyntax[] = []): Difference | null {
  const r = roundTrip(text, placeholders);
  if (r.ok) return null;
  if (r.parsed === null || r.out === null) return { construct: r.reason, line: null };
  const a = text.replace(/\r\n/g, "\n").split("\n");
  const b = r.out.replace(/\r\n/g, "\n").split("\n");
  let d = 0;
  while (d < a.length && d < b.length && a[d] === b[d]) d++;
  return { construct: classify(a, b, d), line: d + 1 };
}

#!/usr/bin/env node
// WSK-45 — a MEASUREMENT, not a gate: how much of a site's real Markdown the visual editor can hold byte-for-byte.
//
//   node scripts/check-markdown-roundtrip.mjs <bundle.json> [--detail] [--editor]
//
// <bundle.json> is a WebDesk content bundle (`{ compositions: { <collection>: { fields, lint } }, items: [{ collectionKey,
// fields }] }`, what `export-bundle.mjs` writes). The script walks EVERY field whose primitive is `markdown` in every item
// (nested groups and lists included) and runs the editor's own codec (src/lib/markdownCodec.ts) over it:
//
//   • round-trip   parse -> serialise; byte-identical means the field opens in the VISUAL editor, anything else opens as
//                  source with a notice;
//   • histogram    for the source-mode fields, the construct at the FIRST difference (names and counts only);
//   • placeholders for the visual fields, a simulated edit (append two paragraphs, one with characters Markdown acts on)
//                  must leave every declared placeholder (`{{token}}`, `[CONFIRM: …]`) byte-for-byte in the output.
//
// --editor additionally loads every visual field into a REAL TipTap editor (jsdom): the editor's own document must serialise to
// the original text, and typing one character then undoing must return to an equal document.
//
// NOTHING OF THE CONTENT IS PRINTED. Output is counts, construct names and (with --detail) "<collection>#<item index>:<line>".
// A bundle can hold unpublished drafts: do not commit it, and do not paste a field into the output. Exit code is 0 always.
//
// Needs Node with native TypeScript stripping (22.18+/24): the codec is loaded straight from its .ts file.
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const argv = process.argv.slice(2);
const detail = argv.includes("--detail");
const withEditor = argv.includes("--editor");
const file = argv.find((a) => !a.startsWith("--"));
if (!file) {
  console.log("usage: node scripts/check-markdown-roundtrip.mjs <bundle.json> [--detail]");
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
let codec;
let pm;
try {
  codec = await import(pathToFileURL(path.join(here, "../src/lib/markdownCodec.ts")).href);
  pm = await import("@tiptap/pm/model");
} catch (e) {
  console.log(`cannot load the codec (${e && e.code ? e.code : "error"}): this needs Node 22.18+ (native TypeScript) and \`npm ci\` in platform-ui.`);
  process.exit(0);
}

const bundle = JSON.parse(readFileSync(file, "utf8"));
const compositions = bundle.compositions ?? {};
const items = Array.isArray(bundle.items) ? bundle.items : [];

/** Yields [value, label] for every markdown value under `defs`/`val`. */
function* markdownValues(defs, val, label) {
  for (const d of defs ?? []) {
    const v = val?.[d.name];
    if (v === undefined || v === null) continue;
    const each = d.multiple ? (Array.isArray(v) ? v : []) : [v];
    for (const x of each) {
      if (d.primitive === "markdown" && typeof x === "string") yield [x, label];
      else if (d.primitive === "group" && typeof x === "object") yield* markdownValues(d.fields, x, label);
    }
  }
}

const total = { fields: 0, items: items.length, visual: 0, source: 0 };
const hist = new Map();
const detailLines = [];
const ph = { fieldsWithPlaceholders: 0, occurrences: 0, simulated: 0, altered: 0, typedAltered: 0, unverified: 0, forced: 0, forcedAltered: 0, forcedUnverified: 0 };
const bytes = { visualBytes: 0, sourceBytes: 0 };

const re = (syn) => new RegExp(syn.map((p) => `${p.open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*?${p.close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).join("|"), "g");
const tally = (text, rx) => {
  const m = new Map();
  for (const s of text.match(rx) ?? []) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
};

items.forEach((item, idx) => {
  const comp = compositions[item.collectionKey] ?? {};
  const syntaxes = codec.placeholderSyntaxes(comp.lint?.placeholders);
  const rx = syntaxes.length ? re(syntaxes) : null;
  for (const [text] of markdownValues(comp.fields, item.fields, item.collectionKey)) {
    total.fields++;
    const rt = codec.roundTrip(text, syntaxes);
    if (rt.ok) {
      total.visual++;
      bytes.visualBytes += text.length;
      if (!rx) continue;
      const before = tally(text, rx);
      if (before.size === 0) continue;
      ph.fieldsWithPlaceholders++;
      for (const n of before.values()) ph.occurrences += n;
      // Simulated edit: two new paragraphs at the end. The second is typed text with characters Markdown acts on, plus a
      // new placeholder, so the "safe" writer (escaping) is exercised next to real placeholders.
      const schema = codec.markdownSchema();
      const { doc, env } = rt.parsed;
      const typed = `${syntaxes[0].open}new_token${syntaxes[0].close}`;
      const p1 = schema.nodes.paragraph.create({ gap: 1 }, [schema.text("An added line.")]);
      const p2 = schema.nodes.paragraph.create({ gap: 1 }, [schema.text(`2 * 3 and a_b and [x] and <y> then ${typed}`)]);
      const edited = doc.copy(doc.content.append(pm.Fragment.from([p1, p2])));
      const out = codec.serializeDoc(edited, env, syntaxes);
      ph.simulated++;
      if (!out.verified) ph.unverified++;
      const after = tally(out.text, rx);
      let bad = false;
      for (const [k, n] of before) if ((after.get(k) ?? 0) < n) bad = true;
      if (bad) ph.altered++;
      if ((after.get(typed) ?? 0) < 1) ph.typedAltered++;
      // Worst case: EVERY block written in the escaping ("safe") mode, as when each block holds text Markdown would act on.
      const forced = codec.serializeDoc(doc, env, syntaxes, { forceSafe: true });
      ph.forced++;
      const afterForced = tally(forced.text, rx);
      let badForced = false;
      for (const [k, n] of before) if ((afterForced.get(k) ?? 0) < n) badForced = true;
      if (badForced) ph.forcedAltered++;
      if (!forced.verified) ph.forcedUnverified++;
    } else {
      total.source++;
      bytes.sourceBytes += text.length;
      const d = codec.diagnose(text, syntaxes) ?? { construct: "unknown", line: null };
      hist.set(d.construct, (hist.get(d.construct) ?? 0) + 1);
      if (detail) detailLines.push(`  ${item.collectionKey}#${idx}${d.line ? `:${d.line}` : ""}  ${d.construct}`);
    }
  }
});

const pct = (n) => (total.fields ? ((100 * n) / total.fields).toFixed(1) : "0.0");
console.log(`items in bundle                         : ${total.items}`);
console.log(`markdown fields (all, nested included)  : ${total.fields}`);
console.log(`round-trip byte-identical -> VISUAL     : ${total.visual} (${pct(total.visual)}%)`);
console.log(`opens as SOURCE (with a notice)         : ${total.source} (${pct(total.source)}%)`);
if (hist.size) {
  console.log("construct at the first difference, source-mode fields:");
  for (const [k, n] of [...hist].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`  ${String(n).padStart(4)}  ${k}`);
}
if (detail && detailLines.length) {
  console.log("detail (<collection>#<item index>:<line>):");
  for (const l of detailLines) console.log(l);
}
console.log("placeholders, simulated edit on the visual fields:");
console.log(`  fields carrying placeholders          : ${ph.fieldsWithPlaceholders}`);
console.log(`  placeholder occurrences               : ${ph.occurrences}`);
console.log(`  edits simulated                       : ${ph.simulated}`);
console.log(`  fields where a placeholder changed    : ${ph.altered}`);
console.log(`  newly typed placeholder not verbatim  : ${ph.typedAltered}`);
console.log(`  edits not proven to re-parse          : ${ph.unverified}`);
console.log(`  every block forced into escaping mode : ${ph.forced} fields; placeholder changed in ${ph.forcedAltered}; not proven to re-parse in ${ph.forcedUnverified}`);

if (withEditor) {
  const { JSDOM } = await import("jsdom");
  const { Editor } = await import("@tiptap/core");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "getComputedStyle", "DOMParser", "Range", "Selection", "requestAnimationFrame", "cancelAnimationFrame"]) {
    try { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); } catch { /* a read-only global: leave it */ }
  }
  const range = dom.window.Range.prototype;
  range.getBoundingClientRect ??= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  range.getClientRects ??= () => ({ length: 0, item: () => null });
  const ed = { fields: 0, reserialisedSame: 0, undoEqual: 0, editChangedOneChar: 0 };
  for (const item of items) {
    const comp = compositions[item.collectionKey] ?? {};
    const syntaxes = codec.placeholderSyntaxes(comp.lint?.placeholders);
    for (const [text] of markdownValues(comp.fields, item.fields, item.collectionKey)) {
      const rt = codec.roundTrip(text, syntaxes);
      if (!rt.ok) continue;
      ed.fields++;
      const editor = new Editor({ element: dom.window.document.createElement("div"), extensions: codec.markdownExtensions, content: rt.parsed.doc.toJSON() });
      const base = editor.state.doc;
      if (codec.serializeDoc(base, rt.parsed.env, syntaxes).text === text) ed.reserialisedSame++;
      editor.commands.insertContentAt(2, "Z");
      if (codec.serializeDoc(editor.state.doc, rt.parsed.env, syntaxes).text.length === text.length + 1) ed.editChangedOneChar++;
      editor.commands.undo();
      if (editor.state.doc.eq(base)) ed.undoEqual++;
      editor.destroy();
    }
  }
  console.log("real TipTap editor (jsdom), visual fields:");
  console.log(`  loaded                                 : ${ed.fields}`);
  console.log(`  editor document serialises to original : ${ed.reserialisedSame}`);
  console.log(`  one typed character -> exactly +1 char : ${ed.editChangedOneChar}`);
  console.log(`  undo returns to an equal document      : ${ed.undoEqual}`);
}
process.exit(0);

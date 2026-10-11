// M5-W3 — a deliberately small, linear-time markdown reader for the content checks. It is not a full
// parser: it finds headings, plain paragraphs, links, images, lists and tables, skips fenced code, and
// works line by line with bounded patterns (no backtracking-prone regex over the whole text).

export interface MdHeading { level: number; text: string }
export interface MdLink { text: string; url: string; image: boolean }
export interface MdParagraph { text: string; words: number }
export interface MdDoc {
  headings: MdHeading[];
  paragraphs: MdParagraph[];
  links: MdLink[];
  lists: number;
  tables: number;
  words: number;
  /** The text with fenced code removed (used for phrase scans). */
  prose: string;
  /** Index into `paragraphs` of the first paragraph after the first H1 (the first paragraph when there is no H1); -1 = none. */
  answerParagraph: number;
}

const LINK = /(!?)\[([^\]\n]{0,300})\]\(([^)\s\n]{1,2000})[^)\n]{0,200}\)/g;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

export function wordsOf(text: string): number {
  let n = 0;
  for (const w of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) n++;
  return n;
}

function plain(line: string): string {
  return line.replace(LINK, (_m, img: string, t: string) => (img ? "" : t)).replace(/[*_`>]/g, "");
}

export function parseMarkdown(src: string): MdDoc {
  const doc: MdDoc = { headings: [], paragraphs: [], links: [], lists: 0, tables: 0, words: 0, prose: "", answerParagraph: -1 };
  const proseLines: string[] = [];
  let para: string[] = [];
  let inFence = false;
  let inList = false;
  let inTable = false;
  let afterH1 = false;
  let h1Seen = false;
  let firstParaIdx = -1;
  const flush = (): void => {
    if (para.length === 0) return;
    const text = para.join(" ").trim();
    para = [];
    if (!text) return;
    const idx = doc.paragraphs.push({ text, words: wordsOf(text) }) - 1;
    if (firstParaIdx < 0) firstParaIdx = idx;
    if (afterH1 && doc.answerParagraph < 0) doc.answerParagraph = idx;
  };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s{0,3}(```|~~~)/.test(line)) { flush(); inFence = !inFence; continue; }
    if (inFence) continue;
    for (const m of line.matchAll(LINK)) doc.links.push({ image: m[1] === "!", text: m[2], url: m[3] });
    proseLines.push(line);
    if (line.trim() === "") { flush(); inList = false; inTable = false; continue; }
    const h = HEADING.exec(line.trim());
    if (h) {
      flush(); inList = false; inTable = false;
      doc.headings.push({ level: h[1].length, text: plain(h[2]).trim() });
      if (h[1].length === 1 && !h1Seen) { h1Seen = true; afterH1 = true; }
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { flush(); if (!inList) doc.lists++; inList = true; continue; }
    if (line.trim().startsWith("|")) { flush(); if (!inTable) doc.tables++; inTable = true; continue; }
    if (/^\s*(>|<)/.test(line) || /^\s*!\[/.test(line)) { flush(); continue; }
    para.push(plain(line).trim());
  }
  flush();
  if (doc.answerParagraph < 0 && !h1Seen) doc.answerParagraph = firstParaIdx;
  doc.prose = proseLines.join("\n");
  doc.words = wordsOf(proseLines.map(plain).join(" "));
  return doc;
}

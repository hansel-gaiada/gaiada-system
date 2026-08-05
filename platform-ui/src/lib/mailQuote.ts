// MAIL-20 — render-side quoted-history boundary detection (design A15.2, §7.6 v4).
//
// Pure, zero-I/O, client-safe (no `server-only` guard — module-trio convention: this is the "X.ts"
// half, `components/mail/QuotedMessageBody.tsx` is the consumer). Nothing here reads or writes
// anything; it only computes, from a `bodyText`/`bodyHtmlSanitized` string already handed to us by
// the BFF, which spans should render behind a "Show quoted history" toggle. THE RESULT IS NEVER
// PERSISTED — recomputed fresh on every render, per the binding design line: "computed at render,
// never stored... a misfire costs a click, never data."
//
// ============================================================================================
// WHY THIS FILE NEVER PATTERN-MATCHES MAIL-19's TRUNCATION MARKER (read before touching this file)
// ============================================================================================
// MAIL-19's intake cap splices `[truncated at intake: N characters omitted here]` into `body_text`
// at a boundary computed ENTIRELY from length, never from content — unforgeable AT THE ACCOUNTING
// LAYER (a forged `N` won't match the real omitted-character count), but MAIL-20 originally found
// that signal NOT exposed to this render layer at all: `ThreadMessageView` carried only
// `bodyText`/`bodyHtmlSanitized`, so the only way to show a truncation notice would have been to
// pattern-match the marker STRING — exactly the thing corpus case `18-elision-marker-spoof` proves is
// forgeable (a decoy string survives intake VERBATIM as ordinary content, indistinguishable from the
// real marker by shape alone).
//
// MAIL-25 closed that gap at the SOURCE, not here: `ThreadMessageView` now also carries
// `bodyTruncated`/`bodyTruncatedChars` (migration `platform-nest/migrations/
// 0082_mail_truncation_metadata.sql`), set at intake from the SAME length arithmetic that produces
// the cap — never by parsing content. `components/mail/QuotedMessageBody.tsx` renders its
// truncation notice from THAT field only. This file's job stays exactly what it was: classify a
// line/tag purely by STRUCTURAL shape a sender's own reply text does not naturally take (a
// `>`-prefixed line, a `<blockquote>` tag) — never by matching the marker's text, forged or genuine.
// That separation is now load-bearing rather than accidental: the truncation notice's correctness no
// longer depends on where the marker's line lands relative to a quote-collapse boundary (previously
// an EMERGENT property of the marker line never being `>`-prefixed, which this file's own boundary
// detector could break the moment a marker's line landed inside a header-style "collapse to the end"
// sweep — see `QuotedMessageBody.test.tsx`'s explicit regression case for the constructed proof).
// ============================================================================================

export interface TextSegment {
  kind: "visible" | "quoted";
  text: string;
}

export interface HtmlSegment {
  kind: "visible" | "quoted";
  html: string;
}

type LineClass = "quote" | "blank" | "text";

function classifyLine(line: string): LineClass {
  if (/^\s{0,3}>/.test(line)) return "quote";
  if (/^\s*$/.test(line)) return "blank";
  return "text";
}

/** Header-style quote openers that carry no per-line `>` prefix, so once one is found there is no
 *  reliable per-line delimiter for where the quote ends — the design's own "collapse everything
 *  below it" wording applies literally here: the collapse runs to the end of the text. This is a
 *  fail-SAFE cost (an unusual client's later content needs one click to reveal), never a fail-open
 *  one — nothing is ever hidden that MAIL-19 didn't already store. */
function findHeaderStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^on .{1,300}wrote:$/i.test(trimmed)) return i;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) return i;
    if (/^from:\s*\S/i.test(trimmed)) {
      const window = lines.slice(i + 1, i + 6).map((l) => l.trim());
      const hasSent = window.some((l) => /^sent:\s*\S/i.test(l));
      const hasTo = window.some((l) => /^to:\s*\S/i.test(l));
      const hasSubject = window.some((l) => /^subject:\s*/i.test(l));
      if (hasSent && hasTo && hasSubject) return i;
    }
  }
  return -1;
}

/**
 * Splits a plain-text body into alternating visible / quoted segments.
 *
 * Quote runs are contiguous `>`-prefixed lines (blank lines strictly SANDWICHED between two quote
 * lines are folded into the run so a one-line gap in a quoted thread doesn't split it into two
 * toggles); a header-style opener (`On ... wrote:`, `-----Original Message-----`, an Outlook
 * `From:`/`Sent:`/`To:`/`Subject:` block) collapses from itself to the end of the text, since it
 * carries no per-line delimiter. Fail-safe by construction: no boundary anywhere → one `visible`
 * segment covering the whole text.
 */
export function splitQuotedText(bodyText: string): TextSegment[] {
  const lines = bodyText.split("\n");
  const n = lines.length;
  if (n === 0) return [{ kind: "visible", text: bodyText }];

  const cls: LineClass[] = lines.map(classifyLine);

  const headerIdx = findHeaderStart(lines);
  if (headerIdx !== -1) {
    for (let i = headerIdx; i < n; i++) cls[i] = "quote";
  }

  for (let i = 0; i < n; i++) {
    if (cls[i] !== "blank") continue;
    let prev = i - 1;
    while (prev >= 0 && cls[prev] === "blank") prev--;
    let next = i + 1;
    while (next < n && cls[next] === "blank") next++;
    if (prev >= 0 && next < n && cls[prev] === "quote" && cls[next] === "quote") cls[i] = "quote";
  }

  const segments: TextSegment[] = [];
  let i = 0;
  while (i < n) {
    const isQuote = cls[i] === "quote";
    let j = i;
    while (j < n && (cls[j] === "quote") === isQuote) j++;
    segments.push({ kind: isQuote ? "quoted" : "visible", text: lines.slice(i, j).join("\n") });
    i = j;
  }
  return segments;
}

/** Finds the index just past the `</blockquote>` that closes the `<blockquote>` opening at `start`,
 *  honouring nesting (a quoted-of-a-quote thread) by depth counting. Falls back to "to the end of
 *  the string" for an unterminated tag — same fail-closed reading `html-sanitize.ts` uses for an
 *  unterminated tag: never re-derive structure the sanitizer didn't itself guarantee. */
function findBlockquoteEnd(html: string, start: number): number {
  const tagRe = /<\/?blockquote>/g;
  tagRe.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    depth += m[0] === "<blockquote>" ? 1 : -1;
    if (depth <= 0) return m.index + m[0].length;
  }
  return html.length;
}

/**
 * Splits already-sanitized inbound HTML (`html-sanitize.ts`'s output — a generated document built
 * from an allowlist, so `<blockquote>` is a complete, attribute-free, always-closable tag) into
 * alternating visible / quoted segments on `<blockquote>` boundaries. Handles nested and repeated
 * (interleaved-reply) blockquotes; no `<blockquote>` anywhere → one `visible` segment.
 */
export function splitQuotedHtml(html: string): HtmlSegment[] {
  const segments: HtmlSegment[] = [];
  let pos = 0;
  while (pos < html.length) {
    const idx = html.indexOf("<blockquote>", pos);
    if (idx === -1) {
      segments.push({ kind: "visible", html: html.slice(pos) });
      break;
    }
    if (idx > pos) segments.push({ kind: "visible", html: html.slice(pos, idx) });
    const end = findBlockquoteEnd(html, idx);
    segments.push({ kind: "quoted", html: html.slice(idx, end) });
    pos = end;
  }
  if (segments.length === 0) segments.push({ kind: "visible", html });
  return segments;
}

/** True when any segment is collapsible — lets a caller skip the toggle machinery entirely for the
 *  common (unquoted) case rather than rendering a zero-item disclosure. */
export function hasQuotedSegment(segments: { kind: "visible" | "quoted" }[]): boolean {
  return segments.some((s) => s.kind === "quoted");
}

// MAIL-13 — the server-side HTML allowlist sanitizer for INBOUND mail (design §7.6, binding:
// "Never store or render raw provider HTML. Server-side allowlist sanitizer at intake; store
// `body_text` + `body_html_sanitized` only").
//
// THE DESIGN CHOICE THAT MAKES THIS SAFE: this is a TOKENIZE-AND-REBUILD sanitizer, not a
// strip-the-bad-parts filter. The output string is CONSTRUCTED from scratch out of (a) tag names
// this file explicitly allowlists and (b) HTML-escaped text. No substring of the input is ever
// copied into the output verbatim except a single validated `a[href]` value. That inverts the usual
// failure mode: a filter that removes `<script>` fails open the moment an attacker finds a shape it
// did not anticipate, whereas a builder can only ever emit what it was told to emit — an
// unanticipated shape becomes escaped text, which is inert by construction.
//
// Consequences worth stating explicitly, because they ARE the security properties:
//   * NO attribute survives except `a[href]`. Not `style`, not `on*`, not `src`, not `srcset`, not
//     `formaction`, not `data-*`. Event handlers and CSS payloads are therefore unrepresentable in
//     the output, rather than "filtered out of it".
//   * `<img>` is NOT allowlisted, so remote-image trackers cannot survive intake at all — the
//     tracker case in the §7.6 corpus is closed by the tag allowlist, not by URL inspection.
//   * `script`/`style`/`svg`/`math`/`iframe`/... are excised WITH THEIR CONTENT (raw-text and
//     foreign-content elements parse by different rules in a browser, so their innards must never be
//     re-emitted even as escaped text).
//   * Every OTHER unrecognized tag (`table`, `font`, `center`, `o:p`, whatever Outlook invents) is
//     UNWRAPPED — the tag is dropped, its text is kept and escaped. Dropping content for
//     unknown-but-harmless wrappers would silently destroy a human's reply.
//
// Deliberately no new dependency: `sanitize-html`/DOMPurify would each add a transitive tree to a
// service whose whole dependency list is 20 lines, for a job whose safety here comes from emitting a
// generated document rather than from parser fidelity. html-sanitize.test.ts pins the corpus of
// bypass shapes this file is claimed to close.
//
// STYLE NOTE (deliberate): the control-character filters below are code-point PREDICATES rather than
// regex character classes. A class like /[<escape>-<escape>]/ is exactly the kind of source line
// that gets silently corrupted by an editor, a codemod, or a shell rewrite into a class of LITERAL
// control bytes that still compiles and still "works" — while making the file binary and the
// intent unreadable. Predicates keep the boundaries stated as numbers.

/** Tags re-emitted as themselves. Structural + inline formatting only — nothing that loads a
 *  resource, executes, or styles. */
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "sub", "sup", "u", "ul",
]);

/** Allowlisted tags with no closing tag. */
const VOID_TAGS = new Set(["br", "hr"]);

/** Excised WITH their content (see the header comment for why content-dropping is required for
 *  exactly these and wrong for everything else).
 *
 *  ⚠ EVERY MEMBER MUST BE AN ELEMENT THAT HAS A CLOSING TAG. Subtree-dropping works by skipping to the
 *  matching `</name>`, and when there is no such tag the scan runs to EOF — silently discarding the
 *  rest of the message. `embed` was in this set and produced exactly that: a mail containing
 *  `<embed src=...>` lost every byte after it, including the human's actual reply (caught by the
 *  hostile-HTML corpus case, which asserts that innocent text AFTER the hostile markup survives).
 *  Void dangerous elements — `embed`, `source`, `track`, `param`, `img`, `link`, `meta`, `base`,
 *  `input` — need no entry here at all: they carry no children, so the default "unknown tag →
 *  unwrap" branch already removes them completely, attributes included. */
const SUBTREE_DROP_TAGS = new Set([
  "script", "style", "iframe", "noscript", "noembed", "noframes", "object", "applet",
  "template", "svg", "math", "textarea", "title", "xmp", "frameset", "plaintext", "listing",
]);

const MAX_DEPTH = 64;

const NUL = 0x00;
const TAB = 0x09;
const LF = 0x0a;
const SPACE = 0x20;
const DEL = 0x7f;
const C1_TOP = 0x9f;

function stripWhere(value: string, drop: (code: number) => boolean): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (!drop(code)) out += ch;
  }
  return out;
}

/** Like `stripWhere` but substitutes a space. Used for HEADER-ish values only, and the difference from
 *  `stripWhere` is deliberate: `../sanitize.ts` DROPS CR/LF on the send side so an injected
 *  `Subject: x\r\nBcc: y` cannot be reformatted into a still-injected header, whereas here the value is
 *  being stored as displayable text and `x\r\nBcc: y` collapsing to `xBcc: y` would silently glue two
 *  words together in the UI. Neither variant can produce a CR/LF, so this is a readability choice with
 *  no security content. */
function replaceWhere(value: string, drop: (code: number) => boolean): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    out += drop(code) ? " " : ch;
  }
  return out;
}

/** C0 controls, space, DEL and C1 — everything invisible-or-structural, and therefore everything
 *  usable to smuggle a scheme past a prefix test (tab/newline inside `javascript:`). */
const isUrlNoise = (code: number): boolean => code <= SPACE || (code >= DEL && code <= C1_TOP);
/** Control characters that must never reach a `text` column. TAB and LF are deliberately excluded —
 *  they are meaningful in a mail body. */
const isTextControl = (code: number): boolean => (code < SPACE && code !== TAB && code !== LF) || code === DEL;
/** For single-line (header-ish) values, CR and LF are controls too. */
const isLineControl = (code: number): boolean => code < SPACE || code === DEL;

/** Entity decode used ONLY for validating an `href` before deciding whether to keep it. Covers the
 *  three shapes that turn a rejected scheme into an accepted one: numeric decimal, numeric hex, and
 *  the named entities for `:` / whitespace (`java&Tab;script&colon;...`). Decode happens BEFORE the
 *  scheme allowlist test, which is the order that matters — decoding after the test is the classic
 *  bypass. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t",
  newline: "\n", sol: "/", semi: ";", nbsp: " ",
};

function decodeEntitiesForUrlCheck(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);?/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

const SAFE_SCHEME_RE = /^(https?:|mailto:)/i;

/** Returns the href to emit, or null to drop the attribute (the `<a>` itself is still emitted, so
 *  the link TEXT survives — a reply whose only content is a link must not become an empty message). */
export function safeHref(raw: string): string | null {
  const decoded = stripWhere(decodeEntitiesForUrlCheck(raw), isUrlNoise);
  if (!SAFE_SCHEME_RE.test(decoded)) return null;
  // Length cap: a megabyte-long href is a storage/DoS shape, not a link.
  if (decoded.length > 2048) return null;
  return decoded;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Index just past the `>` that closes a tag starting at `<`, honouring quoted attribute values so
 *  `<a title="a>b">` is one tag and not two. Returns -1 when the tag is never closed; the caller
 *  then DROPS the remainder, which is the fail-closed reading (an unterminated `<script` must not
 *  have its tail re-emitted as text). */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return -1;
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+)))?/g;

function readHref(attrText: string): string | null {
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrText)) !== null) {
    if (m[1].toLowerCase() !== "href") continue;
    return safeHref(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return null;
}

export interface SanitizeHtmlOptions {
  /** Hard cap on the EMITTED string, so a 5 MB input that sanitizes to 2 KB is not penalised and a
   *  pathological expansion cannot blow up the row. */
  maxLength?: number;
}

/**
 * Sanitizes untrusted inbound HTML to a generated, inert subset.
 *
 * Returns `null` when the input has no renderable content at all (empty, or nothing but dropped
 * elements) so the caller stores SQL NULL rather than an empty string the UI must special-case.
 */
export function sanitizeInboundHtml(input: string | null | undefined, opts: SanitizeHtmlOptions = {}): string | null {
  if (!input) return null;
  const maxLength = opts.maxLength ?? 256 * 1024;
  // NULs first: Postgres `text` rejects a NUL byte outright, and browsers historically ignored NUL
  // inside tag names (the `<scr[NUL]ipt>` shape) — removing it both avoids a hard write error and
  // collapses that bypass into a plain unknown tag.
  const html = stripWhere(input, (code) => code === NUL);

  const out: string[] = [];
  /** Only tags this function actually EMITTED are pushed here, so a close tag can never be emitted
   *  for something that was never opened. */
  const open: string[] = [];
  let length = 0;
  let truncated = false;

  const emit = (chunk: string): void => {
    if (truncated || !chunk) return;
    if (length + chunk.length > maxLength) {
      truncated = true;
      return;
    }
    out.push(chunk);
    length += chunk.length;
  };

  let i = 0;
  while (i < html.length && !truncated) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      emit(escapeText(html.slice(i)));
      break;
    }
    if (lt > i) emit(escapeText(html.slice(i, lt)));

    // Comments, including IE conditional comments whose payload sits INSIDE the comment and is
    // therefore dropped with it.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    // Doctype / CDATA / processing instruction — dropped, never re-emitted.
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = findTagEnd(html, lt + 2);
      i = end === -1 ? html.length : end;
      continue;
    }

    const closing = html[lt + 1] === "/";
    const nameStart = lt + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9]*/.exec(html.slice(nameStart, nameStart + 32));
    if (!nameMatch) {
      // A bare `<` that starts no tag is literal text.
      emit(escapeText("<"));
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const tagEnd = findTagEnd(html, nameStart + nameMatch[0].length);
    if (tagEnd === -1) break; // unterminated tag at EOF: drop the remainder (fail closed)
    const attrText = html.slice(nameStart + nameMatch[0].length, tagEnd - 1);

    if (SUBTREE_DROP_TAGS.has(name)) {
      // A close tag, or an XHTML-style self-closing `<svg/>`, has no subtree to skip — drop the tag
      // only. Without this guard a self-closed member would find no `</name>` and eat the remainder of
      // the message, the same content-loss bug the void elements caused.
      if (closing || attrText.trimEnd().endsWith("/")) {
        i = tagEnd;
        continue;
      }
      const closeRe = new RegExp(`</\\s*${name}\\b[^>]*>`, "i");
      const m = closeRe.exec(html.slice(tagEnd));
      i = m ? tagEnd + m.index + m[0].length : html.length;
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      // Unknown / disallowed-but-harmless tag: unwrap (drop the tag, keep the children).
      i = tagEnd;
      continue;
    }

    if (closing) {
      // Close only what we opened, innermost-first; a stray `</p>` with no matching open is dropped.
      const idx = open.lastIndexOf(name);
      if (idx !== -1) {
        for (let k = open.length - 1; k >= idx; k--) emit(`</${open[k]}>`);
        open.length = idx;
      }
      i = tagEnd;
      continue;
    }

    if (VOID_TAGS.has(name)) {
      emit(`<${name}>`);
      i = tagEnd;
      continue;
    }
    if (open.length >= MAX_DEPTH) {
      // Past the nesting cap the tag is unwrapped rather than emitted — deeply nested markup is a
      // renderer-DoS shape, and unwrapping preserves the text.
      i = tagEnd;
      continue;
    }
    if (name === "a") {
      const href = readHref(attrText);
      // `rel` is OUR literal, not the sender's: a surviving link must never be able to reach back
      // into the ERP tab (`noopener`), leak the approval URL as a referrer, or lend authority.
      emit(href ? `<a href="${escapeText(href)}" rel="noopener noreferrer nofollow">` : "<a>");
    } else {
      emit(`<${name}>`);
    }
    open.push(name);
    i = tagEnd;
  }

  for (let k = open.length - 1; k >= 0; k--) out.push(`</${open[k]}>`);
  const result = out.join("");
  const hasText = result.replace(/<[^>]*>/g, "").trim().length > 0;
  return hasText || /<(br|hr)>/.test(result) ? result : null;
}

/** Plain-text body hygiene. `body_text` is NOT NULL in the DDL, so this always returns a string.
 *
 *  NO semantic trimming happens here. Quoted-history removal is deliberately a RENDER concern
 *  (MAIL-20) and not an intake one: intake caps and records, never interprets.
 *
 *  CAP SHAPE (design A15 / MAIL-19, superseding the earlier head-only cap): for an over-cap body,
 *  this keeps BOTH the head (~¾ of `maxLength`) and the tail (~¼) with an explicit elision marker
 *  spliced in at the boundary between them. The reason is a real defect the head-only cap had: a
 *  **bottom-posted** reply — the human's actual words BELOW a long quoted thread — could be
 *  truncated away entirely, and because the raw MIME is never stored, that loss was permanent. A
 *  head+tail cap survives the reply at EITHER end regardless of whether the sender top- or
 *  bottom-posts, without this function ever having to guess where the quoted history begins — that
 *  guess is exactly what §7.6/A15 forbids at intake and defers to MAIL-20's render-side collapse,
 *  where a wrong guess costs a click instead of destroying data.
 *
 *  The split point and the marker's `N` are computed ENTIRELY from `raw.length` and `maxLength` —
 *  never from the input's content. That is what makes the marker un-forgeable: a sender who embeds
 *  text shaped like `[truncated at intake: ... ]` gets it stored back as ordinary text, wherever it
 *  landed in the kept head/tail (or dropped, if it landed in the omitted middle, exactly like any
 *  other content there) — it can never suppress, relocate, or relabel the ONE marker this function
 *  itself inserts.
 *
 *  MAIL-25: the returned `truncated`/`truncatedChars` pair is the STRUCTURED signal that makes the
 *  fact-of-truncation trustworthy downstream. It is derived from this SAME length arithmetic — never
 *  by scanning `text` for the marker string — so a sender who plants marker-shaped decoy text in the
 *  body has zero influence over it. The caller (`./intake.ts`) persists it onto
 *  `mail_messages.body_truncated`/`body_truncated_chars` (migration
 *  `0082_mail_truncation_metadata.sql`); the render layer
 *  (`platform-ui/src/components/mail/QuotedMessageBody.tsx`) renders its truncation notice from THAT
 *  column pair only, never from matching the marker text — see that file's header comment for the
 *  render-side half of this guarantee. */
export function sanitizeInboundText(
  input: string | null | undefined,
  maxLength = 128 * 1024,
): { text: string; truncated: boolean; truncatedChars: number } {
  const raw = stripWhere((input ?? "").replace(/\r\n?/g, "\n"), isTextControl);
  if (raw.length <= maxLength) return { text: raw, truncated: false, truncatedChars: 0 };

  const headLen = Math.ceil(maxLength * 0.75);
  const tailLen = maxLength - headLen;
  const omitted = raw.length - headLen - tailLen; // == raw.length - maxLength; kept as three terms
                                                   // so the arithmetic mirrors the actual slice below
  const head = raw.slice(0, headLen);
  const tail = tailLen > 0 ? raw.slice(raw.length - tailLen) : "";
  return {
    text: `${head}\n[truncated at intake: ${omitted} characters omitted here]\n${tail}`,
    truncated: true,
    truncatedChars: omitted,
  };
}

/** Header-ish single-line text (subject, attachment filename). Strips CR/LF — so a stored subject
 *  can never be replayed into an outbound header, the same injection class `../sanitize.ts` closes
 *  on the send side — removes control characters, collapses whitespace runs, and caps length. Stored
 *  as PLAIN TEXT in a `text` column and rendered as text, never as markup. */
export function sanitizeInboundHeaderText(input: string | null | undefined, maxLength = 512): string | null {
  if (input == null) return null;
  const stripped = replaceWhere(String(input), isLineControl);
  const clean = stripped.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return clean.length ? clean : null;
}

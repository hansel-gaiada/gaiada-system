// WSK-41 — content_items.search_text for a written projection (write-plane design §3.3: "search_text
// is the string leaves of `blocks`, <= 64 KiB"). 0002's trigger builds search_vector from slug, seo
// title/description and this column, in the row's own locale's text-search config.
//
// Pure. Walks `blocks` depth-first in array order and object insertion order, collects every
// non-empty string leaf (block `type` names are skipped: they are vocabulary, not content), joins
// them with single spaces, and truncates to SEARCH_TEXT_MAX_BYTES of UTF-8 without splitting a
// character.

export const SEARCH_TEXT_MAX_BYTES = 64 * 1024;

function collect(value: unknown, out: string[], isBlockList: boolean): void {
  if (typeof value === "string") {
    const t = value.trim();
    if (t.length > 0) out.push(t);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, false);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isBlockList && k === "type") continue;
      collect(v, out, false);
    }
  }
}

/** Truncates `text` to at most `maxBytes` of UTF-8, never cutting a code point in half. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  // buf[end] is the first byte left out. While it is a UTF-8 continuation byte (10xxxxxx), the cut
  // falls inside a character: move it back to that character's lead byte.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export function extractSearchText(blocks: unknown): string {
  const out: string[] = [];
  if (Array.isArray(blocks)) {
    for (const b of blocks) collect(b, out, true);
  } else {
    collect(blocks, out, false);
  }
  return truncateUtf8(out.join(" "), SEARCH_TEXT_MAX_BYTES);
}

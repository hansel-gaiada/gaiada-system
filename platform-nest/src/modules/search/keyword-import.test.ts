// SM-09 — keyword import parsing (CSV / paste). Pure function, no DB/network.
import { describe, it, expect } from "vitest";
import { parseKeywordImport, UnterminatedQuoteError } from "./keyword-import";

describe("parseKeywordImport", () => {
  it("parses a plain paste (one keyword per line) with the default locale", () => {
    expect(parseKeywordImport("running shoes\nbest running shoes\n\ncheap running shoes")).toEqual([
      { keyword: "running shoes", locale: "id-ID" },
      { keyword: "best running shoes", locale: "id-ID" },
      { keyword: "cheap running shoes", locale: "id-ID" },
    ]);
  });

  it("parses CSV with a header row (keyword,locale)", () => {
    expect(parseKeywordImport("keyword,locale\nrunning shoes,en-US\nsepatu lari,id-ID")).toEqual([
      { keyword: "running shoes", locale: "en-US" },
      { keyword: "sepatu lari", locale: "id-ID" },
    ]);
  });

  it("parses CSV without a header row", () => {
    expect(parseKeywordImport("running shoes,en-US\nsepatu lari,id-ID")).toEqual([
      { keyword: "running shoes", locale: "en-US" },
      { keyword: "sepatu lari", locale: "id-ID" },
    ]);
  });

  it("falls back to the caller's default locale when a CSV row omits it", () => {
    expect(parseKeywordImport("running shoes,\nbest running shoes", "en-US")).toEqual([
      { keyword: "running shoes", locale: "en-US" },
      { keyword: "best running shoes", locale: "en-US" },
    ]);
  });

  it("strips surrounding quotes", () => {
    expect(parseKeywordImport('"running shoes","en-US"')).toEqual([{ keyword: "running shoes", locale: "en-US" }]);
  });

  it("dedupes case-insensitively within the same locale, keeping first occurrence", () => {
    expect(parseKeywordImport("Running Shoes\nrunning shoes\nRUNNING SHOES")).toEqual([{ keyword: "Running Shoes", locale: "id-ID" }]);
  });

  it("keeps the same keyword under two different locales as two rows", () => {
    expect(parseKeywordImport("keyword,locale\nrunning shoes,en-US\nrunning shoes,id-ID")).toEqual([
      { keyword: "running shoes", locale: "en-US" },
      { keyword: "running shoes", locale: "id-ID" },
    ]);
  });

  it("skips blank lines and returns [] for empty/whitespace-only input", () => {
    expect(parseKeywordImport("")).toEqual([]);
    expect(parseKeywordImport("   \n\n  \n")).toEqual([]);
    expect(parseKeywordImport("\n\nrunning shoes\n\n\nbread\n")).toEqual([
      { keyword: "running shoes", locale: "id-ID" },
      { keyword: "bread", locale: "id-ID" },
    ]);
  });

  it("skips a row whose keyword column is empty even with a locale present", () => {
    expect(parseKeywordImport("keyword,locale\n,en-US\nrunning shoes,en-US")).toEqual([{ keyword: "running shoes", locale: "en-US" }]);
  });

  // ── ADVERSARIAL (QA, SM-09): hostile/edge input ─────────────────────────────────────────────────

  // FIXED (SM-32): parseKeywordImport now tokenizes with a quote-aware state machine (parseCsvRows)
  // BEFORE any row/column splitting, so a properly RFC4180-quoted field containing a comma —
  // e.g. `"running, jogging shoes",en-US` — is preserved as ONE field instead of being split on the
  // comma inside the quotes. This test used to pin the old, defective output; it now asserts the
  // correct behaviour that was previously left commented out as the fix target.
  it("preserves a quoted field containing a comma instead of corrupting it (CSV-quoting fix)", () => {
    const rows = parseKeywordImport('"running, jogging shoes",en-US');
    expect(rows).toEqual([{ keyword: "running, jogging shoes", locale: "en-US" }]);
  });

  // FIXED (same root cause, SM-32): a value with an embedded literal newline, correctly
  // RFC4180-quoted, is now kept as one field/row — the tokenizer only treats \r\n/\n as a row
  // separator OUTSIDE a quoted field, so a quoted newline is preserved as part of the field's
  // content instead of splitting the row in two.
  it("preserves a quoted field containing a literal newline as one row (CSV-quoting fix)", () => {
    const rows = parseKeywordImport('"multi\nline keyword",en-US');
    expect(rows).toEqual([{ keyword: "multi\nline keyword", locale: "en-US" }]);
  });

  // NEW (SM-32): escaped `""` inside a quoted field decodes to one literal `"`.
  it("decodes an escaped double-quote (\"\") inside a quoted field to a literal quote", () => {
    const rows = parseKeywordImport('"6\"\" heels",en-US');
    expect(rows).toEqual([{ keyword: '6" heels', locale: "en-US" }]);
  });

  // NEW (SM-32): an unterminated quote must be rejected, never silently mangled or hung on.
  it("throws UnterminatedQuoteError on an unterminated quoted field rather than hanging or mangling", () => {
    expect(() => parseKeywordImport('"running shoes,en-US')).toThrow(UnterminatedQuoteError);
  });

  it("preserves unicode/multi-byte keywords (no mangling) and dedupes them case-insensitively", () => {
    expect(parseKeywordImport("sepatu lari 👟\nSEPATU LARI 👟\nCafé münchen\ncafé münchen")).toEqual([
      { keyword: "sepatu lari 👟", locale: "id-ID" },
      { keyword: "Café münchen", locale: "id-ID" },
    ]);
  });

  it("does not blow up on a large paste (10k lines) and preserves the exact deduped count", () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `keyword number ${i}`);
    const rows = parseKeywordImport(lines.join("\n"));
    expect(rows).toHaveLength(10_000);
    expect(rows[0]).toEqual({ keyword: "keyword number 0", locale: "id-ID" });
    expect(rows[9999]).toEqual({ keyword: "keyword number 9999", locale: "id-ID" });
  });

  it("treats \\r\\n and bare \\n line endings identically (mixed line endings in one paste)", () => {
    expect(parseKeywordImport("running shoes\r\nbest running shoes\ncheap running shoes\r\n")).toEqual([
      { keyword: "running shoes", locale: "id-ID" },
      { keyword: "best running shoes", locale: "id-ID" },
      { keyword: "cheap running shoes", locale: "id-ID" },
    ]);
  });
});

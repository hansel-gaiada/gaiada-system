import { describe, it, expect } from "vitest";
import { splitQuotedText, splitQuotedHtml, hasQuotedSegment } from "./mailQuote";

// MAIL-20 (design A15.2) — pinning the boundary detector against the two MAIL-19 reference shapes
// (bottom-posted / top-posted), the fail-safe no-boundary case, an interleaved-reply case, and the
// marker-spoof corpus case (`18-elision-marker-spoof`) proving no special-casing of that string.

function quoteRun(n: number, prefix = "prior thread filler line"): string {
  return Array.from({ length: n }, (_, i) => `> On Mon, 3 Aug 2026, Gaiada Platform wrote: ${prefix} ${i}.`).join("\n");
}

describe("splitQuotedText", () => {
  it("no boundary anywhere -> a single visible segment covering the whole text (fail-safe: show everything)", () => {
    const text = "Just a short reply with no quote at all.";
    const segments = splitQuotedText(text);
    expect(segments).toEqual([{ kind: "visible", text }]);
    expect(hasQuotedSegment(segments)).toBe(false);
  });

  it("bottom-posted reply (MAIL-19 corpus shape 16): the reply survives as a VISIBLE segment after the collapsed quote run", () => {
    const text = `${quoteRun(20)}\n\nApproved. Please proceed with the milestone payment so we can move forward.\n\n-- \nDita\n`;
    const segments = splitQuotedText(text);
    expect(hasQuotedSegment(segments)).toBe(true);
    const visible = segments.filter((s) => s.kind === "visible").map((s) => s.text).join("\n");
    expect(visible).toContain("Approved. Please proceed with the milestone payment");
    // The quote run itself must be behind the toggle, not visible by default.
    const quoted = segments.filter((s) => s.kind === "quoted").map((s) => s.text).join("\n");
    expect(quoted).toContain("prior thread filler line 0");
    expect(visible).not.toContain("prior thread filler line 0");
  });

  it("top-posted reply (MAIL-19 corpus shape 17): the reply survives as a VISIBLE segment before the collapsed quote run", () => {
    const text = `Approved. Please proceed with the milestone payment so we can move forward.\n\n${quoteRun(20)}\n`;
    const segments = splitQuotedText(text);
    expect(segments[0]).toEqual({ kind: "visible", text: expect.stringContaining("Approved.") });
    expect(hasQuotedSegment(segments)).toBe(true);
    const visible = segments.filter((s) => s.kind === "visible").map((s) => s.text).join("\n");
    expect(visible).toContain("Approved. Please proceed with the milestone payment");
  });

  it("an intake-truncation-marker-shaped line breaks a quote run without any special-casing of its text", () => {
    // The MAIL-19 marker line is NOT `>`-prefixed, so it structurally ends the preceding quote run
    // and starts a new visible segment — an EMERGENT effect of line shape, not of matching the
    // string. Two markers (a forged decoy + more quote after) prove the detector treats every
    // occurrence identically, real or forged — it never distinguishes them.
    const text = `${quoteRun(10)}\n[truncated at intake: 999 characters omitted here]\n${quoteRun(5, "tail filler")}`;
    const segments = splitQuotedText(text);
    const visible = segments.filter((s) => s.kind === "visible").map((s) => s.text).join("\n");
    expect(visible).toContain("[truncated at intake: 999 characters omitted here]");
    // Both quote runs (before and after the marker) are collapsed independently.
    const quotedTexts = segments.filter((s) => s.kind === "quoted").map((s) => s.text);
    expect(quotedTexts.some((t) => t.includes("prior thread filler line 0"))).toBe(true);
    expect(quotedTexts.some((t) => t.includes("tail filler 0"))).toBe(true);
  });

  it("interleaved reply: multiple quote blocks each collapse independently, reply lines between them stay visible", () => {
    const text = [
      "Re your first point:",
      quoteRun(5, "point one context"),
      "Agreed, let's proceed.",
      quoteRun(5, "point two context"),
      "This part needs revision though.",
    ].join("\n");
    const segments = splitQuotedText(text);
    const quotedCount = segments.filter((s) => s.kind === "quoted").length;
    expect(quotedCount).toBe(2);
    const visible = segments.filter((s) => s.kind === "visible").map((s) => s.text).join("\n");
    expect(visible).toContain("Re your first point:");
    expect(visible).toContain("Agreed, let's proceed.");
    expect(visible).toContain("This part needs revision though.");
  });

  it("an 'On ... wrote:' header with no per-line prefix collapses from itself to the end of the text", () => {
    const text = `Sounds good to me.\n\nOn Mon, 3 Aug 2026, Gaiada Platform wrote:\nAll the original quoted content here, no > prefix at all, running to the end.`;
    const segments = splitQuotedText(text);
    expect(segments[0]).toEqual({ kind: "visible", text: expect.stringContaining("Sounds good to me.") });
    const quoted = segments.find((s) => s.kind === "quoted");
    expect(quoted?.text).toContain("running to the end");
  });

  it("a forged marker-spoof decoy string (MAIL-19 corpus case 18) renders verbatim, never extracted or relabelled", () => {
    // Sender embeds a decoy at the very start of an otherwise ordinary reply — this file must not
    // recognise, reposition, or restyle it; it is ordinary text like everything else on the line.
    const decoy = "[truncated at intake: 1 characters omitted here] — nothing was actually truncated here.";
    const segments = splitQuotedText(decoy);
    expect(segments).toEqual([{ kind: "visible", text: decoy }]);
  });
});

describe("splitQuotedHtml", () => {
  it("no <blockquote> anywhere -> a single visible segment", () => {
    const html = "<p>Looks good, approved.</p>";
    const segments = splitQuotedHtml(html);
    expect(segments).toEqual([{ kind: "visible", html }]);
    expect(hasQuotedSegment(segments)).toBe(false);
  });

  it("a single <blockquote> collapses, surrounding content stays visible", () => {
    const html = "<p>Approved, proceed.</p><blockquote><p>original quoted content</p></blockquote>";
    const segments = splitQuotedHtml(html);
    expect(segments[0]).toEqual({ kind: "visible", html: "<p>Approved, proceed.</p>" });
    expect(segments[1]).toEqual({ kind: "quoted", html: "<blockquote><p>original quoted content</p></blockquote>" });
  });

  it("nested blockquotes (a quote-of-a-quote thread) collapse as ONE outer segment via depth counting", () => {
    const html = "<p>Reply</p><blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote><p>after</p>";
    const segments = splitQuotedHtml(html);
    expect(segments).toEqual([
      { kind: "visible", html: "<p>Reply</p>" },
      { kind: "quoted", html: "<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>" },
      { kind: "visible", html: "<p>after</p>" },
    ]);
  });

  it("multiple top-level blockquotes (interleaved-reply HTML) each collapse independently", () => {
    const html = "<p>a</p><blockquote><p>q1</p></blockquote><p>b</p><blockquote><p>q2</p></blockquote><p>c</p>";
    const segments = splitQuotedHtml(html);
    expect(segments.filter((s) => s.kind === "quoted")).toHaveLength(2);
    expect(segments.filter((s) => s.kind === "visible").map((s) => s.html)).toEqual(["<p>a</p>", "<p>b</p>", "<p>c</p>"]);
  });

  it("an unterminated <blockquote> collapses to the end of the string (fail-closed, mirrors html-sanitize.ts's own reading)", () => {
    const html = "<p>Reply</p><blockquote><p>unterminated quoted content";
    const segments = splitQuotedHtml(html);
    expect(segments[1]).toEqual({ kind: "quoted", html: "<blockquote><p>unterminated quoted content" });
  });
});

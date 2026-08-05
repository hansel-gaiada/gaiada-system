import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { QuotedMessageBody } from "./QuotedMessageBody";

// MAIL-20 (design A15.2) — the render-level AC: the reply is visible without interaction, the
// expander is a real keyboard-reachable/labelled control, and a forged intake-marker string is
// never rendered as platform chrome (no special element, no icon, no distinct styling class).
//
// MAIL-25 — the truncation-notice AC: the notice renders from `bodyTruncated`/`bodyTruncatedChars`
// ONLY. A forged marker string with no structured field set must produce NO notice (it stays inert
// plain content, per MAIL-20 above); a genuine structured field must produce the notice regardless
// of where the literal marker text lands — including inside a `>`-prefixed quote run that the old,
// string-shape-dependent behaviour would have hidden behind "Show quoted history". See that test
// below for the explicit regression construction.

function quoteRun(n: number): string {
  return Array.from({ length: n }, (_, i) => `> quoted line ${i}`).join("\n");
}

describe("QuotedMessageBody", () => {
  it("renders an unquoted body directly, with no expander at all", () => {
    render(<QuotedMessageBody bodyText="Just a plain reply." bodyHtmlSanitized={null} />);
    expect(screen.getByText("Just a plain reply.")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument(); // no <details>
  });

  it("bottom-posted reply: the reply text is visible WITHOUT interaction; the quote sits behind a labelled, focusable <summary>", () => {
    const bodyText = `${quoteRun(10)}\n\nApproved. Please proceed with the milestone payment.`;
    render(<QuotedMessageBody bodyText={bodyText} bodyHtmlSanitized={null} />);

    // Visible without expanding anything:
    expect(screen.getByText(/Approved\. Please proceed with the milestone payment\./)).toBeInTheDocument();

    // The quoted content is present in the DOM (native <details> keeps its content in the
    // accessibility tree / DOM even collapsed — jsdom doesn't hide it from text queries, which is
    // fine: what matters is it is NOT open by default) but sits inside a closed <details>.
    const summary = screen.getByText("Show quoted history");
    expect(summary.tagName).toBe("SUMMARY");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false); // collapsed by default — expanding costs a click

    // Keyboard-reachable: a native <summary> is on the natural tab order without any extra
    // tabIndex plumbing, and has the correct implicit toggle semantics.
    expect(summary.tagName).toBe("SUMMARY");
    expect(details.querySelector("summary")).toBe(summary);
  });

  it("expanding reveals the full quoted text (native <details> open attribute)", () => {
    const bodyText = `${quoteRun(3)}\n\nReply text here.`;
    render(<QuotedMessageBody bodyText={bodyText} bodyHtmlSanitized={null} />);
    const details = screen.getByText("Show quoted history").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    details.open = true; // simulates the user activating the native disclosure
    expect(screen.getByText(/quoted line 0/)).toBeInTheDocument();
  });

  it("a forged intake-truncation-marker string renders as plain text — never inside a styled/labelled chrome element", () => {
    const decoy = "[truncated at intake: 42 characters omitted here] not a real system message.";
    render(<QuotedMessageBody bodyText={decoy} bodyHtmlSanitized={null} />);
    const node = screen.getByText(decoy);
    // Plain <pre>, not wrapped in a <details>/summary or any element carrying a distinguishing role.
    expect(node.tagName).toBe("PRE");
    expect(screen.queryByText("Show quoted history")).not.toBeInTheDocument();
  });

  it("HTML body: the quoted <blockquote> collapses behind the same labelled toggle, reply text stays visible", () => {
    const html = "<p>Approved, proceed.</p><blockquote><p>original quoted content</p></blockquote>";
    render(<QuotedMessageBody bodyText="" bodyHtmlSanitized={html} />);
    expect(screen.getByText("Approved, proceed.")).toBeInTheDocument();
    const summary = screen.getByText("Show quoted history");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  // ── MAIL-25: the structured truncation notice ─────────────────────────────────────────────────
  describe("truncation notice (MAIL-25)", () => {
    it("[AC] a truncated message renders the notice from the structured field, with the correct count", () => {
      render(
        <QuotedMessageBody
          bodyText="Approved. Ship it."
          bodyHtmlSanitized={null}
          bodyTruncated={true}
          bodyTruncatedChars={3000}
        />,
      );
      expect(screen.getByText(/3,000/)).toBeInTheDocument();
      expect(screen.getByText("Approved. Ship it.")).toBeInTheDocument();
    });

    it("[AC] a forged marker with NO structured field renders as inert plain text — no notice, no chrome at all", () => {
      // Same decoy shape as the corpus's `18-elision-marker-spoof` case, and no `bodyTruncated` prop
      // supplied (defaults to false) — exactly what a real forged message looks like to this
      // component, since intake never lets a forged marker set the structured field either.
      const decoy = "[truncated at intake: 999999999 characters omitted here]";
      render(<QuotedMessageBody bodyText={`${decoy} Approved, proceed with deployment.`} bodyHtmlSanitized={null} />);
      // The decoy text is present as ordinary content...
      expect(screen.getByText(/999999999 characters omitted here/)).toBeInTheDocument();
      // ...but NO notice element exists anywhere. `role="note"` is the exact element the real
      // notice would use, so its absence isn't a fluke of a different phrasing.
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });

    it("[AC — the regression this ticket exists to prevent] a GENUINE marker whose line is `>`-prefixed still renders the notice", () => {
      // Constructed explicitly: the literal marker substring sits on a `>`-prefixed line, sandwiched
      // inside a quote run — the exact shape that the OLD emergent behaviour (a bare-line marker
      // breaking the quote run) depended on NOT happening. Under the old logic this marker text
      // would have been swept into the collapsed `<details>` and hidden by default; the structured
      // notice must appear regardless, because it does not look at `bodyText` at all.
      const bodyText = [
        "> On Mon, 3 Aug 2026, Gaiada Platform wrote: prior context 0.",
        "> On Mon, 3 Aug 2026, Gaiada Platform wrote: prior context 1.",
        "> [truncated at intake: 5000 characters omitted here]",
        "> On Mon, 3 Aug 2026, Gaiada Platform wrote: prior context 2.",
        "",
        "Approved. Ship it.",
      ].join("\n");

      render(<QuotedMessageBody bodyText={bodyText} bodyHtmlSanitized={null} bodyTruncated={true} bodyTruncatedChars={5000} />);

      // The notice is visible WITHOUT expanding anything — it sits outside the collapse entirely.
      expect(screen.getByText(/5,000/)).toBeInTheDocument();
      // The marker's own line is indeed folded into the collapsed quote run (proving the regression
      // scenario is real: the raw text is hidden by default)...
      const summary = screen.getByText("Show quoted history");
      const details = summary.closest("details") as HTMLDetailsElement;
      expect(details.open).toBe(false);
      // ...yet the structured notice rendered anyway, because it never looked at that text.
      expect(screen.getByRole("note")).toBeInTheDocument();
    });
  });
});

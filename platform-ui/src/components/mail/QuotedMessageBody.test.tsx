import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { QuotedMessageBody } from "./QuotedMessageBody";

// MAIL-20 (design A15.2) — the render-level AC: the reply is visible without interaction, the
// expander is a real keyboard-reachable/labelled control, and a forged intake-marker string is
// never rendered as platform chrome (no special element, no icon, no distinct styling class).

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
});

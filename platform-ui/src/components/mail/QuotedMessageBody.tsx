import { hasQuotedSegment, splitQuotedHtml, splitQuotedText } from "@/lib/mailQuote";

// MAIL-20 — the shared render for an inbound mail body, quote-collapsed (design A15.2, §7.6 v4).
// Used by both `MailThreadPanel` (entity/portal thread panels) and the admin mail detail page —
// one implementation, so the collapse behaves identically on every surface that shows an inbound
// reply. The split is computed by `lib/mailQuote.ts` fresh on every render from whatever
// `bodyText`/`bodyHtmlSanitized` the BFF handed us; NOTHING here is persisted anywhere (design
// binding: "computed at render, never stored").
//
// No client JS: `<details>`/`<summary>` is a native, keyboard-operable (Tab to focus, Enter/Space
// to toggle), screen-reader-labelled disclosure widget, so the expand affordance needs no
// "use client" boundary and works with JS disabled.
//
// SECURITY NOTE — sender-controlled text must never render as platform chrome (ticket brief, MAIL-
// 19's `18-elision-marker-spoof` corpus case): this component applies exactly ONE unstyled
// treatment to sender content — plain text/HTML inside a plain `<pre>`/div, or the same inside a
// bare `<details>` whose only chrome is the literal label "Show quoted history" that this file
// itself writes (never sender-supplied text). Nothing sender-controlled is ever read to decide
// what to LABEL, ICON, or STYLE — only to decide, via `lib/mailQuote.ts`'s purely structural
// detector (a `>`-prefix, a `<blockquote>` tag), which existing chunk of the message goes behind
// the toggle. A forged `[truncated at intake: ...]` string is never detected, extracted, or
// special-cased here: it renders as ordinary sender text, wherever the structural split places it,
// exactly like the rest of the message. See `lib/mailQuote.ts`'s header comment for the full
// reasoning on why no structured signal exists to do better, and what would be needed to.
export function QuotedMessageBody({
  bodyText,
  bodyHtmlSanitized,
}: {
  bodyText: string;
  bodyHtmlSanitized: string | null;
}) {
  if (bodyHtmlSanitized) {
    const segments = splitQuotedHtml(bodyHtmlSanitized);
    if (!hasQuotedSegment(segments)) {
      return <div dangerouslySetInnerHTML={{ __html: bodyHtmlSanitized }} />;
    }
    return (
      <>
        {segments.map((seg, i) =>
          seg.kind === "visible" ? (
            seg.html ? <div key={i} dangerouslySetInnerHTML={{ __html: seg.html }} /> : null
          ) : (
            <details key={i} style={{ margin: "6px 0" }}>
              <summary style={{ cursor: "pointer", font: "500 12px var(--font-body)", color: "var(--ink-subtle)" }}>
                Show quoted history
              </summary>
              <div dangerouslySetInnerHTML={{ __html: seg.html }} />
            </details>
          ),
        )}
      </>
    );
  }

  const segments = splitQuotedText(bodyText);
  if (!hasQuotedSegment(segments)) {
    return <pre style={{ whiteSpace: "pre-wrap", margin: 0, font: "inherit" }}>{bodyText}</pre>;
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "visible" ? (
          seg.text ? (
            <pre key={i} style={{ whiteSpace: "pre-wrap", margin: 0, font: "inherit" }}>
              {seg.text}
            </pre>
          ) : null
        ) : (
          <details key={i} style={{ margin: "6px 0" }}>
            <summary style={{ cursor: "pointer", font: "500 12px var(--font-body)", color: "var(--ink-subtle)" }}>
              Show quoted history
            </summary>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, font: "inherit" }}>{seg.text}</pre>
          </details>
        ),
      )}
    </>
  );
}

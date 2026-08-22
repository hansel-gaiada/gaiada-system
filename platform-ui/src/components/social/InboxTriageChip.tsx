// SMM-18 — the four-state AI-triage chip. Pure presentational; no hooks, safe in either a server
// or a client tree. `describeTriage` (lib/socialShared.ts) does the branching; this only draws it.
//
// The FOUR states must look nothing alike, on purpose (criterion 5 + this ticket's own named risk,
// "launder a guess into a fact"):
//   - `absent` ("unclassified")   — dashed border, italic, muted: signals "nobody has looked".
//   - `unavailable`               — dashed border like `absent` (also a non-answer) but SOLID
//                                    caution colour + non-italic label, so it reads as "we tried and
//                                    failed", never confused with "never tried".
//   - `classified`                — solid border, normal weight, coloured by sentiment: a REAL
//                                    answer, even a boring "neutral" one.
//   - `purged`                    — its own distinct treatment: a small lock glyph + explicit
//                                    "purged" wording in the caution family, framed as a compliance
//                                    fact, never styled like an error (never the critical/red family).
import type { CSSProperties } from "react";
import type { InboxThread } from "@/lib/socialShared";
import { describeTriage } from "@/lib/socialShared";

function sentimentColor(sentiment: InboxThread["sentiment"]): string {
  switch (sentiment) {
    case "positive": return "var(--status-ok-fg, #1a7f37)";
    case "negative":
    case "urgent": return "var(--status-critical-fg, #b3261e)";
    default: return "var(--erp-ink-60)";
  }
}

export function InboxTriageChip({
  thread,
}: {
  thread: Pick<InboxThread, "aiTriageStatus" | "sentiment" | "category" | "urgency">;
}) {
  const d = describeTriage(thread);
  const base: CSSProperties = {
    display: "inline-flex", flexDirection: "column", gap: 2, padding: "3px 8px",
    border: "0.5px solid var(--erp-hairline)", font: "600 11px var(--font-body)",
  };

  if (d.visual === "absent") {
    return (
      <span style={{ ...base, borderStyle: "dashed", color: "var(--erp-ink-50)", fontStyle: "italic", fontWeight: 400 }} title={d.detail}>
        {d.label}
      </span>
    );
  }
  if (d.visual === "unavailable") {
    return (
      <span style={{ ...base, borderStyle: "dashed", borderColor: "var(--status-caution-fg, #9a6700)", color: "var(--status-caution-fg, #9a6700)" }} title={d.detail}>
        ⚠ {d.label}
      </span>
    );
  }
  if (d.visual === "purged") {
    return (
      <span style={{ ...base, borderColor: "var(--status-caution-fg, #9a6700)", color: "var(--status-caution-fg, #9a6700)", background: "var(--tint-hover)" }} title={d.detail}>
        <span>🔒 {d.label}</span>
        <span style={{ font: "400 10px/1.3 var(--font-body)", color: "var(--erp-ink-50)", fontWeight: 400, maxWidth: 220, whiteSpace: "normal" }}>
          Retention compliance — not a failure.
        </span>
      </span>
    );
  }
  // classified — a real answer, coloured by sentiment.
  return (
    <span style={{ ...base, color: sentimentColor(thread.sentiment) }} title={d.detail}>
      {d.label}
    </span>
  );
}

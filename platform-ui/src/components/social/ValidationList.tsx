// SMM-11 — renders a variant's `{ok, errors[], warnings[]}` validation result INLINE, against the
// `rule` TOKEN (never by matching `message` prose — docs/FRONTEND-BFF-CONTRACT.md §19's binding
// rule: "the rule is a snake_case token — render against the token"). Errors block a submit;
// warnings never do — that distinction is why the two arrays get visually different treatment
// here rather than one flat list.
//
// Two tokens get an explicit second badge on top of the ordinary warning styling, per the owner
// decisions this ticket must render honestly:
//   `quota_unknown`   — "the registry hasn't synced," never "zero used." Plain amber would read as
//                       just another soft warning; the extra "UNKNOWN, NOT ZERO" badge stops a
//                       reader from mentally rounding it down to "fine."
//   `body_over_base_limit` — X's soft 280-char floor: it warns, never blocks, because a premium
//                       account's real limit is invisible to us. Labelled "may still post" so it
//                       does not read as an error that got miscategorized.
import type { ValidationIssue } from "@/lib/socialShared";
import { QUOTA_UNKNOWN_RULE } from "@/lib/socialShared";

function IssueRow({ issue, tone }: { issue: ValidationIssue; tone: "critical" | "caution" }) {
  const color = tone === "critical" ? "var(--status-critical-fg, #b3261e)" : "var(--status-caution-fg, #9a6700)";
  return (
    <li style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
      <code
        style={{
          flex: "0 0 auto", font: "700 10px var(--font-mono, monospace)", letterSpacing: "0.02em",
          color, background: "var(--tint-hover)", border: `0.5px solid ${color}`, padding: "1px 5px",
          borderRadius: 2, whiteSpace: "nowrap",
        }}
      >
        {issue.rule}
      </code>
      <span style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--text-primary)" }}>
        {issue.message}
        {issue.rule === QUOTA_UNKNOWN_RULE && (
          <strong style={{ marginLeft: 6, color }}> (unknown — not zero)</strong>
        )}
        {issue.rule === "body_over_base_limit" && (
          <strong style={{ marginLeft: 6, color }}> (may still post on a premium account)</strong>
        )}
      </span>
    </li>
  );
}

export function ValidationList({ errors, warnings }: { errors: ValidationIssue[]; warnings: ValidationIssue[] }) {
  if (errors.length === 0 && warnings.length === 0) {
    return <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>No validation issues — publishable as far as content rules go.</p>;
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {errors.map((e, i) => <IssueRow key={`err-${i}-${e.rule}`} issue={e} tone="critical" />)}
      {warnings.map((w, i) => <IssueRow key={`warn-${i}-${w.rule}`} issue={w} tone="caution" />)}
    </ul>
  );
}

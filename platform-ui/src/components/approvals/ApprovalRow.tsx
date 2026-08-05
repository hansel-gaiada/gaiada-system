import Link from "next/link";
import type { ExecutionInfo, UnifiedApprovalItem } from "@/lib/approvalsShared";
import { ORIGIN_LABEL, formatAge } from "@/lib/approvalsShared";
import { StatusBadge } from "@/components/ui";
import "../dashboard/dashboard.css";
import "./approvals.css";

// A single row — pending (decidable/view-only) or decided (read-only history).
// Presentational only; `ApprovalsList` (its client-component parent) owns the
// decide/retry wiring, matching the split `NeedsMeQueue` already uses for its rows.
export function ApprovalRow({
  item,
  mode,
  note,
  onNoteChange,
  onDecide,
  busy,
  // D14-08 — the second, honest axis (decision vs. execution). `undefined` means "unknown to this
  // reader" (older backend, or this origin has no execution step at all) and renders NOTHING extra
  // — the ticket's explicit requirement that a `not_applicable`/unavailable row render EXACTLY as
  // today, not a noisier "empty" chip.
  executionInfo,
  canRetry,
  onRetry,
  retryBusy,
}: {
  item: UnifiedApprovalItem;
  mode: "pending" | "decided";
  note?: string;
  onNoteChange?: (v: string) => void;
  onDecide?: (decision: "approved" | "rejected") => void;
  busy?: boolean;
  executionInfo?: ExecutionInfo;
  canRetry?: boolean;
  onRetry?: () => void;
  retryBusy?: boolean;
}) {
  const showExecutionChip = !!executionInfo && executionInfo.status !== "not_applicable";
  const title = item.subjectHref ? (
    <Link href={item.subjectHref} className="needs-me-queue__title-link">{item.subject}</Link>
  ) : item.subject;

  return (
    <div className="needs-me-queue__row">
      <span className="approval-row__age" title={new Date(item.createdAt).toLocaleString()}>
        ⏱ {formatAge(item.ageMs)}
      </span>
      <div className="needs-me-queue__body">
        <div className="needs-me-queue__line">
          <span className="approval-row__origin">{ORIGIN_LABEL[item.origin]}</span>
          <span className="needs-me-queue__title">{title}</span>
        </div>
        <div className="needs-me-queue__meta">
          <span className="needs-me-queue__company">{item.company}</span>
          {item.previewUrl && (
            <>
              {" · "}
              <a href={item.previewUrl} target="_blank" rel="noreferrer" className="approval-row__preview">Preview</a>
            </>
          )}
        </div>
        {/* D14-08 — failed execution's reason belongs in the row body (like the preview link
            above), not squeezed into the actions rail alongside the badge/Retry button. */}
        {showExecutionChip && executionInfo!.status === "failed" && executionInfo!.error && (
          <div className="approval-row__exec-error" role="status">{executionInfo!.error}</div>
        )}
      </div>
      <div className="needs-me-queue__actions">
        {mode === "decided" ? (
          <>
            <span className="lux-badge">{item.status}</span>
            {showExecutionChip && (
              <StatusBadge label={executionInfo!.status} />
            )}
            {showExecutionChip && executionInfo!.status === "failed" && canRetry && (
              <button
                type="button"
                className="lux-btn lux-btn--ghost lux-btn--sm"
                disabled={retryBusy}
                onClick={onRetry}
              >
                {retryBusy ? "Retrying…" : "Retry"}
              </button>
            )}
          </>
        ) : item.decidable ? (
          <>
            {onNoteChange && (
              <input
                type="text"
                className="approval-row__note"
                placeholder="Note (optional)"
                value={note ?? ""}
                onChange={(e) => onNoteChange(e.target.value)}
                disabled={busy}
                aria-label={`Note for ${item.subject}`}
              />
            )}
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={busy} onClick={() => onDecide?.("approved")}>Approve</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={busy} onClick={() => onDecide?.("rejected")}>Deny</button>
          </>
        ) : item.subjectHref ? (
          <Link href={item.subjectHref} className="lux-btn lux-btn--ghost lux-btn--sm">View</Link>
        ) : null}
      </div>
    </div>
  );
}

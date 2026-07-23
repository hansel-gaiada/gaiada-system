import Link from "next/link";
import type { UnifiedApprovalItem } from "@/lib/approvalsShared";
import { ORIGIN_LABEL, formatAge } from "@/lib/approvalsShared";
import "../dashboard/dashboard.css";
import "./approvals.css";

// A single row — pending (decidable/view-only) or decided (read-only history).
// Presentational only; `ApprovalsList` (its client-component parent) owns the
// decide wiring, matching the split `NeedsMeQueue` already uses for its rows.
export function ApprovalRow({
  item,
  mode,
  note,
  onNoteChange,
  onDecide,
  busy,
}: {
  item: UnifiedApprovalItem;
  mode: "pending" | "decided";
  note?: string;
  onNoteChange?: (v: string) => void;
  onDecide?: (decision: "approved" | "rejected") => void;
  busy?: boolean;
}) {
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
      </div>
      <div className="needs-me-queue__actions">
        {mode === "decided" ? (
          <span className="lux-badge">{item.status}</span>
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

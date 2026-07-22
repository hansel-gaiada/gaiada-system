"use client";
import { useState } from "react";
import type { HrLeaveRequest } from "@/lib/hr";
import type { HrResult } from "@/lib/hrActions";
import { Toast } from "@/components/ui";
import { formatDate } from "@/lib/format";
import "@/components/dashboard/dashboard.css";

type Row = HrLeaveRequest & { tenantId: string; tenantName: string };
type Decide = (tenantId: string, approvalId: string, decision: "approved" | "rejected") => Promise<HrResult>;

// Pending leave approve/deny queue — same optimistic-remove-then-toast UX as
// components/dashboard/ApprovalsPanel.tsx, extended with the company label
// (relevant once scope=all fans multiple served companies into one list) and a
// per-row decidable flag (capability gates the ACTION, never the row's
// visibility — UX-2 §2.4/§1.6).
export function LeaveQueue({ items, decide, showCompany }: { items: Row[]; decide: Decide; showCompany: boolean }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const visible = items.filter((i) => !gone.has(i.id));

  async function act(row: Row, decision: "approved" | "rejected") {
    if (!row.approvalId) {
      setToast("This request has no linked approval yet — try refreshing.");
      setTimeout(() => setToast(null), 2200);
      return;
    }
    setGone((g) => new Set(g).add(row.id));
    const res = await decide(row.tenantId, row.approvalId, decision);
    if (!res.ok) {
      setGone((g) => { const n = new Set(g); n.delete(row.id); return n; });
      setToast(res.error ?? "That decision didn't go through — please try again.");
    } else {
      setToast(decision === "approved" ? "Approved — the balance and requester have been updated." : "Denied — the requester has been notified.");
    }
    setTimeout(() => setToast(null), 2600);
  }

  if (visible.length === 0) {
    return <div className="dash-empty"><p>Nothing needs a decision right now.</p></div>;
  }

  return (
    <div>
      {visible.map((r) => (
        <div key={r.id} className="dash-approval">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="dash-approval__title">
              {r.subjectName ?? r.subjectUserId} · {r.leaveType}
            </div>
            <div className="dash-approval__meta">
              {formatDate(r.startsOn)} – {formatDate(r.endsOn)} · {Math.round(r.minutes / 480 * 10) / 10}d
              {showCompany ? ` · ${r.tenantName}` : ""}
              {r.note ? ` · “${r.note}”` : ""}
            </div>
          </div>
          <div className="dash-approval__actions">
            <button title="Approve" className="dash-approval__btn dash-approval__btn--solid" onClick={() => act(r, "approved")}>✓</button>
            <button title="Deny" className="dash-approval__btn" onClick={() => act(r, "rejected")}>✕</button>
          </div>
        </div>
      ))}
      {toast && <Toast message={toast} />}
    </div>
  );
}

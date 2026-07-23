"use client";
import { useState } from "react";
import Link from "next/link";
import type { QueueItem } from "@/lib/queueUrgency";
import { urgencyBand } from "@/lib/queueUrgency";
import { Toast } from "@/components/ui";
import type { QueueDecideOrigin } from "@/app/(app)/actions";
import "./dashboard.css";

type Decide = (tenantId: string, origin: QueueDecideOrigin, originId: string, decision: "approved" | "rejected") => Promise<{ ok: boolean; error?: string }>;

const TYPE_LABEL: Record<QueueItem["type"], string> = {
  approval: "Approval",
  gate: "Gate",
  task: "Task",
  mention: "Mention",
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.floor((d.getTime() - startOfToday.getTime()) / 86_400_000);
  if (days < 0) return `Overdue · ${-days}d`;
  if (days === 0) return "Due today";
  if (days <= 6) return `Due ${d.toLocaleDateString(undefined, { weekday: "short" })}`;
  return `Due ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

// The shared ranked list — UX-2 §1.4. Used verbatim by both Home variants
// (CommandCenterHome/QueueAgendaHome); a client component only because
// approval/gate rows need optimistic decide + a toast (mirrors
// components/dashboard/ApprovalsPanel.tsx's own pattern).
export function NeedsMeQueue({ items, decide, emptyText }: { items: QueueItem[]; decide: Decide; emptyText?: string }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const visible = items.filter((i) => !gone.has(i.id));

  async function act(item: QueueItem, decision: "approved" | "rejected") {
    if (!item.origin || !item.originId) return;
    setGone((g) => new Set(g).add(item.id)); // optimistic
    const res = await decide(item.companyId, item.origin, item.originId, decision);
    if (!res.ok) {
      setGone((g) => { const n = new Set(g); n.delete(item.id); return n; });
      setToast(res.error ?? "That decision didn't go through — please try again.");
    } else {
      setToast(decision === "approved" ? "Approved — noted." : "Declined — noted.");
    }
    setTimeout(() => setToast(null), 2200);
  }

  if (visible.length === 0) {
    return (
      <div className="dash-empty">
        <p>{emptyText ?? "Nothing needs you right now."}</p>
      </div>
    );
  }

  return (
    <div className="needs-me-queue">
      {visible.map((item) => {
        const band = urgencyBand(item);
        const isApprovalLike = item.type === "approval" || item.type === "gate";
        const title = item.href ? (
          <Link href={item.href} className="needs-me-queue__title-link">{item.title}</Link>
        ) : item.title;
        return (
          <div key={item.id} className="needs-me-queue__row">
            <span className={`needs-me-queue__dot needs-me-queue__dot--${band}`} aria-hidden="true" />
            <div className="needs-me-queue__body">
              <div className="needs-me-queue__line">
                <span className="needs-me-queue__type">{TYPE_LABEL[item.type]}</span>
                <span className="needs-me-queue__title">{title}</span>
              </div>
              <div className="needs-me-queue__meta">
                <span className="needs-me-queue__company">{item.company}</span>
                {item.meta && <span className="needs-me-queue__meta-extra"> · {item.meta}</span>}
                {item.dueDate && <span className="needs-me-queue__due"> · {when(item.dueDate)}</span>}
              </div>
            </div>
            <div className="needs-me-queue__actions">
              {isApprovalLike ? (
                item.decidable ? (
                  <>
                    <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => act(item, "approved")}>Approve</button>
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => act(item, "rejected")}>Deny</button>
                  </>
                ) : item.href ? (
                  <Link href={item.href} className="lux-btn lux-btn--ghost lux-btn--sm">View</Link>
                ) : null
              ) : item.href ? (
                <Link href={item.href} className="lux-btn lux-btn--ghost lux-btn--sm">Open</Link>
              ) : null}
            </div>
          </div>
        );
      })}
      {toast && <Toast message={toast} />}
    </div>
  );
}

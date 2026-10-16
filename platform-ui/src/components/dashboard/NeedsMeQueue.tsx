"use client";
import { useId, useState } from "react";
import Link from "next/link";
import type { QueueItem } from "@/lib/queueUrgency";
import { urgencyBand } from "@/lib/queueUrgency";
import { Toast } from "@/components/ui";
import type { QueueDecideOrigin } from "@/app/(app)/actions";
import { ALERT_NOTE_MAX } from "@/lib/deptKpiAlertFormat";
import "./dashboard.css";

type Decide = (tenantId: string, origin: QueueDecideOrigin, originId: string, decision: "approved" | "rejected") => Promise<{ ok: boolean; error?: string }>;

/** DW-4j-2: the one action of a KPI alert row (BFF §43.5). The server decides who may; its sentence comes back in `error`. */
export type Acknowledge = (tenantId: string, alertId: string, note?: string) => Promise<{ ok: boolean; error?: string }>;

const TYPE_LABEL: Record<QueueItem["type"], string> = {
  approval: "Approval",
  gate: "Gate",
  task: "Task",
  mention: "Mention",
  conversation: "Conversation",
  alert: "KPI off track",
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

// The decide state of a ranked list: the optimistic "gone" set, the toast and the dispatch to the
// `decide` prop. Shared by `NeedsMeQueue` (the Home variants) and the Overview's Needs you block
// (DW-3c), so approving from either runs the very same code.
//
// DW-4j-2: a KPI alert has ONE action, Acknowledge, with an optional note, through the optional `acknowledge` prop. Without it the row offers
// "Open" (the KPI page) and nothing that would act. Like a decision, an acknowledged alert leaves the list at once and comes back with the
// server's sentence if the server refused.
export function useQueueDecisions(items: QueueItem[], decide: Decide, acknowledge?: Acknowledge) {
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

  async function ack(item: QueueItem, note: string) {
    if (!acknowledge || item.type !== "alert" || !item.originId) return;
    setGone((g) => new Set(g).add(item.id)); // optimistic
    let res: { ok: boolean; error?: string };
    try {
      res = await acknowledge(item.companyId, item.originId, note);
    } catch {
      res = { ok: false };
    }
    if (!res.ok) {
      setGone((g) => { const n = new Set(g); n.delete(item.id); return n; });
      setToast(res.error ?? "That acknowledgement didn't go through — please try again.");
      setTimeout(() => setToast(null), 5000);
    } else {
      setToast("Acknowledged — noted.");
      setTimeout(() => setToast(null), 2200);
    }
  }

  return { visible, act, ack: acknowledge ? ack : undefined, toast };
}

/** The Acknowledge control of a KPI alert row: one button, and an optional note that stays collapsed until asked for. */
function AckControl({ item, ack }: { item: QueueItem; ack: (item: QueueItem, note: string) => void }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const id = useId();
  return (
    <div className="needs-me-queue__ack">
      <div className="needs-me-queue__ack-buttons">
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => ack(item, note)}>Acknowledge</button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-expanded={noting} aria-controls={id}
          onClick={() => setNoting((n) => !n)}>
          {noting ? "Hide note" : "Add a note"}
        </button>
      </div>
      {noting && (
        <textarea id={id} className="needs-me-queue__ack-note" rows={2} maxLength={ALERT_NOTE_MAX} value={note}
          aria-label={`Note for ${item.title} (optional)`} placeholder="Note (optional)" onChange={(e) => setNote(e.target.value)} />
      )}
    </div>
  );
}

/** The rows of a ranked list, with each row's Approve/Deny/View/Open control. `showCompany` tags each row with
 *  its company (always, on the Home); the Overview turns it off for someone with a single company. */
export function QueueRows({ items, act, ack, showCompany = true }: {
  items: QueueItem[];
  act: (item: QueueItem, decision: "approved" | "rejected") => void;
  /** Acknowledge a KPI alert (DW-4j-2). Absent: an alert row offers "Open" only. */
  ack?: (item: QueueItem, note: string) => void;
  showCompany?: boolean;
}) {
  return (
    <div className="needs-me-queue">
      {items.map((item) => {
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
                {showCompany && <span className="needs-me-queue__company">{item.company}</span>}
                {item.meta && <span className="needs-me-queue__meta-extra">{showCompany ? " · " : ""}{item.meta}</span>}
                {item.dueDate && <span className="needs-me-queue__due">{showCompany || item.meta ? " · " : ""}{when(item.dueDate)}</span>}
              </div>
            </div>
            <div className="needs-me-queue__actions">
              {item.type === "alert" ? (
                item.decidable && ack ? (
                  <AckControl item={item} ack={ack} />
                ) : item.href ? (
                  <Link href={item.href} className="lux-btn lux-btn--ghost lux-btn--sm">Open</Link>
                ) : null
              ) : isApprovalLike ? (
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
    </div>
  );
}

// The shared ranked list — UX-2 §1.4. Its rows and decide hook (`QueueRows`, `useQueueDecisions`) draw the Overview's
// Needs you block. A client component only because approval/gate rows need optimistic decide + a toast (mirrors
// components/dashboard/ApprovalsPanel.tsx's own pattern).
export function NeedsMeQueue({ items, decide, acknowledge, emptyText }: { items: QueueItem[]; decide: Decide; acknowledge?: Acknowledge; emptyText?: string }) {
  const { visible, act, ack, toast } = useQueueDecisions(items, decide, acknowledge);

  if (visible.length === 0) {
    return (
      <div className="dash-empty">
        <p>{emptyText ?? "Nothing needs you right now."}</p>
      </div>
    );
  }

  return (
    <>
      <QueueRows items={visible} act={act} ack={ack} />
      {toast && <Toast message={toast} />}
    </>
  );
}

"use client";
import { useState } from "react";
import type { ApprovalOrigin, UnifiedApprovalItem } from "@/lib/approvalsShared";
import { Toast } from "@/components/ui";
import { ApprovalRow } from "./ApprovalRow";
import "../dashboard/dashboard.css";

type Decide = (
  tenantId: string,
  origin: ApprovalOrigin,
  id: string,
  decision: "approved" | "rejected",
  note?: string,
) => Promise<{ ok: boolean; error?: string }>;

// The inbox's ranked row list — a client component only because decidable
// rows need optimistic decide + a toast (mirrors NeedsMeQueue's own pattern,
// UX-2 §1.4/§2.1). `mode` governs whether rows render actions at all: pending
// rows show Approve/Deny (+ optional note) when `decidable`, else a View
// deep-link; decided rows are read-only history (a status badge).
export function ApprovalsList({
  items,
  mode,
  decide,
  emptyText,
}: {
  items: UnifiedApprovalItem[];
  mode: "pending" | "decided";
  decide: Decide;
  emptyText: string;
}) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const visible = items.filter((i) => !gone.has(i.id));

  async function act(item: UnifiedApprovalItem, decision: "approved" | "rejected") {
    setBusy((b) => new Set(b).add(item.id));
    const res = await decide(item.tenantId, item.origin, item.id, decision, notes[item.id] || undefined);
    setBusy((b) => { const n = new Set(b); n.delete(item.id); return n; });
    if (!res.ok) {
      setToast(res.error ?? "That decision didn't go through — please try again.");
    } else {
      setGone((g) => new Set(g).add(item.id));
      setToast(decision === "approved" ? "Approved — noted." : "Declined — noted.");
    }
    setTimeout(() => setToast(null), 2200);
  }

  if (visible.length === 0) {
    return (
      <div className="dash-empty">
        <p>{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="needs-me-queue">
      {visible.map((item) => (
        <ApprovalRow
          key={item.id}
          item={item}
          mode={mode}
          note={notes[item.id]}
          onNoteChange={mode === "pending" ? (v) => setNotes((n) => ({ ...n, [item.id]: v })) : undefined}
          onDecide={mode === "pending" ? (decision) => act(item, decision) : undefined}
          busy={busy.has(item.id)}
        />
      ))}
      {toast && <Toast message={toast} />}
    </div>
  );
}

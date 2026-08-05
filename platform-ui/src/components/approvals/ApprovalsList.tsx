"use client";
import { useState } from "react";
import type { ApprovalOrigin, ExecutionInfo, UnifiedApprovalItem } from "@/lib/approvalsShared";
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

// D14-08 — D14-07's retry façade (`POST /:t/automation-approvals/:id/retry`), routed the same
// shape as `Decide` above so `ApprovalsList` can wire it the same way.
type Retry = (tenantId: string, id: string) => Promise<{ ok: boolean; error?: string }>;

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
  // D14-08 — additive, decided-mode-only. `executionByItemId` is looked up by `item.id`; a row with
  // no entry (unknown to the reader, or this origin has no execution step) renders unchanged.
  // `retryableTenantIds` is the caller's own `can(me, "approvals.retry", tenantId)` result per
  // company in scope — the UI decision of whether to OFFER Retry at all, never re-derived here.
  executionByItemId,
  retryableTenantIds,
  retry,
}: {
  items: UnifiedApprovalItem[];
  mode: "pending" | "decided";
  decide: Decide;
  emptyText: string;
  executionByItemId?: Record<string, ExecutionInfo>;
  retryableTenantIds?: string[];
  retry?: Retry;
}) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  // Optimistic overlay for a successful retry: the row stays in "Recently decided" (unlike decide's
  // `gone` set, which removes the row) but its execution chip flips to "executing" immediately
  // rather than waiting on the next server round-trip.
  const [retryBusy, setRetryBusy] = useState<Set<string>>(new Set());
  const [retryOverride, setRetryOverride] = useState<Record<string, ExecutionInfo>>({});
  const visible = items.filter((i) => !gone.has(i.id));
  const retryableSet = new Set(retryableTenantIds ?? []);

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

  async function retryAct(item: UnifiedApprovalItem) {
    if (!retry) return;
    setRetryBusy((b) => new Set(b).add(item.id));
    const res = await retry(item.tenantId, item.id);
    setRetryBusy((b) => { const n = new Set(b); n.delete(item.id); return n; });
    if (!res.ok) {
      setToast(res.error ?? "That retry didn't go through — please try again.");
    } else {
      setRetryOverride((o) => ({ ...o, [item.id]: { status: "executing", error: null, attempts: null } }));
      setToast("Retry queued.");
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
          executionInfo={mode === "decided" ? retryOverride[item.id] ?? executionByItemId?.[item.id] : undefined}
          canRetry={mode === "decided" && !!retry && retryableSet.has(item.tenantId)}
          onRetry={() => retryAct(item)}
          retryBusy={retryBusy.has(item.id)}
        />
      ))}
      {toast && <Toast message={toast} />}
    </div>
  );
}

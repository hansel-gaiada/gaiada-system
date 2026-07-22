"use client";
import { useState, useTransition } from "react";
import { StatusBadge, Button } from "@/components/ui";
import type { AssignmentSummary } from "@/lib/serviceAssignments";
import "./services.css";

type Result = { ok: boolean; error?: string };

// One assignment lifecycle row, reused by the org page's ServicedFunctionsPanel
// (target perspective) and /admin/services (both perspectives). Each row owns
// its own pending/error state so one slow action never blocks its siblings.
// Every handler is expected to be a server action already `.bind(null,
// companyId)`-ed by the caller (see org/actions.ts) — this component only
// ever calls `fn(assignmentId[, nodeId])`.
export interface AssignmentRowActions {
  accept?: (id: string) => Promise<Result>;
  suspend?: (id: string) => Promise<Result>;
  resume?: (id: string) => Promise<Result>;
  revoke?: (id: string) => Promise<Result>;
  reconcile?: (id: string) => Promise<Result>;
  relink?: { unitOptions: { id: string; name: string }[]; run: (id: string, nodeId: string) => Promise<Result> };
}

export function ServiceAssignmentRow({ a, label, actions }: { a: AssignmentSummary; label: string; actions: AssignmentRowActions }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [relinkTarget, setRelinkTarget] = useState("");

  const run = (fn?: (id: string) => Promise<Result>) => {
    if (!fn) return;
    setError(null);
    startTransition(async () => {
      const res = await fn(a.id);
      if (!res.ok) setError(res.error ?? "Couldn't update.");
    });
  };

  const runRelink = () => {
    if (!actions.relink || !relinkTarget) return;
    setError(null);
    startTransition(async () => {
      const res = await actions.relink!.run(a.id, relinkTarget);
      if (!res.ok) setError(res.error ?? "Couldn't re-link.");
      else setRelinkTarget("");
    });
  };

  return (
    <li className="svc-row">
      <div className="svc-row__main">
        <span className="svc-row__label">{label}</span>
        <span className="svc-row__module">{a.module}</span>
        <StatusBadge label={a.unitStatus === "orphaned" ? "orphaned" : a.status} />
      </div>
      {a.unitStatus === "orphaned" && (
        <p className="svc-row__banner">Orphaned — the provider unit was removed or changed kind and needs re-linking.</p>
      )}
      <div className="svc-row__actions">
        {actions.accept && a.status === "proposed" && (
          <Button size="sm" onClick={() => run(actions.accept)} disabled={pending}>Accept</Button>
        )}
        {actions.suspend && a.status === "active" && (
          <Button size="sm" variant="ghost" onClick={() => run(actions.suspend)} disabled={pending}>Suspend</Button>
        )}
        {actions.resume && a.status === "suspended" && (
          <Button size="sm" variant="ghost" onClick={() => run(actions.resume)} disabled={pending}>Resume</Button>
        )}
        {actions.reconcile && (
          <Button size="sm" variant="ghost" onClick={() => run(actions.reconcile)} disabled={pending}>Reconcile</Button>
        )}
        {actions.revoke && a.status !== "revoked" && (
          <Button size="sm" variant="ghost" onClick={() => run(actions.revoke)} disabled={pending}>Revoke</Button>
        )}
        {actions.relink && (
          <span className="svc-row__relink">
            <select
              className="org-insp__sel"
              value={relinkTarget}
              aria-label="Re-link to a different unit"
              onChange={(e) => setRelinkTarget(e.target.value)}
            >
              <option value="">Re-link to…</option>
              {actions.relink.unitOptions.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <Button size="sm" variant="ghost" disabled={pending || !relinkTarget} onClick={runRelink}>Re-link</Button>
          </span>
        )}
      </div>
      {error && <p className="svc-row__error">{error}</p>}
    </li>
  );
}

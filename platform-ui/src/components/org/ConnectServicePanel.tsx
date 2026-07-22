"use client";
import { useState, useTransition } from "react";
import type { OrgNode } from "@/lib/org";
import type { AssignmentSummary, DryRunResult, ProposeResult } from "@/lib/serviceAssignments";
import { StatusBadge } from "@/components/ui";
import "./org.css";

// ORG-13 — the "Connect service" button/flow (A9: v1 is a confirm-sheet flow
// on the existing per-company OrgBuilder, NOT the holding-canvas drag —
// that's WSF-5/v1.1). Lets a provider-admin/global user turn a department or
// division into a shared-service provider for one or more target companies +
// a module, previewing exactly who would be materialized (dryRun) before
// confirming, and shows/revokes existing assignments for the same node.
export interface ConnectServiceActions {
  dryRun: (nodeId: string, body: { targets: string[]; module: string; leadUserId?: string }) => Promise<{ ok: boolean; error?: string; result?: DryRunResult }>;
  propose: (nodeId: string, body: { targets: string[]; module: string; leadUserId?: string }) => Promise<{ ok: boolean; error?: string; result?: ProposeResult }>;
  listForUnit: (nodeId: string) => Promise<AssignmentSummary[]>;
  revoke: (assignmentId: string) => Promise<{ ok: boolean; error?: string }>;
}

export function ConnectServicePanel({
  node, companies, modules, members, actions, existing, onClose,
}: {
  node: OrgNode;
  companies: { id: string; name: string }[]; // candidate targets (self already excluded by the caller)
  modules: readonly string[];
  members: { id: string; name: string }[];
  actions: ConnectServiceActions;
  existing: AssignmentSummary[]; // already-live assignments for this node (fetched by the caller)
  onClose: () => void;
}) {
  const [targets, setTargets] = useState<string[]>([]);
  const [module, setModule] = useState<string>(modules[0] ?? "");
  const [leadUserId, setLeadUserId] = useState("");
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [confirmed, setConfirmed] = useState<ProposeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleTarget = (id: string) => {
    setPreview(null); setConfirmed(null); setError(null);
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  };

  const runDryRun = () => {
    if (targets.length === 0 || !module) { setError("Pick at least one target company and a module."); return; }
    setError(null);
    startTransition(async () => {
      const res = await actions.dryRun(node.id, { targets, module, leadUserId: leadUserId || undefined });
      if (res.ok) setPreview(res.result ?? null);
      else setError(res.error ?? "Couldn't preview this connection.");
    });
  };

  const runConfirm = () => {
    startTransition(async () => {
      const res = await actions.propose(node.id, { targets, module, leadUserId: leadUserId || undefined });
      if (res.ok) { setConfirmed(res.result ?? null); setPreview(null); }
      else setError(res.error ?? "Couldn't create the service assignment.");
    });
  };

  const runRevoke = (assignmentId: string) => {
    startTransition(async () => { await actions.revoke(assignmentId); onClose(); });
  };

  return (
    <div className="connect-svc" role="dialog" aria-label={`Connect ${node.name} to another company's module`}>
      <div className="connect-svc__head">
        <span className="connect-svc__title">Connect service — {node.name}</span>
        <button type="button" className="org-insp__close" aria-label="Close" onClick={onClose}>×</button>
      </div>

      {existing.length > 0 && (
        <div className="connect-svc__existing">
          <span className="connect-svc__eyebrow">Already connected</span>
          <ul className="connect-svc__list">
            {existing.map((a) => (
              <li key={a.id} className="connect-svc__row">
                <span>{a.targetCompanyName ?? a.targetTenantId}</span>
                <span className="connect-svc__module">{a.module}</span>
                <StatusBadge label={a.unitStatus === "orphaned" ? "orphaned" : a.status} />
                {a.status !== "revoked" && (
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => runRevoke(a.id)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="connect-svc__form">
        <span className="connect-svc__eyebrow">Serve which company(ies)?</span>
        <div className="connect-svc__targets">
          {companies.length === 0 ? (
            <span className="org-hint">No other companies in this holding.</span>
          ) : companies.map((c) => (
            <label key={c.id} className="connect-svc__check">
              <input type="checkbox" checked={targets.includes(c.id)} onChange={() => toggleTarget(c.id)} />
              {c.name}
            </label>
          ))}
        </div>

        <label className="connect-svc__field">
          <span className="connect-svc__eyebrow">Module</span>
          <select className="org-insp__sel" value={module} onChange={(e) => { setModule(e.target.value); setPreview(null); setConfirmed(null); }}>
            {modules.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <label className="connect-svc__field">
          <span className="connect-svc__eyebrow">Lead (optional)</span>
          <select className="org-insp__sel" value={leadUserId} onChange={(e) => setLeadUserId(e.target.value)}>
            <option value="">— no lead —</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>

        {error && <p className="connect-svc__error">{error}</p>}

        <div className="connect-svc__actions">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={runDryRun}>
            {pending ? "Working…" : "Preview staff (dry run)"}
          </button>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={runConfirm}>
            {pending ? "Working…" : "Confirm & connect"}
          </button>
        </div>
      </div>

      {preview && (
        <div className="connect-svc__preview">
          <span className="connect-svc__eyebrow">Would serve ({preview.items.length} people from {preview.unit.name})</span>
          {preview.items.length === 0 ? (
            <span className="org-hint">No one is placed under this unit yet.</span>
          ) : (
            <ul className="connect-svc__list">
              {preview.items.map((p) => (
                <li key={p.userId} className="connect-svc__row">
                  <span>{p.name}</span>
                  <span className="connect-svc__module">{p.role}</span>
                </li>
              ))}
            </ul>
          )}
          {preview.companies.some((c) => !c.included) && (
            <p className="connect-svc__error">
              {preview.companies.filter((c) => !c.included).map((c) => `${c.name}: ${c.reason ?? "not eligible"}`).join(", ")}
            </p>
          )}
        </div>
      )}

      {confirmed && (
        <div className="connect-svc__confirmed">
          {confirmed.assignments.map((a) => (
            <p key={a.id} className="org-note">Connected — status: <strong>{a.status}</strong>{a.status === "proposed" ? " (awaiting the target company's acceptance)" : ""}.</p>
          ))}
        </div>
      )}
    </div>
  );
}

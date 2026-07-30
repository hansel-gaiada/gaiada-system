"use client";
// SM-12 — the Site Audit tab's interactive half: findings for one already-selected audit,
// grouped severity-first, with the manual triage workflow (`PATCH findings/:id`). The audit/
// property SELECTION itself is a plain GET-form + Links in the server page (matches this repo's
// `lux-filters` convention, e.g. `/activity`) — this component only owns what a click here
// actually MUTATES.
//
// `canManage` is a HINT, not the boundary — same rule `ScopeEditor.tsx` documents for
// `canWrite`/`search.scope.write`. Cerbos enforces the real gate server-side
// (`triageFinding` in searchMarketingActions.ts re-checks `can()` too, and the PATCH itself is
// gated by the `update` action on `resource_search_audit` regardless). When `canManage` is false
// every row renders its status as a plain badge, never a control.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, StatusBadge, Button } from "@/components/ui";
import {
  groupFindingsBySeverity,
  type AuditFinding,
  type AuditTriageStatus,
} from "@/lib/searchMarketingShared";
// "use server" exports compile to a callable RPC stub in the client bundle — see ScopeEditor.tsx's
// header note for why importing straight from the *Actions.ts module is this repo's convention.
import { triageFinding } from "@/lib/searchMarketingActions";

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info",
};

export function AuditFindingsPanel({
  tenantId, findings, canManage,
}: {
  tenantId: string;
  findings: AuditFinding[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (findings.length === 0) {
    return (
      <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
        This audit produced no findings — either the crawl came back clean, or every finding it
        raised has since been marked fixed.
      </p>
    );
  }

  function setStatus(findingId: string, status: AuditTriageStatus) {
    setError(null);
    setPendingId(findingId);
    startTransition(async () => {
      const res = await triageFinding(tenantId, findingId, status);
      setPendingId(null);
      if (!res.ok) {
        setError(res.error ?? "Couldn't update this finding.");
        return;
      }
      router.refresh();
    });
  }

  const groups = groupFindingsBySeverity(findings);

  // Quick-action buttons rather than a bound <select>: the current status includes 'regressed',
  // a system-derived state the console never lets a human set directly (see AuditTriageStatus's
  // header note), so a control whose VALUE must always equal the current status has no honest way
  // to represent it. Buttons sidestep that — each one is a plain "set status to X" action,
  // disabled only when X already IS the current status.

  return (
    <div>
      {error && (
        <p role="alert" style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-danger, #B5622F)", marginBottom: 12 }}>
          {error}
        </p>
      )}
      {groups.map((group) => (
        <div key={group.severity} style={{ marginBottom: 20 }}>
          <h4 style={{ font: "700 12px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-60)", marginBottom: 8 }}>
            {SEVERITY_LABEL[group.severity] ?? group.severity} ({group.findings.length})
          </h4>
          <HairlineTable
            columns={[
              { label: "Code" }, { label: "Category" }, { label: "Message" },
              { label: "URLs", align: "right" }, { label: "Status" }, { label: "Triage" },
            ]}
            rows={group.findings.map((f) => [
              <code key="code" style={{ font: "400 12px var(--font-mono, monospace)" }}>{f.code}</code>,
              f.category,
              f.message,
              String(f.urlCount),
              <StatusBadge key="status" label={f.status} />,
              canManage ? (
                <div key="triage" style={{ display: "flex", gap: 6 }}>
                  {f.status !== "fixed" && (
                    <Button variant="ghost" size="sm" disabled={pendingId === f.id} onClick={() => setStatus(f.id, "fixed")}>
                      Mark fixed
                    </Button>
                  )}
                  {f.status !== "ignored" && (
                    <Button variant="ghost" size="sm" disabled={pendingId === f.id} onClick={() => setStatus(f.id, "ignored")}>
                      Ignore
                    </Button>
                  )}
                  {f.status !== "open" && (
                    <Button variant="ghost" size="sm" disabled={pendingId === f.id} onClick={() => setStatus(f.id, "open")}>
                      Reopen
                    </Button>
                  )}
                </div>
              ) : (
                <span key="triage" style={{ opacity: 0.5 }}>—</span>
              ),
            ])}
            tcols="1fr .8fr 2fr .5fr .8fr 1.6fr"
          />
        </div>
      ))}
      {!canManage && (
        <p style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 8 }}>
          Triaging a finding needs the elevated <code>search.manage</code> permission.
        </p>
      )}
    </div>
  );
}

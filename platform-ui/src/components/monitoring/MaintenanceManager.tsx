"use client";
// MON-20 — schedule a maintenance window, so a planned outage does not page anyone (and does not
// silently corrupt SLA math either — the backend treats `.create` as `sensitive: true` for exactly
// that reason). `canCreate`/`canDelete` are cosmetic UI gates mirroring
// `monitoring.maintenance.create`/`.delete`; the server re-checks both on every write.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { scheduleMaintenance, deleteMaintenance } from "@/lib/monitoringActions";
import { maintenanceState, describeMaintenanceScope, type MaintenanceWindow } from "@/lib/monitoring";
// Pinned locale + timeZone — see platform-ui/CLAUDE.md's hydration-divergence trap.
import { formatDateTime } from "@/lib/format";

const labelStyle = {
  font: "600 11px var(--font-body)",
  letterSpacing: "0.04em",
  color: "var(--erp-ink-60)",
  textTransform: "uppercase" as const,
  display: "block",
  marginBottom: 4,
};

const STATE_LABEL: Record<string, string> = { active: "on hold", upcoming: "pending", ended: "closed" };

export function MaintenanceManager({ tenantId, windows, monitors, canCreate, canDelete }: {
  tenantId: string;
  windows: MaintenanceWindow[];
  monitors: { id: string; name: string }[];
  canCreate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [scopeMonitorId, setScopeMonitorId] = useState(""); // "" = all monitors
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const names = new Map(monitors.map((m) => [m.id, m.name]));
  const now = Date.now();

  function submit() {
    setError(null);
    if (!startsAt || !endsAt) {
      setError("Set both a start and an end.");
      return;
    }
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    fd.set("scope", scopeMonitorId ? `monitor:${scopeMonitorId}` : "all");
    fd.set("startsAt", new Date(startsAt).toISOString());
    fd.set("endsAt", new Date(endsAt).toISOString());
    if (reason.trim()) fd.set("reason", reason.trim());
    startTransition(async () => {
      const res = await scheduleMaintenance(fd);
      if (!res.ok) {
        setError(res.error ?? "Couldn't schedule the window.");
        return;
      }
      setShowForm(false);
      setScopeMonitorId("");
      setStartsAt("");
      setEndsAt("");
      setReason("");
      router.refresh();
    });
  }

  function cancel(w: MaintenanceWindow) {
    if (!window.confirm("Cancel this maintenance window? Alerting resumes immediately for its scope.")) return;
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    fd.set("windowId", w.id);
    startTransition(async () => {
      const res = await deleteMaintenance(fd);
      if (!res.ok) setError(res.error ?? "Couldn't cancel the window.");
      router.refresh();
    });
  }

  return (
    <div>
      {windows.length === 0 ? (
        <EmptyNote>
          No maintenance windows scheduled. A planned outage right now would still page whoever the
          routes point at.
        </EmptyNote>
      ) : (
        <HairlineTable
          columns={[
            { label: "Scope" },
            { label: "Starts" },
            { label: "Ends" },
            { label: "State" },
            { label: "Reason" },
            { label: "Created by" },
            ...(canDelete ? [{ label: "Actions" }] : []),
          ]}
          rows={[...windows]
            .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))
            .map((w) => {
              const state = maintenanceState(w, now);
              return [
                describeMaintenanceScope(w.scope, names),
                formatDateTime(w.startsAt),
                formatDateTime(w.endsAt),
                <StatusBadge key={`s-${w.id}`} label={STATE_LABEL[state]} />,
                w.reason ?? "—",
                w.createdBy ?? "—",
                ...(canDelete
                  ? [
                      state === "ended" ? (
                        <span key={`a-${w.id}`} style={{ opacity: 0.5, fontSize: 12 }}>—</span>
                      ) : (
                        <Button key={`a-${w.id}`} size="sm" variant="ghost" onClick={() => cancel(w)} disabled={pending}>
                          Cancel
                        </Button>
                      ),
                    ]
                  : []),
              ];
            })}
        />
      )}

      {canCreate && (
        <div style={{ marginTop: 20 }}>
          {showForm ? (
            <div style={{ display: "grid", gap: 12, maxWidth: 480, paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
              <h4 style={{ fontSize: 13, fontWeight: 600 }}>Schedule a maintenance window</h4>
              <div>
                <label htmlFor="mw-scope" style={labelStyle}>Scope</label>
                <select
                  id="mw-scope"
                  value={scopeMonitorId}
                  onChange={(e) => setScopeMonitorId(e.target.value)}
                  style={{ width: "100%", padding: "8px 10px" }}
                >
                  <option value="">All monitors</option>
                  {monitors.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 200px" }}>
                  <label htmlFor="mw-start" style={labelStyle}>Starts</label>
                  <input
                    id="mw-start" type="datetime-local" value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    style={{ width: "100%", padding: "8px 10px" }}
                  />
                </div>
                <div style={{ flex: "1 1 200px" }}>
                  <label htmlFor="mw-end" style={labelStyle}>Ends</label>
                  <input
                    id="mw-end" type="datetime-local" value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    style={{ width: "100%", padding: "8px 10px" }}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="mw-reason" style={labelStyle}>Reason (optional)</label>
                <input
                  id="mw-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="WordPress + PHP upgrade"
                  style={{ width: "100%", padding: "8px 10px" }}
                />
              </div>
              <p style={{ fontSize: 12, opacity: 0.7 }}>
                Alerting — and SLA/uptime math — is suppressed for this scope for the whole window.
                Set the end time you actually expect, not a generous guess: an open-ended window is
                how alerting gets muted and forgotten.
              </p>
              {error && <p role="alert" style={{ fontSize: 13, color: "var(--status-critical-fg)" }}>{error}</p>}
              <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={submit} disabled={pending}>{pending ? "Scheduling…" : "Schedule window"}</Button>
                <Button variant="ghost" onClick={() => { setShowForm(false); setError(null); }} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setShowForm(true)}>+ Schedule maintenance</Button>
          )}
        </div>
      )}
    </div>
  );
}

"use client";
// MON-20 — create/edit/delete a route: the filter that decides which incidents reach which channel.
// A channel with no route pointing at it is exactly the "configured, never used" quiet failure
// `/monitoring/channels` already computes an `unrouted` warning for — this is what lets someone
// actually FIX that warning instead of only reading it.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { saveRoute, deleteRoute } from "@/lib/monitoringActions";
import { isCatchAll, type MonitorRoute } from "@/lib/monitoring";

const labelStyle = {
  font: "600 11px var(--font-body)",
  letterSpacing: "0.04em",
  color: "var(--erp-ink-60)",
  textTransform: "uppercase" as const,
  display: "block",
  marginBottom: 4,
};

const SEVERITIES = [
  { value: "", label: "Any severity" },
  { value: "page", label: "Page" },
  { value: "ticket", label: "Ticket" },
  { value: "info", label: "Info" },
];

interface Draft {
  id: string | null;
  channelId: string;
  matchClientId: string;
  matchSeverity: string;
  matchKind: string;
  enabled: boolean;
}

export function RouteManager({ tenantId, routes, channels, clients, canManage }: {
  tenantId: string;
  routes: MonitorRoute[];
  channels: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const blank = (): Draft => ({
    id: null, channelId: channels[0]?.id ?? "", matchClientId: "", matchSeverity: "", matchKind: "", enabled: true,
  });

  function edit(r: MonitorRoute) {
    setError(null);
    setDraft({
      id: r.id,
      channelId: r.channelId,
      matchClientId: r.matchClientId ?? "",
      matchSeverity: r.matchSeverity ?? "",
      matchKind: r.matchKind ?? "",
      enabled: r.enabled,
    });
  }

  function save() {
    if (!draft) return;
    setError(null);
    if (!draft.channelId) {
      setError("Choose which channel this route delivers to.");
      return;
    }
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    if (draft.id) fd.set("routeId", draft.id);
    fd.set("channelId", draft.channelId);
    if (draft.matchClientId) fd.set("matchClientId", draft.matchClientId);
    if (draft.matchSeverity) fd.set("matchSeverity", draft.matchSeverity);
    if (draft.matchKind) fd.set("matchKind", draft.matchKind);
    if (draft.enabled) fd.set("enabled", "on");
    startTransition(async () => {
      const res = await saveRoute(fd);
      if (!res.ok) {
        setError(res.error ?? "Couldn't save the route.");
        return;
      }
      setDraft(null);
      router.refresh();
    });
  }

  function remove(r: MonitorRoute) {
    if (!window.confirm(`Delete this route to "${r.channelName ?? r.channelId}"?`)) return;
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    fd.set("routeId", r.id);
    startTransition(async () => {
      const res = await deleteRoute(fd);
      if (!res.ok) setError(res.error ?? "Couldn't delete the route.");
      router.refresh();
    });
  }

  return (
    <div>
      {routes.length === 0 ? (
        <EmptyNote>No routes configured. Channels exist but nothing is directed to them.</EmptyNote>
      ) : (
        <HairlineTable
          columns={[
            { label: "Channel" },
            { label: "Client" },
            { label: "Severity" },
            { label: "Check type" },
            { label: "Status" },
            ...(canManage ? [{ label: "Actions" }] : []),
          ]}
          rows={routes.map((r) => [
            r.channelName ?? r.channelId,
            r.matchClientName ?? (r.matchClientId ? r.matchClientId : "any"),
            r.matchSeverity ?? "any",
            r.matchKind ?? "any",
            <span key={`st-${r.id}`} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <StatusBadge label={r.enabled ? "active" : "suspended"} />
              {r.enabled && isCatchAll(r) && <StatusBadge label="at risk" />}
            </span>,
            ...(canManage
              ? [
                  <div key={`a-${r.id}`} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Button size="sm" variant="ghost" onClick={() => edit(r)} disabled={pending}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(r)} disabled={pending}>Delete</Button>
                  </div>,
                ]
              : []),
          ])}
        />
      )}

      {canManage && (
        <div style={{ marginTop: 20 }}>
          {draft ? (
            <div style={{ display: "grid", gap: 12, maxWidth: 480, paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
              <h4 style={{ fontSize: 13, fontWeight: 600 }}>{draft.id ? "Edit route" : "New route"}</h4>
              {channels.length === 0 ? (
                <p style={{ fontSize: 13, opacity: 0.75 }}>Add a channel first — a route has to point at one.</p>
              ) : (
                <>
                  <div>
                    <label htmlFor="rt-channel" style={labelStyle}>Deliver to</label>
                    <select
                      id="rt-channel"
                      value={draft.channelId}
                      onChange={(e) => setDraft({ ...draft, channelId: e.target.value })}
                      style={{ width: "100%", padding: "8px 10px" }}
                    >
                      {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="rt-client" style={labelStyle}>Client (optional)</label>
                    <select
                      id="rt-client"
                      value={draft.matchClientId}
                      onChange={(e) => setDraft({ ...draft, matchClientId: e.target.value })}
                      style={{ width: "100%", padding: "8px 10px" }}
                    >
                      <option value="">Any client</option>
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="rt-sev" style={labelStyle}>Severity (optional)</label>
                    <select
                      id="rt-sev"
                      value={draft.matchSeverity}
                      onChange={(e) => setDraft({ ...draft, matchSeverity: e.target.value })}
                      style={{ width: "100%", padding: "8px 10px" }}
                    >
                      {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                    />
                    Enabled
                  </label>
                  {!draft.matchClientId && !draft.matchSeverity && !draft.matchKind && (
                    <p style={{ fontSize: 12, color: "var(--status-critical-fg)" }}>
                      No filter set — this route will match every incident. That is occasionally
                      intended (a single catch-all pager), and is usually how one channel ends up
                      flooded and then muted.
                    </p>
                  )}
                  {error && <p role="alert" style={{ fontSize: 13, color: "var(--status-critical-fg)" }}>{error}</p>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save route"}</Button>
                    <Button variant="ghost" onClick={() => { setDraft(null); setError(null); }} disabled={pending}>Cancel</Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setDraft(blank())} disabled={channels.length === 0}>
              + Add route
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

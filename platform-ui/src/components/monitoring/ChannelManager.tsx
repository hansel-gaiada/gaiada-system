"use client";
// MON-20 — create/edit/enable/disable/delete an alert channel, and send a test notification.
// Closes the actual defect this ticket exists for: alert delivery has always worked once a channel
// exists (runner.ts fans an incident out monitor_routes -> monitor_channels -> enqueueMail), but
// `/monitoring/channels` only ever LISTED channels. This is the write side.
//
// `canManage` is COSMETIC — it hides the affordances for a user who would get a 403 anyway, so a
// dead button never renders. The server (Cerbos `monitoring.channel.manage`) is the real gate; every
// action in `monitoringActions.ts` re-checks it, so hiding the button here is a courtesy, not a lock.
//
// ── TWO BACKEND REALITIES THIS UI MUST NOT PAPER OVER (per T1's landed implementation) ───────────
// 1. Only `email` has a delivery driver today. The other four kinds (telegram/ntfy/webhook/wa/mcp)
//    can be created and routed, but a test send — and real delivery — 400s for all of them. Offering
//    a working-looking "Send test" button on those would be exactly the false-green failure this
//    whole module exists to replace, so it renders disabled with an honest reason instead.
// 2. CH — `lastDeliveryAt`/`lastDeliveryOk`/`failureCount` are now written on every delivery
//    attempt (runner.ts's incident fan-out AND this component's own test-send), so `channelHealth()`
//    reflects real attempts. But "ok" only ever means "handed to the mail queue" — enqueueMail()
//    inserts a `mail_log` row and returns; it does not wait for the provider to accept the send or
//    the recipient to receive it. The Health column and the note below say so plainly rather than
//    implying a green/"active" badge means confirmed delivery.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { saveChannel, setChannelEnabled, deleteChannel, testChannel } from "@/lib/monitoringActions";
import { channelHealth, ageSeconds, formatAge, CHANNEL_KINDS, type MonitorChannel } from "@/lib/monitoringShared";

const HEALTH_LABEL: Record<string, string> = {
  ok: "active",
  degraded: "at risk",
  failing: "critical",
  unused: "draft",
};

/** The only channel kind with a real delivery driver today. Everything else can be configured and
 *  routed (so the UI does not hide them), but a test send — and real delivery — will 400. */
const KINDS_WITH_DRIVER = new Set(["email"]);

/** The backend 400s on a missing/implausible `destination` for `email` at create time; catching it
 *  client-side turns that into an inline field message instead of a round-trip toast. Deliberately
 *  loose (this is a client-side pre-check, not the validator) — the server's rule is authoritative. */
function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

const labelStyle = {
  font: "600 11px var(--font-body)",
  letterSpacing: "0.04em",
  color: "var(--erp-ink-60)",
  textTransform: "uppercase" as const,
  display: "block",
  marginBottom: 4,
};

interface Draft {
  id: string | null; // null = creating a new channel
  kind: string;
  name: string;
  destination: string;
  enabled: boolean;
}

const BLANK: Draft = { id: null, kind: CHANNEL_KINDS[0], name: "", destination: "", enabled: true };

export function ChannelManager({ tenantId, channels, canManage }: {
  tenantId: string;
  channels: MonitorChannel[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function edit(c: MonitorChannel) {
    setError(null);
    setDraft({ id: c.id, kind: c.kind, name: c.name, destination: c.destination ?? "", enabled: c.enabled });
  }

  function save() {
    if (!draft) return;
    setError(null);
    if (draft.kind === "email" && !looksLikeEmail(draft.destination)) {
      setError("Enter a real email address — the backend rejects anything else for this kind.");
      return;
    }
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    if (draft.id) fd.set("channelId", draft.id);
    fd.set("kind", draft.kind);
    fd.set("name", draft.name.trim());
    fd.set("destination", draft.destination.trim());
    if (draft.enabled) fd.set("enabled", "on");
    startTransition(async () => {
      const res = await saveChannel(fd);
      if (!res.ok) {
        setError(res.error ?? "Couldn't save the channel.");
        return;
      }
      setDraft(null);
      router.refresh();
    });
  }

  function toggle(c: MonitorChannel) {
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    fd.set("channelId", c.id);
    fd.set("enabled", String(!c.enabled));
    startTransition(async () => {
      const res = await setChannelEnabled(fd);
      if (!res.ok) setError(res.error ?? "Couldn't update the channel.");
      router.refresh();
    });
  }

  function remove(c: MonitorChannel) {
    if (!window.confirm(`Delete "${c.name}"? Any route pointing at it will stop delivering.`)) return;
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    fd.set("channelId", c.id);
    startTransition(async () => {
      const res = await deleteChannel(fd);
      if (!res.ok) setError(res.error ?? "Couldn't delete the channel.");
      router.refresh();
    });
  }

  function sendTest(c: MonitorChannel) {
    setTestMsg(null);
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    fd.set("channelId", c.id);
    startTransition(async () => {
      const res = await testChannel(fd);
      setTestMsg(
        res.ok
          ? { id: c.id, ok: true, text: `Test notification sent to "${c.name}".` }
          : { id: c.id, ok: false, text: res.error ?? "The test notification failed to send." },
      );
      router.refresh();
    });
  }

  const now = Date.now();

  return (
    <div>
      {channels.length === 0 ? (
        <EmptyNote>
          No channels configured. Monitoring will still record incidents, but nobody will be told
          about them.
        </EmptyNote>
      ) : (
        <>
          <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
            Health reflects real delivery attempts (both real incident alerts and test sends), but
            &quot;active&quot; means only that the send was handed to the mail queue — it is not
            confirmation the provider accepted it or the recipient received it. Only{" "}
            <strong>email</strong> has a delivery driver; the others can be configured and routed but
            cannot send yet, and always show &quot;draft&quot;.
          </p>
          <HairlineTable
            columns={[
              { label: "Channel" },
              { label: "Kind" },
              { label: "Destination" },
              { label: "Health" },
              { label: "Last delivery" },
              ...(canManage ? [{ label: "Actions" }] : []),
            ]}
            rows={channels.map((c) => {
              const hasDriver = KINDS_WITH_DRIVER.has(c.kind);
              return [
                c.name,
                c.kind,
                c.destination ?? "—",
                <StatusBadge key={`h-${c.id}`} label={HEALTH_LABEL[channelHealth(c)] ?? "draft"} />,
                c.lastDeliveryAt
                  ? `${formatAge(ageSeconds(c.lastDeliveryAt, now))}${c.lastDeliveryOk === false ? " (failed)" : ""}`
                  : "never",
                ...(canManage
                  ? [
                      <div key={`a-${c.id}`} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <Button size="sm" variant="ghost" onClick={() => edit(c)} disabled={pending}>Edit</Button>
                        <Button size="sm" variant="ghost" onClick={() => toggle(c)} disabled={pending}>
                          {c.enabled ? "Disable" : "Enable"}
                        </Button>
                        {hasDriver ? (
                          <Button size="sm" variant="ghost" onClick={() => sendTest(c)} disabled={pending}>Send test</Button>
                        ) : (
                          <span title="No delivery driver exists for this kind yet" style={{ fontSize: 12, opacity: 0.55 }}>
                            No driver yet
                          </span>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => remove(c)} disabled={pending}>Delete</Button>
                      </div>,
                    ]
                  : []),
              ];
            })}
          />
        </>
      )}

      {/* role="status" (polite, not "log") — a one-shot result for the single test just fired, never
          a running feed, so the log/status distinction in the a11y checklist matters here. */}
      {testMsg && (
        <p role="status" style={{ fontSize: 13, marginTop: 10, color: testMsg.ok ? "var(--status-ok-fg)" : "var(--status-critical-fg)" }}>
          {testMsg.text}
        </p>
      )}

      {canManage && (
        <div style={{ marginTop: 20 }}>
          {draft ? (
            <div style={{ display: "grid", gap: 12, maxWidth: 480, paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
              <h4 style={{ fontSize: 13, fontWeight: 600 }}>{draft.id ? "Edit channel" : "New channel"}</h4>
              <div>
                <label htmlFor="ch-kind" style={labelStyle}>Kind</label>
                <select
                  id="ch-kind"
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                  style={{ width: "100%", padding: "8px 10px" }}
                >
                  {CHANNEL_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ch-name" style={labelStyle}>Name</label>
                <input
                  id="ch-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Ops Telegram"
                  style={{ width: "100%", padding: "8px 10px" }}
                />
              </div>
              <div>
                <label htmlFor="ch-dest" style={labelStyle}>Destination</label>
                <input
                  id="ch-dest"
                  value={draft.destination}
                  onChange={(e) => setDraft({ ...draft, destination: e.target.value })}
                  placeholder="ops@gaiada.com, @gaiada-alerts, or a webhook URL"
                  style={{ width: "100%", padding: "8px 10px" }}
                />
                <p style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>
                  {draft.kind === "email"
                    ? "Must be a real email address — the backend rejects anything else for this kind."
                    : "No delivery driver exists for this kind yet, so it can be saved and routed but a test send will fail. A webhook URL with an embedded token is a credential — the backend redacts it in every read after this save, so paste it here once."}
                </p>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                Enabled
              </label>
              {error && <p role="alert" style={{ fontSize: 13, color: "var(--status-critical-fg)" }}>{error}</p>}
              <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save channel"}</Button>
                <Button variant="ghost" onClick={() => { setDraft(null); setError(null); }} disabled={pending}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setDraft(BLANK)}>+ Add channel</Button>
          )}
        </div>
      )}
    </div>
  );
}

"use client";
// SM-25a's UI half — the Connections tab's Google (Search Console / GA4 / Ads) section.
// §A12.3's honesty rule, the reason this component exists rather than reusing the generic GitHub/
// Drive `ConnectionsPanel`: "the Connections tab MUST render `issuerHost` whenever `issuerIsGoogle`
// is false — a dev/sandbox-issued connection must be readable as one at a glance." Field names
// verified against `google/oauth.ts`'s `GoogleConnectionView` (§4i discipline).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, StatusBadge } from "@/components/ui";
import {
  GOOGLE_PROVIDER_VALUES, GOOGLE_PROVIDER_LABEL, issuerDisclosure,
  type GoogleConnectionView, type GoogleProvider,
} from "@/lib/searchMarketingShared";
import { startGoogleAuthorization, refreshGoogleConnection, revokeGoogleConnection } from "@/lib/searchMarketingActions";

export interface GoogleClientOption { id: string; name: string }
export interface GooglePropertyOption { id: string; domain: string; clientId: string }

function ConnectionRow({
  connection, canManage, onRefresh, onRevoke,
}: {
  connection: GoogleConnectionView;
  canManage: boolean;
  onRefresh: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onRevoke: (id: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [pending, startAction] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const disclosure = issuerDisclosure(connection);
  const revoked = connection.status === "revoked";

  return (
    <li className="dept-conn-row">
      <div className="dept-conn-row__main">
        <span className="dept-conn-row__label">{GOOGLE_PROVIDER_LABEL[connection.provider]}</span>
        <StatusBadge label={connection.status} />
        <span className="dept-conn-row__account">{connection.externalAccount ?? "no account"}</span>
      </div>
      {/* §A12.3 — the disclosure line. Rendered ONLY when issuerIsGoogle is false; a real-Google
          connection shows nothing extra here, which is itself the honest "nothing to disclose"
          state — never a chip, never a claim of realness either way. */}
      {disclosure && (
        <p
          role="note"
          style={{ font: "600 11px var(--font-body)", color: "var(--erp-warn, #9c6f1f)", margin: "4px 0 0" }}
          title="This connection was not issued by Google's own OAuth endpoint — a dev or sandbox issuer stood in for it."
        >
          ▲ {disclosure}
        </p>
      )}
      <div className="dept-conn-row__actions" style={{ marginTop: 6 }}>
        <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>
          {connection.scopes.length} scope{connection.scopes.length === 1 ? "" : "s"}
          {connection.tokenExpiresAt && !revoked ? ` · token expires ${new Date(connection.tokenExpiresAt).toLocaleString()}` : ""}
        </span>
        {canManage && !revoked && (
          <>
            <Button
              size="sm" variant="ghost" disabled={pending}
              onClick={() => {
                setError(null);
                startAction(async () => {
                  const res = await onRefresh(connection.id);
                  if (!res.ok) setError(res.error ?? "Refresh failed.");
                });
              }}
            >
              {pending ? "Working…" : "Refresh"}
            </Button>
            <Button
              size="sm" variant="ghost" disabled={pending}
              onClick={() => {
                setError(null);
                startAction(async () => {
                  const res = await onRevoke(connection.id);
                  if (!res.ok) setError(res.error ?? "Revoke failed.");
                });
              }}
            >
              {pending ? "Working…" : "Revoke"}
            </Button>
          </>
        )}
      </div>
      {error && <p className="dept-conn-row__error">{error}</p>}
    </li>
  );
}

function NewConnectionForm({
  tenantId, returnPath, clients, properties, canManage,
}: {
  tenantId: string;
  returnPath: string;
  clients: GoogleClientOption[];
  properties: GooglePropertyOption[];
  canManage: boolean;
}) {
  const [provider, setProvider] = useState<GoogleProvider>("google_search_console");
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [propertyId, setPropertyId] = useState("");
  const [pending, startAction] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canManage) return null;
  if (clients.length === 0) {
    return <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>No clients yet — add one before connecting a Google account.</p>;
  }

  const propertiesForClient = properties.filter((p) => p.clientId === clientId);

  function submit() {
    setError(null);
    startAction(async () => {
      // `startGoogleAuthorization` REDIRECTS on success (Next.js `redirect()`, throws internally) —
      // this callback only "returns" on the error path.
      const res = await startGoogleAuthorization(tenantId, provider, clientId, propertyId || undefined, returnPath);
      if (!res.ok) setError(res.error ?? "Could not start the connection flow.");
    });
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "0.5px solid var(--erp-hairline)" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as GoogleProvider)} style={{ marginLeft: 8 }}>
            {GOOGLE_PROVIDER_VALUES.map((p) => (
              <option key={p} value={p}>{GOOGLE_PROVIDER_LABEL[p]}</option>
            ))}
          </select>
        </label>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Client
          <select value={clientId} onChange={(e) => { setClientId(e.target.value); setPropertyId(""); }} style={{ marginLeft: 8 }}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Property (optional — binds it once linked)
          <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="">— none yet —</option>
            {propertiesForClient.map((p) => (
              <option key={p.id} value={p.id}>{p.domain}</option>
            ))}
          </select>
        </label>
        <Button variant="solid" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Starting…" : "Connect"}
        </Button>
      </div>
      <p style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 6 }}>
        Redirects to the issuer&apos;s consent page (real Google, or the sandbox/dev issuer in this
        environment) and returns here once the operator approves or declines.
      </p>
      {error && <p role="alert" style={{ font: "400 13px var(--font-body)", color: "var(--erp-danger, #B5622F)", marginTop: 6 }}>{error}</p>}
    </div>
  );
}

export function GoogleConnectionsPanel({
  tenantId, returnPath, connections, clients, properties, canManage, oauthStatus, oauthDetail,
}: {
  tenantId: string;
  returnPath: string;
  connections: GoogleConnectionView[];
  clients: GoogleClientOption[];
  properties: GooglePropertyOption[];
  canManage: boolean;
  oauthStatus?: string;
  oauthDetail?: string;
}) {
  const router = useRouter();

  const refresh = async (id: string) => {
    const res = await refreshGoogleConnection(tenantId, id);
    router.refresh();
    return res;
  };
  const revoke = async (id: string) => {
    const res = await revokeGoogleConnection(tenantId, id);
    router.refresh();
    return res;
  };

  return (
    <div>
      {oauthStatus === "connected" && (
        <p style={{ font: "600 13px var(--font-body)", color: "var(--erp-ok, #3a7a54)", marginBottom: 12 }}>
          Connected.
        </p>
      )}
      {oauthStatus === "denied" && (
        <p style={{ font: "600 13px var(--font-body)", color: "var(--erp-warn, #9c6f1f)", marginBottom: 12 }}>
          Connection not completed{oauthDetail ? ` — ${oauthDetail}` : " — declined at the issuer"}.
        </p>
      )}
      {oauthStatus === "error" && (
        <p role="alert" style={{ font: "600 13px var(--font-body)", color: "var(--erp-danger, #B5622F)", marginBottom: 12 }}>
          Connection failed{oauthDetail ? ` — ${oauthDetail}` : ""}.
        </p>
      )}

      {connections.length === 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No Search Console, GA4 or Ads accounts connected yet.
        </p>
      ) : (
        <ul className="dept-conn-list">
          {connections.map((c) => (
            <ConnectionRow key={c.id} connection={c} canManage={canManage} onRefresh={refresh} onRevoke={revoke} />
          ))}
        </ul>
      )}

      <NewConnectionForm tenantId={tenantId} returnPath={returnPath} clients={clients} properties={properties} canManage={canManage} />
    </div>
  );
}

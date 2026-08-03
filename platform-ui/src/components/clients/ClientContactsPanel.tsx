"use client";
import { useActionState, useState } from "react";
import {
  inviteClientContactAction,
  revokeClientContactAction,
  type InviteResult,
  type RevokeResult,
} from "@/lib/clientContactsActions";
import {
  CAPABILITY_LABEL,
  STATUS_LABEL,
  canCountersign,
  type ClientContact,
} from "@/lib/clientContactsView";
import "@/components/departments/departments.css";

// W0-5 — the PM's "external setup" surface (owner decision D-2: a PM delegates internally AND starts
// the external setup; D-3: clients get access BEFORE the first meeting, so this must be usable with no
// project and no recording in existence).
//
// The invite link is shown ONCE and cannot be re-read: the API stores only a sha256 of the token, so a
// lost link means issuing a new invite. The UI has to make that explicit rather than let a PM assume
// they can come back for it later.
export function ClientContactsPanel({
  clientId,
  clientName,
  contacts,
  projects,
}: {
  clientId: string;
  clientName: string;
  contacts: ClientContact[];
  projects: { id: string; name: string }[];
}) {
  const [invite, inviteAction, invitePending] = useActionState<InviteResult | null, FormData>(inviteClientContactAction, null);
  const [revoke, revokeAction, revokePending] = useActionState<RevokeResult | null, FormData>(revokeClientContactAction, null);
  const [showForm, setShowForm] = useState(contacts.length === 0);
  const [copied, setCopied] = useState(false);

  const active = contacts.filter((c) => c.status !== "revoked");
  const signers = active.filter(canCountersign);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, font: "600 14px var(--font-display)", color: "var(--ink)" }}>Client contacts</h3>
          <p style={{ margin: "4px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
            People on {clientName}&rsquo;s side who can follow the work. Set them up before the first
            meeting so everyone is on the same page from the start.
          </p>
        </div>
        {!showForm && (
          <button type="button" className="btn" onClick={() => setShowForm(true)} style={{ fontSize: 13 }}>
            Invite a contact
          </button>
        )}
      </div>

      {/* The signer count is the thing that decides whether a scope agreement can ever be
          countersigned, so it is surfaced rather than left to be discovered at the gate. */}
      {active.length > 0 && signers.length === 0 && (
        <p className="dept-teach" style={{ padding: "10px 12px", margin: 0, font: "400 12px/1.5 var(--font-body)" }}>
          No contact here can sign off yet — a scope agreement will wait indefinitely. Invite someone as
          &ldquo;Can sign off&rdquo;, or change an existing contact&rsquo;s access.
        </p>
      )}

      {contacts.length === 0 ? (
        <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
          No client contacts yet.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {contacts.map((c) => {
            const projectName = c.projectId ? projects.find((p) => p.id === c.projectId)?.name ?? "a project" : null;
            return (
              <div
                key={c.id}
                style={{
                  display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
                  padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10,
                  opacity: c.status === "revoked" ? 0.55 : 1,
                }}
              >
                <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <div style={{ font: "500 13px var(--font-body)", color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {c.name || c.email}
                  </div>
                  <div style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>{c.email}</div>
                </div>
                <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
                  {CAPABILITY_LABEL[c.capability]}
                </span>
                <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
                  {/* D-1: null project = the whole client. Spelling that out beats an empty cell. */}
                  {projectName ? `Project: ${projectName}` : "All projects"}
                </span>
                <span style={{ font: "500 12px var(--font-body)", color: c.status === "active" ? "var(--ink-muted)" : "var(--erp-accent)" }}>
                  {STATUS_LABEL[c.status]}
                  {/* `invited` with no account is the normal waiting state, not an error — say which. */}
                  {c.status === "invited" && !c.hasAccount ? " · link not used yet" : ""}
                </span>
                {c.status !== "revoked" && (
                  <form action={revokeAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="clientId" value={clientId} />
                    <button type="submit" className="btn" disabled={revokePending} style={{ fontSize: 12 }}>
                      {revokePending ? "…" : "Revoke"}
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      {revoke?.ok && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
          Access revoked.{" "}
          {revoke.keptAccount
            ? "Their sign-in was kept because they are still a contact on other work."
            : revoke.idpDisabled
              ? "Their sign-in has been disabled."
              : ""}
        </p>
      )}
      {revoke && !revoke.ok && revoke.error && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{revoke.error}</p>
      )}

      {showForm && (
        <form action={inviteAction} style={{ display: "grid", gap: 10, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 10 }}>
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="clientName" value={clientName} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              name="email" type="email" required placeholder="their@email.com"
              style={{ flex: "1 1 200px", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}
            />
            <input
              name="name" placeholder="Name (optional)"
              style={{ flex: "1 1 140px", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}
            />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ display: "grid", gap: 4, flex: "1 1 160px" }}>
              <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>Access</span>
              <select name="capability" defaultValue="viewer" style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}>
                <option value="viewer">Can view only</option>
                <option value="signer">Can sign off</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
              <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>Scope</span>
              {/* Default is client-wide, which is the D-3 case: setting a client up before any project
                  exists. A project list that is empty must not make this control unusable. */}
              <select name="projectId" defaultValue="" style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}>
                <option value="">All this client&rsquo;s projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="submit" className="btn btn-primary" disabled={invitePending} style={{ fontSize: 13 }}>
              {invitePending ? "Creating invitation…" : "Create invitation"}
            </button>
            <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
              You&rsquo;ll get a link to send them.
            </span>
          </div>
          {invite && !invite.ok && (
            <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{invite.error}</p>
          )}
        </form>
      )}

      {/* The link appears exactly once. Saying so is not decoration: the API keeps only a hash, so
          there is no screen that can show it again. */}
      {invite?.ok && (
        <div style={{ display: "grid", gap: 8, padding: "12px 14px", border: "1px solid var(--erp-accent)", borderRadius: 10 }}>
          <p style={{ margin: 0, font: "500 13px var(--font-body)", color: "var(--ink)" }}>
            Invitation ready for {invite.email}
          </p>
          <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
            Send them this link. <strong>It is shown only once</strong> and can be used once — if it is
            lost, create a new invitation. It expires{" "}
            {new Date(invite.expiresAt).toLocaleString()}.
          </p>
          <code
            style={{
              display: "block", padding: "8px 10px", background: "var(--surface-sunken)", borderRadius: 8,
              font: "400 12px/1.5 var(--font-mono, monospace)", wordBreak: "break-all", color: "var(--ink)",
            }}
          >
            {invite.acceptUrl}
          </code>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12 }}
              onClick={() => {
                // Clipboard can be unavailable (insecure origin, permissions) — the link is rendered
                // above regardless, so a copy failure is never a dead end.
                void navigator.clipboard?.writeText(invite.acceptUrl).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

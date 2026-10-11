"use client";
import { refreshPortalWebsiteAccessAction, setPortalWebsiteEditorAction } from "@/lib/portalWebsiteAccessActions";
import {
  PORTAL_WEBSITE_ACCESS_HINT,
  displayName,
  type WebsiteAccessCapability,
  type WebsiteAccessRow,
} from "@/lib/clientWebsiteAccessView";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { WebsiteEditorSwitch } from "@/components/website-access/WebsiteEditorSwitch";
import { useWebsiteAccess } from "@/components/website-access/useWebsiteAccess";
import "@/components/website-access/websiteAccess.css";

// WSK-49f — the client ADMIN's "Website access" card on the portal People page.
// (docs/FRONTEND-BFF-CONTRACT.md §16i; ruling WSK-D60 amended 2026-10-11.)
//
// The page renders this ONLY for a caller whose own profile says they are an admin of this client, and
// then asks the BFF. The BFF is still the authority: a 403 (on the read, handled by the page, or on any
// write, handled here) means the section is HIDDEN, not shown disabled. A non-admin sees nothing new at
// all, and nothing here advertises a power they lack.
//
// What an admin may do is exactly one thing: give or take away the website editor role for a colleague
// of THIS client. There is no control for a capability (staff-only) or for any other role, and none is
// added on top of what the BFF answers. In particular there is no client-side rule about granting
// yourself: the row for the caller is an ordinary row, and the BFF's answer (a self-grant is refused, a
// self-revoke is allowed) is shown as it comes.
// The People page already says "Can sign" / "View only"; an admin can always sign (owner ruling).
const PORTAL_CAPABILITY: Record<WebsiteAccessCapability, string> = {
  admin: "Admin, can sign",
  signer: "Can sign",
  viewer: "View only",
};

export type PortalWebsiteAccessInitial =
  | { kind: "ok"; contacts: WebsiteAccessRow[] }
  | { kind: "unavailable"; reason: string };

export function PortalWebsiteAccessCard({
  clientId,
  clientName,
  showClientName,
  meUserId,
  initial,
}: {
  clientId: string;
  clientName: string;
  /** More than one client on this account: say which one the card is about. */
  showClientName: boolean;
  /** The caller's user id, to mark their own row "(you)". */
  meUserId: string | null;
  initial: PortalWebsiteAccessInitial;
}) {
  const title = showClientName ? `Website access: ${clientName}` : "Website access";
  if (initial.kind === "unavailable") {
    return (
      <Card title={title}>
        <p className="wa-note" style={{ marginBottom: 10 }}>{PORTAL_WEBSITE_ACCESS_HINT}</p>
        <ReadRefusal subject="Website access" kind="unavailable" reason={initial.reason} inline />
      </Card>
    );
  }
  return <Loaded title={title} clientId={clientId} meUserId={meUserId} initialRows={initial.contacts} />;
}

function Loaded({
  title,
  clientId,
  meUserId,
  initialRows,
}: {
  title: string;
  clientId: string;
  meUserId: string | null;
  initialRows: WebsiteAccessRow[];
}) {
  const wa = useWebsiteAccess({
    clientId,
    initialRows,
    setEditor: setPortalWebsiteEditorAction,
    refresh: refreshPortalWebsiteAccessAction,
  });

  // The server said no (a 403 on a write, or on the re-read): this person is not an admin here (any
  // more). Hide the whole section.
  if (wa.locked) return null;

  return (
    <Card title={title}>
      <div style={{ display: "grid", gap: 14 }}>
        <p className="wa-note">{PORTAL_WEBSITE_ACCESS_HINT}</p>

        {wa.rows.length === 0 ? (
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
            Nobody on your account can be given website access yet. Only people who cover your whole account
            can have it.
          </p>
        ) : (
          <ul className="wa-list" aria-label="Website access">
            {wa.rows.map((row) => {
              const who = displayName(row);
              const isMe = meUserId !== null && row.userId === meUserId;
              return (
                <li key={row.contactId} className="wa-row">
                  <div className="wa-row__who">
                    <div className="wa-row__name">{isMe ? `${who} (you)` : who}</div>
                    {row.name ? <div className="wa-row__email">{row.email}</div> : null}
                  </div>
                  <span className="wa-row__meta">
                    {PORTAL_CAPABILITY[row.capability]}
                    {row.status === "invited" ? " · Invited, not signed in yet" : ""}
                  </span>
                  <WebsiteEditorSwitch
                    checked={row.websiteEditor}
                    pending={wa.busy.has(`${row.contactId}:editor`)}
                    label="Website access"
                    accessibleName={`Website access for ${who}`}
                    onChange={(next) => void wa.toggleEditor(row, next)}
                  />
                </li>
              );
            })}
          </ul>
        )}

        {/* One polite status line for every outcome, always rendered so assistive tech has the region
            registered before the first message. */}
        <p role="status" className={`wa-status${wa.message?.tone === "error" ? " wa-status--error" : ""}`}>
          {wa.message?.text ?? ""}
        </p>
      </div>
    </Card>
  );
}

"use client";
import { useId, useState } from "react";
import {
  refreshStaffWebsiteAccessAction,
  setStaffClientAdminAction,
  setStaffWebsiteEditorAction,
} from "@/lib/clientWebsiteAccessActions";
import {
  ADMIN_EXPLANATION,
  WEBSITE_ACCESS_CAPABILITY_LABEL,
  displayName,
  type WebsiteAccessReadResult,
  type WebsiteAccessRow,
} from "@/lib/clientWebsiteAccessView";
import { Modal } from "@/components/overlay/Modal";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { WebsiteEditorSwitch } from "@/components/website-access/WebsiteEditorSwitch";
import { useWebsiteAccess } from "@/components/website-access/useWebsiteAccess";
import "@/components/website-access/websiteAccess.css";

// WSK-49f — "who may edit this client's website, and who may say so", on the staff Contacts page.
// (docs/FRONTEND-BFF-CONTRACT.md §16i; ruling WSK-D60 amended 2026-10-11.)
//
// What this lists is the server's list, verbatim: CLIENT-WIDE, non-revoked contacts. A contact limited to
// one project is not eligible and the route does not return it, so it is not shown here, and the note
// below says why rather than leaving a staff member wondering where a person went.
//
// Controls are shown only to a viewer who is allowed to use them (`canManageEditor` / `canManageAdmin`,
// the UI mirror of Cerbos). That gating is cosmetic: every write is re-authorized, a 403 flips the
// panel to a plain read-only list (`locked`), and a 403 on the admin route alone hides just the admin
// buttons. Nothing is ever left as a toggle that cannot work.
export type StaffWebsiteAccessInitial =
  | { kind: "ok"; contacts: WebsiteAccessRow[] }
  | { kind: "forbidden" }
  | { kind: "unavailable"; reason: string };

export function ClientWebsiteAccessPanel({
  clientId,
  clientName,
  initial,
  canManageEditor,
  canManageAdmin,
}: {
  clientId: string;
  clientName: string;
  initial: StaffWebsiteAccessInitial;
  canManageEditor: boolean;
  canManageAdmin: boolean;
}) {
  if (initial.kind === "forbidden") {
    return <ReadRefusal subject="who has website access for this client" kind="forbidden" inline />;
  }
  if (initial.kind === "unavailable") {
    // Not a statement that nobody has access: say we cannot tell.
    return <ReadRefusal subject="Website access" kind="unavailable" reason={initial.reason} inline />;
  }
  return (
    <Loaded
      clientId={clientId}
      clientName={clientName}
      initialRows={initial.contacts}
      canManageEditor={canManageEditor}
      canManageAdmin={canManageAdmin}
    />
  );
}

type AdminDialog = { kind: "make" | "remove"; row: WebsiteAccessRow } | null;

function Loaded({
  clientId,
  clientName,
  initialRows,
  canManageEditor,
  canManageAdmin,
}: {
  clientId: string;
  clientName: string;
  initialRows: WebsiteAccessRow[];
  canManageEditor: boolean;
  canManageAdmin: boolean;
}) {
  const wa = useWebsiteAccess({
    clientId,
    initialRows,
    setEditor: setStaffWebsiteEditorAction,
    refresh: refreshStaffWebsiteAccessAction,
  });
  const { rows, busy, message, setMessage, patchRow, mark, handleGone } = wa;
  const [adminLocked, setAdminLocked] = useState(false);
  const [dialog, setDialog] = useState<AdminDialog>(null);

  const editorControls = canManageEditor && !wa.locked;
  const adminControls = canManageAdmin && !adminLocked && !wa.locked;

  async function changeAdmin(row: WebsiteAccessRow, grant: boolean, to: "signer" | "viewer") {
    const key = `${row.contactId}:admin`;
    const who = displayName(row);
    mark(key, true);
    setMessage(null);
    try {
      const r = await setStaffClientAdminAction({ clientId, contactId: row.contactId, grant, to: grant ? undefined : to });
      if (r.ok) {
        // `capability` is the contact's resulting capability, also on a no-op: show the real one.
        const now = r.capability ?? (grant ? "admin" : to);
        patchRow(row.contactId, { capability: now, isAdmin: now === "admin" });
        if (r.changed) {
          setMessage({
            tone: "ok",
            text: grant
              ? `${who} is now an admin.`
              : `${who} is no longer an admin and is now a ${WEBSITE_ACCESS_CAPABILITY_LABEL[now]}.`,
          });
        } else {
          setMessage({
            tone: "info",
            text: grant ? `${who} was already an admin, so nothing changed.` : `${who} was not an admin, so nothing changed.`,
          });
        }
      } else if (r.kind === "forbidden") {
        setAdminLocked(true);
        setMessage({ tone: "error", text: "Only a company admin can change who is an admin. Nothing was changed." });
      } else if (r.kind === "not_found") {
        await handleGone(who, row.contactId);
      } else {
        setMessage({ tone: "error", text: `${r.message} Nothing was changed.` });
      }
    } catch {
      setMessage({ tone: "error", text: "Could not reach the server. Nothing was changed." });
    } finally {
      mark(key, false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div>
        <h3 style={{ margin: 0, font: "600 14px var(--font-display)", color: "var(--ink)" }}>Website editors</h3>
        <p className="wa-note" style={{ marginTop: 4 }}>
          Who can edit and publish {clientName}&rsquo;s website in the client portal. An admin can also give their
          colleagues website access. Only contacts who cover the whole client are listed: a contact limited to one
          project can&rsquo;t edit the website.
        </p>
      </div>

      {!canManageEditor && (
        <p className="wa-note">
          You can see who has website access. Changing it takes a company admin or manager.
        </p>
      )}
      {wa.locked && (
        <p className="wa-note">
          The server did not allow that change, so this list is read-only for you.
        </p>
      )}
      {canManageEditor && !canManageAdmin && !wa.locked && (
        <p className="wa-note">Making someone an admin takes a company admin.</p>
      )}

      {rows.length === 0 ? (
        <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
          No contact covers the whole client yet, so nobody can be given website access. Invite one under Client access first.
        </p>
      ) : (
        <ul className="wa-list" aria-label={`Website access for ${clientName}`}>
          {rows.map((row) => {
            const who = displayName(row);
            const editorBusy = busy.has(`${row.contactId}:editor`);
            const adminBusy = busy.has(`${row.contactId}:admin`);
            return (
              <li key={row.contactId} className="wa-row">
                <div className="wa-row__who">
                  <div className="wa-row__name">{who}</div>
                  {row.name ? <div className="wa-row__email">{row.email}</div> : null}
                </div>
                <span className="wa-row__meta">
                  <strong>{WEBSITE_ACCESS_CAPABILITY_LABEL[row.capability]}</strong>
                  {row.status === "invited" ? " · Invited, not signed in yet" : ""}
                </span>
                {adminControls && (
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 12 }}
                    aria-disabled={adminBusy || undefined}
                    aria-label={row.isAdmin ? `Remove admin: ${who}` : `Make admin: ${who}`}
                    onClick={() => {
                      if (adminBusy) return;
                      setDialog({ kind: row.isAdmin ? "remove" : "make", row });
                    }}
                  >
                    {adminBusy ? "Working…" : row.isAdmin ? "Remove admin" : "Make admin"}
                  </button>
                )}
                {editorControls ? (
                  <WebsiteEditorSwitch
                    checked={row.websiteEditor}
                    pending={editorBusy}
                    label="Website editor"
                    accessibleName={`Website editor: ${who}`}
                    onChange={(next) => void wa.toggleEditor(row, next)}
                  />
                ) : (
                  <span className="wa-row__meta">{`Website editor: ${row.websiteEditor ? "Yes" : "No"}`}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ONE polite status line for every outcome. `role="status"` is a polite live region; errors are
          not `alert`, because nothing here is urgent and an assertive interrupt on a refused toggle
          would be noise. The element is always rendered so a screen reader has it registered before
          the first message arrives. */}
      <p
        role="status"
        ref={wa.statusRef}
        tabIndex={-1}
        className={`wa-status${message?.tone === "error" ? " wa-status--error" : ""}`}
      >
        {message?.text ?? ""}
      </p>

      {dialog?.kind === "make" && (
        <MakeAdminDialog
          row={dialog.row}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const row = dialog.row;
            setDialog(null);
            void changeAdmin(row, true, "viewer");
          }}
        />
      )}
      {dialog?.kind === "remove" && (
        <RemoveAdminDialog
          row={dialog.row}
          onCancel={() => setDialog(null)}
          onConfirm={(to) => {
            const row = dialog.row;
            setDialog(null);
            void changeAdmin(row, false, to);
          }}
        />
      )}
    </div>
  );
}

function MakeAdminDialog({
  row,
  onCancel,
  onConfirm,
}: {
  row: WebsiteAccessRow;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const bodyId = useId();
  const who = displayName(row);
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Make ${who} an admin?`}
      describedBy={bodyId}
      size="sm"
      footer={
        <div className="wa-dialog__foot">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>Make admin</button>
        </div>
      }
    >
      <div className="wa-dialog__body" id={bodyId}>
        <p>{ADMIN_EXPLANATION}.</p>
        <p>
          Their access today ({WEBSITE_ACCESS_CAPABILITY_LABEL[row.capability]}) is replaced by Admin. An admin can
          always sign. You can remove admin later.
        </p>
      </div>
    </Modal>
  );
}

function RemoveAdminDialog({
  row,
  onCancel,
  onConfirm,
}: {
  row: WebsiteAccessRow;
  onCancel: () => void;
  onConfirm: (to: "signer" | "viewer") => void;
}) {
  const bodyId = useId();
  const who = displayName(row);
  // Mounted only while open, so it always starts at the default. Viewer is the default because it is
  // the least access: omitting the choice must never mint signing authority.
  const [to, setTo] = useState<"signer" | "viewer">("viewer");
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Remove admin from ${who}?`}
      describedBy={bodyId}
      size="sm"
      footer={
        <div className="wa-dialog__foot">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onConfirm(to)}>Remove admin</button>
        </div>
      }
    >
      <div className="wa-dialog__body" id={bodyId}>
        <p>
          They will no longer be able to give colleagues website access. Choose what they keep. We don&rsquo;t
          remember what they had before they became an admin.
        </p>
        <fieldset className="wa-choice">
          <legend>{who} keeps</legend>
          <label>
            <input type="radio" name="keep-capability" value="viewer" checked={to === "viewer"} onChange={() => setTo("viewer")} />
            <span>
              Viewer
              <small>Can follow the work, but can&rsquo;t sign.</small>
            </span>
          </label>
          <label>
            <input type="radio" name="keep-capability" value="signer" checked={to === "signer"} onChange={() => setTo("signer")} />
            <span>
              Signer
              <small>Can sign agreements and approve work.</small>
            </span>
          </label>
        </fieldset>
      </div>
    </Modal>
  );
}

import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import {
  listClientNotes, listClientHistory, listMembers, readFiles, CLIENT_CONTACT_LABELS,
  type ClientHistoryEntry, type ClientContactKey,
} from "@/lib/entities";
import { addClientNoteAction, deleteClientNoteForm } from "@/lib/clientWorkActions";
import { readResult } from "@/lib/readResult";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ClientNoteForm } from "@/components/forms/ClientWorkForms";
import { FilesPanel } from "@/components/FilesPanel";
import { formatDateTime } from "@/lib/format";
import { registry, centreChangeLabel, isAreaTogglePath } from "@/lib/clientCentre";

// CC-D10 — the client hub's Notes & history tab; PV3-05 — now the hub's INTERNAL area.
//
// STAFF ONLY, and the page says so in a banner (and the tab in a distinct style): no client-visible
// area may look like this one. Nothing here is a portal read, so none of it is ever shown to the client.
//
// EVERY READ REFUSES EXPLICITLY (PV3-05): notes, history and the staff directory each render
// `<ReadRefusal>` when refused. An empty list means the read succeeded and found nothing — "No notes
// yet" used to be what a 403 looked like.
//
// NOTES are internal: stored in the core `comments` table, which no client/portal role can read, so
// nothing written here reaches the client. Anyone with `client.write` can add one; you can delete your
// own, and `client.delete` (manager+) can delete anyone's — the same line the backend enforces.
//
// FILES (DW-8h, BFF §45.4) are the client's own attachments (`client` target): staff only, like everything here. The
// portal never lists or serves a `client` file. Placed here, "notes and files", at PV's call (PV-D4: staff-only material
// lives in the Internal area).
//
// HISTORY is the activity log for this client, newest first. Owner changes are stored as user ids and
// rendered as names here, from the same directory the owner picker uses.
export default async function ClientNotesPage({ params }: { params: Promise<{ clientId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const [notesRes, historyRes, membersRes, filesRes] = await Promise.all([
    listClientNotes(userId, tenant, clientId),
    listClientHistory(userId, tenant, clientId),
    // Only used to turn owner ids in the history into names; its refusal is shown beside the history.
    readResult(listMembers(userId, tenant)),
    readFiles(userId, tenant, "client", clientId),
  ]);
  const canWrite = can(me, "client.write", tenant);
  const canDeleteAny = can(me, "client.delete", tenant);
  const names = membersRes.kind === "ok" ? new Map(membersRes.data.map((m) => [m.user_id, m.name || m.email])) : null;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div role="note" className="ch-internal-banner">
        <strong>Internal: never shown to the client.</strong> The notes and the change history on this tab are
        for our team only.
      </div>
      <Card title={`Notes${notesRes.kind === "ok" && notesRes.data.length ? ` · ${notesRes.data.length}` : ""}`} hint="Internal to our team. Clients never see these.">
        {canWrite && (
          <div style={{ marginBottom: 16 }}>
            <ClientNoteForm action={addClientNoteAction.bind(null, clientId)} />
          </div>
        )}
        {notesRes.kind !== "ok" ? (
          <ReadRefusal subject="this client's notes" kind={notesRes.kind} reason={notesRes.kind === "unavailable" ? notesRes.reason : undefined} inline />
        ) : notesRes.data.length === 0 ? (
          <EmptyNote>No notes yet.</EmptyNote>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
            {notesRes.data.map((n) => {
              const mayDelete = (n.authorId === userId && canWrite) || canDeleteAny;
              return (
                <li key={n.id} style={{ borderTop: "1px solid var(--hairline)", paddingTop: 10 }}>
                  <p style={{ margin: "0 0 6px", font: "400 13px/1.5 var(--font-body)", color: "var(--ink-strong)", whiteSpace: "pre-wrap" }}>{n.body}</p>
                  <div style={{ display: "flex", gap: 12, alignItems: "center", font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
                    <span>{n.authorName ?? "Unknown"} · {formatDateTime(n.createdAt)}</span>
                    {mayDelete && (
                      <form action={deleteClientNoteForm.bind(null, clientId, n.id)}>
                        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Delete</button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Files" hint="Internal to our team. Clients never see these.">
        <FilesPanel entityType="client" entityId={clientId} revalidate={`/clients/${clientId}/notes`} result={filesRes} note="Only staff see these files." />
      </Card>

      <Card title="History" hint="Every change to this client and its profile, newest first.">
        {membersRes.kind !== "ok" && (
          <ReadRefusal
            subject="the staff directory"
            kind={membersRes.kind}
            reason={membersRes.kind === "unavailable" ? membersRes.reason : undefined}
            detail="Owner changes below show the person's id instead of a name."
            inline
          />
        )}
        {historyRes.kind !== "ok" ? (
          <ReadRefusal subject="this client's history" kind={historyRes.kind} reason={historyRes.kind === "unavailable" ? historyRes.reason : undefined} inline />
        ) : historyRes.data.length === 0 ? (
          <EmptyNote>No recorded changes yet. Changes made from now on are listed here.</EmptyNote>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {historyRes.data.map((h) => (
              <li key={h.id} style={{ borderTop: "1px solid var(--hairline)", paddingTop: 8, font: "400 13px/1.5 var(--font-body)" }}>
                <div>
                  <strong style={{ fontWeight: 600 }}>{h.actorName ?? "System"}</strong> {describe(h)}
                  <span style={{ color: "var(--ink-muted)" }}> · {formatDateTime(h.occurredAt)}</span>
                </div>
                {changesOf(h).length > 0 && (
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--ink-muted)", font: "400 12px/1.5 var(--font-body)" }}>
                    {changesOf(h).map((ch, i) => (
                      <li key={i}>
                        {fieldLabel(ch.field)}: {show(ch.field, ch.before, names)} → {show(ch.field, ch.after, names)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

type Change = { field: string; before: string | null; after: string | null };

/** Client edits record `field`; Client Centre profile edits record `path` (e.g. `profile.city`). */
function changesOf(h: ClientHistoryEntry): Change[] {
  const raw = (h.metadata?.changes ?? []) as Array<{ field?: string; path?: string; before: unknown; after: unknown }>;
  return raw.map((c) => ({
    field: c.field ?? c.path ?? "?",
    before: plain(c.before),
    after: plain(c.after),
  }));
}

/** A change value as text. A connection entry is an object and a custom-connection list is an array; both
 *  used to print as "[object Object]". */
function plain(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? String((x as { name?: unknown }).name ?? "") : String(x))).join(", ");
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${String(x)}`).join(", ");
  return String(v);
}

function describe(h: ClientHistoryEntry): string {
  const via = h.metadata?.via;
  switch (h.verb) {
    case "created": return "created the client";
    case "deleted": return "deleted the client";
    case "noted": return "added a note";
    case "note_deleted": return "deleted a note";
    case "commented": return "commented";
    case "updated":
      if (via === "portal") return "updated the business profile from the client portal";
      if (via === "client-centre") return "updated the business profile";
      return changesOf(h).length ? "edited the client" : "saved the client with no changes";
    default: return h.verb.replace(/_/g, " ");
  }
}

function fieldLabel(field: string): string {
  if (field === "name") return "Name";
  if (field === "status") return "Status";
  if (field === "owner") return "Owner";
  if (field.startsWith("contact.")) {
    const k = field.slice("contact.".length) as ClientContactKey;
    return CLIENT_CONTACT_LABELS[k] ?? k;
  }
  // Business profile edits record a path (PV6-01): the field's label, the connection's name, "Business area <name>".
  return centreChangeLabel(registry, field);
}

function show(field: string, v: string | null, names: Map<string, string> | null): string {
  // A Business area toggle reads "on" / "off"; a cleared override is back to the business type's default.
  if (isAreaTogglePath(field)) return v === "true" ? "on" : v === "false" ? "off" : "(default)";
  if (v === null || v === "") return "(empty)";
  // `names === null` means the directory read was refused (shown above the list): the id is the honest
  // value then, NOT "a former staff member", which would be a confident wrong answer.
  if (field === "owner") return names ? (names.get(v) ?? "a former staff member") : v;
  return v;
}

import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import {
  listClientNotes, listClientHistory, listMembers, CLIENT_CONTACT_LABELS,
  type ClientHistoryEntry, type ClientContactKey,
} from "@/lib/entities";
import { addClientNoteAction, deleteClientNoteForm } from "@/lib/clientWorkActions";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ClientNoteForm } from "@/components/forms/ClientWorkForms";
import { formatDateTime } from "@/lib/format";

// CC-D10 — the client hub's Notes & history tab.
//
// NOTES are internal: stored in the core `comments` table, which no client/portal role can read, so
// nothing written here reaches the client. Anyone with `client.write` can add one; you can delete your
// own, and `client.delete` (manager+) can delete anyone's — the same line the backend enforces.
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

  const [notes, history, members] = await Promise.all([
    listClientNotes(userId, tenant, clientId),
    listClientHistory(userId, tenant, clientId),
    listMembers(userId, tenant).catch(() => []),
  ]);
  const canWrite = can(me, "client.write", tenant);
  const canDeleteAny = can(me, "client.delete", tenant);
  const names = new Map(members.map((m) => [m.user_id, m.name || m.email]));

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <Card title={`Notes${notes.length ? ` · ${notes.length}` : ""}`} hint="Internal to our team. Clients never see these.">
        {canWrite && (
          <div style={{ marginBottom: 16 }}>
            <ClientNoteForm action={addClientNoteAction.bind(null, clientId)} />
          </div>
        )}
        {notes.length === 0 ? (
          <EmptyNote>No notes yet.</EmptyNote>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
            {notes.map((n) => {
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

      <Card title="History" hint="Every change to this client and its profile, newest first.">
        {history.length === 0 ? (
          <EmptyNote>No recorded changes yet. Changes made from now on are listed here.</EmptyNote>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {history.map((h) => (
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
    before: c.before === null || c.before === undefined ? null : String(c.before),
    after: c.after === null || c.after === undefined ? null : String(c.after),
  }));
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
  return field;
}

function show(field: string, v: string | null, names: Map<string, string>): string {
  if (v === null || v === "") return "(empty)";
  if (field === "owner") return names.get(v) ?? "a former staff member";
  return v;
}

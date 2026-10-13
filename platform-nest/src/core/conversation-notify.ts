// PV4-06 — notifications for client Conversation, both ways.
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-06; finding 1, finding 2, design decision 5; PV4-Q1).
// BFF contract: docs/FRONTEND-BFF-CONTRACT.md §29 ("Notifications").
//
// ── WHEN EACH NOTICE FIRES ────────────────────────────────────────────────────────────────────────
//   a CLIENT posts (new thread or reply)      -> staff recipients,  `conversation.message.client`
//   STAFF post, or a draft is SENT            -> in-scope contacts, `conversation.message.staff`
//   an AGENT creates a draft                  -> staff recipients,  `conversation.draft.created`
// Closing a thread notifies nobody. (Messages are permanent, PV-D34: there is no edit or retract to notify.)
//
// ── BEST-EFFORT, AFTER THE WRITE COMMITS ──────────────────────────────────────────────────────────
// The controllers call these AFTER `withTenants` has returned (the message is committed). Everything in here, the thread
// lookup and the recipient queries included, runs inside one try/catch that logs loudly and never rethrows, and each
// `notify()` is isolated per recipient by `notifyBestEffort` (client-notify.ts). A notification problem therefore can neither
// fail nor roll back a message someone has already been told was sent.
//
// ── NEVER THE MESSAGE TEXT ────────────────────────────────────────────────────────────────────────
// A notification row is stored in `notifications.payload` and may be mailed. The text of a message stays in the thread,
// behind authorization; the payload carries a short fixed title, the deep link, and the thread id. Nothing here reads
// `conversation_messages.body`, and nothing here names the drafts table (the portal controller imports this file, and
// `conversation-portal-guard.test.ts` scans what it imports for that name).
//
// ── WHO HEARS ─────────────────────────────────────────────────────────────────────────────────────
// Staff (design decision 5; there is no project-team table, finding 2): the thread's staff participants (distinct authors of
// its live staff messages), plus the project's owner (project threads only), plus the client's account manager
// (`clients.owner_user_id`); deduplicated, the actor excluded, inactive users dropped. An empty set notifies nobody and is not
// an error: the thread still shows as awaiting reply on the client hub, so a missed notice never hides it.
//
// Contacts: `resolveClientRecipients(kind: 'general')` with the thread's own project. For a project thread that is the
// client-wide contacts plus those scoped to THAT project (never another project's). For a client-wide thread
// (`project_id` NULL) the SQL's `project_id = NULL` is never true, so only client-wide contacts are returned, which is
// PV4-Q1: a project-scoped contact must not hear about the general thread, because they cannot open it.
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { notifyBestEffort, resolveClientRecipients } from "./client-notify";

export const CONVERSATION_MESSAGE_CLIENT = "conversation.message.client";
export const CONVERSATION_MESSAGE_STAFF = "conversation.message.staff";
export const CONVERSATION_DRAFT_CREATED = "conversation.draft.created";

export interface ConversationThreadFacts {
  threadId: string;
  clientId: string;
  clientName: string;
  projectId: string | null;
}

/** The staff deep link for a thread (a page PV4-09 builds; the client Work area's Conversation tab). */
export function staffThreadHref(clientId: string, threadId: string): string {
  return `/clients/${clientId}/work/conversation/${threadId}`;
}

/** THE staff-recipient rule as one SQL fragment: a subquery of user ids, `thread` authors (live staff messages) UNION the
 *  project's owner UNION the client's account manager. The arguments are SQL expressions (a bind parameter or a column of
 *  the enclosing query) so the notify path and the staff list's `mine` filter (DW-5g) share ONE definition. */
export function staffRecipientIdsSql(x: { thread: string; project: string; client: string }): string {
  return `SELECT m.author_id FROM conversation_messages m
           WHERE m.thread_id = ${x.thread} AND m.author_side = 'staff' AND m.retracted_at IS NULL
          UNION
          SELECT p.owner_id FROM projects p
           WHERE p.id = ${x.project} AND p.deleted_at IS NULL AND p.owner_id IS NOT NULL
          UNION
          SELECT cl.owner_user_id FROM clients cl
           WHERE cl.id = ${x.client} AND cl.deleted_at IS NULL AND cl.owner_user_id IS NOT NULL`;
}

/** Staff who should hear about activity on a thread. See the file header for the rule. The actor is excluded here (and
 *  `notify()` also skips self); an inactive or soft-deleted user is dropped. Ordered by id so the result is deterministic. */
export async function resolveStaffRecipients(
  c: PoolClient,
  params: { threadId: string; clientId: string; projectId: string | null; actorId: string | null },
): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    `SELECT u.id
       FROM users u
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        AND ($4::uuid IS NULL OR u.id <> $4::uuid)
        AND u.id IN (
          ${staffRecipientIdsSql({ thread: "$1", project: "$2::uuid", client: "$3" })}
        )
      ORDER BY u.id`,
    [params.threadId, params.projectId, params.clientId, params.actorId],
  );
  return r.rows.map((x) => x.id);
}

/** Client contacts who may open this thread and so should hear about a staff message: `resolveClientRecipients` with the
 *  thread's own project (so `projectId` NULL yields client-wide contacts only, PV4-Q1), minus the actor. */
export async function resolveContactRecipients(
  c: PoolClient,
  params: { clientId: string; projectId: string | null; actorId: string | null },
): Promise<string[]> {
  const ids = await resolveClientRecipients(c, { clientId: params.clientId, projectId: params.projectId, kind: "general" });
  return ids.filter((id) => id !== params.actorId);
}

async function loadThread(c: PoolClient, threadId: string): Promise<ConversationThreadFacts | null> {
  const r = await c.query<{ client_id: string; client_name: string; project_id: string | null }>(
    `SELECT t.client_id, cl.name AS client_name, t.project_id
       FROM conversation_threads t JOIN clients cl ON cl.id = t.client_id
      WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [threadId],
  );
  const row = r.rows[0];
  return row ? { threadId, clientId: row.client_id, clientName: row.client_name, projectId: row.project_id } : null;
}

/** Run one notification step inside the never-throws wrapper. `resolve` runs on a tenant connection; `send` runs after it.
 *  Returns the recipients that were handed to `notify()` (empty on any failure, or when there was nobody to tell). */
async function dispatch(
  label: string,
  tenantId: string,
  threadId: string,
  resolve: (c: PoolClient, thread: ConversationThreadFacts) => Promise<string[]>,
  send: (thread: ConversationThreadFacts, recipients: string[]) => Promise<void>,
): Promise<string[]> {
  try {
    const found = await withTenants([tenantId], async (c) => {
      const thread = await loadThread(c, threadId);
      if (!thread) return null;
      return { thread, recipients: await resolve(c, thread) };
    });
    if (!found || found.recipients.length === 0) return [];
    await send(found.thread, found.recipients);
    return found.recipients;
  } catch (err) {
    console.error(`[conversation-notify] ${label} failed (thread=${threadId}):`, (err as Error)?.message ?? err);
    return [];
  }
}

/** A client posted (a new thread, or a reply): tell the staff recipients. */
export function notifyClientPosted(tenantId: string, actorId: string | null, threadId: string): Promise<string[]> {
  return dispatch(
    "client post",
    tenantId,
    threadId,
    (c, t) => resolveStaffRecipients(c, { threadId, clientId: t.clientId, projectId: t.projectId, actorId }),
    (t, recipients) =>
      notifyBestEffort(tenantId, actorId, recipients, CONVERSATION_MESSAGE_CLIENT, {
        title: `New message from ${t.clientName}`,
        href: staffThreadHref(t.clientId, threadId),
        entityType: "conversation",
        entityId: threadId,
      }),
  );
}

/** Staff posted, or a draft was sent: tell every contact in the thread's scope. */
export function notifyStaffPosted(tenantId: string, actorId: string | null, threadId: string): Promise<string[]> {
  return dispatch(
    "staff post",
    tenantId,
    threadId,
    (c, t) => resolveContactRecipients(c, { clientId: t.clientId, projectId: t.projectId, actorId }),
    (_t, recipients) =>
      notifyBestEffort(tenantId, actorId, recipients, CONVERSATION_MESSAGE_STAFF, {
        title: "You have a new message",
        // The portal deep link (a page PV4-08 builds). Kept as a literal ON this `href` line on purpose: the UI's
        // deep-link ledger (portal-links.guard.test.ts) finds the links the backend sends by scanning for them here.
        href: `/portal/conversation/${threadId}`,
        entityType: "conversation",
        entityId: threadId,
      }),
  );
}

/** An agent (or anyone) created a draft reply: tell the staff recipients one is waiting. */
export function notifyDraftCreated(tenantId: string, actorId: string | null, threadId: string): Promise<string[]> {
  return dispatch(
    "draft created",
    tenantId,
    threadId,
    (c, t) => resolveStaffRecipients(c, { threadId, clientId: t.clientId, projectId: t.projectId, actorId }),
    (t, recipients) =>
      notifyBestEffort(tenantId, actorId, recipients, CONVERSATION_DRAFT_CREATED, {
        title: "A draft reply is waiting",
        href: staffThreadHref(t.clientId, threadId),
        entityType: "conversation",
        entityId: threadId,
      }),
  );
}

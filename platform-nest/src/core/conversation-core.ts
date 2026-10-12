// PV4-03 — the parts of client Conversation that the STAFF and the PORTAL controllers share: input
// validation, the lazy client-wide thread, message insert, inline attachments, read markers, the
// 15-minute edit/retract window, and the message read shape.
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-03; design decisions 3, 4, 7; PV4-Q1/Q2).
//
// ── WHAT THIS FILE NEVER DOES ─────────────────────────────────────────────────────────────────────
//   * It never decides WHO may reach a row. Callers pass rows they already admitted: the portal through
//     `conversationThreadInPortalScope` (portal-visibility.ts), the staff side through Cerbos `conversation`
//     + the tenant wall. A helper here that took a bare thread id and trusted it would be the shortcut
//     that leaks one client's thread to another, so every function below takes an ALREADY-RESOLVED
//     thread/message, or a predicate fragment the caller owns.
//   * It never reads `conversation_drafts`. The portal controller imports this file, and design decision 3
//     says no portal path touches drafts; the static guard (conversation-portal-guard.test.ts) scans this
//     file as well as the portal controller.
//   * It never takes `author_id`, `author_side`, `client_id` or `tenant_id` from a request body. Every
//     write below receives them as arguments the controller derived from the principal and the scope.
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId } from "../db";
import { config } from "../config";
import { storage } from "./storage";
import { sha256Hex } from "./content-hash";
import { scrubText, isScrubbableText } from "./scrub";

export type ConversationSide = "client" | "staff";

/** Plain-text body bounds. The DB CHECK (`conv_messages_body_length`) enforces 1..10,000 characters too;
 *  checking here turns a would-be 500 into a 400. JS `length` counts UTF-16 units, which is >= the
 *  code-point count Postgres measures, so this is never looser than the CHECK. */
export const MAX_BODY_CHARS = 10_000;
export const MAX_SUBJECT_CHARS = 200;
/** Lead decision (PV4-03 brief, deviation 1): up to 5 files per message, TOTAL <= 10 MB per message —
 *  the same budget as a payment proof (`MAX_PROOF_BYTES`). Not 5 x 10 MB: 50 MB of base64 JSON is
 *  an absurd request body. The ONE definition of the total: `core/upload-body-limits.ts` derives the four
 *  conversation routes' Fastify `bodyLimit` from it (PV4-03b), so the global 1 MiB default no longer
 *  pre-empts it; see the BFF §29 note. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;
/** PV4-Q2 default: a message may be edited or retracted by its author for 15 minutes, then it is permanent. */
export const EDIT_WINDOW_MINUTES = 15;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export interface AttachmentInput {
  filename?: unknown;
  contentType?: unknown;
  content?: unknown;
}

/** A decoded, validated attachment, ready to store. Decoding happens BEFORE any write so a bad
 *  attachment refuses the whole message instead of leaving half of it stored. */
export interface PreparedAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
  scrubbed: boolean;
}

/** The message text: required, plain text, 1..10,000 characters after the PAN/national-id scrub
 *  (free text from outside the trust boundary, the same rule as change requests). Never interpreted as
 *  HTML or Markdown (design decision 7); the UI renders it as text. */
export function validateBody(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) throw new BadRequestException("body is required");
  if (raw.length > MAX_BODY_CHARS) throw new BadRequestException(`body is too long (max ${MAX_BODY_CHARS} characters)`);
  // A redaction token can be longer than what it replaced, so clamp again AFTER the scrub: the CHECK
  // would otherwise turn a legitimate 9,990-character message into a 500.
  return scrubText(raw).text.slice(0, MAX_BODY_CHARS);
}

export function validateSubject(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new BadRequestException("subject must be a string");
  const s = raw.trim();
  if (!s) return null;
  return scrubText(s).text.slice(0, MAX_SUBJECT_CHARS);
}

/** Validate and decode inline base64 attachments (copying portal-commerce's `storeProof`). */
export function prepareAttachments(raw: unknown): PreparedAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException("attachments must be an array");
  if (raw.length > MAX_ATTACHMENTS) throw new BadRequestException(`at most ${MAX_ATTACHMENTS} attachments per message`);
  let total = 0;
  return raw.map((a: AttachmentInput, i) => {
    if (!a || typeof a !== "object" || typeof a.content !== "string" || !a.content) {
      throw new BadRequestException(`attachments[${i}].content (base64) is required`);
    }
    const filename = scrubText(typeof a.filename === "string" && a.filename ? a.filename : "attachment").text.slice(0, 200);
    const contentType = (typeof a.contentType === "string" && a.contentType ? a.contentType : "application/octet-stream").slice(0, 120);
    const decoded = Buffer.from(a.content, "base64");
    if (decoded.byteLength === 0) throw new BadRequestException(`attachments[${i}] is empty or not valid base64`);
    total += decoded.byteLength;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new BadRequestException("attachments too large (max 10 MB per message in total)");
    let bytes: Buffer = decoded;
    let scrubbed = false;
    // Text attachments get the same day-one scrub as the staff upload path and payment proofs; binaries
    // pass through and are served as sandboxed attachments (no inline render) by both download routes.
    if (isScrubbableText(contentType)) {
      const { text, redactions } = scrubText(decoded.toString("utf8"));
      bytes = Buffer.from(text, "utf8");
      scrubbed = redactions > 0;
    }
    return { filename, contentType, bytes, scrubbed };
  });
}

/** Store prepared attachments as ordinary `files` rows targeting the MESSAGE: `target_entity_type =
 *  'conversation'`, `target_entity_id = <message id>`. The staff `/files/:id/content` route then
 *  authorizes the `conversation` kind with no change there; the portal route admits the file through
 *  `DOWNLOADABLE.conversation` + `ownsEntity`, which walks message -> thread -> the thread predicate. */
export async function storeAttachments(
  c: PoolClient, tenantId: string, uploaderId: string, messageId: string, files: PreparedAttachment[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    const fileId = newId();
    const storageKey = `${tenantId}/${fileId}`;
    await storage().put(storageKey, f.bytes);
    await c.query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename,
                          content_type, byte_size, storage_key, sha256, scrubbed, origin_site)
       VALUES ($1, $2, $3, 'conversation', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [fileId, tenantId, uploaderId, messageId, f.filename, f.contentType, f.bytes.byteLength, storageKey, sha256Hex(f.bytes), f.scrubbed, config.originSite],
    );
    ids.push(fileId);
  }
  return ids;
}

/** The client's ONE live client-wide thread, created on first use (PV-D22, lead deviation 2).
 *
 *  RACE-SAFE BY THE INDEX, NOT BY A LOCK: `ux_conv_threads_client_wide` is a partial UNIQUE over
 *  `(tenant_id, client_id) WHERE project_id IS NULL AND deleted_at IS NULL`. Two concurrent first posts
 *  both INSERT ... ON CONFLICT DO NOTHING; the loser blocks on the winner's index entry, and once the
 *  winner commits its DO NOTHING applies and the follow-up SELECT (a fresh READ COMMITTED snapshot)
 *  finds the winner's row. Both posts land in ONE thread. If the winner rolls back, the loser's insert
 *  simply proceeds. `clientId` MUST already be one the caller may reach. */
export async function findOrCreateGeneralThread(
  c: PoolClient, tenantId: string, clientId: string, actorId: string, side: ConversationSide,
): Promise<{ id: string; created: boolean; status: string }> {
  const ins = await c.query<{ id: string; status: string }>(
    `INSERT INTO conversation_threads (id, tenant_id, client_id, project_id, subject, created_by, created_side, origin_site)
     VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)
     ON CONFLICT (tenant_id, client_id) WHERE project_id IS NULL AND deleted_at IS NULL DO NOTHING
     RETURNING id, status`,
    [newId(), tenantId, clientId, actorId, side, config.originSite],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true, status: ins.rows[0].status };
  const sel = await c.query<{ id: string; status: string }>(
    `SELECT id, status FROM conversation_threads
      WHERE tenant_id = $1 AND client_id = $2 AND project_id IS NULL AND deleted_at IS NULL`,
    [tenantId, clientId],
  );
  if (!sel.rows[0]) throw new ConflictException("the general conversation is being created — try again");
  return { id: sel.rows[0].id, created: false, status: sel.rows[0].status };
}

/** A new project thread (many per project are allowed). `projectId` MUST already be admitted for the
 *  caller and belong to `clientId`; the composite FK (project, client, tenant) re-checks the latter. */
export async function createProjectThread(
  c: PoolClient, tenantId: string, clientId: string, projectId: string, subject: string | null,
  actorId: string, side: ConversationSide,
): Promise<string> {
  const id = newId();
  await c.query(
    `INSERT INTO conversation_threads (id, tenant_id, client_id, project_id, subject, created_by, created_side, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, tenantId, clientId, projectId, subject, actorId, side, config.originSite],
  );
  return id;
}

/** Insert one message into an ADMITTED thread, store its attachments, bump the thread's activity and
 *  mark the thread read for the author (posting implies having read it). `authorId` / `side` come from
 *  the principal and the route, never the body. `draftedBy` is set only by the staff draft-send path. */
export async function insertMessage(
  c: PoolClient,
  args: {
    tenantId: string; threadId: string; authorId: string; side: ConversationSide; body: string;
    attachments: PreparedAttachment[]; draftedBy?: string | null;
  },
): Promise<{ id: string; createdAt: string; attachmentIds: string[] }> {
  const id = newId();
  const r = await c.query<{ created_at: string }>(
    `INSERT INTO conversation_messages (id, tenant_id, thread_id, author_id, author_side, body, drafted_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING created_at`,
    [id, args.tenantId, args.threadId, args.authorId, args.side, args.body, args.draftedBy ?? null, config.originSite],
  );
  const attachmentIds = await storeAttachments(c, args.tenantId, args.authorId, id, args.attachments);
  await c.query(
    `UPDATE conversation_threads SET last_message_at = GREATEST(last_message_at, $2::timestamptz), updated_at = now()
      WHERE id = $1`,
    [args.threadId, r.rows[0].created_at],
  );
  await markRead(c, args.tenantId, args.threadId, args.authorId);
  return { id, createdAt: r.rows[0].created_at, attachmentIds };
}

/** Upsert the caller's read marker on an admitted thread. Never moves backwards. */
export async function markRead(c: PoolClient, tenantId: string, threadId: string, userId: string): Promise<void> {
  await c.query(
    `INSERT INTO conversation_reads (tenant_id, thread_id, user_id, last_read_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = GREATEST(conversation_reads.last_read_at, EXCLUDED.last_read_at)`,
    [tenantId, threadId, userId],
  );
}

/** SQL for "unread for this user": messages on thread `t` written by the OTHER side, not retracted,
 *  newer than the user's read marker `r` (LEFT JOINed `conversation_reads r ON r.thread_id = t.id AND
 *  r.user_id = $n`). `otherSide` is a constant chosen by the controller, never caller input. */
export function unreadCountSql(threadAlias: string, readAlias: string, otherSide: ConversationSide): string {
  const side = otherSide === "client" ? "client" : "staff";
  return `(SELECT count(*)::int FROM conversation_messages um
            WHERE um.thread_id = ${threadAlias}.id AND um.author_side = '${side}' AND um.retracted_at IS NULL
              AND um.created_at > COALESCE(${readAlias}.last_read_at, '-infinity'::timestamptz))`;
}

/** A message row as BOTH sides read it, before per-side decoration. A retracted message NEVER carries
 *  its body or its attachments, to either side (lead deviation 4). */
export interface MessageOut {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string | null;
  authorSide: ConversationSide;
  body: string | null;
  retracted: boolean;
  edited: boolean;
  editedAt: string | null;
  createdAt: string;
  /** When the author's 15-minute edit/retract window closes (null once retracted). */
  editableUntil: string | null;
  mine: boolean;
  attachments: Array<{ id: string; filename: string; contentType: string; byteSize: number }>;
  draftedBy?: string | null;
}

interface RawMessage {
  id: string; thread_id: string; author_id: string; author_name: string | null; author_side: ConversationSide;
  body: string; drafted_by: string | null; edited_at: string | null; retracted_at: string | null;
  created_at: string; editable_until: string;
}

/** Read the messages of ONE already-admitted thread, oldest first (the newest `limit`). The caller has
 *  proven the thread is in reach; this function only shapes rows. `includeDraftedBy` is the staff view
 *  (provenance of an agent draft); the portal shows the named sender only (design decision 4). */
export async function readMessages(
  c: PoolClient, threadId: string, viewerId: string, viewerSide: ConversationSide,
  opts: { includeDraftedBy: boolean; limit?: number },
): Promise<MessageOut[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 500);
  const r = await c.query<RawMessage>(
    `SELECT * FROM (
       SELECT m.id, m.thread_id, m.author_id, u.name AS author_name, m.author_side, m.body, m.drafted_by,
              m.edited_at, m.retracted_at, m.created_at,
              m.created_at + make_interval(mins => ${EDIT_WINDOW_MINUTES}) AS editable_until
         FROM conversation_messages m
         LEFT JOIN users u ON u.id = m.author_id
        WHERE m.thread_id = $1
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $2
     ) x ORDER BY x.created_at ASC, x.id ASC`,
    [threadId, limit],
  );
  const live = r.rows.filter((m) => !m.retracted_at).map((m) => m.id);
  const files = live.length
    ? await c.query<{ id: string; target_entity_id: string; filename: string; content_type: string; byte_size: number }>(
        `SELECT id, target_entity_id, filename, content_type, byte_size::int AS byte_size
           FROM files
          WHERE target_entity_type = 'conversation' AND target_entity_id = ANY($1::uuid[]) AND deleted_at IS NULL
          ORDER BY created_at ASC`,
        [live],
      )
    : { rows: [] as Array<{ id: string; target_entity_id: string; filename: string; content_type: string; byte_size: number }> };
  const byMsg = new Map<string, MessageOut["attachments"]>();
  for (const f of files.rows) {
    const list = byMsg.get(f.target_entity_id) ?? [];
    list.push({ id: f.id, filename: f.filename, contentType: f.content_type, byteSize: f.byte_size });
    byMsg.set(f.target_entity_id, list);
  }
  const now = Date.now();
  return r.rows.map((m) => {
    const retracted = m.retracted_at !== null;
    const mine = m.author_id === viewerId && m.author_side === viewerSide;
    const until = new Date(m.editable_until);
    const out: MessageOut = {
      id: m.id,
      threadId: m.thread_id,
      authorId: m.author_id,
      authorName: m.author_name,
      authorSide: m.author_side,
      body: retracted ? null : m.body,
      retracted,
      edited: m.edited_at !== null,
      editedAt: m.edited_at,
      createdAt: m.created_at,
      editableUntil: retracted || !mine || until.getTime() <= now ? null : until.toISOString(),
      mine,
      attachments: retracted ? [] : (byMsg.get(m.id) ?? []),
    };
    if (opts.includeDraftedBy) out.draftedBy = m.drafted_by;
    return out;
  });
}

/** The edit/retract decision on a message row the caller has already admitted AND proven to be their
 *  own (each side answers "not yours" differently: 403 for staff, 404 for the portal). Refuses a
 *  retracted message and a message past its 15-minute window with 409. The row was read FOR UPDATE, so
 *  `within_window` is evaluated against the DB clock under the lock. */
export function assertEditable(row: { retracted_at: string | null; within_window: boolean }): void {
  if (row.retracted_at) throw new ConflictException("this message was removed");
  if (!row.within_window) {
    throw new ConflictException(`a message can only be changed within ${EDIT_WINDOW_MINUTES} minutes of sending`);
  }
}

/** SQL fragment: is message `m` still inside its edit window, by the DB clock. */
export const WITHIN_EDIT_WINDOW_SQL = `(now() < m.created_at + make_interval(mins => ${EDIT_WINDOW_MINUTES}))`;

export async function applyEdit(c: PoolClient, messageId: string, body: string): Promise<{ editedAt: string }> {
  const r = await c.query<{ edited_at: string }>(
    `UPDATE conversation_messages SET body = $2, edited_at = now() WHERE id = $1 RETURNING edited_at`,
    [messageId, body],
  );
  return { editedAt: r.rows[0].edited_at };
}

export async function applyRetract(c: PoolClient, messageId: string): Promise<{ retractedAt: string }> {
  const r = await c.query<{ retracted_at: string }>(
    `UPDATE conversation_messages SET retracted_at = now() WHERE id = $1 RETURNING retracted_at`,
    [messageId],
  );
  return { retractedAt: r.rows[0].retracted_at };
}

// MAIL-13 — the entity-scoped inbound thread reads (design §8A, authorized per A10).
//
//   GET /api/:tenantId/mail/threads?entityType=&entityId=
//   GET /api/:tenantId/mail/messages/:messageId/attachments/:index
//   GET /api/:tenantId/portal/mail/threads?runId=  (or ?gateId=, MAIL-33)
//
// `mail_messages` is a GLOBAL table with no RLS (§6.1), so NOTHING here may reach it before the
// caller has been authorized against the parent entity (`thread-authz.ts`). Every handler below is
// therefore ordered authorize-then-read, and the reads additionally pin `tenant_id = :tenantId` — a
// belt-and-braces predicate that a row provenance-stamped to another tenant can never satisfy, since
// RLS is not available to enforce it here.
//
// WHAT IS DELIBERATELY NOT SERVED: `mail_log.payload`, `reply_token`, and the quarantine `fileRef`
// storage keys. §6.1's test list requires that "no endpoint serializes `mail_log.payload` or
// `mail_messages.body_*` to a caller who fails the entity check" — this file serves `body_*` only
// after the entity check, and never serves `payload`/`reply_token` at all (a leaked reply token is a
// write capability into someone else's thread).
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { withMailContext, withTenants } from "../db";
import { AuthGuard } from "../auth/guards";
import { authorize } from "../core/http";
import { isElevated } from "../admin/elevated";
import { resolvePortalScope } from "../core/portal-scope";
import { storage } from "../core/storage";
import { MAIL_THREAD_ENTITY_KINDS, authorizeThreadParent } from "./thread-authz";
import type { StoredAttachment } from "./inbound/intake";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MailMessageRow {
  id: string;
  mail_log_id: string;
  from_email: string;
  subject: string | null;
  body_text: string;
  body_html_sanitized: string | null;
  body_truncated: boolean;
  body_truncated_chars: number;
  attachments: StoredAttachment[] | null;
  size_bytes: number;
  received_at: string;
}

export interface ThreadAttachmentView {
  index: number;
  name: string;
  contentType: string;
  bytes: number;
  scanStatus: StoredAttachment["scanStatus"];
  /** True when THIS caller may fetch the bytes. `skipped` (scanning off) is admin-only per §7.6, so
   *  this is caller-dependent and computed per request rather than stored. */
  downloadable: boolean;
  /** Why not, when `downloadable` is false — so the UI can say "blocked: infected" rather than
   *  rendering a dead link. */
  blockedReason: "infected" | "not_yet_scanned" | "admin_only" | "no_content" | null;
  rejected?: boolean;
  rejectReason?: StoredAttachment["rejectReason"];
}

export interface ThreadMessageView {
  id: string;
  mailLogId: string;
  /** DISPLAY ONLY. Paired with `senderVerified: false` so the "Email reply — sender unverified"
   *  provenance banner (§7.6) is driven by a machine-readable field the BFF cannot forget to honour,
   *  not by a hardcoded string in one component. */
  fromEmail: string;
  senderVerified: false;
  provenance: "inbound-email";
  subject: string | null;
  bodyText: string;
  /** Already through the intake allowlist sanitizer — the raw MIME was never stored (§7.6). Still to
   *  be rendered in a constrained container, per the same section. */
  bodyHtmlSanitized: string | null;
  /** MAIL-25 — the STRUCTURED truncation signal, set at intake from length arithmetic alone (never by
   *  parsing `bodyText`; see `inbound/html-sanitize.ts`'s `sanitizeInboundText`). This is what the
   *  render layer's truncation notice must be driven by, NOT the `[truncated at intake: ...]` marker
   *  string that may also be present in `bodyText` — a forged marker cannot set this field, because it
   *  is never derived from content. */
  bodyTruncated: boolean;
  /** Characters omitted at intake when `bodyTruncated` is true; `0` otherwise. */
  bodyTruncatedChars: number;
  sizeBytes: number;
  receivedAt: string;
  attachments: ThreadAttachmentView[];
}

function attachmentView(att: StoredAttachment, callerIsElevated: boolean): ThreadAttachmentView {
  const base = {
    index: att.index,
    name: att.name,
    contentType: att.contentType,
    bytes: att.bytes,
    scanStatus: att.scanStatus,
    ...(att.rejected ? { rejected: att.rejected, rejectReason: att.rejectReason } : {}),
  };
  const gate = attachmentGate(att, callerIsElevated);
  return { ...base, downloadable: gate === null, blockedReason: gate };
}

/** THE download gate, in one place (the endpoint and the list view must never disagree about whether
 *  a byte is servable). Returns null when serving is allowed, else the reason it is refused.
 *
 *  Fail-closed on exposure is the binding rule (§7.6: "unscannable stays quarantined"), so the ONLY
 *  universally-servable state is `clean`. `pending` — clamd unreachable, timed out, or bytes never
 *  arrived — is refused at every privilege, including admin: an unscanned attachment from an
 *  unauthenticated sender is exactly what quarantine is for. `skipped` (scanning switched off) is
 *  admin-only, verbatim per §7.6. */
function attachmentGate(att: StoredAttachment, callerIsElevated: boolean): ThreadAttachmentView["blockedReason"] {
  if (att.scanStatus === "infected") return "infected";
  if (!att.fileRef) return "no_content";
  if (att.scanStatus === "pending") return "not_yet_scanned";
  if (att.scanStatus === "skipped") return callerIsElevated ? null : "admin_only";
  return null; // clean
}

function toView(row: MailMessageRow, callerIsElevated: boolean): ThreadMessageView {
  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  return {
    id: row.id,
    mailLogId: row.mail_log_id,
    fromEmail: row.from_email,
    senderVerified: false,
    provenance: "inbound-email",
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtmlSanitized: row.body_html_sanitized,
    bodyTruncated: row.body_truncated,
    bodyTruncatedChars: row.body_truncated_chars,
    sizeBytes: row.size_bytes,
    receivedAt: row.received_at,
    attachments: atts.map((a) => attachmentView(a, callerIsElevated)),
  };
}

const MESSAGE_COLUMNS = `id, mail_log_id, from_email, subject, body_text, body_html_sanitized,
       body_truncated, body_truncated_chars, attachments, size_bytes, received_at`;

/** Shared read. `tenant_id = $3` is not redundant with the entity predicate: `mail_messages` has no
 *  RLS, so without it a (hypothetical) entity-id collision or a mis-stamped row would cross tenants. */
async function readEntityThread(tenantId: string, entityType: string, entityId: string): Promise<MailMessageRow[]> {
  const { rows } = await withMailContext((c) =>
    c.query<MailMessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM mail_messages
        WHERE entity_type = $1 AND entity_id = $2 AND tenant_id = $3
        ORDER BY received_at ASC, created_at ASC
        LIMIT 200`,
      [entityType, entityId, tenantId],
    ),
  );
  return rows;
}

@Controller("api")
@UseGuards(AuthGuard)
export class MailThreadController {
  /** Entity-scoped thread read (design §8A/A10). Powers the approval-detail and run-workspace thread
   *  panels; the portal has its own route below because a client principal is authorized by the
   *  portal predicate, not by the staff entity policies. */
  @Get(":tenantId/mail/threads")
  async entityThread(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
  ): Promise<{ entityType: string; entityId: string; messages: ThreadMessageView[] }> {
    if (!entityType || !entityId) throw new BadRequestException("entityType and entityId required");
    if (!MAIL_THREAD_ENTITY_KINDS.has(entityType)) throw new BadRequestException("unsupported entityType");
    if (!UUID_RE.test(entityId)) throw new BadRequestException("entityId must be a valid id");

    await authorizeThreadParent(req.principal, tenantId, entityType, entityId);
    const rows = await readEntityThread(tenantId, entityType, entityId);
    return { entityType, entityId, messages: rows.map((r) => toView(r, isElevated(req))) };
  }

  /** Quarantined attachment bytes. Authorized against the PARENT of the message's own entity — the
   *  same A10 rule as the thread it appears in — and then gated on `scanStatus`. */
  @Get(":tenantId/mail/messages/:messageId/attachments/:index")
  async attachment(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("messageId") messageId: string,
    @Param("index") indexRaw: string,
  ): Promise<void> {
    if (!UUID_RE.test(messageId)) throw new BadRequestException("messageId must be a valid id");
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0) throw new BadRequestException("index must be a non-negative integer");

    const { rows } = await withMailContext((c) =>
      c.query<{ entity_type: string | null; entity_id: string | null; attachments: StoredAttachment[] | null }>(
        `SELECT entity_type, entity_id, attachments FROM mail_messages WHERE id = $1 AND tenant_id = $2`,
        [messageId, tenantId],
      ),
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("message not found");
    // A message with no entity (an NDR — see inbound/intake.ts) has no parent to authorize against and
    // is therefore not reachable through the tenant surface at all. Fail closed rather than fall back
    // to the tenant param, which the caller controls.
    if (!row.entity_type || !row.entity_id) throw new NotFoundException("message not found");
    await authorizeThreadParent(req.principal, tenantId, row.entity_type, row.entity_id);

    const att = (Array.isArray(row.attachments) ? row.attachments : []).find((a) => a.index === index);
    if (!att) throw new NotFoundException("attachment not found");
    const blocked = attachmentGate(att, isElevated(req));
    if (blocked === "no_content") throw new NotFoundException("attachment has no stored content");
    if (blocked) throw new ForbiddenException(`attachment not downloadable: ${blocked}`);

    const bytes = await storage().get(att.fileRef as string);
    // Same stored-XSS posture as `core/files.controller.ts`: always an attachment download, never
    // inline, `nosniff`, and a CSP that makes the response inert even if a browser is talked into
    // rendering it. Inbound attachments are strictly MORE hostile than uploaded files (the sender is
    // unauthenticated), so this is the floor, not the ceiling.
    await reply
      .header("content-disposition", dispositionHeader(att.name))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type("application/octet-stream")
      .send(bytes);
  }

  /** Portal variant (design §8A: the portal run view gets the same thread panel; §6.1: "The portal
   *  reuses the same rule through the portal BFF — portal-scope predicate applies to the entity
   *  first"). A client principal is NOT authorized by `resource_pipeline_run` (its read rules are
   *  elevated-only), so the entity check here is the portal's own four-layer kernel: Cerbos `portal`
   *  read, then `resolvePortalScope`'s client+project ownership predicate applied TO THE RUN, before
   *  any mail table is touched.
   *
   *  MAIL-33 — accepts `gateId` as an alternative to `runId`. `pipeline.gate.opened` (the notification
   *  that reaches a client signer, `pipeline.controller.ts`'s `openGate`) stamps `mail_log.entity_type
   *  = 'pipeline_gate'` with the GATE's own id, not the run's — so a reply to that email threads onto
   *  `mail_messages` rows keyed the same way, and `runId` alone can never surface them (an entity-scoped
   *  read is keyed on the exact `(entity_type, entity_id)` pair, never "any thread on this run"). The
   *  ownership predicate mirrors `PortalController.decideGate`'s own gate-ownership check exactly
   *  (`actor_side = 'client'`, joined through the run to the SAME client/project scope) — a gate this
   *  client cannot legitimately act on must not leak its thread either, even if the client happens to
   *  own the parent run. */
  @Get(":tenantId/portal/mail/threads")
  async portalThread(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("runId") runId?: string,
    @Query("gateId") gateId?: string,
  ): Promise<{ entityType: "pipeline_run" | "pipeline_gate"; entityId: string; messages: ThreadMessageView[] }> {
    if (!runId && !gateId) throw new BadRequestException("runId or gateId required");
    if (runId && gateId) throw new BadRequestException("provide only one of runId or gateId");
    await authorize(req.principal, { kind: "portal", tenantId }, "read");

    if (gateId) {
      if (!UUID_RE.test(gateId)) throw new BadRequestException("gateId must be a valid id");
      const owned = await withTenants([tenantId], async (c) => {
        const scope = await resolvePortalScope(c, req.principal);
        // Predicate shape is IDENTICAL to `PortalController.decideGate`'s own ownership check
        // (`core/portal.controller.ts`) — same table join, same `actor_side = 'client'` gate, same
        // `($n IS NULL OR project_id = ANY($n))` project clause, deliberately WITHOUT the extra
        // "OR project_id IS NULL" this file's `runId` branch below carries: mirroring decideGate here
        // means a client can read a gate's thread in exactly the cases they could act on that same
        // gate, never a case wider than that.
        const g = await c.query<{ id: string }>(
          `SELECT g.id FROM pipeline_gates g JOIN pipeline_runs r ON g.run_id = r.id
            WHERE g.id = $1 AND g.deleted_at IS NULL AND g.actor_side = 'client' AND r.deleted_at IS NULL
              AND r.client_id = ANY($2::uuid[])
              AND ($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]))`,
          [gateId, scope.clientIds, scope.projectIds],
        );
        return g.rows.length > 0;
      });
      // 404, not 403 — same non-disclosure rule as the run branch below.
      if (!owned) throw new NotFoundException("gate not found");
      const rows = await readEntityThread(tenantId, "pipeline_gate", gateId);
      return { entityType: "pipeline_gate", entityId: gateId, messages: rows.map((r) => toView(r, false)) };
    }

    if (!UUID_RE.test(runId!)) throw new BadRequestException("runId must be a valid id");
    const owned = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const r = await c.query<{ id: string }>(
        `SELECT r.id FROM pipeline_runs r
          WHERE r.id = $1 AND r.deleted_at IS NULL
            AND r.client_id = ANY($2::uuid[])
            AND ($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]) OR r.project_id IS NULL)`,
        [runId, scope.clientIds, scope.projectIds],
      );
      return r.rows.length > 0;
    });
    // 404, not 403: to a client, a run belonging to a different client of the same agency must not be
    // distinguishable from one that does not exist — the same non-disclosure rule the rest of the
    // portal follows.
    if (!owned) throw new NotFoundException("run not found");

    const rows = await readEntityThread(tenantId, "pipeline_run", runId!);
    // `false` for elevation: a portal caller is never treated as an admin here even if they somehow
    // also hold a global grant, so `skipped` attachments stay unservable on the portal surface.
    return { entityType: "pipeline_run", entityId: runId!, messages: rows.map((r) => toView(r, false)) };
  }
}

/** RFC 5987 + CR/LF-stripped filename, same shape as `core/files.controller.ts` (header injection via
 *  a sender-chosen filename is the exact class this closes). */
function dispositionHeader(filename: string): string {
  const ascii = filename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

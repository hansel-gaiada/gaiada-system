// MAIL-04 — `GET /api/admin/mail/log[/:id]` (design §6.1/§8A). `mail_log` is a GLOBAL table (no
// RLS, §6.1) — its ONLY read path at any privilege is this elevated-only admin surface (plus the
// entity-scoped thread read MAIL-13 adds later, authorized against the PARENT entity per A10,
// which is why it does NOT live in this controller). Non-elevated callers get a flat 403; there is
// no partial/redacted view.
import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withMailContext } from "../db";
import { AuthGuard } from "../auth/guards";
import { isElevated } from "../admin/elevated";
import { authorizeThreadParent } from "./thread-authz";
import { renderTemplate, UnknownMailTemplateError } from "./templates";
import type { StoredAttachment } from "./inbound/intake";
import type { ThreadMessageView } from "./thread.controller";

// Defect fix (QA-filed, adversarial-qa.test.ts's former "[DOCUMENTS DEFECT]" case): `tenantId`/
// `entityId` are typed `uuid` columns and `since` is `timestamptz` — a malformed value for any of
// the three was still safely PARAMETERIZED (no injection, no leak), but the raw Postgres "invalid
// input syntax for type X" error was uncaught and surfaced as a bare 500 instead of a 400. Same
// shape-check-before-query convention as `modules/pm/pm.controller.ts`'s `UUID_RE` /
// `modules/search/search.controller.ts`'s `assertUuid` — and, since MAIL-33, applied to BOTH of
// this controller's own `:id`-taking routes (`detail()` and `thread()`), not just one of them: the
// same drift class as MAIL-33's `pipeline_gate` finding — `thread()` validated `id`, `detail()`
// didn't, each internally consistent, neither checked against the other. `admin-mail.controller.
// test.ts`'s "every id-taking route" test pins that the two agree, so this can't silently re-split.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidFilter(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new BadRequestException(`${label} must be a valid id`);
}

function assertTimestampFilter(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) throw new BadRequestException(`${label} must be a valid date`);
}

interface MailLogRow {
  id: string;
  stream: string;
  tenant_id: string | null;
  user_id: string | null;
  to_email: string;
  template_key: string;
  subject: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  provider: string | null;
  provider_message_id: string | null;
  queued_at: string;
  provider_accepted_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

const LIST_COLUMNS = `id, stream, tenant_id, user_id, to_email, template_key, subject, entity_type, entity_id,
       status, attempts, next_attempt_at, last_error, provider, provider_message_id,
       queued_at, provider_accepted_at, delivered_at, created_at, updated_at`;

@Controller("api/admin/mail")
@UseGuards(AuthGuard)
export class AdminMailController {
  @Get("log")
  async list(
    @Req() req: FastifyRequest,
    @Query("stream") stream?: string,
    @Query("status") status?: string,
    @Query("tenantId") tenantId?: string,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
    @Query("since") since?: string,
    @Query("limit") limitQ?: string,
    @Query("offset") offsetQ?: string,
  ): Promise<{ rows: MailLogRow[]; limit: number; offset: number }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");

    const limit = Math.max(1, Math.min(Number(limitQ ?? 100) || 100, 500));
    const offset = Math.max(0, Number(offsetQ ?? 0) || 0);

    const clauses: string[] = [];
    const args: unknown[] = [];
    if (stream) clauses.push(`stream = $${args.push(stream)}`);
    if (status) clauses.push(`status = $${args.push(status)}`);
    if (tenantId) {
      assertUuidFilter(tenantId, "tenantId");
      clauses.push(`tenant_id = $${args.push(tenantId)}`);
    }
    if (entityType) clauses.push(`entity_type = $${args.push(entityType)}`);
    if (entityId) {
      assertUuidFilter(entityId, "entityId");
      clauses.push(`entity_id = $${args.push(entityId)}`);
    }
    if (since) {
      assertTimestampFilter(since, "since");
      clauses.push(`created_at >= $${args.push(since)}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = await withMailContext((c) =>
      c.query<MailLogRow>(
        `SELECT ${LIST_COLUMNS} FROM mail_log ${where} ORDER BY created_at DESC LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
        args,
      ),
    );
    return { rows: rows.rows, limit, offset };
  }

  @Get("log/:id")
  async detail(@Req() req: FastifyRequest, @Param("id") id: string): Promise<MailLogRow> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    // Same shape-check-before-query this file's own `list()` already applies to its `tenantId`/
    // `entityId` filters (`assertUuidFilter`, see this file's header comment) and `thread()` below
    // applies to this SAME `:id` param — added because it was missing here: a malformed id used to
    // reach the raw Postgres `uuid` column and surface as a bare 500 through the last-resort filter,
    // exactly the class of bug that header comment already exists to prevent, just not applied
    // symmetrically across this controller's own two id-taking routes.
    if (!UUID_RE.test(id)) throw new BadRequestException("id must be a valid id");
    const rows = await withMailContext((c) =>
      c.query<MailLogRow>(`SELECT ${LIST_COLUMNS} FROM mail_log WHERE id = $1`, [id]),
    );
    const row = rows.rows[0];
    if (!row) throw new NotFoundException("mail log entry not found");
    return row;
  }

  /** MAIL-38 — `GET /api/admin/mail/log/:id/preview` (design §8A): the RENDERED body of an outbound
   *  mail, recomposed on demand.
   *
   *  `mail_log` deliberately has no body column (§6.1) — the body is composed at send time from
   *  `template_key` + `payload` and never persisted. That is why the admin log could show that a
   *  mail was sent, to whom, with what status, and still never show what it SAID: the only surface
   *  that could answer "what did the recipient actually see" was the Mailpit dev sink, which does
   *  not exist outside dev. The owner hit exactly this on 2026-08-07 ("i can see the list in the
   *  erp, but cannot click to see the mail content").
   *
   *  Re-render, never store. This calls the SAME `renderTemplate()` the sender uses, so the preview
   *  is the composition path that produced the mail rather than a second, drifting approximation of
   *  it. Nothing is cached: per design §11's "render on demand, cache nothing", caching would put
   *  message bodies into the database that §6.1 is deliberately built to keep out — and would make
   *  every future erasure request have a second place to reach.
   *
   *  The honest limit, surfaced in the response rather than left for a viewer to assume: this
   *  renders from the CURRENT template code, so for a historical row whose template has since
   *  changed it shows what that payload renders as TODAY, not a byte-exact archive of what was sent
   *  then. That is the accepted cost of not storing bodies. `renderedFromCurrentTemplate` says so
   *  explicitly; the UI prints it.
   *
   *  Authorization is elevation-only, matching `detail()` rather than `thread()`. That asymmetry is
   *  deliberate: `thread()` adds the A10 parent-entity gate because it exposes INBOUND,
   *  unauthenticated, attacker-supplied content on a decision surface. A preview exposes only what
   *  this platform itself composed and already sent, from a row the same caller can read in full
   *  via `detail()` — so it inherits `detail()`'s gate, not the stricter one. */
  @Get("log/:id/preview")
  async preview(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ): Promise<{
    mailLogId: string;
    templateKey: string;
    subject: string;
    html: string;
    text: string;
    renderedFromCurrentTemplate: boolean;
    linkOmitted: boolean;
  }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    if (!UUID_RE.test(id)) throw new BadRequestException("id must be a valid id");

    const rows = await withMailContext((c) =>
      c.query<{ template_key: string; payload: Record<string, unknown> | null }>(
        `SELECT template_key, payload FROM mail_log WHERE id = $1`,
        [id],
      ),
    );
    const row = rows.rows[0];
    if (!row) throw new NotFoundException("mail log entry not found");

    // A row can outlive its renderer: `template_key` is free text in the column, and a template
    // retired between send and view would otherwise surface as a bare 500 through the last-resort
    // filter — the same failure mode the UUID checks above exist to prevent. Fail as a 404 naming
    // the key, which is actionable, instead of an opaque server error.
    try {
      const payload = row.payload ?? {};
      const rendered = renderTemplate(row.template_key, payload);
      // Some templates interpolate a value that is DELIBERATELY never persisted, so a faithful
      // preview cannot reproduce it. The magic-link URL is the case that exists today: it carries a
      // bearer token, so storing it on `mail_log` would put a live credential at rest — verified
      // 2026-08-08 that it is genuinely absent (auth rows carry only `ttlMinutes`; 0 of 7 hold an
      // `href`). The template therefore renders `<a href=""></a>`, which looks like a broken
      // template to anyone reviewing mail quality. Say so explicitly instead: the omission is the
      // security property working, not a defect, and the UI must not imply otherwise.
      const linkOmitted = !("href" in payload) && rendered.html.includes('href=""');
      return {
        mailLogId: id,
        templateKey: row.template_key,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        renderedFromCurrentTemplate: true,
        linkOmitted,
      };
    } catch (err) {
      if (err instanceof UnknownMailTemplateError) {
        throw new NotFoundException(`no renderer for template ${row.template_key}`);
      }
      throw err;
    }
  }

  /** MAIL-13 — `GET /api/admin/mail/log/:id/thread` (design §8A): the inbound replies to one outbound
   *  mail, for the admin log's detail pane.
   *
   *  TWO gates, not one, and the second is the interesting one. Elevation is required (§6.1 lists this
   *  route as elevated-only), AND when the mail hangs off an entity the caller must additionally pass
   *  the PARENT-ENTITY check (A10). Elevation alone would make this the one thread read that does NOT
   *  403 where its parent does — and inbound thread content is unauthenticated content sitting on a
   *  decision surface, which is precisely what A10 exists to fence. In practice a `platform_admin`
   *  passes both (its policies allow `*`); the case this catches is a global `group_executive`, whom
   *  `isElevated` admits but `variables.inTenant` may not.
   *
   *  A mail with NO entity (auth-stream mail, and NDR messages — which intake deliberately stores with
   *  a NULL entity so a bounce notice can never render as a human reply on an approval surface) has no
   *  parent to authorize against, so elevation governs on its own. That is not a gap: there is no
   *  narrower authority to defer to, and the row is by construction tenant-less or entity-less. */
  @Get("log/:id/thread")
  async thread(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ): Promise<{ mailLogId: string; messages: ThreadMessageView[] }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    if (!UUID_RE.test(id)) throw new BadRequestException("id must be a valid id");

    const logRows = await withMailContext((c) =>
      c.query<{ id: string; tenant_id: string | null; entity_type: string | null; entity_id: string | null }>(
        `SELECT id, tenant_id, entity_type, entity_id FROM mail_log WHERE id = $1`,
        [id],
      ),
    );
    const log = logRows.rows[0];
    if (!log) throw new NotFoundException("mail log entry not found");
    if (log.entity_type && log.entity_id && log.tenant_id) {
      await authorizeThreadParent(req.principal, log.tenant_id, log.entity_type, log.entity_id);
    }

    const messages = await withMailContext((c) =>
      c.query<AdminThreadRow>(
        `SELECT id, mail_log_id, from_email, subject, body_text, body_html_sanitized, body_truncated,
                body_truncated_chars, attachments, size_bytes, received_at
           FROM mail_messages WHERE mail_log_id = $1 ORDER BY received_at ASC, created_at ASC LIMIT 200`,
        [id],
      ),
    );
    return {
      mailLogId: id,
      messages: messages.rows.map((row) => ({
        id: row.id,
        mailLogId: row.mail_log_id,
        fromEmail: row.from_email,
        senderVerified: false as const,
        provenance: "inbound-email" as const,
        subject: row.subject,
        bodyText: row.body_text,
        bodyHtmlSanitized: row.body_html_sanitized,
        // MAIL-25 — same structured signal as the entity/portal thread reads (`thread.controller.ts`);
        // see `ThreadMessageView.bodyTruncated`'s doc comment for why this, not the marker string.
        bodyTruncated: row.body_truncated,
        bodyTruncatedChars: row.body_truncated_chars,
        sizeBytes: row.size_bytes,
        receivedAt: row.received_at,
        attachments: (Array.isArray(row.attachments) ? row.attachments : []).map((a) => ({
          index: a.index,
          name: a.name,
          contentType: a.contentType,
          bytes: a.bytes,
          scanStatus: a.scanStatus,
          // The admin log pane is a metadata view: bytes are fetched through the tenant-scoped
          // attachment route (which re-runs the A10 parent check), so this never advertises itself as
          // a download source.
          downloadable: false,
          blockedReason: "admin_only" as const,
          ...(a.rejected ? { rejected: a.rejected, rejectReason: a.rejectReason } : {}),
        })),
      })),
    };
  }
}

interface AdminThreadRow {
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

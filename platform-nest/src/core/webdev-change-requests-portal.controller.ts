// MI-02 — the client portal's change-request surface (webdev maintenance intake, D-7).
// Design: docs/superpowers/plans/2026-08-07-webdev-maintenance-intake-design.md §5 (portal surface),
// §1.2 (schema, migration 0088), §4.1 (Cerbos: rides `portal`, new `request_change` action).
//
// ── THE §5.1 RULING, TEST-PINNED HERE, NOT JUST DOCUMENTED ────────────────────────────────────────
// Submitting a change request is a VIEWER-permitted act. Signature capability (`scope.canSign`) gates
// only the downstream mini-run's own gates (prd_sign/scope_signoff) — it is NEVER checked in this
// file. Do not add a `requireSigner(scope)` call here: that would silently narrow a ratified decision
// back to signers-only, which is exactly the "tighten it" mistake the design doc calls out by name.
//
// ── SERVER-DERIVED, NEVER BODY-TRUSTED (the 0075 "rule 1" discipline) ─────────────────────────────
// `client_id`, `requested_by`, `source` and `status` never come from the request body. `client_id` is
// resolved from the caller's own PortalScope (via the project, when a project is named, or from the
// scope's client set otherwise) — see resolveSubmitTarget(). A project-scoped contact MUST name one of
// their own projects; only a client-wide contact (`scope.projectIds === null`) may submit a
// client-wide (`project_id IS NULL`) request.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { scrubText } from "./scrub";
import { notifyBestEffort } from "./client-notify";
import { resolvePortalScope, type PortalScope } from "./portal-scope";
import type { PoolClient } from "pg";

const KINDS = new Set(["content", "design", "feature", "bug"]);
const MAX_TITLE = 300;
const MAX_BODY = 10_000;
// Bug-detail caps. These four are REPORTER-SUPPLIED — they are the things only the person who hit
// the defect knows. `severity` is deliberately NOT among them: it is a triage output, set by staff
// (migration 202608271000 §3). A portal caller naming their own severity is exactly the failure that
// constraint exists to prevent.
//
// Not gated on `kind === 'bug'`. A design request can legitimately carry an affected URL, and
// refusing a field the caller took the trouble to fill in buys nothing — the columns are nullable
// and non-bug rows simply leave them NULL.
const MAX_REPRO = 5_000;
const MAX_ENVIRONMENT = 200;
const MAX_SEEN_ON_VERSION = 100;
const MAX_AFFECTED_URL = 2_000;

/** Every column the portal is allowed to see on a change request, camelCased once here so list and
 *  detail can never drift into two different shapes for the same row. */
const SELECT_COLUMNS = `
  wcr.id, wcr.kind, wcr.title, wcr.body, wcr.status, wcr.route,
  wcr.client_id AS "clientId", wcr.project_id AS "projectId", p.name AS "projectName",
  wcr.pipeline_run_id AS "pipelineRunId", wcr.pm_task_id AS "pmTaskId",
  wcr.declined_reason AS "declinedReason", wcr.requested_by AS "requestedBy",
  wcr.created_at AS "createdAt", wcr.updated_at AS "updatedAt",
  -- Bug detail. Selected so the portal can read back what it submitted: an omitted column is
  -- indistinguishable from a NULL value, so leaving these out would make a successfully-stored
  -- repro step look, to the UI, exactly like one the client never typed.
  -- severity IS included and is READ-ONLY here — the client may see how their bug was ranked at
  -- triage, but create never accepts it.
  wcr.severity, wcr.repro_steps AS "reproSteps", wcr.environment,
  wcr.seen_on_version AS "seenOnVersion", wcr.affected_url AS "affectedUrl"`;

@Controller("api")
@UseGuards(AuthGuard)
export class WebdevChangeRequestsPortalController {
  /** The caller's own change requests (own clients, own project scope). Newest first, capped like
   *  every other portal list (invoices/contracts use the same 200-row cap). */
  @Get(":tenantId/portal/change-requests")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const rows = await c.query(
        `SELECT ${SELECT_COLUMNS}
           FROM webdev_change_requests wcr
           LEFT JOIN projects p ON p.id = wcr.project_id
          WHERE wcr.client_id = ANY($1::uuid[])
            AND ($2::uuid[] IS NULL OR wcr.project_id = ANY($2::uuid[]) OR wcr.project_id IS NULL)
            AND wcr.deleted_at IS NULL
          ORDER BY wcr.created_at DESC LIMIT 200`,
        [scope.clientIds, scope.projectIds],
      );
      return rows.rows;
    });
  }

  /** One change request. 404 (not 403) when it exists but is out of the caller's scope — same
   *  existence-oracle avoidance as ownedInvoice/ownedContract in portal-commerce.controller.ts: a
   *  client A probing client B's id inside the same tenant must not learn "that id exists". */
  @Get(":tenantId/portal/change-requests/:id")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const row = await this.owned(c, scope, id);
      return row;
    });
  }

  /** Submit a change request.
   *
   *  `kind`/`title`/`body` are the only caller-supplied fields that end up in the row verbatim (after
   *  scrubText + length caps, exactly the `note`/`reference` idiom in portal-commerce's
   *  recordPayment). Everything else — client_id, project_id, requested_by, source, status — is
   *  server-derived. A body that supplies `status` or a foreign `clientId` is not merely refused, it
   *  is never read: the INSERT below has no parameter fed from `b.status` or an unvalidated `b.clientId`. */
  @Post(":tenantId/portal/change-requests")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: {
      kind?: string; title?: string; body?: string; projectId?: string; clientId?: string;
      reproSteps?: string; environment?: string; seenOnVersion?: string; affectedUrl?: string;
    },
  ) {
    const b = body ?? {};
    // AUTHORIZE BEFORE VALIDATE — same fix as createProject / triage. This one faces CLIENTS, so
    // leaking the request contract to someone who may not file a change request is the least
    // acceptable of the three. Nothing below the call depends on the body.
    await authorize(req.principal, { kind: "portal", tenantId }, "request_change");
    if (!KINDS.has(b.kind ?? "")) throw new BadRequestException("kind must be one of content|design|feature|bug");
    const title = (b.title ?? "").trim();
    if (!title) throw new BadRequestException("title is required");

    const id = newId();
    const kind = b.kind as string;
    const result = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const { clientId, projectId } = await this.resolveSubmitTarget(c, scope, b.projectId, b.clientId);

      await c.query(
        `INSERT INTO webdev_change_requests
           (id, tenant_id, client_id, project_id, source, kind, title, body, requested_by, origin_site,
            repro_steps, environment, seen_on_version, affected_url)
         VALUES ($1, $2, $3, $4, 'portal', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id, tenantId, clientId, projectId, kind,
          scrubText(title).text.slice(0, MAX_TITLE),
          b.body ? scrubText(b.body).text.slice(0, MAX_BODY) : null,
          req.principal.userId, config.originSite,
          // scrubText on every one of these: they are free text from outside the trust boundary, and
          // a reproduction step is exactly where someone pastes a real account number to show what
          // broke. Same idiom as title/body above — the PAN/national-ID scrub is not optional here.
          // NO severity parameter. See MAX_* block.
          b.reproSteps ? scrubText(b.reproSteps).text.slice(0, MAX_REPRO) : null,
          b.environment ? scrubText(b.environment).text.slice(0, MAX_ENVIRONMENT) : null,
          b.seenOnVersion ? scrubText(b.seenOnVersion).text.slice(0, MAX_SEEN_ON_VERSION) : null,
          b.affectedUrl ? scrubText(b.affectedUrl).text.slice(0, MAX_AFFECTED_URL) : null,
        ],
      );
      // Transactional outbox: the row and its event commit or roll back together (MI-02 AC).
      await emitEvent(c, tenantId, "webdev_change_request", id, "webdev.change_request.created", {
        clientId, projectId, kind, requestedBy: req.principal.userId, via: "portal",
      });
      return { clientId, projectId };
    });

    await writeActivity(tenantId, req.principal.userId, "submitted", "webdev_change_request", id, {
      kind, via: "portal",
    });
    // Best-effort AFTER commit — a notify failure must never turn a successfully-submitted request
    // into an error response (client-notify.ts's rule, applied identically here).
    await this.notifyProjectOwners(tenantId, req.principal.userId, result.clientId, id, kind, title);
    return { id, status: "new" };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Scope resolution — the §5.1 project rule, applied server-side
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  /** Derive {clientId, projectId} for a new submission from the caller's scope — never from an
   *  unvalidated body field.
   *
   *  - A PROJECT-SCOPED contact (`scope.projectIds !== null`) MUST name one of their own projects; the
   *    client is then derived from THAT PROJECT ROW (not from any body-supplied clientId), so a
   *    mismatched/foreign `clientId` in the body can never redirect the request at another client.
   *  - A CLIENT-WIDE contact (`scope.projectIds === null`) may name a project belonging to one of
   *    their clients (client derived the same way), or omit `projectId` entirely for a client-wide
   *    request — in which case `clientId` is taken from scope if unambiguous (exactly one client) or,
   *    for the genuinely multi-client case, validated against `scope.clientIds` (0075 "rule 1": the
   *    form picks one, the server never trusts it blindly). */
  private async resolveSubmitTarget(
    c: PoolClient, scope: PortalScope, bodyProjectId: string | undefined, bodyClientId: string | undefined,
  ): Promise<{ clientId: string; projectId: string | null }> {
    const projectId = typeof bodyProjectId === "string" && bodyProjectId ? bodyProjectId : null;

    if (scope.projectIds !== null) {
      // Project-scoped contact: NULL project is refused, and so is a project outside their set.
      if (!projectId || !scope.projectIds.includes(projectId)) {
        throw new BadRequestException("select one of your projects");
      }
      const clientId = await this.clientOfProject(c, projectId, scope.clientIds);
      if (!clientId) throw new BadRequestException("select one of your projects");
      return { clientId, projectId };
    }

    // Client-wide contact.
    if (projectId) {
      const clientId = await this.clientOfProject(c, projectId, scope.clientIds);
      if (!clientId) throw new BadRequestException("project not found");
      return { clientId, projectId };
    }
    if (scope.clientIds.length === 1) return { clientId: scope.clientIds[0], projectId: null };
    const clientId = typeof bodyClientId === "string" ? bodyClientId : null;
    if (!clientId || !scope.clientIds.includes(clientId)) {
      throw new BadRequestException("select which of your accounts this request is for");
    }
    return { clientId, projectId: null };
  }

  /** The project's own client_id, but ONLY if that client is one the caller is actually scoped to —
   *  this is what makes deriving `clientId` FROM a body-supplied `projectId` safe: a project belonging
   *  to a client outside the caller's set is treated as not found, never as "belongs to someone else,
   *  use their id". */
  private async clientOfProject(c: PoolClient, projectId: string, callerClientIds: string[]): Promise<string | null> {
    const r = await c.query<{ client_id: string | null }>(
      `SELECT client_id FROM projects WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    const clientId = r.rows[0]?.client_id ?? null;
    if (!clientId || !callerClientIds.includes(clientId)) return null;
    return clientId;
  }

  private async owned(c: PoolClient, scope: PortalScope, id: string): Promise<Record<string, unknown>> {
    const r = await c.query(
      `SELECT ${SELECT_COLUMNS}
         FROM webdev_change_requests wcr
         LEFT JOIN projects p ON p.id = wcr.project_id
        WHERE wcr.id = $1 AND wcr.client_id = ANY($2::uuid[])
          AND ($3::uuid[] IS NULL OR wcr.project_id = ANY($3::uuid[]) OR wcr.project_id IS NULL)
          AND wcr.deleted_at IS NULL`,
      [id, scope.clientIds, scope.projectIds],
    );
    if (!r.rows[0]) throw new NotFoundException("request not found");
    return r.rows[0];
  }

  /** Tell the internal side a client asked for something. Recipients are the client's project
   *  owners — the exact `notifyInternal` precedent in portal-commerce.controller.ts (§5.3 of the
   *  design doc names this precedent explicitly): falls back to NOBODY, never to everybody, so a
   *  tenant with no owner assigned does not turn every submission into a company-wide broadcast. */
  private async notifyProjectOwners(
    tenantId: string, actorId: string | null, clientId: string, crId: string, kind: string, title: string,
  ): Promise<void> {
    const owners = await withTenants([tenantId], (c) =>
      c.query<{ owner_id: string }>(
        `SELECT DISTINCT owner_id FROM projects
          WHERE client_id = $1 AND owner_id IS NOT NULL AND deleted_at IS NULL`,
        [clientId],
      ),
    );
    const ids = owners.rows.map((r) => r.owner_id);
    if (!ids.length) return;
    await notifyBestEffort(tenantId, actorId, ids, "webdev.change_request.created", {
      title: `New ${kind} request — ${title}`,
      href: "/clients",
      entityType: "webdev_change_request",
      entityId: crId,
      severity: "info",
    });
  }
}

// Clients (CRM) resource routes (WSA-2). Extracted from src/core/client-work.controller.ts into
// the clients MODULE; gated by ModuleEnabledGuard("clients"). Deliverables + time_entries stay in
// the CORE ClientWorkController (shared work substrate — NOT module-gated).
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { validateCustomFields } from "../../core/custom-fields";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { assertActiveStaff } from "../../core/agency-lead-convert.service";
import {
  diffForActivity, normalizeContactCreate, normalizeContactPatch, normalizeName, normalizeNoteBody,
  normalizeOwner, normalizeStatus,
} from "./client-input";

// CC-D10: every read of a client row carries its owner (account manager) and the owner's name. The
// users join is LEFT so an ownerless client, or one whose owner was hard-deleted, still reads.
const CLIENT_COLUMNS = `cl.id, cl.name, cl.contact, cl.status, cl.custom_fields, cl.owner_user_id, ou.name AS owner_name`;
const CLIENT_FROM = `FROM clients cl LEFT JOIN users ou ON ou.id = cl.owner_user_id`;

// Notes are rows in the core `comments` table with this target type. That table is staff-only by
// policy (resource_comment.yaml grants no client/portal role), so an internal note about a client can
// never surface in the portal; the routes below add the per-client authz the generic endpoint lacks.
const NOTE_TARGET = "client";

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("clients"))
export class ClientsController {
  @Get(":tenantId/clients")
  async listClients(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "client", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT ${CLIENT_COLUMNS} ${CLIENT_FROM} WHERE cl.deleted_at IS NULL ORDER BY cl.created_at DESC`),
    );
    return rows.rows;
  }

  @Get(":tenantId/clients/:clientId")
  async getClient(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT ${CLIENT_COLUMNS} ${CLIENT_FROM} WHERE cl.id = $1 AND cl.deleted_at IS NULL`, [clientId]),
    );
    if (!rows.rows[0]) throw new NotFoundException("client not found");
    return rows.rows[0];
  }

  @Post(":tenantId/clients")
  @HttpCode(201)
  async createClient(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { name?: unknown; contact?: unknown; status?: unknown; ownerUserId?: unknown; customFields?: Record<string, unknown> },
  ) {
    const b = body ?? {};
    if (!b.name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "client", tenantId }, "create");
    // Shape validation runs AFTER authorize so a denial test with a sloppy body still tests authz.
    const name = normalizeName(b.name);
    // CC-D10 fix: `status` used to be dropped here, so the New client form's Status select was
    // silently ignored and every client was born `active`.
    const status = b.status === undefined ? "active" : normalizeStatus(b.status);
    const contact = normalizeContactCreate(b.contact);
    const owner = normalizeOwner(b.ownerUserId) ?? null;
    const customFields = b.customFields ?? {};
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const cfError = await validateCustomFields(c, tenantId, "client", customFields);
      if (cfError) throw new BadRequestException(cfError);
      if (owner) await assertActiveStaff(c, owner, "ownerUserId");
      await c.query(
        `INSERT INTO clients (id, tenant_id, name, contact, status, owner_user_id, custom_fields, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, tenantId, name, JSON.stringify(contact), status, owner, JSON.stringify(customFields), config.originSite],
      );
      // Transactional outbox (same tx as the insert): powers the event→n8n bridge / consumers.
      await emitEvent(c, tenantId, "client", id, "client.created", { name });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "client", id, { name, status });
    return { id };
  }

  // CC-D10: validated, and `contact` is a KEY-LEVEL MERGE (see client-input.ts): a string sets that
  // key, null/"" deletes it, an omitted key is untouched. Before this, `contact` replaced the whole
  // object and a blank `name` was stored as "". The activity row now carries before/after per field,
  // which is what the client's History shows.
  @Patch(":tenantId/clients/:clientId")
  async updateClient(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
    @Body() body: { name?: unknown; contact?: unknown; status?: unknown; ownerUserId?: unknown; customFields?: Record<string, unknown> },
  ) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "update");
    const b = body ?? {};
    const name = b.name === undefined ? undefined : normalizeName(b.name);
    const status = b.status === undefined ? undefined : normalizeStatus(b.status);
    const contact = b.contact === undefined ? undefined : normalizeContactPatch(b.contact);
    const owner = normalizeOwner(b.ownerUserId);
    const changes = await withTenants([tenantId], async (c) => {
      if (b.customFields) {
        const cfError = await validateCustomFields(c, tenantId, "client", b.customFields);
        if (cfError) throw new BadRequestException(cfError);
      }
      if (owner) await assertActiveStaff(c, owner, "ownerUserId");
      const prev = await c.query(
        `SELECT name, status, owner_user_id, contact FROM clients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [clientId],
      );
      if (!prev.rows[0]) throw new NotFoundException("client not found");
      const res = await c.query(
        `UPDATE clients SET name = COALESCE($2, name),
           contact = CASE WHEN $3::jsonb IS NULL THEN contact ELSE (contact || $3::jsonb) - $4::text[] END,
           status = COALESCE($5, status),
           owner_user_id = CASE WHEN $6::boolean THEN $7::uuid ELSE owner_user_id END,
           custom_fields = COALESCE($8, custom_fields), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING name, status, owner_user_id, contact`,
        [
          clientId, name ?? null,
          contact ? JSON.stringify(contact.set) : null, contact ? contact.remove : [],
          status ?? null, owner !== undefined, owner ?? null,
          b.customFields ? JSON.stringify(b.customFields) : null,
        ],
      );
      return diffForActivity(prev.rows[0], res.rows[0]);
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "client", clientId, changes.length ? { changes } : {});
    return { id: clientId };
  }

  @Delete(":tenantId/clients/:clientId")
  @HttpCode(200)
  async deleteClient(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "delete");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(`UPDATE clients SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
      if (res.rowCount === 0) throw new NotFoundException("client not found");
      await emitEvent(c, tenantId, "client", clientId, "client.deleted", {});
    });
    await writeActivity(tenantId, req.principal.userId, "deleted", "client", clientId);
    return { ok: true };
  }

  // ── CC-D10 · notes and history ────────────────────────────────────────────────────────────────
  // Internal notes on a client: read with `client` read, written with `client` update, so any staff
  // member who can edit the client can leave a note. Deleting your OWN note needs only `update`;
  // deleting somebody else's needs `delete` (manager+), the same line the client itself draws.
  @Get(":tenantId/clients/:clientId/notes")
  async listNotes(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      await this.assertClient(c, clientId);
      const rows = await c.query(
        `SELECT co.id, co.body, co.author_id AS "authorId", u.name AS "authorName", co.created_at AS "createdAt"
           FROM comments co LEFT JOIN users u ON u.id = co.author_id
          WHERE co.target_entity_type = $1 AND co.target_entity_id = $2 AND co.deleted_at IS NULL
          ORDER BY co.created_at DESC LIMIT 200`,
        [NOTE_TARGET, clientId],
      );
      return rows.rows;
    });
  }

  @Post(":tenantId/clients/:clientId/notes")
  @HttpCode(201)
  async createNote(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
    @Body() body: { body?: unknown },
  ) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "update");
    const text = normalizeNoteBody(body?.body);
    const id = newId();
    await withTenants([tenantId], async (c) => {
      await this.assertClient(c, clientId);
      await c.query(
        `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, req.principal.userId, NOTE_TARGET, clientId, text, config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "noted", "client", clientId, { noteId: id });
    return { id };
  }

  @Delete(":tenantId/clients/:clientId/notes/:noteId")
  @HttpCode(200)
  async deleteNote(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
    @Param("noteId") noteId: string,
  ) {
    // Read access first, so a caller who cannot see this client cannot probe which note ids exist.
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    const note = await withTenants([tenantId], (c) =>
      c.query<{ author_id: string | null }>(
        `SELECT author_id FROM comments
          WHERE id = $1 AND target_entity_type = $2 AND target_entity_id = $3 AND deleted_at IS NULL`,
        [noteId, NOTE_TARGET, clientId],
      ),
    );
    if (!note.rows[0]) throw new NotFoundException("note not found");
    const own = note.rows[0].author_id === req.principal.userId;
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, own ? "update" : "delete");
    await withTenants([tenantId], (c) =>
      c.query(`UPDATE comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [noteId]),
    );
    await writeActivity(tenantId, req.principal.userId, "note_deleted", "client", clientId, { noteId });
    return { ok: true };
  }

  // What happened to this client, newest first: the activity rows written against it (created,
  // updated with before/after, noted, Client Centre and portal profile edits). Denials (`authz.*`)
  // are audit rows, not history, and are left out.
  @Get(":tenantId/clients/:clientId/history")
  async history(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
    @Query("limit") limitRaw?: string,
  ) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    const limit = Math.max(1, Math.min(Number(limitRaw ?? 50) || 50, 200));
    return withTenants([tenantId], async (c) => {
      await this.assertClient(c, clientId);
      const rows = await c.query(
        `SELECT a.id, a.verb, a.metadata, a.occurred_at AS "occurredAt", a.actor_id AS "actorId", u.name AS "actorName"
           FROM activities a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.target_entity_type = 'client' AND a.target_entity_id = $1 AND a.verb NOT LIKE 'authz.%'
          ORDER BY a.occurred_at DESC LIMIT $2`,
        [clientId, limit],
      );
      return rows.rows;
    });
  }

  private async assertClient(c: PoolClient, clientId: string): Promise<void> {
    const r = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
    if (!r.rowCount) throw new NotFoundException("client not found");
  }

  // ── CC-2 · the client hub aggregate ───────────────────────────────────────────────────────────────
  //
  // The staff mirror of `portal/overview`. ONE round trip for the whole hub header, deliberately: the
  // portal already paid for the alternative (`/portal/runs` was 2N+1, up to 201 round trips on one
  // page) and this surface has the same fan-in shape.
  //
  // ── WHY `needsUs` IS THE POINT OF THIS ENDPOINT ──────────────────────────────────────────────────
  // `needsClient` is what the portal already tells the client: sign this, decide that. `needsUs` is its
  // MIRROR, and nothing in the ERP renders it today — which is exactly how a client-recorded payment
  // sits `pending` forever because no staff screen ever says "someone has to confirm this". Both lists
  // answer one question per client: WHO IS HOLDING THE BALL.
  //
  // Every `needsUs` item is something only WE can clear, and each has a real accumulation story:
  //   payment      a client says they paid; the balance does not move until finance confirms it
  //   review       the client asked for changes on a post; the draft is ours again
  //   request      a change request nobody has triaged
  //   contract     drafted but never sent — we are sitting on our own paperwork
  //
  // ⚠ MODULE SCOPE. `social_post_client_reviews` carries the `social` third wall
  // (`app_module_allowed('social')`), so this whole transaction runs with `{ modules: ["social"] }`.
  // Without it that one SELECT returns ZERO ROWS AND RAISES NOTHING — the hub would report "no post
  // reviews outstanding" for a client with ten. Core tables carry no such predicate, so declaring the
  // scope costs the other queries nothing.
  @Get(":tenantId/clients/:clientId/overview")
  async clientOverview(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
  ) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const client = await c.query(
        `SELECT cl.id, cl.name, cl.contact, cl.status, cl.owner_user_id, ou.name AS owner_name
           ${CLIENT_FROM} WHERE cl.id = $1 AND cl.deleted_at IS NULL`,
        [clientId],
      );
      if (!client.rows[0]) throw new NotFoundException("client not found");
      const a = [clientId];

      const [projects, tasks, deliverables, milestone, money, needsUs, needsClient] = await Promise.all([
        c.query<{ total: string; active: string; done: string; percent: string | null }>(
          // Portfolio progress is the MEAN OF PROJECT progress, not of all tasks pooled — the same
          // choice `portal/overview` makes, for the same reason: pooling lets a 200-task project drown
          // out a 3-task one, so the headline would track the biggest project, not the relationship.
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE p.status NOT IN ('done','complete','archived','cancelled')) AS active,
                  count(*) FILTER (WHERE p.status IN ('done','complete')) AS done,
                  round(avg(sub.pct)) AS percent
             FROM projects p
             CROSS JOIN LATERAL (
               SELECT COALESCE((SELECT avg(CASE WHEN t.status = 'done' THEN 100 ELSE t.progress END)
                                  FROM pm_tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL), 0) AS pct
             ) sub
            WHERE p.client_id = $1 AND p.deleted_at IS NULL`,
          a,
        ),
        c.query<{ total: string; open: string; overdue: string; blocked: string }>(
          // `current_date` is acceptable here (unlike listTasks, which resolves `today` in Node): these
          // are dashboard COUNTS, not a cursor or a sort key, so a timezone-boundary off-by-one moves a
          // tile by one rather than corrupting a paginated sequence.
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE t.status <> 'done') AS open,
                  count(*) FILTER (WHERE t.status <> 'done' AND t.due_date < current_date) AS overdue,
                  count(*) FILTER (WHERE t.status = 'blocked') AS blocked
             FROM pm_tasks t JOIN projects p ON p.id = t.project_id
            WHERE p.client_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL`,
          a,
        ),
        c.query<{ total: string; delivered: string; overdue: string }>(
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE d.status IN ('delivered','approved','done')) AS delivered,
                  count(*) FILTER (WHERE d.due_date < current_date AND d.status NOT IN ('delivered','approved','done')) AS overdue
             FROM deliverables d
            WHERE d.client_id = $1 AND d.deleted_at IS NULL`,
          a,
        ),
        c.query(
          `SELECT m.id, m.name, to_char(m.due_date, 'YYYY-MM-DD') AS "dueDate", m.status,
                  p.id AS "projectId", p.name AS "projectName"
             FROM pm_milestones m JOIN projects p ON p.id = m.project_id
            WHERE p.client_id = $1 AND p.deleted_at IS NULL AND m.deleted_at IS NULL
              AND m.status <> 'done' AND m.due_date IS NOT NULL
            ORDER BY m.due_date ASC LIMIT 1`,
          a,
        ),
        this.clientMoney(c, clientId),
        this.needsUs(c, clientId),
        this.needsClient(c, clientId),
      ]);

      const p = projects.rows[0];
      const t = tasks.rows[0];
      const d = deliverables.rows[0];
      return {
        client: client.rows[0],
        projects: {
          total: Number(p?.total ?? 0),
          active: Number(p?.active ?? 0),
          done: Number(p?.done ?? 0),
          percent: p?.percent === null || p?.percent === undefined ? 0 : Number(p.percent),
        },
        tasks: {
          total: Number(t?.total ?? 0),
          open: Number(t?.open ?? 0),
          overdue: Number(t?.overdue ?? 0),
          blocked: Number(t?.blocked ?? 0),
        },
        deliverables: {
          total: Number(d?.total ?? 0),
          delivered: Number(d?.delivered ?? 0),
          overdue: Number(d?.overdue ?? 0),
        },
        nextMilestone: milestone.rows[0] ?? null,
        money,
        needsUs,
        needsClient,
      };
    }, { modules: ["social"] });
  }

  /** Money for one client, per currency.
   *
   *  Per-currency and never one total: `invoices.currency` is per-row, and summing across currencies
   *  produces a number wrong in a way nobody notices until it is quoted back at you. Mirrors
   *  `portal-workspace.controller.ts:finance` so the two sides of the relationship cannot disagree
   *  about the balance — if that query changes, change this one.
   *
   *  One deliberate difference: `draft` invoices are INCLUDED here, as their own figure. The portal
   *  hides drafts because a client must not see a number the agency has not committed to; staff are
   *  precisely the people who need to know a draft is sitting there unsent. */
  private async clientMoney(c: PoolClient, clientId: string) {
    const r = await c.query<{
      currency: string; invoiced: number; paid: number; pending: number; drafted: number;
      overdue: string; open: string;
    }>(
      `WITH inv AS (
         SELECT i.id, i.currency, i.total, i.status, i.period_end
           FROM invoices i WHERE i.client_id = $1 AND i.deleted_at IS NULL
       )
       SELECT inv.currency,
              COALESCE(sum(inv.total) FILTER (WHERE inv.status NOT IN ('void','draft')), 0)::float8 AS invoiced,
              COALESCE(sum(inv.total) FILTER (WHERE inv.status = 'draft'), 0)::float8 AS drafted,
              COALESCE(sum(pay.confirmed), 0)::float8 AS paid,
              COALESCE(sum(pay.pending), 0)::float8 AS pending,
              count(*) FILTER (WHERE inv.status = 'sent' AND inv.period_end < current_date) AS overdue,
              count(*) FILTER (WHERE inv.status = 'sent') AS open
         FROM inv
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(pp.amount) FILTER (WHERE pp.status = 'confirmed'), 0) AS confirmed,
                  COALESCE(sum(pp.amount) FILTER (WHERE pp.status = 'pending'), 0) AS pending
             FROM invoice_payments pp WHERE pp.invoice_id = inv.id AND pp.deleted_at IS NULL
         ) pay ON true
        GROUP BY inv.currency ORDER BY invoiced DESC`,
      [clientId],
    );
    const byCurrency = r.rows.map((row) => ({
      currency: row.currency,
      invoiced: Number(row.invoiced),
      drafted: Number(row.drafted),
      paid: Number(row.paid),
      pendingConfirmation: Number(row.pending),
      // Rounded to 2dp: float8 round-tripping of a numeric sum yields 1234.5600000000001, and this
      // number ends up in front of someone who is paying it.
      outstanding: Math.round((Number(row.invoiced) - Number(row.paid)) * 100) / 100,
      overdueCount: Number(row.overdue),
      openCount: Number(row.open),
    }));
    return { byCurrency, primary: byCurrency[0] ?? null };
  }

  /** Outstanding items only WE can clear. See the endpoint header for why this list exists. */
  private async needsUs(c: PoolClient, clientId: string) {
    const [payments, reviews, requests, drafts] = await Promise.all([
      c.query(
        `SELECT pp.id, pp.invoice_id AS "invoiceId", pp.amount::float8 AS amount, pp.currency,
                pp.created_at AS "since"
           FROM invoice_payments pp
          WHERE pp.client_id = $1 AND pp.status = 'pending' AND pp.deleted_at IS NULL
          ORDER BY pp.created_at ASC`,
        [clientId],
      ),
      // The social third wall applies to this join — see the endpoint header.
      c.query(
        `SELECT r.id, r.comment, r.decided_at AS "since", pst.title AS "postTitle"
           FROM social_post_client_reviews r
           JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
           JOIN social_posts pst       ON pst.id = v.post_id  AND pst.tenant_id = v.tenant_id
          WHERE r.client_id = $1 AND r.status = 'changes_requested'
          ORDER BY r.decided_at ASC`,
        [clientId],
      ),
      c.query(
        `SELECT w.id, w.title, w.kind, w.created_at AS "since"
           FROM webdev_change_requests w
          WHERE w.client_id = $1 AND w.status = 'new' AND w.deleted_at IS NULL
          ORDER BY w.created_at ASC`,
        [clientId],
      ),
      c.query(
        `SELECT k.id, k.title, k.created_at AS "since"
           FROM contracts k
          WHERE k.client_id = $1 AND k.status = 'draft' AND k.deleted_at IS NULL
          ORDER BY k.created_at ASC`,
        [clientId],
      ),
    ]);
    return [
      ...payments.rows.map((r: Record<string, unknown>) => ({
        kind: "payment" as const, id: r.id as string,
        label: "Confirm a client-recorded payment",
        context: `${r.currency as string} ${r.amount as number}`,
        href: `/invoices/${r.invoiceId as string}`, since: r.since,
      })),
      ...reviews.rows.map((r: Record<string, unknown>) => ({
        kind: "review" as const, id: r.id as string,
        label: "Client asked for changes on a post",
        context: (r.postTitle as string) ?? "Social post",
        href: `/clients/${clientId}/requests`, since: r.since,
      })),
      ...requests.rows.map((r: Record<string, unknown>) => ({
        kind: "request" as const, id: r.id as string,
        label: "Triage a new change request",
        context: r.title as string,
        href: `/clients/${clientId}/requests`, since: r.since,
      })),
      ...drafts.rows.map((r: Record<string, unknown>) => ({
        kind: "contract" as const, id: r.id as string,
        label: "Send a drafted agreement",
        context: r.title as string,
        href: `/clients/${clientId}/commercial`, since: r.since,
      })),
    ];
  }

  /** Outstanding items only the CLIENT can clear — the staff-side view of what the portal is asking of
   *  them. Kept in step with `portal-workspace.controller.ts:needsYou`: same two sources (pending
   *  client-side gates, sent-but-unsigned contracts) plus pending post reviews, which that method
   *  deliberately omits because its own tab carries no badge. */
  private async needsClient(c: PoolClient, clientId: string) {
    const [gates, contracts, reviews] = await Promise.all([
      c.query(
        `SELECT g.id, g.kind, g.created_at AS "since", r.id AS "runId", r.title AS "runTitle"
           FROM pipeline_gates g JOIN pipeline_runs r ON r.id = g.run_id
          WHERE r.client_id = $1 AND r.deleted_at IS NULL
            AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL
          ORDER BY g.created_at ASC`,
        [clientId],
      ),
      c.query(
        // Same "already countersigned by that side" exclusion the portal's own query carries: `status`
        // flips only once BOTH parties are in, so a row can read 'sent' while the client has signed.
        `SELECT k.id, k.title, k.created_at AS "since"
           FROM contracts k
          WHERE k.client_id = $1 AND k.deleted_at IS NULL AND k.status = 'sent'
            AND NOT EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'client')
          ORDER BY k.created_at ASC`,
        [clientId],
      ),
      c.query(
        `SELECT r.id, r.requested_at AS "since", pst.title AS "postTitle"
           FROM social_post_client_reviews r
           JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
           JOIN social_posts pst       ON pst.id = v.post_id  AND pst.tenant_id = v.tenant_id
          WHERE r.client_id = $1 AND r.status = 'pending'
          ORDER BY r.requested_at ASC`,
        [clientId],
      ),
    ]);
    const GATE_LABEL: Record<string, string> = {
      prd_sign: "Sign off the project requirements",
      scope_signoff: "Sign the Scope Agreement",
      customer_feedback: "Share feedback",
    };
    return [
      ...gates.rows.map((g: Record<string, unknown>) => ({
        kind: "gate" as const, id: g.id as string,
        label: GATE_LABEL[g.kind as string] ?? "Client input needed",
        context: (g.runTitle as string) ?? "Delivery run",
        href: `/pipeline/${g.runId as string}`, since: g.since,
      })),
      ...contracts.rows.map((k: Record<string, unknown>) => ({
        kind: "contract" as const, id: k.id as string,
        label: "Awaiting client signature",
        context: k.title as string,
        href: `/clients/${clientId}/commercial`, since: k.since,
      })),
      ...reviews.rows.map((r: Record<string, unknown>) => ({
        kind: "review" as const, id: r.id as string,
        label: "Awaiting client post approval",
        context: (r.postTitle as string) ?? "Social post",
        href: `/clients/${clientId}/requests`, since: r.since,
      })),
    ];
  }
}

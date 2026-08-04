// CP-2 — the client portal's WORKSPACE reads: overview, projects, progress, milestones, timeline,
// deliverables. Separate controller class from PortalController (which owns runs/gates/scope-sign) and
// from PortalCommerceController (invoices/contracts) — Nest allows several controllers on the `api`
// prefix as long as no route path collides, and splitting by subject keeps each file reviewable.
//
// ── THE CLIENT-SAFE VIEW IS A DESIGN CONSTRAINT, NOT A FILTER APPLIED LATER ───────────────────────
// Everything here is read by someone OUTSIDE the company. Three categories are deliberately absent
// and must stay absent:
//   * INDIVIDUAL TASKS. `pm_tasks` rows carry internal titles, assignees, estimates and blocked
//     reasons. The portal exposes MILESTONES (a client-meaningful commitment) plus an aggregate
//     percentage derived from tasks — never the task list. A client learning that "refactor auth
//     before the demo" is blocked is a support conversation nobody asked for.
//   * EFFORT AND COST. `time_entries`, hourly rates and margin never appear. What the client owes is
//     answered by invoices (CP-3), which are already frozen, deliberate statements.
//   * THE RAW ACTIVITY LOG. `activities` records every internal verb by every actor. The timeline
//     below is instead composed from client-visible OBJECTS (milestones, deliverables, gate decisions,
//     sign-offs), so a new internal feature cannot leak into the client's feed by default. That
//     inversion — allowlist the events, don't denylist them — is the whole point.
//
// Every query is scoped by `resolvePortalScope` (see portal-scope.ts for the four isolation layers).
// The recurring shape is a join to `projects` with
//   `p.client_id = ANY($clients) AND ($projects::uuid[] IS NULL OR p.id = ANY($projects))`
// which is what makes an entity whose OWN client_id is nullable (deliverables) still correctly scoped:
// ownership travels through the project, which always has a client.
import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope, type PortalScope } from "./portal-scope";
import type { PoolClient } from "pg";

/** SQL predicate restricting `projects p` to the caller's scope. Kept as one exported constant rather
 *  than retyped per query: the second copy of an isolation predicate is where the typo lives. Binds
 *  $1 = clientIds uuid[], $2 = projectIds uuid[] | null. */
const PROJECT_SCOPE = `p.client_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[])) AND p.deleted_at IS NULL`;

/** Progress for one project, 0-100.
 *
 *  Weighted by each task's `progress` rather than a done/total count, because a project of 10 tasks
 *  with 9 at 90% reads as 0% under a naive count and as 81% here — and the client's question is "how
 *  far along are we", not "how many items have been ticked". `done` tasks count as 100 regardless of
 *  their stored progress: a task can be closed at progress=0 (marked done without the field being
 *  updated), and letting that drag the number down made finished projects show as unfinished. */
const PROJECT_PROGRESS_SQL = `
  COALESCE((
    SELECT round(avg(CASE WHEN t.status = 'done' THEN 100 ELSE t.progress END))::int
      FROM pm_tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL
  ), 0) AS "progressPercent"`;

interface ScopedArgs {
  scope: PortalScope;
  /** Positional args for PROJECT_SCOPE: always passed as $1/$2 of the query. */
  args: [string[], string[] | null];
}

function scoped(scope: PortalScope): ScopedArgs {
  return { scope, args: [scope.clientIds, scope.projectIds] };
}

@Controller("api")
@UseGuards(AuthGuard)
export class PortalWorkspaceController {
  /** The portal landing payload: what needs the client, how far things are, what is next, what is
   *  owed, and a short recent-events strip — in ONE request.
   *
   *  Deliberately one endpoint rather than the six it composes. The previous portal page issued a
   *  request per run and the round trips scaled with the number of projects; that latency is paid by
   *  someone outside the company, on whatever connection they have. Everything below runs inside a
   *  single transaction on one connection. */
  @Get(":tenantId/portal/overview")
  async overview(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const { args } = scoped(scope);

      const [clients, projects, milestone, needsYou, finance, deliverables] = await Promise.all([
        c.query(
          `SELECT id, name, status FROM clients WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY name`,
          [scope.clientIds],
        ),
        c.query<{ total: string; active: string; done: string; percent: string | null }>(
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE p.status NOT IN ('done', 'complete', 'archived', 'cancelled')) AS active,
                  count(*) FILTER (WHERE p.status IN ('done', 'complete')) AS done,
                  -- Portfolio progress is the MEAN OF PROJECT progress, not of all tasks pooled: a
                  -- 200-task project would otherwise drown out a 3-task one and the headline number
                  -- would track the biggest project rather than the relationship.
                  round(avg(sub.pct)) AS percent
             FROM projects p
             CROSS JOIN LATERAL (
               SELECT COALESCE((SELECT avg(CASE WHEN t.status = 'done' THEN 100 ELSE t.progress END)
                                  FROM pm_tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL), 0) AS pct
             ) sub
            WHERE ${PROJECT_SCOPE}`,
          args,
        ),
        c.query(
          `SELECT m.id, m.name, to_char(m.due_date, 'YYYY-MM-DD') AS "dueDate", m.status,
                  p.id AS "projectId", p.name AS "projectName"
             FROM pm_milestones m JOIN projects p ON p.id = m.project_id
            WHERE ${PROJECT_SCOPE} AND m.deleted_at IS NULL AND m.status <> 'done' AND m.due_date IS NOT NULL
            ORDER BY m.due_date ASC LIMIT 1`,
          args,
        ),
        this.needsYou(c, scope),
        this.finance(c, scope),
        c.query<{ total: string; delivered: string; overdue: string }>(
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE d.status IN ('delivered', 'approved', 'done')) AS delivered,
                  count(*) FILTER (WHERE d.due_date < current_date AND d.status NOT IN ('delivered', 'approved', 'done')) AS overdue
             FROM deliverables d JOIN projects p ON p.id = d.project_id
            WHERE ${PROJECT_SCOPE} AND d.deleted_at IS NULL`,
          args,
        ),
      ]);

      const p = projects.rows[0];
      const d = deliverables.rows[0];
      return {
        clients: clients.rows,
        // Convenience for the common single-client contact so the UI need not special-case it.
        client: clients.rows[0] ?? null,
        viewOnly: !scope.canSign,
        progress: {
          projects: Number(p?.total ?? 0),
          activeProjects: Number(p?.active ?? 0),
          completedProjects: Number(p?.done ?? 0),
          percent: p?.percent === null || p?.percent === undefined ? 0 : Number(p.percent),
        },
        deliverables: {
          total: Number(d?.total ?? 0),
          delivered: Number(d?.delivered ?? 0),
          overdue: Number(d?.overdue ?? 0),
        },
        nextMilestone: milestone.rows[0] ?? null,
        needsYou,
        finance,
      };
    });
  }

  /** Everything outstanding that only the CLIENT can clear: pending client-side pipeline gates and
   *  contracts sent but unsigned. One list, already sorted by age, so the portal's first screen can be
   *  "here is your to-do" rather than "here is a dashboard, go hunting".
   *
   *  Reads `capability` into each item: a viewer sees the item (they should know a signature is
   *  outstanding) but the UI renders it as informational rather than actionable, matching what
   *  `requireSigner` would enforce if they tried. */
  private async needsYou(c: PoolClient, scope: PortalScope) {
    const { args } = scoped(scope);
    const [gates, contracts] = await Promise.all([
      c.query(
        `SELECT g.id, g.kind, g.created_at AS "since", r.id AS "runId", r.title AS "runTitle"
           FROM pipeline_gates g
           JOIN pipeline_runs r ON r.id = g.run_id
           -- LEFT join + the OR below: a run may legitimately have no project (internal/manual runs
           -- predate 0072's project link and manual runs may be created before a project exists), and
           -- an INNER join would silently drop every gate on such a run — the client would simply
           -- never be asked to sign. Client-wide contacts (projectIds IS NULL) therefore see them.
           LEFT JOIN projects p ON p.id = r.project_id
          WHERE r.client_id = ANY($1::uuid[]) AND r.deleted_at IS NULL
            AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL
            AND ($2::uuid[] IS NULL OR r.project_id = ANY($2::uuid[]))
          ORDER BY g.created_at ASC`,
        args,
      ),
      c.query(
        `SELECT k.id, k.title, k.reference, k.created_at AS "since", k.sent_at AS "sentAt",
                k.value::float8 AS value, k.currency
           FROM contracts k
          WHERE k.client_id = ANY($1::uuid[]) AND k.deleted_at IS NULL AND k.status = 'sent'
            AND ($2::uuid[] IS NULL OR k.project_id = ANY($2::uuid[]) OR k.project_id IS NULL)
            -- A contract already countersigned by this side is not outstanding even if the row still
            -- says 'sent' (status flips only when BOTH parties are in).
            AND NOT EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'client')
          ORDER BY k.created_at ASC`,
        args,
      ),
    ]);
    const GATE_LABEL: Record<string, string> = {
      prd_sign: "Sign off the project requirements",
      scope_signoff: "Sign the Scope Agreement",
      customer_feedback: "Share your feedback",
    };
    return [
      ...gates.rows.map((g: Record<string, unknown>) => ({
        kind: "gate" as const,
        id: g.id as string,
        // `requires` distinguishes "we need your signature" from "we need your opinion", which is what
        // decides whether a view-only contact can actually clear the item.
        requires: g.kind === "customer_feedback" ? ("feedback" as const) : ("signature" as const),
        label: GATE_LABEL[g.kind as string] ?? "Your input is needed",
        context: (g.runTitle as string) ?? "Your project",
        href: `/portal/approvals/${g.runId as string}`,
        since: g.since,
      })),
      ...contracts.rows.map((k: Record<string, unknown>) => ({
        kind: "contract" as const,
        id: k.id as string,
        requires: "signature" as const,
        label: "Sign your agreement",
        context: (k.title as string) ?? (k.reference as string) ?? "Agreement",
        href: `/portal/contracts/${k.id as string}`,
        since: k.sentAt ?? k.since,
      })),
    ].sort((a, b) => String(a.since).localeCompare(String(b.since)));
  }

  /** Money, per currency.
   *
   *  Per-currency and not one total, because `invoices.currency` is per-row and summing across
   *  currencies produces a number that is wrong in a way nobody notices until it is quoted back at
   *  you. `paid` counts CONFIRMED payments only — a client-recorded transfer sits in
   *  `pendingConfirmation` until finance verifies it, so the portal can say "received, being
   *  verified" without the balance moving on an unverified claim (see 0075's header).
   *
   *  `draft` invoices are excluded entirely: they are internal work-in-progress and a client seeing a
   *  draft would be seeing a number the agency has not committed to. */
  private async finance(c: PoolClient, scope: PortalScope) {
    const r = await c.query<{
      currency: string; invoiced: number; paid: number; pending: number; overdue: string; open: string;
    }>(
      `WITH inv AS (
         SELECT i.id, i.currency, i.total, i.status, i.period_end
           FROM invoices i
          WHERE i.client_id = ANY($1::uuid[]) AND i.deleted_at IS NULL AND i.status <> 'draft'
       )
       SELECT inv.currency,
              COALESCE(sum(inv.total) FILTER (WHERE inv.status <> 'void'), 0)::float8 AS invoiced,
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
      [scope.clientIds],
    );
    const byCurrency = r.rows.map((row) => ({
      currency: row.currency,
      invoiced: Number(row.invoiced),
      paid: Number(row.paid),
      pendingConfirmation: Number(row.pending),
      // Rounded to 2dp because float8 round-tripping of numeric sums produces 1234.5600000000001,
      // and this string ends up in front of a paying customer.
      outstanding: Math.round((Number(row.invoiced) - Number(row.paid)) * 100) / 100,
      overdueCount: Number(row.overdue),
      openCount: Number(row.open),
    }));
    // `primary` is the currency the client actually transacts in (largest invoiced volume) so the
    // headline tile has something to show without the UI guessing.
    return { byCurrency, primary: byCurrency[0] ?? null };
  }

  /** The client's projects, with progress and their next milestone. */
  @Get(":tenantId/portal/projects")
  async listProjects(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const { args } = scoped(scope);
      const rows = await c.query(
        `SELECT p.id, p.name, p.status,
                to_char(p.start_date, 'YYYY-MM-DD') AS "startDate",
                to_char(p.due_date, 'YYYY-MM-DD') AS "dueDate",
                p.client_id AS "clientId", cl.name AS "clientName",
                ${PROJECT_PROGRESS_SQL},
                (SELECT count(*) FROM pm_milestones m WHERE m.project_id = p.id AND m.deleted_at IS NULL) AS "milestoneCount",
                (SELECT count(*) FROM pm_milestones m WHERE m.project_id = p.id AND m.deleted_at IS NULL AND m.status = 'done') AS "milestonesDone",
                (SELECT count(*) FROM deliverables d WHERE d.project_id = p.id AND d.deleted_at IS NULL) AS "deliverableCount",
                (SELECT to_char(min(m.due_date), 'YYYY-MM-DD') FROM pm_milestones m
                  WHERE m.project_id = p.id AND m.deleted_at IS NULL AND m.status <> 'done' AND m.due_date IS NOT NULL) AS "nextMilestoneDue"
           FROM projects p LEFT JOIN clients cl ON cl.id = p.client_id
          WHERE ${PROJECT_SCOPE}
          ORDER BY (p.status IN ('done', 'complete', 'archived', 'cancelled')), p.due_date NULLS LAST, p.created_at DESC
          LIMIT 200`,
        args,
      );
      return rows.rows.map((r: Record<string, unknown>) => ({
        ...r,
        milestoneCount: Number(r.milestoneCount),
        milestonesDone: Number(r.milestonesDone),
        deliverableCount: Number(r.deliverableCount),
      }));
    });
  }

  /** One project, client-safe: progress, milestones, deliverables, its delivery runs, and the phase
   *  breakdown. No task list — see the file header. */
  @Get(":tenantId/portal/projects/:projectId")
  async projectDetail(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const args: unknown[] = [scope.clientIds, scope.projectIds, projectId];
      const project = await c.query(
        `SELECT p.id, p.name, p.status,
                to_char(p.start_date, 'YYYY-MM-DD') AS "startDate",
                to_char(p.due_date, 'YYYY-MM-DD') AS "dueDate",
                p.client_id AS "clientId", cl.name AS "clientName",
                ${PROJECT_PROGRESS_SQL}
           FROM projects p LEFT JOIN clients cl ON cl.id = p.client_id
          WHERE ${PROJECT_SCOPE} AND p.id = $3`,
        args,
      );
      // Same 404 for "does not exist" and "not yours" — the isolation boundary must not distinguish
      // them, or the response becomes an existence oracle for other clients' project ids.
      if (!project.rows[0]) throw new NotFoundException("project not found");

      const [milestones, deliverables, runs, phases] = await Promise.all([
        c.query(
          `SELECT m.id, m.name, m.status, to_char(m.due_date, 'YYYY-MM-DD') AS "dueDate",
                  (SELECT count(*) FROM pm_tasks t WHERE t.milestone_id = m.id AND t.deleted_at IS NULL) AS "itemCount",
                  (SELECT count(*) FROM pm_tasks t WHERE t.milestone_id = m.id AND t.deleted_at IS NULL AND t.status = 'done') AS "itemsDone"
             FROM pm_milestones m
            WHERE m.project_id = $1 AND m.deleted_at IS NULL
            ORDER BY m.due_date NULLS LAST, m.created_at ASC`,
          [projectId],
        ),
        c.query(
          `SELECT d.id, d.name, d.status, to_char(d.due_date, 'YYYY-MM-DD') AS "dueDate", d.updated_at AS "updatedAt",
                  (SELECT count(*) FROM files f
                    WHERE f.target_entity_type = 'deliverable' AND f.target_entity_id = d.id AND f.deleted_at IS NULL) AS "fileCount"
             FROM deliverables d
            WHERE d.project_id = $1 AND d.deleted_at IS NULL
            ORDER BY d.due_date NULLS LAST, d.created_at DESC`,
          [projectId],
        ),
        c.query(
          `SELECT r.id, r.title, r.status,
                  (SELECT count(*) FROM pipeline_gates g
                    WHERE g.run_id = r.id AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL) AS "pendingActions"
             FROM pipeline_runs r
            WHERE r.project_id = $1 AND r.client_id = ANY($2::uuid[]) AND r.deleted_at IS NULL
            ORDER BY r.created_at DESC`,
          [projectId, scope.clientIds],
        ),
        // Aggregate-only, by task STATUS. Counts are safe; titles are not.
        c.query<{ status: string; n: string }>(
          `SELECT status, count(*) AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL GROUP BY status`,
          [projectId],
        ),
      ]);

      const workload: Record<string, number> = { todo: 0, in_progress: 0, blocked: 0, done: 0 };
      for (const row of phases.rows) workload[row.status] = Number(row.n);
      return {
        ...project.rows[0],
        milestones: milestones.rows.map((m: Record<string, unknown>) => ({
          ...m, itemCount: Number(m.itemCount), itemsDone: Number(m.itemsDone),
        })),
        deliverables: deliverables.rows.map((d: Record<string, unknown>) => ({ ...d, fileCount: Number(d.fileCount) })),
        runs: runs.rows.map((r: Record<string, unknown>) => ({ ...r, pendingActions: Number(r.pendingActions) })),
        workload,
      };
    });
  }

  /** Milestones across every project the caller can see — the commitment calendar. */
  @Get(":tenantId/portal/milestones")
  async milestones(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const { args } = scoped(scope);
      const rows = await c.query(
        `SELECT m.id, m.name, m.status, to_char(m.due_date, 'YYYY-MM-DD') AS "dueDate",
                p.id AS "projectId", p.name AS "projectName"
           FROM pm_milestones m JOIN projects p ON p.id = m.project_id
          WHERE ${PROJECT_SCOPE} AND m.deleted_at IS NULL
          ORDER BY m.due_date NULLS LAST, m.created_at ASC LIMIT 300`,
        args,
      );
      return rows.rows;
    });
  }

  /** The unified timeline: one chronological stream of everything the client can legitimately see.
   *
   *  Built as a UNION of typed events over client-visible OBJECTS — never from `activities`. That is
   *  an allowlist by construction: a new internal entity or verb produces no client-visible row here
   *  until someone deliberately adds a branch, which is the opposite of filtering a firehose and
   *  hoping the filter stays complete.
   *
   *  Two kinds of row share the stream: things that HAPPENED (`at` in the past — a signature, a
   *  payment, a delivery) and things that are DUE (a milestone or deliverable date, possibly in the
   *  future). `tense` distinguishes them so the UI can split "history" from "what's coming" without
   *  re-deriving it from date comparisons that disagree across timezones. */
  @Get(":tenantId/portal/timeline")
  async timeline(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("limit") limit?: string,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    // Clamped, not trusted: an unbounded LIMIT from a query string is a cheap way for anyone to make
    // the portal's heaviest query heavier.
    const cap = Math.min(Math.max(Number(limit) || 120, 1), 400);
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const rows = await c.query(
        `WITH scoped_projects AS (
           SELECT p.id, p.name FROM projects p WHERE ${PROJECT_SCOPE}
         )
         -- Milestone dates: the commitments.
         SELECT 'milestone' AS kind, m.id::text AS id, m.name AS label, m.status,
                m.due_date::timestamptz AS at, 'due' AS tense, sp.name AS context, sp.id::text AS "projectId"
           FROM pm_milestones m JOIN scoped_projects sp ON sp.id = m.project_id
          WHERE m.deleted_at IS NULL AND m.due_date IS NOT NULL
         UNION ALL
         -- Deliverables: due when open, and their last change when settled (there is no per-status
         -- history table, so updated_at is the honest best answer and is labelled as such).
         SELECT 'deliverable', d.id::text, d.name,
                d.status,
                CASE WHEN d.status IN ('delivered', 'approved', 'done') THEN d.updated_at
                     ELSE d.due_date::timestamptz END,
                CASE WHEN d.status IN ('delivered', 'approved', 'done') THEN 'happened' ELSE 'due' END,
                sp.name, sp.id::text
           FROM deliverables d JOIN scoped_projects sp ON sp.id = d.project_id
          WHERE d.deleted_at IS NULL AND COALESCE(d.due_date::timestamptz, d.updated_at) IS NOT NULL
         UNION ALL
         -- Decisions the client themselves made: the audit trail they are entitled to.
         SELECT 'decision', g.id::text,
                CASE g.kind WHEN 'prd_sign' THEN 'Requirements signed off'
                            WHEN 'scope_signoff' THEN 'Scope Agreement signed'
                            WHEN 'customer_feedback' THEN 'Feedback submitted'
                            ELSE 'Decision recorded' END,
                COALESCE(g.decision, 'decided'), g.decided_at, 'happened',
                COALESCE(r.title, 'Your project'), r.project_id::text
           FROM pipeline_gates g JOIN pipeline_runs r ON r.id = g.run_id
          WHERE r.client_id = ANY($1::uuid[]) AND r.deleted_at IS NULL AND g.deleted_at IS NULL
            AND g.actor_side = 'client' AND g.status = 'decided' AND g.decided_at IS NOT NULL
            AND ($2::uuid[] IS NULL OR r.project_id = ANY($2::uuid[]))
         UNION ALL
         -- Contract lifecycle. A NULL project_id is admitted for a project-scoped contact because a
         -- master agreement covers the whole relationship, including their project.
         SELECT 'contract', k.id::text, COALESCE(k.title, 'Agreement'), k.status,
                COALESCE(k.signed_at, k.sent_at, k.created_at), 'happened',
                COALESCE(k.reference, 'Agreement'), k.project_id::text
           FROM contracts k
          WHERE k.client_id = ANY($1::uuid[]) AND k.deleted_at IS NULL AND k.status <> 'draft'
            AND ($2::uuid[] IS NULL OR k.project_id = ANY($2::uuid[]) OR k.project_id IS NULL)
         UNION ALL
         -- Invoices + confirmed payments. Drafts excluded (see finance()).
         SELECT 'invoice', i.id::text,
                'Invoice ' || COALESCE(to_char(i.period_start, 'Mon YYYY'), '') , i.status,
                i.created_at, 'happened', i.currency || ' ' || i.total::text, NULL
           FROM invoices i
          WHERE i.client_id = ANY($1::uuid[]) AND i.deleted_at IS NULL AND i.status <> 'draft'
         UNION ALL
         SELECT 'payment', pp.id::text, 'Payment received', pp.status,
                COALESCE(pp.confirmed_at, pp.created_at), 'happened',
                pp.currency || ' ' || pp.amount::text, NULL
           FROM invoice_payments pp
          WHERE pp.client_id = ANY($1::uuid[]) AND pp.deleted_at IS NULL AND pp.status = 'confirmed'
         ORDER BY at DESC
         LIMIT ${cap}`,
        [scope.clientIds, scope.projectIds],
      );
      return rows.rows;
    });
  }

  /** Deliverables across the caller's projects, with attachment counts. The files themselves are
   *  fetched through the portal's own download route (CP-3), never the staff `/files` route. */
  @Get(":tenantId/portal/deliverables")
  async deliverables(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("projectId") projectId?: string,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const rows = await c.query(
        `SELECT d.id, d.name, d.status, to_char(d.due_date, 'YYYY-MM-DD') AS "dueDate",
                d.updated_at AS "updatedAt", p.id AS "projectId", p.name AS "projectName"
           FROM deliverables d JOIN projects p ON p.id = d.project_id
          WHERE ${PROJECT_SCOPE} AND d.deleted_at IS NULL
            AND ($3::uuid IS NULL OR d.project_id = $3)
          ORDER BY d.due_date NULLS LAST, d.created_at DESC LIMIT 300`,
        [scope.clientIds, scope.projectIds, projectId ?? null],
      );
      if (!rows.rows.length) return [];
      // Attachments in one batched query rather than a count subquery per row: the list is the surface
      // a client visits to FIND a file, so it is the one that must not be slow.
      const ids = rows.rows.map((r: Record<string, unknown>) => r.id as string);
      const files = await c.query<{ target_entity_id: string; id: string; filename: string; content_type: string; byte_size: string; url: string | null; created_at: string }>(
        `SELECT target_entity_id, id, filename, content_type, byte_size, url, created_at
           FROM files
          WHERE target_entity_type = 'deliverable' AND target_entity_id = ANY($1::uuid[]) AND deleted_at IS NULL
          ORDER BY created_at DESC`,
        [ids],
      );
      const byTarget = new Map<string, Array<Record<string, unknown>>>();
      for (const f of files.rows) {
        const list = byTarget.get(f.target_entity_id) ?? [];
        list.push({
          id: f.id, filename: f.filename, contentType: f.content_type,
          byteSize: Number(f.byte_size), url: f.url, createdAt: f.created_at,
        });
        byTarget.set(f.target_entity_id, list);
      }
      return rows.rows.map((r: Record<string, unknown>) => ({ ...r, files: byTarget.get(r.id as string) ?? [] }));
    });
  }
}

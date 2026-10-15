// PV7-02 — the client's own view of how the work is going: `GET :t/portal/health` (BFF §54.5).
//
// ── FACTS, NEVER A VERDICT ───────────────────────────────────────────────────────────────────────────
// The staff board turns signals into a state (on track / at risk / off track). The portal does NOT: a client is shown
// what is late and WHO HOLDS THE BALL, in numbers and dates, and never a label for how the relationship is going (plan L3).
//
// ── WHAT IS NEVER IN THIS PAYLOAD ────────────────────────────────────────────────────────────────────
//   * tasks, or any figure derived from them (`blocked`, percent complete, estimates): milestones and deliverables only (L1);
//   * time entries, effort, activities, the raw history;
//   * internal gates (`actor_side = 'internal'`): only the client-side gates a client already sees in the portal;
//   * people: no names, assignees, owners or authors;
//   * money figures (PV-D38): a pending payment is listed by kind and age, with no amount;
//   * the staff-phrased labels and hrefs the hub overview's ball items carry, and the staff `clientVisible` marker.
// `portal-health.db.test.ts` scans the whole body for each of these against a fixture that plants every one of them.
//
// ── REACH, PER CLIENT AND PER PROJECT (PV7-Q2, PV-D33, PV-D37) ───────────────────────────────────────
// One section per client in the caller's scope within THIS company (PV-D10: one request per company). A contact limited to
// some projects gets those projects' health, and nothing that has no project (client-wide waiting items, the client-wide
// conversation thread, payments and post reviews, which belong to the client rather than a project). A client-wide contact
// gets every project and the client-wide parts. Every row predicate comes from portal-visibility.ts; the reads are the ones
// the staff one-client read uses (modules/clients/client-health.ts), run with a portal `Reach`.
//
// Each source reads on its own (client-health.ts, `HealthReads`). A failed one is named in `unavailable[]` and its figures
// are null, never 0.
import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope, scopeValues } from "./portal-scope";
import { HealthReads, loadProjectHealth, loadTurnaround, TURNAROUND_WINDOW_DAYS, type HealthSource, type Reach, type Turnaround } from "../modules/clients/client-health";
import { loadClientBall, type BallRow } from "../modules/clients/client-ball";

/** At most this many items are listed per ball; `count` is always the true total. */
export const PORTAL_BALL_ITEM_CAP = 25;

export interface PortalBall {
  count: number;
  oldestSince: string | null;
  items: Array<{ kind: string; id: string; context: string | null; since: string | null }>;
}
export interface PortalTurnaround { medianDays: number | null; n: number; withheld: boolean }

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

function portalBall(rows: BallRow[]): PortalBall {
  // `clientVisible` is true for every row the portal reads reach (the predicates already enforce it); the filter is the belt to that brace.
  const visible = rows.filter((r) => r.clientVisible);
  return {
    count: visible.length,
    oldestSince: iso(visible[0]?.since),
    items: visible.slice(0, PORTAL_BALL_ITEM_CAP).map((r) => ({
      kind: r.kind,
      id: r.id,
      // A payment's context is its amount: money is not told here (PV-D38).
      context: r.kind === "payment" ? null : r.context,
      since: iso(r.since),
    })),
  };
}

const side = (t: Turnaround): PortalTurnaround => ({ medianDays: t.medianDays, n: t.n, withheld: t.withheld });

@Controller("api")
@UseGuards(AuthGuard)
export class PortalHealthController {
  @Get(":tenantId/portal/health")
  async health(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");

    // The caller's scope and the names of their clients: essential, so a failure is a failure, not an "unavailable" section.
    const { scope, names } = await withTenants([tenantId], async (c) => {
      const s = await resolvePortalScope(c, req.principal);
      const r = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM clients WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY name, id`,
        [s.clientIds],
      );
      return { scope: s, names: r.rows };
    });

    const values = scopeValues(scope);
    const reach: Reach = { kind: "portal", clientIds: scope.clientIds, scopeParams: values };
    const reads = new HealthReads(tenantId);
    const projects = await reads.read("projectHealth", undefined, (c) => loadProjectHealth(c, reach));
    // The social wall is declared on every source that touches a post review (client-ball.ts, loadTurnaround).
    const ball = await reads.read("ball", ["social"], (c) => loadClientBall(c, scope.clientIds, { portal: { params: values } }));
    const turnaround = await reads.read("turnaround", ["social"], (c) => loadTurnaround(c, reach));

    const clients = names.map((cl) => {
      const wide = scope.wideClientIds.includes(cl.id);
      const items = ball?.get(cl.id);
      const forProject = (rows: BallRow[] | undefined, projectId: string | null) =>
        ball === null ? null : portalBall((rows ?? []).filter((r) => r.projectId === projectId));
      const t = turnaround?.get(cl.id);
      return {
        clientId: cl.id,
        name: cl.name,
        wide,
        projects: projects === null ? null : (projects.get(cl.id) ?? []).map((p) => ({
          projectId: p.projectId,
          name: p.name,
          status: p.status,
          milestones: p.milestones,
          deliverables: p.deliverables,
          nextMilestone: p.nextMilestone,
          waitingOnYou: forProject(items?.needsClient, p.projectId),
          waitingOnUs: forProject(items?.needsUs, p.projectId),
        })),
        // Ball items with no project are client-wide material: client-wide contacts only. (They are not even read for anyone else.)
        clientWide: !wide || ball === null ? null : {
          waitingOnYou: forProject(items?.needsClient, null),
          waitingOnUs: forProject(items?.needsUs, null),
        },
        turnaround: t ? { windowDays: TURNAROUND_WINDOW_DAYS, client: side(t.client), ours: side(t.ours) } : null,
      };
    });

    return { asOf: new Date().toISOString(), clients, unavailable: [...reads.unavailable] as HealthSource[] };
  }
}

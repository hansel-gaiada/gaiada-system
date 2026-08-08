import "server-only";
// TEMP DEMO MODE — stateful in-memory store for MI-05's staff Requests tab (mirrors demoPipeline.ts's
// convention). Lets `/departments/[deptId]/requests` exercise a real triage queue — new/declined/
// in_progress rows, both convert routes, and the 409/501 outcomes — with NO backend. Wired from
// demoFixtures.getDemoResponse. Session-only, resets on restart. Safe to delete once verified live.
//
// Deliberately reuses demoPipeline's `run-demo-2` and demoPm's `p-web-1`/`t-4` ids for the two
// convert-route link targets, so a demo click-through actually resolves to a real fixture row
// instead of a dangling id — the same "one fixture set, not two parallel realities" rule
// demoPipeline.ts's portal section documents.

export type DemoCrKind = "content" | "design" | "feature" | "bug";
export type DemoCrStatus = "new" | "triaged" | "in_progress" | "done" | "declined";
export type DemoCrRoute = "control_plane" | "mini_run" | "pm_task" | null;

interface DemoCr {
  id: string;
  clientId: string | null; clientName: string | null;
  projectId: string | null; projectName: string | null;
  source: "portal" | "internal";
  kind: DemoCrKind;
  title: string;
  body: string | null;
  status: DemoCrStatus;
  route: DemoCrRoute;
  pipelineRunId: string | null;
  pmTaskId: string | null;
  requestedBy: string | null; requestedByName: string | null;
  triagedBy: string | null; triagedByName: string | null; triagedAt: string | null;
  declinedReason: string | null;
  createdAt: string; updatedAt: string;
}

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });

let seq = 0;
const nid = (p: string) => `cr-demo-${p}-${++seq}`;

const CRS: DemoCr[] = [
  {
    id: "cr-demo-1", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, projectName: null,
    source: "portal", kind: "feature",
    title: "Add a wishlist to the product page",
    body: "Customers keep asking for a way to save items for later without adding to cart.",
    status: "new", route: null, pipelineRunId: null, pmTaskId: null,
    requestedBy: "demo-client", requestedByName: "Dana Whitfield",
    triagedBy: null, triagedByName: null, triagedAt: null, declinedReason: null,
    createdAt: "2026-08-01T09:00:00Z", updatedAt: "2026-08-01T09:00:00Z",
  },
  {
    id: "cr-demo-2", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, projectName: null,
    source: "portal", kind: "bug",
    title: "Checkout button unresponsive on Safari",
    body: "Reported by two customers this week; repros on iOS Safari only.",
    status: "new", route: null, pipelineRunId: null, pmTaskId: null,
    requestedBy: "demo-client", requestedByName: "Dana Whitfield",
    triagedBy: null, triagedByName: null, triagedAt: null, declinedReason: null,
    createdAt: "2026-08-02T14:30:00Z", updatedAt: "2026-08-02T14:30:00Z",
  },
  {
    id: "cr-demo-3", clientId: null, clientName: null, projectId: "p-web-1", projectName: "Client site redesign",
    source: "internal", kind: "content",
    title: "Refresh the About page copy",
    body: "Marketing sent updated boilerplate last week; swap it in.",
    status: "new", route: null, pipelineRunId: null, pmTaskId: null,
    requestedBy: "demo-hansel", requestedByName: "Clement Hansel",
    triagedBy: null, triagedByName: null, triagedAt: null, declinedReason: null,
    createdAt: "2026-08-03T11:00:00Z", updatedAt: "2026-08-03T11:00:00Z",
  },
  {
    id: "cr-demo-4", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, projectName: null,
    source: "portal", kind: "design",
    title: "Rework the footer for the redesign",
    body: null,
    status: "in_progress", route: "mini_run", pipelineRunId: "run-demo-2", pmTaskId: null,
    requestedBy: "demo-client", requestedByName: "Dana Whitfield",
    triagedBy: "demo-hansel", triagedByName: "Clement Hansel", triagedAt: "2026-07-24T10:00:00Z", declinedReason: null,
    createdAt: "2026-07-23T08:00:00Z", updatedAt: "2026-07-24T10:00:00Z",
  },
  {
    id: "cr-demo-5", clientId: null, clientName: null, projectId: "p-web-1", projectName: "Client site redesign",
    source: "internal", kind: "bug",
    title: "Fix broken 404 page styling",
    body: null,
    status: "in_progress", route: "pm_task", pipelineRunId: null, pmTaskId: "t-4",
    requestedBy: "demo-hansel", requestedByName: "Clement Hansel",
    triagedBy: "demo-hansel", triagedByName: "Clement Hansel", triagedAt: "2026-07-20T09:00:00Z", declinedReason: null,
    createdAt: "2026-07-19T09:00:00Z", updatedAt: "2026-07-20T09:00:00Z",
  },
  {
    id: "cr-demo-6", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, projectName: null,
    source: "portal", kind: "feature",
    title: "Multi-language storefront",
    body: "Out of scope for this quarter's budget.",
    status: "declined", route: null, pipelineRunId: null, pmTaskId: null,
    requestedBy: "demo-client", requestedByName: "Dana Whitfield",
    triagedBy: "demo-hansel", triagedByName: "Clement Hansel", triagedAt: "2026-07-15T09:00:00Z",
    declinedReason: "Out of scope for this quarter's budget — revisit in the phase-2 estimate.",
    createdAt: "2026-07-14T09:00:00Z", updatedAt: "2026-07-15T09:00:00Z",
  },
];

const DEFAULT_ROUTE_BY_KIND: Record<DemoCrKind, DemoCrRoute> = {
  content: "pm_task", design: "mini_run", feature: "mini_run", bug: "pm_task",
};

function toRow(cr: DemoCr) {
  return {
    id: cr.id, clientId: cr.clientId, clientName: cr.clientName, projectId: cr.projectId, projectName: cr.projectName,
    source: cr.source, kind: cr.kind, title: cr.title, status: cr.status, route: cr.route,
    pipelineRunId: cr.pipelineRunId, pmTaskId: cr.pmTaskId,
    requestedBy: cr.requestedBy, requestedByName: cr.requestedByName,
    triagedBy: cr.triagedBy, triagedByName: cr.triagedByName, triagedAt: cr.triagedAt,
    declinedReason: cr.declinedReason, createdAt: cr.createdAt, updatedAt: cr.updatedAt,
  };
}

/** Returns a DemoResult for any /webdev/change-requests route, or null if it doesn't match. */
export function webdevChangeRequestsDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();

  const triageM = p.match(/^\/api\/[^/]+\/webdev\/change-requests\/([^/]+)\/triage$/);
  if (triageM && m === "POST") {
    const cr = CRS.find((c) => c.id === triageM[1]);
    if (!cr) return { status: 404, json: { error: "change request not found" } };
    const b = JSON.parse(body || "{}") as { action?: string; route?: DemoCrRoute; reason?: string; kindOverride?: DemoCrKind };
    if (!b.action || !["decline", "convert"].includes(b.action)) return { status: 400, json: { error: "action must be decline|convert" } };

    // Mirrors the controller's precondition re-check: a second triage of a non-'new' row is the
    // "already triaged" 409, carrying the existing artifact — not a bare error.
    if (cr.status !== "new") {
      return {
        status: 409,
        json: {
          error: `change request already triaged (status ${cr.status})`,
          existing: { status: cr.status, route: cr.route, pipelineRunId: cr.pipelineRunId, pmTaskId: cr.pmTaskId },
        },
      };
    }

    const kind = b.kindOverride ?? cr.kind;
    if (b.action === "decline") {
      const reason = (b.reason ?? "").trim();
      if (!reason) return { status: 400, json: { error: "reason required when declining" } };
      cr.status = "declined"; cr.route = null; cr.kind = kind;
      cr.declinedReason = reason; cr.triagedBy = userId; cr.triagedByName = userId; cr.triagedAt = new Date().toISOString();
      cr.updatedAt = cr.triagedAt;
      return ok({ id: cr.id, status: "declined", route: null });
    }

    const routeChoice = b.route ?? DEFAULT_ROUTE_BY_KIND[kind];
    if (routeChoice === "control_plane") {
      return { status: 501, json: { error: "route 'control_plane' needs the webdesk control plane (webdesk phase 4), which does not exist yet — convert to pm_task and make the edit by hand" } };
    }
    if (routeChoice === "pm_task" && !cr.projectId) {
      return { status: 400, json: { error: "this request names no project — a pm_task route needs one (convert to mini_run, or re-file against a project)" } };
    }
    cr.status = "in_progress"; cr.route = routeChoice; cr.kind = kind;
    cr.triagedBy = userId; cr.triagedByName = userId; cr.triagedAt = new Date().toISOString(); cr.updatedAt = cr.triagedAt;
    if (routeChoice === "mini_run") {
      // Reuses the shared demoPipeline fixture (run-demo-2) so the deep link actually resolves.
      cr.pipelineRunId = "run-demo-2";
      return ok({ id: cr.id, status: "in_progress", route: "mini_run", pipelineRunId: cr.pipelineRunId });
    }
    // Reuses the shared demoPm fixture (t-4) for the same reason.
    cr.pmTaskId = "t-4";
    return ok({ id: cr.id, status: "in_progress", route: "pm_task", pmTaskId: cr.pmTaskId });
  }

  const detailM = p.match(/^\/api\/[^/]+\/webdev\/change-requests\/([^/]+)$/);
  if (detailM && m === "GET") {
    const cr = CRS.find((c) => c.id === detailM[1]);
    if (!cr) return { status: 404, json: { error: "change request not found" } };
    return ok({
      ...toRow(cr), body: cr.body,
      runStatus: cr.route === "mini_run" ? "delivery_active" : null,
      runTitle: cr.route === "mini_run" ? "Mobile app revamp — discovery" : null,
      taskStatus: cr.route === "pm_task" ? "in_progress" : null,
      taskTitle: cr.route === "pm_task" ? "Homepage hero section" : null,
    });
  }

  const createM = p.match(/^\/api\/[^/]+\/webdev\/change-requests$/);
  if (createM && m === "POST") {
    const b = JSON.parse(body || "{}") as { kind?: DemoCrKind; title?: string; body?: string; clientId?: string; projectId?: string };
    if (!b.kind || !b.title?.trim()) return { status: 400, json: { error: "kind and title required" } };
    const id = nid("int");
    const now = new Date().toISOString();
    CRS.push({
      id, clientId: b.clientId ?? null, clientName: null, projectId: b.projectId ?? null, projectName: null,
      source: "internal", kind: b.kind, title: b.title.trim(), body: b.body ?? null,
      status: "new", route: null, pipelineRunId: null, pmTaskId: null,
      requestedBy: userId, requestedByName: userId, triagedBy: null, triagedByName: null, triagedAt: null,
      declinedReason: null, createdAt: now, updatedAt: now,
    });
    return ok({ id, status: "new" }, 201);
  }

  if (createM && m === "GET") {
    let rows = CRS;
    const status = params.get("status");
    const kind = params.get("kind");
    const clientId = params.get("clientId");
    const projectId = params.get("projectId");
    if (status) rows = rows.filter((c) => c.status === status);
    if (kind) rows = rows.filter((c) => c.kind === kind);
    if (clientId) rows = rows.filter((c) => c.clientId === clientId);
    if (projectId) rows = rows.filter((c) => c.projectId === projectId);
    return ok([...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toRow));
  }

  return null;
}

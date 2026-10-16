// DW-10e-1 — the shared world of the two database suites that prove migration 202610160200 (work_requests_across): the route
// and client wall (src/core/work-requests-across.db.test.ts) and the migration itself (work-requests-across-migration.db.test.ts).
//
// Everything here writes through `adminPool()` (a superuser, so RLS is bypassed): this module BUILDS the world, it never proves
// anything about isolation. The suites that prove the wall run their INSERTs through `withTenants` (the app role,
// NOSUPERUSER NOBYPASSRLS), so what the trigger can see is exactly what it sees in production.
//
// The shape (BFF §60.11 "Seed", reduced to what the data layer needs):
//   * one root with the provider P, the requesting company H, a hotel company T and a second provider P2;
//   * a second root with one company R;
//   * P's clients: cH (live, linked to H), cT (linked to T), cOther (linked to nobody), cDel (linked to H, deleted),
//     cInternal (the internal sentinel, linked to H); H's own client cOfH;
//   * P's requests projects, one per client, and §32's internal intake project;
//   * routes (service_assignments with a routing key), one per shape the guard must tell apart.
import { newId } from "../db";
import { adminPool } from "./setup";
import { createCompany, createUser, createClient, createProject } from "./fixtures";

export type Kind = "assets" | "engineering";

export interface AcrossWorld {
  P: string; H: string; T: string; P2: string; R: string;
  /** requested_by of every row. */
  user: string;
  user2: string;
  cH: string; cT: string; cOther: string; cOfH: string; cDel: string; cInternal: string; cR: string;
  projCreativeH: string; projWebH: string; projInternalIntake: string; projOther: string; projT: string; projR: string;
  /** Routes: service_assignments ids. */
  sa: {
    assets: string; eng: string; suspended: string; proposed: string; orphaned: string; division: string; toT: string;
    p2: string; rootR: string; wrongKey: string;
  };
}

const q = (sql: string, args: unknown[] = []) => adminPool().query(sql, args);

async function mkUnit(tenant: string, nodeId: string, kind: "department" | "division", name: string): Promise<string> {
  const id = newId();
  await q(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1, $2, $3, $4, $5)`, [id, tenant, nodeId, kind, name]);
  return id;
}

async function mkRoute(o: {
  provider: string; target: string; unitId: string; key: string; status?: string; unitStatus?: string; unitKind?: string;
  name: string; createdBy: string;
}): Promise<string> {
  const id = newId();
  await q(
    `INSERT INTO service_assignments (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, unit_status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, o.unitId, o.provider, o.target, o.key, o.status ?? "active", o.name, o.unitKind ?? "department", o.unitStatus ?? "active", o.createdBy],
  );
  return id;
}

/** A client of `tenant` (a platform operator's link, direct): `group` is the company it IS (clients.group_company_id). */
async function mkClient(tenant: string, name: string, group: string | null, extra: { internal?: boolean; deleted?: boolean } = {}): Promise<string> {
  const id = await createClient(tenant, name);
  await q(`UPDATE clients SET group_company_id = $2, is_internal = $3, deleted_at = $4 WHERE id = $1`, [
    id, group, extra.internal ?? false, extra.deleted ? new Date() : null,
  ]);
  return id;
}

export async function buildAcrossWorld(): Promise<AcrossWorld> {
  const P = await createCompany("Across Provider", ["pm", "webdev"]);
  const H = await createCompany("Across Holding", ["agency"], P);
  const T = await createCompany("Across Hotel", [], P);
  const P2 = await createCompany("Across Second Provider", ["pm", "webdev"], P);
  const R = await createCompany("Across Other Root", ["pm", "webdev"]);
  const user = await createUser("across-requester@across.test");
  const user2 = await createUser("across-other@across.test");

  const cH = await mkClient(P, "Holding at Provider", H);
  const cT = await mkClient(P, "Hotel at Provider", T);
  const cOther = await mkClient(P, "Unrelated client", null);
  const cOfH = await createClient(H, "A client of the holding itself");
  const cDel = await mkClient(P, "Deleted group client", H, { deleted: true });
  // The one live sentinel of P, wrongly linked to H: an internal client is never billable client work.
  const cInternal = await mkClient(P, "Internal sentinel", H, { internal: true });
  const cR = await mkClient(R, "Holding at the other root", H);

  const projCreativeH = await createProject(P, "Creatives · Requests · Holding", undefined, cH);
  const projWebH = await createProject(P, "Web Dev · Requests · Holding", undefined, cH);
  const projOther = await createProject(P, "Unrelated project", undefined, cOther);
  const projT = await createProject(P, "Hotel project", undefined, cT);
  const projR = await createProject(R, "Other root project", undefined, cR);
  // §32.1's intake: internal, no client. An asset task here is unbilled internal work.
  const projInternalIntake = await createProject(P, "Creatives · Requests");
  await q(`UPDATE projects SET is_internal = true WHERE id = $1`, [projInternalIntake]);

  const uCreative = await mkUnit(P, "d-creative", "department", "Creatives");
  const uWeb = await mkUnit(P, "d-web", "department", "Web Dev");
  const uSusp = await mkUnit(P, "d-susp", "department", "Suspended Dept");
  const uProp = await mkUnit(P, "d-prop", "department", "Proposed Dept");
  const uOrph = await mkUnit(P, "d-orph", "department", "Orphaned Dept");
  const uDiv = await mkUnit(P, "dv-div", "division", "A Division");
  const uWrongKey = await mkUnit(P, "d-wrongkey", "department", "Wrong Key Dept");
  const uP2 = await mkUnit(P2, "d-creative", "department", "Creatives");
  const uR = await mkUnit(R, "d-creative", "department", "Creatives");

  const sa = {
    assets: await mkRoute({ provider: P, target: H, unitId: uCreative, key: "asset_requests", name: "Creatives", createdBy: user }),
    eng: await mkRoute({ provider: P, target: H, unitId: uWeb, key: "engineering_requests", name: "Web Dev", createdBy: user }),
    suspended: await mkRoute({ provider: P, target: H, unitId: uSusp, key: "asset_requests", status: "suspended", name: "Suspended Dept", createdBy: user }),
    proposed: await mkRoute({ provider: P, target: H, unitId: uProp, key: "asset_requests", status: "proposed", name: "Proposed Dept", createdBy: user }),
    orphaned: await mkRoute({ provider: P, target: H, unitId: uOrph, key: "asset_requests", unitStatus: "orphaned", name: "Orphaned Dept", createdBy: user }),
    division: await mkRoute({ provider: P, target: H, unitId: uDiv, key: "asset_requests", unitKind: "division", name: "A Division", createdBy: user }),
    toT: await mkRoute({ provider: P, target: T, unitId: uCreative, key: "asset_requests", name: "Creatives", createdBy: user }),
    // Same department and same key as the real route, but its provider is the SECOND provider of the same root.
    p2: await mkRoute({ provider: P2, target: H, unitId: uP2, key: "asset_requests", name: "Creatives", createdBy: user }),
    // The provider sits in ANOTHER root than the requester (the controller refuses to make one; this is the direct insert).
    rootR: await mkRoute({ provider: R, target: H, unitId: uR, key: "asset_requests", name: "Creatives", createdBy: user }),
    // An engineering key on a department whose requests would be assets.
    wrongKey: await mkRoute({ provider: P, target: H, unitId: uWrongKey, key: "engineering_requests", name: "Wrong Key Dept", createdBy: user }),
  };

  return { P, H, T, P2, R, user, user2, cH, cT, cOther, cOfH, cDel, cInternal, cR, projCreativeH, projWebH, projInternalIntake, projOther, projT, projR, sa };
}

/** A PM task of `tenant` in `project`. */
export async function mkTask(tenant: string, project: string): Promise<string> {
  const id = newId();
  await q(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'Across task', 'central')`, [id, tenant, project]);
  return id;
}

/** A Web Dev change request of `tenant`, internal source, on `client` and `project` (either may be null). */
export async function mkChangeRequest(tenant: string, client: string | null, project: string | null, requestedBy: string): Promise<string> {
  const id = newId();
  await q(
    `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, client_id, project_id, requested_by, origin_site)
     VALUES ($1, $2, 'internal', 'feature', 'Across change request', 'new', $3, $4, $5, 'central')`,
    [id, tenant, client, project, requestedBy],
  );
  return id;
}

/** Column values for one work_requests INSERT. A key mapped to `OMIT` is left out of the statement altogether. */
export const OMIT = Symbol("omit");
export type Cols = Record<string, unknown>;

/** The columns of a VALID cross-company request of `kind` from H to P, with its work item written first (BFF §32.5's order).
 *  `over` replaces any column; `work` shapes the work item for the cases whose point is the work item itself. */
export async function validCrossCols(
  w: AcrossWorld, kind: Kind,
  over: Cols = {},
  work: { taskProject?: string; crClient?: string | null; crProject?: string | null; tenant?: string } = {},
): Promise<Cols> {
  const tenant = (over.tenant_id as string | undefined) ?? work.tenant ?? w.P;
  const base: Cols = {
    id: newId(), tenant_id: tenant, kind, requested_by: w.user, title: `Across ${kind}`, origin_site: "central",
    requester_tenant_id: w.H, requester_unit_id: "d-hr", requester_unit_name: "Human Resources",
    from_unit_id: null, campaign_part_id: null,
  };
  if (kind === "assets") {
    Object.assign(base, {
      to_unit_id: "d-creative", service_assignment_id: w.sa.assets, client_id: w.cH,
      pm_task_id: await mkTask(tenant, work.taskProject ?? w.projCreativeH), change_request_id: null,
    });
  } else {
    Object.assign(base, {
      to_unit_id: "d-web", service_assignment_id: w.sa.eng, client_id: w.cH, pm_task_id: null,
      change_request_id: await mkChangeRequest(
        tenant,
        work.crClient === undefined ? w.cH : work.crClient,
        work.crProject === undefined ? w.projWebH : work.crProject,
        w.user,
      ),
    });
  }
  return { ...base, ...over };
}

/** The columns of a same-company request of `tenant` (what code that predates the column writes). */
export async function sameCompanyCols(w: AcrossWorld, tenant: string, kind: Kind = "assets", over: Cols = {}): Promise<Cols> {
  const project = tenant === w.P ? w.projInternalIntake : await createProject(tenant, "Same company intake");
  const base: Cols = {
    id: newId(), tenant_id: tenant, kind, requested_by: w.user, title: `Same company ${kind}`, origin_site: "central",
    to_unit_id: "d-creative",
    pm_task_id: kind === "assets" ? await mkTask(tenant, project) : null,
    change_request_id: kind === "engineering" ? await mkChangeRequest(tenant, null, null, w.user) : null,
  };
  return { ...base, ...over };
}

export function insertSql(cols: Cols): { sql: string; params: unknown[] } {
  const keys = Object.keys(cols).filter((k) => cols[k] !== OMIT);
  return {
    sql: `INSERT INTO work_requests (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    params: keys.map((k) => cols[k]),
  };
}

/** What a failed statement raised: its SQLSTATE and (for a CHECK or an FK) the constraint's name. `undefined` code = it worked. */
export interface Outcome { code?: string; constraint?: string }
export async function outcomeOf(p: Promise<unknown>): Promise<Outcome> {
  try {
    await p;
    return {};
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return { code: err.code, constraint: err.constraint };
  }
}

// Test seeding shared by the delivery readers' database tests (DW-6n). Not a test file.
// Builds one company with the department tree
//   d-corp > d-soc (the unit under test) > dv-sub (a child unit)
//          > d-other (a sibling unit)
// and four clients, each with one project placed in a unit:
//   inUnit -> d-soc (counted), child -> dv-sub (counted), sibling -> d-other (never), internal -> d-soc but is_internal (never).
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { withTenants } from "../db";
import { rebuildOrgUnitClosure } from "../core/org-unit-closure";
import { adminPool } from "./setup";
import { createClient, createCompany, createProject } from "./fixtures";

export const UNIT = "d-soc";

export interface DeptWorld {
  tenant: string;
  clients: { inUnit: string; child: string; sibling: string; internal: string };
}

export async function seedDept(name: string, modules: string[]): Promise<DeptWorld> {
  const tenant = await createCompany(name, modules);
  const root = {
    id: "d-corp",
    kind: "company",
    name,
    children: [
      { id: UNIT, kind: "department", name: "Social", children: [{ id: "dv-sub", kind: "division", name: "Sub", children: [] }] },
      { id: "d-other", kind: "department", name: "Other", children: [] },
    ],
  };
  await withTenants([tenant], (c) => rebuildOrgUnitClosure(c, tenant, root));
  const make = async (label: string, unit: string, internal = false) => {
    const clientId = await createClient(tenant, `${name} ${label}`);
    const projectId = await createProject(tenant, `${name} ${label} project`, undefined, clientId);
    await withTenants([tenant], async (c) => {
      await c.query(`UPDATE projects SET department_id = $2 WHERE id = $1`, [projectId, unit]);
      if (internal) await c.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [clientId]);
    });
    return clientId;
  };
  return {
    tenant,
    clients: {
      inUnit: await make("in-unit", UNIT),
      child: await make("child", "dv-sub"),
      sibling: await make("sibling", "d-other"),
      internal: await make("internal", UNIT, true),
    },
  };
}

/** `date` 00:00 in REPORTS_TZ plus `seconds`: the window's boundaries without assuming the zone. */
export async function at(date: string, seconds = 0): Promise<Date> {
  const { rows } = await adminPool().query<{ t: Date }>(
    `SELECT (($1::date)::timestamp AT TIME ZONE $2::text) + ($3 || ' seconds')::interval AS t`,
    [date, config.reportsTz, String(seconds)],
  );
  return rows[0].t;
}

export const uuid = () => randomUUID();

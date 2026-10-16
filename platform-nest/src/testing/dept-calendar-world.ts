// DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59) — the shared fixture world of the department-calendar suites
// (`core/dept-calendar.test.ts`, the read; `core/calendar-events-department.test.ts`, the `department` visibility).
//
// ONE org shape in EVERY company, node ids included (seed ids such as `d-webdev` repeat across companies): the same tree in A and B is
// what makes the two-companies-same-node-id case a real one.
//
//   d-corp (the root)
//     d-web  "Web Dev"      ── dv-fe "Frontend"
//     d-seo  "SEO"
//     d-ops  "Operations"
//
// Everything here is written through `withTenants` / `withGlobal` (RLS-bound, the module wall declared for the hr_* tables), never a
// superuser, so a fixture that read back through the wrong wall would show as missing rows.
import { config } from "../config";
import { newId, withTenants } from "../db";
import { rebuildOrgUnitClosure } from "../core/org-unit-closure";
import { adminPool } from "./setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "./fixtures";

const site = () => config.originSite;

export const orgTree = (name: string) => ({
  id: "d-corp", kind: "company", name,
  children: [
    { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
    { id: "d-ops", kind: "department", name: "Operations", children: [] },
  ],
});

export async function seedTree(tenant: string, name: string): Promise<void> {
  const root = orgTree(name);
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
      [tenant, JSON.stringify({ root }), config.originSite],
    ),
  );
  await withTenants([tenant], (c) => rebuildOrgUnitClosure(c, tenant, root));
}

/** A person's PRIMARY placement, valid from 2020 and open-ended (or ended on `validTo`). */
export const place = (tenant: string, userId: string, unit: string, validTo: string | null = null) =>
  withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
       VALUES ($1,$2,$3,$4,true,'2020-01-01',$5,'manual',$6)`,
      [newId(), tenant, userId, unit, validTo, site()],
    ),
  );

export interface LeaveSpec {
  userId: string; type?: "vacation" | "sick" | "unpaid" | "other"; from: string; to: string;
  status?: "pending" | "approved" | "denied" | "cancelled"; note?: string | null; minutes?: number; deleted?: boolean; decidedBy?: string | null;
}
export async function addLeave(tenant: string, l: LeaveSpec): Promise<string> {
  const id = newId();
  await withTenants(
    [tenant],
    (c) =>
      c.query(
        `INSERT INTO hr_leave_requests (id, tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, note, status, decided_by, decided_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10, CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END, CASE WHEN $11 THEN now() ELSE NULL END)`,
        [id, tenant, l.userId, l.type ?? "vacation", l.from, l.to, l.minutes ?? 480, l.note ?? null, l.status ?? "approved", l.decidedBy ?? null, l.deleted ?? false],
      ),
    { modules: ["hr"] },
  );
  return id;
}

/** A holiday calendar (the DEFAULT one when `isDefault`) and its days. */
export async function addCalendar(tenant: string, name: string, isDefault: boolean, days: Array<[string, string, "public" | "joint_leave" | "company"]>): Promise<string> {
  const id = newId();
  await withTenants(
    [tenant],
    async (c) => {
      await c.query(`INSERT INTO hr_holiday_calendars (id, tenant_id, name, is_default) VALUES ($1,$2,$3,$4)`, [id, tenant, name, isDefault]);
      for (const [day, dayName, kind] of days) {
        await c.query(`INSERT INTO hr_holidays (tenant_id, calendar_id, day, name, kind) VALUES ($1,$2,$3::date,$4,$5)`, [tenant, id, day, dayName, kind]);
      }
    },
    { modules: ["hr"] },
  );
  return id;
}

export async function addProject(tenant: string, name: string, departmentId: string | null): Promise<string> {
  const id = await createProject(tenant, name);
  if (departmentId) await withTenants([tenant], (c) => c.query(`UPDATE projects SET department_id = $2 WHERE id = $1`, [id, departmentId]));
  return id;
}

export interface MilestoneSpec { projectId: string; name: string; due: string | null; status?: string; deleted?: boolean }
export async function addMilestone(tenant: string, m: MilestoneSpec): Promise<string> {
  const id = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, deleted_at, origin_site)
       VALUES ($1,$2,$3,$4,$5::date,$6, CASE WHEN $7 THEN now() ELSE NULL END, $8)`,
      [id, tenant, m.projectId, m.name, m.due, m.status ?? "open", m.deleted ?? false, site()],
    ),
  );
  return id;
}

export interface EventSpec {
  tenant: string; organizer: string; title: string;
  visibility?: "attendees" | "company" | "department"; unit?: string | null;
  startsAt?: string; endsAt?: string; startsOn?: string; endsOn?: string;
  cancelled?: boolean; attendees?: string[];
}
/** An event written straight to the table (no route, no notification), for the cases whose subject is the READ. */
export async function addEvent(e: EventSpec): Promise<string> {
  const id = newId();
  const allDay = e.startsOn !== undefined;
  await withTenants([e.tenant], async (c) => {
    await c.query(
      `INSERT INTO calendar_events (id, tenant_id, title, starts_at, ends_at, starts_on, ends_on, organizer_id, visibility, unit_node_id,
                                    status, cancelled_at, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11, CASE WHEN $12 THEN now() ELSE NULL END, $13)`,
      [
        id, e.tenant, e.title,
        allDay ? null : (e.startsAt ?? "2026-10-14T09:00:00+08:00"), allDay ? null : (e.endsAt ?? "2026-10-14T10:00:00+08:00"),
        allDay ? e.startsOn : null, allDay ? (e.endsOn ?? e.startsOn) : null,
        e.organizer, e.visibility ?? "attendees", e.unit ?? null, e.cancelled ? "cancelled" : "confirmed", e.cancelled ?? false, site(),
      ],
    );
    for (const u of [...new Set([e.organizer, ...(e.attendees ?? [])])]) {
      await c.query(`INSERT INTO calendar_event_attendees (event_id, user_id, tenant_id, response) VALUES ($1,$2,$3,$4)`, [id, u, e.tenant, u === e.organizer ? "accepted" : "needs_action"]);
    }
  });
  return id;
}

export interface World {
  A: string; B: string; HROFF: string; PMOFF: string; CAP: string;
  // company A
  admin: string; owner: string; hr: string; hrOnly: string; webHead: string; feHead: string; seoHead: string; corpHead: string;
  webStaff: string; feStaff: string; feLead2: string; seoStaff: string; viewerWeb: string; floater: string; botU: string; autoU: string; clientU: string; exWeb: string;
  // other companies
  bAdmin: string; bStaff: string; hrOffAdmin: string; hrOffStaff: string; pmOffAdmin: string; pmOffStaff: string; capAdmin: string;
}

/** Companies, people, roles and placements. The caller has already run `initTestDb()` and set the service token. */
export async function seedWorld(prefix: string): Promise<World> {
  const q = adminPool;
  const A = await createCompany(`${prefix} Co A`, ["hr", "pm"]);
  const B = await createCompany(`${prefix} Co B`, ["hr", "pm"]);
  const HROFF = await createCompany(`${prefix} Co HR off`, ["pm"]);
  const PMOFF = await createCompany(`${prefix} Co PM off`, ["hr"]);
  const CAP = await createCompany(`${prefix} Co Cap`, ["hr", "pm"]);
  const mkUser = async (key: string, name: string, tenants: string[] = [A]) => {
    const id = await createUser(`${key}@${prefix.toLowerCase()}.test`, name);
    for (const t of tenants) await addMembership(t, id);
    return id;
  };
  const w = {} as World;
  Object.assign(w, { A, B, HROFF, PMOFF, CAP });
  w.admin = await mkUser("admin", "Ada Admin");
  w.owner = await mkUser("owner", "Olga Owner");
  w.hr = await mkUser("hr", "Hana HR");
  w.hrOnly = await mkUser("hronly", "Hugo HROnly");
  w.webHead = await mkUser("webhead", "Wes Head");
  w.feHead = await mkUser("fehead", "Fay Head");
  w.seoHead = await mkUser("seohead", "Sia Head");
  w.corpHead = await mkUser("corphead", "Cory Head");
  w.webStaff = await mkUser("webstaff", "Andre Webstaff");
  w.feStaff = await mkUser("festaff", "Fenny Festaff");
  w.feLead2 = await mkUser("felead2", "Fia Lead");
  w.seoStaff = await mkUser("seostaff", "Seno Seostaff");
  w.viewerWeb = await mkUser("viewerweb", "Vera Viewer");
  w.floater = await mkUser("floater", "Flo Ater");
  w.botU = await mkUser("bot", "Agent Bot");
  w.autoU = await mkUser("auto", "Automation Bot");
  w.exWeb = await mkUser("exweb", "Exa Former");
  w.clientU = await createUser(`client@${prefix.toLowerCase()}.test`, "Client Login");
  w.bAdmin = await mkUser("badmin", "Bea Admin", [B]);
  w.bStaff = await mkUser("bstaff", "Bi Staff", [B]);
  w.hrOffAdmin = await mkUser("hroffadmin", "Hero Admin", [HROFF]);
  w.hrOffStaff = await mkUser("hroffstaff", "Hero Staff", [HROFF]);
  w.pmOffAdmin = await mkUser("pmoffadmin", "Pim Admin", [PMOFF]);
  w.pmOffStaff = await mkUser("pmoffstaff", "Pim Staff", [PMOFF]);
  w.capAdmin = await mkUser("capadmin", "Cap Admin", [CAP]);

  const role = {
    admin: await createRole("company_admin"), owner: await createRole("owner"), hr: await createRole("hr_staff"), manager: await createRole("manager"),
    member: await createRole("member"), viewer: await createRole("viewer"), lead: await createRole("org_unit_lead"), client: await createRole("client"),
  };
  for (const u of [w.hr, w.webHead, w.feHead, w.feLead2, w.seoHead, w.corpHead, w.webStaff, w.feStaff, w.seoStaff, w.floater, w.botU, w.exWeb]) {
    await grantRole(u, role.member, "company", A);
  }
  await grantRole(w.viewerWeb, role.viewer, "company", A);
  await grantRole(w.admin, role.admin, "company", A);
  await grantRole(w.autoU, role.admin, "company", A);
  await grantRole(w.owner, role.owner, "company", A);
  await q().query(`UPDATE users SET home_company_id = $2 WHERE id = $1`, [w.owner, A]);
  await grantRole(w.hr, role.hr, "company", A);
  await grantRole(w.hrOnly, role.hr, "company", A); // the HR read tier ALONE: no member / viewer / manager role
  for (const u of [w.webHead, w.feHead, w.seoHead]) await grantRole(u, role.manager, "company", A);
  await grantRole(w.webHead, role.lead, "org_unit", "d-web");
  await grantRole(w.feHead, role.lead, "org_unit", "dv-fe");
  await grantRole(w.feLead2, role.lead, "org_unit", "dv-fe"); // leads dv-fe, placed in d-ops: reaches dv-fe, NOT d-web above it
  await grantRole(w.seoHead, role.lead, "org_unit", "d-seo");
  await grantRole(w.corpHead, role.lead, "org_unit", "d-corp");
  await grantRole(w.clientU, role.client, "company", A);
  await q().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [w.botU]);
  await q().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [w.autoU]);
  await grantRole(w.bAdmin, role.admin, "company", B);
  await grantRole(w.bStaff, role.member, "company", B);
  await grantRole(w.hrOffAdmin, role.admin, "company", HROFF);
  await grantRole(w.hrOffStaff, role.member, "company", HROFF);
  await grantRole(w.pmOffAdmin, role.admin, "company", PMOFF);
  await grantRole(w.pmOffStaff, role.member, "company", PMOFF);
  await grantRole(w.capAdmin, role.admin, "company", CAP);

  for (const [t, name] of [[A, "A"], [B, "B"], [HROFF, "HR off"], [PMOFF, "PM off"], [CAP, "Cap"]] as const) await seedTree(t, `${prefix} ${name}`);
  await place(A, w.webHead, "d-web");
  await place(A, w.webStaff, "d-web");
  await place(A, w.viewerWeb, "d-web");
  await place(A, w.botU, "d-web");
  await place(A, w.exWeb, "d-web", "2020-12-31"); // left the unit long ago
  await place(A, w.feHead, "dv-fe");
  await place(A, w.feStaff, "dv-fe");
  await place(A, w.feLead2, "d-ops");
  await place(A, w.seoHead, "d-seo");
  await place(A, w.seoStaff, "d-seo");
  await place(B, w.bStaff, "d-web");
  await place(HROFF, w.hrOffStaff, "d-web");
  await place(PMOFF, w.pmOffStaff, "d-web");
  return w;
}


// The org chart as SEATS — `positions` + `position_assignments` + `position_roles` (IAM Phase 2,
// migration 0109), seeded from the real roster for the first time.
//
// ⚠ NOTHING SEEDED THESE TABLES BEFORE THIS FILE. 0109 built the whole position machinery in Phase 2
// and it has stood empty since: `grep "INSERT INTO positions"` over `src/` returned nothing. So the
// estate had an org TREE (the `org_structures` JSON blob agency.ts writes) but no seats — which is
// why "who reports to whom" could not be answered from data, only read off a picture.
//
// ── WHY SEATS RATHER THAN A manager_user_id ON EVERY PERSON ───────────────────────────────────────
// The owner gave an explicit chain: Edward (GM) → Azlan (Head of Web Dev) → Hansel + the Project
// Manager → the web dev / web maintenance divisions. The tempting encoding is a `manager_user_id` on
// each person. 0109 says not to: the DEFAULT reporting line IS the org chart ("nearest ancestor
// unit's lead position holder", design §2.1) and `employees.manager_user_id` is an OVERRIDE column
// only. Writing a manager onto all 25 rows would create a second source of truth that diverges from
// the chart the first time somebody is promoted in the UI. So the chain is expressed as `is_lead`
// seats at the right nodes, and the reporting line is DERIVED.
//
// ── WHAT A SEAT DOES AND DOES NOT CONFER ─────────────────────────────────────────────────────────
// `positions.is_lead` is display + backfill ONLY (0109 §2: "a position with is_lead=true and no
// org_unit_lead role row confers no lead power"). Authority comes from `position_roles`, and even
// that is a TEMPLATE — the reconciler that materializes it into real `user_roles` grants is P2-05 and
// is NOT BUILT. Consequence worth being exact about: after this seed the chart is correct and the
// intended role-set is recorded, but the grants people actually authorize against are still the ones
// `agency.ts` writes directly. This file makes the org chart true; it does not silently become the
// authorization path.
import { withGlobal, withTenants } from "../db";
import { STAFF, VACANCIES, type StaffMember } from "./roster";

/** Levels that lead the unit they sit in. `fixture` is excluded on purpose — the
 *  `@gaiada-creative.test` accounts are seed actors, not staff, and must not appear as unit leads. */
const LEAD_LEVELS = new Set(["gm", "head", "manager"]);

async function roleIdByName(name: string): Promise<string | null> {
  // Global (library) roles only: company_id IS NULL, per 0073's partial unique index.
  // withGlobal, NOT withTenants([]). An empty tenant array sets the GUC to nothing, so anything
  // RLS-predicated matches ZERO ROWS and reports success — here that would silently resolve every
  // role id to null and seed seats with no roles at all. `roles` carries no RLS and these are global
  // library rows (company_id IS NULL), so the global reader is both correct and the idiom three
  // other call sites already use for this exact query. Caught by lint:withtenants.
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name = $1`, [name]),
  );
  return rows[0]?.id ?? null;
}

/**
 * Seed one seat per roster member plus the owner's UNFILLED seats, and record each seat's intended
 * role set.
 *
 * @param tenantId  the employing company (Gaia Digital Agency)
 * @param userIds   email -> users.id, already resolved by agency.ts's roster loop
 * @param actorId   attributed as `assigned_by`
 */
export async function seedPositions(
  tenantId: string,
  userIds: Map<string, string>,
  actorId: string,
): Promise<{ seats: number; assigned: number; vacant: number }> {
  const roleMember = await roleIdByName("member");
  const roleManager = await roleIdByName("manager");
  const roleUnitLead = await roleIdByName("org_unit_lead");

  let seats = 0;
  let assigned = 0;
  let vacant = 0;

  await withTenants([tenantId], async (c) => {
    // `positions` has no natural unique key (0109 gives it only a surrogate id + the composite
    // (id, tenant_id) anchor), so idempotency has to be asserted here rather than by a constraint.
    // (tenant, unit_node_id, title) is the identity that matters: re-running the seed must not give
    // Azlan two "Tech Lead · Head of Web Dev" seats in the same department.
    const ensureSeat = async (unit: string, title: string, isLead: boolean, headcount: number | null) => {
      const existing = await c.query<{ id: string }>(
        `SELECT id FROM positions
          WHERE tenant_id = $1 AND unit_node_id = $2 AND title = $3 AND status <> 'retired'`,
        [tenantId, unit, title],
      );
      if (existing.rows[0]) return existing.rows[0].id;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO positions (tenant_id, unit_node_id, title, is_lead, headcount)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, unit, title, isLead, headcount],
      );
      seats++;
      return rows[0].id;
    };

    const attachRole = async (positionId: string, roleId: string | null, scopeKind: "company" | "own_unit") => {
      if (!roleId) return;
      // ux_position_roles is (position_id, role_id, scope_kind) — ON CONFLICT DO NOTHING is exactly
      // right here, and is what makes re-running safe.
      //
      // ⚠ `trg_position_roles_guard` will REFUSE platform_admin / group_executive / client / owner at
      // any scope_kind, and refuse `manager` at own_unit (its reachable scopes are company/global/
      // project, not org_unit). Both are why leads below get org_unit_lead@own_unit AND manager@
      // company rather than one role at one scope — the shapes are not interchangeable.
      await c.query(
        `INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind)
         VALUES ($1,$2,$3,$4) ON CONFLICT (position_id, role_id, scope_kind) DO NOTHING`,
        [tenantId, positionId, roleId, scopeKind],
      );
    };

    for (const s of STAFF as StaffMember[]) {
      const userId = userIds.get(s.email);
      // A roster row whose account was not created is a real inconsistency, not a skippable one:
      // agency.ts's loop creates every one of them immediately before this runs.
      if (!userId) throw new Error(`seedPositions: no users row for roster member ${s.email}`);

      const isLead = !!s.lead && LEAD_LEVELS.has(s.level);
      const positionId = await ensureSeat(s.target, s.title, isLead, null);

      await attachRole(positionId, roleMember, "company");
      if (isLead) {
        await attachRole(positionId, roleUnitLead, "own_unit");
        await attachRole(positionId, roleManager, "company");
      }

      // The EXCLUDE constraint (position_assignments_no_overlap) already refuses a second overlapping
      // assignment of the same seat to the same person, so this guard is for the friendly path — the
      // constraint is the one that actually holds under concurrency.
      const held = await c.query<{ id: string }>(
        `SELECT id FROM position_assignments
          WHERE tenant_id = $1 AND position_id = $2 AND user_id = $3 AND valid_to IS NULL`,
        [tenantId, positionId, userId],
      );
      if (!held.rows[0]) {
        await c.query(
          `INSERT INTO position_assignments (tenant_id, position_id, user_id, assigned_by, reason)
           VALUES ($1,$2,$3,$4,$5)`,
          [tenantId, positionId, userId, actorId, "Initial roster seed (owner-supplied, 2026-08-23)"],
        );
        assigned++;
      }
    }

    // ── the seats the owner described but did not name ────────────────────────────────────────────
    // "Project Manager (still no name, just position now)", "3 others" under Creative, "6 person
    // under him" under Social Media. A position with NO assignment is the honest encoding: the seat
    // exists, the chart shows the shape of the team, and nobody fake holds it. `headcount` carries
    // the number the owner gave (0109: "a soft target, display only").
    //
    // ⚠ A VACANCY CAN COLLIDE WITH AN OCCUPIED SEAT, AND ONE HERE DOES. Seats are identified by
    // (tenant, unit, title), so Andre/Rifat/Elmer — all titled "Creative" at `d-creatives` — share a
    // SINGLE position row with three assignments, which is correct (one seat definition, several
    // holders). But the owner's "3 others" under Creative has that same title at that same node, so a
    // separate vacant row is not expressible: it would be the same row.
    //
    // The fix is to stop modelling a vacancy as a ROW and model it as `headcount` minus holders, which
    // is what 0109's "soft target" field is for. A seat with headcount 6 and 3 assignments IS three
    // openings. This is strictly better than the alternative I first wrote (a second row with a
    // distinguishing title like "Creative (open)"), which would have put a fake job title on the org
    // chart to work around a key collision.
    for (const v of VACANCIES) {
      const named = STAFF.filter((s) => s.target === v.target && s.title === v.title).length;
      const target = named + v.count;
      const id = await ensureSeat(v.target, v.title, false, target);
      // ensureSeat returns early for an existing seat without touching headcount, so set it here —
      // otherwise the colliding "Creative" seat keeps the NULL it was created with and the three
      // openings vanish silently.
      await c.query(`UPDATE positions SET headcount = $2, updated_at = now() WHERE id = $1`, [id, target]);
      vacant += v.count;
    }
  });

  return { seats, assigned, vacant };
}

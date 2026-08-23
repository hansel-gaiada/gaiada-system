// Give the real roster ERP ACCESS — and nothing else.
//
// ⚠ WHY THIS EXISTS RATHER THAN JUST RUNNING `seed:agency`.
//
// ⚠⚠ CORRECTION (2026-08-23, same night): the ORIGINAL version of this comment justified the script
// by claiming production was "deliberately clean — zero clients/projects/tasks/invoices". THAT WAS
// FALSE, and the way it was false matters more than the claim.
//
// The pre-flight query used `set_config('app.current_tenant_ids', ..., true)` inside `withGlobal`.
// `withGlobal` opens NO TRANSACTION (src/db/index.ts — it just leases a client), and `is_local=true`
// scopes a setting to the current transaction. Outside one, each statement is its own implicit
// transaction, so the GUC was discarded before the very next query ran. Every count came back zero
// through RLS and reported success. The zero-row trap, hit while running the check meant to avoid it.
//
// The estate actually holds 4 clients, 17 projects, 8 invoices and 17 deliverables, seeded in July
// and August. Re-measured with `withTenants`, which does open a transaction.
//
// ── SO WHY KEEP THIS SCRIPT? ──────────────────────────────────────────────────────────────────────
// The "don't pollute a clean estate" argument is gone. What remains is still sufficient, and it is
// the honest reason:
//   · It is TARGETED. `seed:agency` also creates the holding's other companies, Anthony's `owner`
//     grants, and a department/PM/IT/invoice portfolio. Those are separate decisions with their own
//     review; "give nineteen people access" should not smuggle them in.
//   · It is IDEMPOTENT and its report says what it actually changed, re-read from the database rather
//     than inferred from a helper's return value.
//   · It REFUSES on a missing company instead of creating one (the 202608230612 fork hazard).
// Access and business data are different changes, and keeping them separable is worth a small script
// even on an estate that already has both.
//
// ── WHAT "ACCESS" MINIMALLY REQUIRES, AND WHY EACH PIECE IS HERE ──────────────────────────────────
//   1. a `users` row      — a Keycloak account alone authenticates but resolves to no principal.
//   2. a company MEMBERSHIP — `inTenant` is built from `company_memberships`; without one, almost
//      every policy denies even a correctly-granted role. This is the piece most easily forgotten,
//      because the role grant looks like it should be enough.
//   3. a role grant       — `member` for everyone, plus `manager` for the heads the owner named.
//   4. a SEAT             — positions/assignments, so the org chart is answerable from data.
//
// ⚠ WHAT THIS DOES NOT DO, stated so nobody assumes otherwise:
//   · It does not seed the org-structure BLOB (`org_structures`). Seats carry a free-text
//     `unit_node_id` with no FK (0109), so they are valid without it, but a UI reading the blob will
//     not render the tree until `seed:agency` — or a future targeted org seed — provides it.
//   · It does not grant Anthony `owner`, or create the holding's other companies. That is the
//     holding backbone, a separate concern with its own migration and its own review.
//   · It creates no client, project, task or invoice. On purpose. See above.
import { withGlobal, closePool } from "../db";
import { config } from "../config";
// The same helpers `agency.ts` uses — deliberately, rather than hand-rolled SQL. `addMembership`
// goes through `withTenants`, which sets `app.current_tenant_ids` correctly; my first draft set the
// GUC by hand through `withGlobal`, which works but re-implements the one thing this codebase has a
// linter for. Reusing the helper means the membership insert cannot drift from the seed's.
import { addMembership, grantRole } from "../testing/fixtures";
import { STAFF } from "./roster";
import { seedPositions } from "./positions";

const AGENCY_NAME = "Gaia Digital Agency";

export interface RosterAccessResult {
  tenantId: string;
  usersCreated: string[];
  usersExisting: string[];
  membershipsAdded: number;
  memberGrants: number;
  managerGrants: number;
  seats: { seats: number; assigned: number; vacant: number };
}

/** `company_memberships` is FORCE RLS, so this read needs the tenant GUC — hence withTenants, not
 *  withGlobal. A withGlobal read here would return 0 for everyone and report every membership as
 *  newly added. */
async function countMemberships(tenantId: string, userId: string): Promise<number> {
  const { withTenants } = await import("../db");
  const r = await withTenants([tenantId], (c) =>
    c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    ),
  );
  return Number(r.rows[0].n);
}

/** `user_roles` carries no RLS predicate, so the global reader is correct here. `scope_id` is TEXT
 *  (0100 altered it; 0001's `uuid` is stale), which is why the comparison needs no cast. */
async function countGrant(userId: string, roleId: string, tenantId: string): Promise<number> {
  const r = await withGlobal((c) =>
    c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_roles
        WHERE user_id = $1 AND role_id = $2 AND scope_type = 'company' AND scope_id = $3`,
      [userId, roleId, tenantId],
    ),
  );
  return Number(r.rows[0].n);
}

/** The heads and managers the owner named. Mirrors agency.ts's own rule so the two seeds cannot
 *  disagree about who is a manager. */
const MANAGER_LEVELS = new Set(["gm", "head", "manager"]);

export async function seedRosterAccess(): Promise<RosterAccessResult> {
  const site = config.originSite;

  const tenant = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  if (!tenant.rows[0]) {
    // Refuse rather than create it. A missing agency company means this is not the estate this script
    // was written for, and inventing one here would fork the company exactly the way the resort was
    // forked (see migration 202608230612).
    throw new Error(
      `seedRosterAccess: no company named "${AGENCY_NAME}". Refusing to create one — if this is a ` +
        `fresh database, run seed:agency instead; if it is the live estate, something is wrong.`,
    );
  }
  const tenantId = tenant.rows[0].id;

  // Library roles are global rows (company_id IS NULL, 0073's partial unique index).
  const roleId = async (name: string): Promise<string> => {
    const r = await withGlobal((c) =>
      c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name = $1`, [name]),
    );
    if (!r.rows[0]) throw new Error(`seedRosterAccess: role "${name}" is missing — run migrations first`);
    return r.rows[0].id;
  };
  const memberRole = await roleId("member");
  const managerRole = await roleId("manager");

  const usersCreated: string[] = [];
  const usersExisting: string[] = [];
  const ids = new Map<string, string>();
  let membershipsAdded = 0;
  let memberGrants = 0;
  let managerGrants = 0;

  for (const s of STAFF) {
    // ── 1 · the users row ────────────────────────────────────────────────────────────────────────
    const found = await withGlobal((c) =>
      c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [s.email]),
    );
    let userId: string;
    if (found.rows[0]) {
      userId = found.rows[0].id;
      usersExisting.push(s.email);
    } else {
      const ins = await withGlobal((c) =>
        c.query<{ id: string }>(
          `INSERT INTO users (id, email, name, title, origin_site) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
          [s.email, s.name, s.title, site],
        ),
      );
      userId = ins.rows[0].id;
      usersCreated.push(s.email);
    }
    ids.set(s.email, userId);

    // ── 2 · the membership ───────────────────────────────────────────────────────────────────────
    // `company_memberships` is FORCE RLS; `addMembership` goes through `withTenants`, so the GUC is
    // set for us. Counted by re-reading rather than by the helper's return (it returns void and
    // swallows the conflict), so the report says what actually happened.
    const before = await countMemberships(tenantId, userId);
    await addMembership(tenantId, userId);
    if (before === 0 && (await countMemberships(tenantId, userId)) === 1) membershipsAdded++;

    // ── 3 · the role grants ──────────────────────────────────────────────────────────────────────
    const grant = async (rid: string): Promise<number> => {
      const had = await countGrant(userId, rid, tenantId);
      await grantRole(userId, rid, "company", tenantId);
      return had === 0 && (await countGrant(userId, rid, tenantId)) === 1 ? 1 : 0;
    };
    memberGrants += await grant(memberRole);
    if (MANAGER_LEVELS.has(s.level)) managerGrants += await grant(managerRole);
  }

  // ── 4 · the seats ──────────────────────────────────────────────────────────────────────────────
  // Attributed to the superadmin, who exists on every estate this runs against.
  const actor = ids.get("hansel@gaiada.com") ?? ids.values().next().value!;
  const seats = await seedPositions(tenantId, ids, actor);

  return { tenantId, usersCreated, usersExisting, membershipsAdded, memberGrants, managerGrants, seats };
}

async function main(): Promise<void> {
  const r = await seedRosterAccess();
  console.log(`tenant:               ${r.tenantId}`);
  console.log(`users created:        ${r.usersCreated.length}`);
  for (const e of r.usersCreated) console.log(`  + ${e}`);
  console.log(`users already there:  ${r.usersExisting.length}`);
  console.log(`memberships added:    ${r.membershipsAdded}`);
  console.log(`member grants added:  ${r.memberGrants}`);
  console.log(`manager grants added: ${r.managerGrants}`);
  console.log(`seats: ${r.seats.seats} created, ${r.seats.assigned} assigned, ${r.seats.vacant} open headcount`);
  console.log(
    "\nNOTE: this grants ACCESS only — no clients, projects or invoices, and no org_structures blob.",
  );
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();

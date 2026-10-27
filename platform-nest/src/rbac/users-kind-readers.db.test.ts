// PK-02 — the people-shaped readers ask `users.kind`, not `company_memberships.kind`.
//
// THE DEFECT THIS PINS. The two columns answer different questions:
//   `company_memberships.kind` = WHY this account is in this company (employee | service)
//   `users.kind`               = WHAT this account IS (employee | client | automation | bot)
//
// Before PK-01 only the first existed, so every people surface had to guess the second from it. That
// guess is wrong in BOTH directions, and this suite exists because neither direction is visible from
// reading the code:
//
//   TOO STRONG — the shared-service reconciler (`service-reconciler.ts`) materializes a
//   `kind='service'` membership in the SERVED company for real, placed STAFF. Filtering on the
//   membership therefore erased every shared-service human from the directory of the company they
//   serve. A person vanishing from a people surface is the kind of bug nobody reports as a bug; they
//   just quietly cannot assign work to a colleague.
//
//   TOO WEAK — `GET /:t/members` filtered nothing at all unless SERVICE_ASSIGNMENTS_ENABLED was on
//   (it is off by default, and was off for every deployed consumer), so the 17 n8n accounts were
//   listed as members. Same defect that once made HR report 36 people when 19 were people.
//
// ⚠ BOTH DIRECTIONS ARE ASSERTED HERE ON PURPOSE. A test that only checked "the bot is absent" would
// pass just as well against a reader that returns nothing at all, and one that only checked "the
// human is present" would pass against a reader that filters nothing. Each case is the other's
// control.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise — a skipped run of this file proves nothing
// while looking identical to a pass. Check the skip count.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { withTenants } from "../db";
import { createCompany, createUser, addMembership, linkIdentity } from "../testing/fixtures";
import { planTenantBackfill } from "../admin/iam-phase2-backfill";
import { loadActiveMemberIds } from "../core/dept-notices.service";

/** The exact predicate the readers now use (admin-identity.controller, core.controller). Kept as one
 *  string so a drift between the two endpoints shows up here rather than in production. */
const HUMAN_ONLY = `AND u.kind = 'employee'`;

async function directory(tenantId: string, opts: { includeNonHuman?: boolean } = {}) {
  return withTenants([tenantId], async (c) => {
    await c.query("SELECT set_config('app.principal_user_id', NULL, true)");
    const { rows } = await c.query<{ email: string }>(
      `SELECT u.email
         FROM company_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.deleted_at IS NULL AND u.deleted_at IS NULL
          ${opts.includeNonHuman ? "" : HUMAN_ONLY}
        ORDER BY u.email`,
    );
    return rows.map((r) => r.email);
  });
}

describe.skipIf(!TEST_URL)("PK-02 · people-shaped readers filter on users.kind", () => {
  let tenantId: string;
  let staffEmail: string;
  let lentStaffEmail: string;
  let botEmail: string;

  beforeAll(async () => {
    await initTestDb();
    const stamp = Date.now();
    tenantId = await createCompany(`PK02 Served Co ${stamp}`);

    // An ordinary employee of this company.
    staffEmail = `pk02-staff-${stamp}@a.test`;
    await addMembership(tenantId, await createUser(staffEmail), "employee");

    // ⚠ THE CASE THE WHOLE TICKET IS ABOUT: a real HUMAN placed here by the shared-service
    // reconciler, so their membership in THIS company is kind='service' while they themselves are
    // an employee. Shaped exactly as service-reconciler.ts:234 writes it.
    lentStaffEmail = `pk02-lent-${stamp}@a.test`;
    await addMembership(tenantId, await createUser(lentStaffEmail), "service");

    // An n8n workflow: a `users` row on purpose (it cannot be authorized otherwise), with the same
    // service membership the lent human has. Indistinguishable from them by membership alone.
    botEmail = `pk02-wf-${stamp}@a.test`;
    const botId = await createUser(botEmail);
    await addMembership(tenantId, botId, "service");
    await linkIdentity(botId, "n8n", `wf:pk02-${stamp}`, true);
    await adminPool().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [botId]);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("the shared-service HUMAN appears in the served company's directory (they no longer vanish)", async () => {
    const emails = await directory(tenantId);
    expect(
      emails,
      "a real staff member placed into this company by the shared-service reconciler is missing " +
        "from its directory — the reader is still filtering on company_memberships.kind, which " +
        "cannot tell a lent colleague from a workflow",
    ).toContain(lentStaffEmail);
    expect(emails).toContain(staffEmail);
  });

  it("the automation account does NOT appear — and the human above is the control that this is not just an empty read", async () => {
    const emails = await directory(tenantId);
    expect(
      emails,
      "an n8n workflow is being presented as a colleague; this is the defect that made HR report " +
        "36 people when 19 were people",
    ).not.toContain(botEmail);
    // Without this the assertion above would pass against a reader that returns nothing at all.
    expect(emails.length, "the directory returned nothing, so the exclusion proves nothing").toBeGreaterThan(0);
  });

  it("?includeService=1 still reaches the automation account, so its grants remain auditable", async () => {
    // Settings -> Users & Roles must be able to see and revoke a workflow's grants. If the opt-in
    // stopped working, an automation account would become both invisible AND unrevokable.
    const emails = await directory(tenantId, { includeNonHuman: true });
    expect(emails).toContain(botEmail);
    expect(emails).toContain(lentStaffEmail);
    expect(emails).toContain(staffEmail);
  });

  it("🔴 NEGATIVE CONTROL — the OLD membership-based predicate fails both ways on this same fixture", async () => {
    // Demonstrates, rather than asserts, why the column had to change. Nothing in the codebase runs
    // this predicate any more; it is here so the ticket's premise stays falsifiable. If someone
    // "simplifies" the readers back to m.kind, the two expectations below are what they are choosing.
    const old = await withTenants([tenantId], async (c) => {
      await c.query("SELECT set_config('app.principal_user_id', NULL, true)");
      const { rows } = await c.query<{ email: string }>(
        `SELECT u.email
           FROM company_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.deleted_at IS NULL AND u.deleted_at IS NULL AND m.kind = 'employee'
          ORDER BY u.email`,
      );
      return rows.map((r) => r.email);
    });
    expect(old, "TOO STRONG: the old predicate erased the lent human").not.toContain(lentStaffEmail);
    expect(old, "the old predicate did keep ordinary staff — so the erasure above is specific").toContain(staffEmail);
  });
});

// T18 (agentic-native close-out, exit item 3) — the readers that were still asking `company_memberships.kind`
// alone now ask `users.kind` too, so a contributor, bot or automation account holding an EMPLOYEE-kind membership
// (the freelance writer's anchor membership, or a mis-seeded bot) is never counted as a person. The static ratchet
// in people-reader-kind-guard.test.ts keeps a new reader from regressing; this proves the repointed ones behave.
// Each exclusion has its control: the employee is present, so an empty read cannot pass.
describe.skipIf(!TEST_URL)("T18 · repointed people readers exclude automation, bot and contributor, and keep the employee", () => {
  let tenantId: string;
  const emails: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await initTestDb();
    const stamp = Date.now();
    tenantId = await createCompany(`T18 Readers Co ${stamp}`, ["hr"]);
    for (const kind of ["employee", "automation", "bot", "contributor"] as const) {
      emails[kind] = `t18-${kind}-${stamp}@a.test`;
      ids[kind] = await createUser(emails[kind]);
      // ALL FOUR hold an `employee`-kind membership: the membership column cannot tell them apart. That is the point.
      await addMembership(tenantId, ids[kind], "employee");
      if (kind !== "employee") await adminPool().query(`UPDATE users SET kind = $2 WHERE id = $1`, [ids[kind], kind]);
    }
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("dept-notices audience (loadActiveMemberIds): only the employee", async () => {
    const got = await withTenants([tenantId], (c) => loadActiveMemberIds(c, tenantId));
    expect(got).toContain(ids.employee);
    for (const k of ["automation", "bot", "contributor"]) expect(got, `${k} counted as a person`).not.toContain(ids[k]);
  });

  it("HR backfill plan (planTenantBackfill): the employee is a candidate; automation, bot and contributor are not", async () => {
    const plan = await planTenantBackfill(tenantId);
    const candidates = plan.employees.create.map((e) => e.userId);
    expect(candidates).toContain(ids.employee);
    for (const k of ["automation", "bot", "contributor"]) expect(candidates, `${k} would get an HR record`).not.toContain(ids[k]);
  });

  it("IT-accounts staff worklist and membership gate (predicate as written in it-accounts.controller): only the employee", async () => {
    const staff = await withTenants([tenantId], (c) =>
      c.query<{ user_id: string }>(
        `SELECT cm.user_id FROM company_memberships cm JOIN users u ON u.id = cm.user_id
          WHERE cm.tenant_id = $1 AND u.kind = 'employee' AND cm.kind = 'employee' AND cm.status = 'active'
            AND cm.deleted_at IS NULL AND u.deleted_at IS NULL`,
        [tenantId],
      ),
    );
    const got = staff.rows.map((r) => r.user_id);
    expect(got).toContain(ids.employee);
    for (const k of ["automation", "bot", "contributor"]) expect(got, `${k} on the human worklist`).not.toContain(ids[k]);
  });
});

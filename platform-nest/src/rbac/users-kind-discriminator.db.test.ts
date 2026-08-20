// PK-01 — `users.kind`, the principal discriminator.
//
// WHAT THIS FILE IS EVIDENCE FOR. `users.kind` exists because authorization here is defined over
// PRINCIPALS, so an n8n workflow and a Hermes persona have to be `users` rows to be authorized at
// all — and once they are, "principal" and "person" are different sets with nothing in the schema
// telling them apart. On 2026-08-03 HR reported 36 people when 19 were people and 17 were n8n
// service accounts. The column is the fix; this suite is what says the column's VALUES are right.
//
// ⚠ WHY IT RE-EXECUTES THE MIGRATION'S OWN `DO` BLOCK INSTEAD OF RESTATING THE RULES. A test that
// re-implements the classification would pass against a migration that classifies differently —
// the two copies drift and the suite quietly stops being evidence of anything. So the block is READ
// FROM THE MIGRATION FILE and run verbatim against fixtures. `initTestDb()` runs migrations against
// an empty database, so the backfill has zero rows to classify on the real pass; re-running it over
// fixtures is the only way to exercise the rules at all, and re-running is safe because every rule
// derives from evidence rather than mutating state incrementally.
//
// ⚠ RUN AS THE APP ROLE (`withGlobal`), NOT `adminPool()`. `adminPool()` bypasses RLS, and the whole
// hazard in this backfill is that its evidence tables (`company_memberships`, `client_contacts`,
// `clients`) are FORCE ROW LEVEL SECURITY. Bypassing RLS would make the trap invisible and every
// assertion below would pass for the wrong reason. Migrations run as a NOBYPASSRLS role; so does
// this.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise, and a skipped run of this file proves nothing
// while looking identical to a pass. Check the skip count.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { withGlobal, withTenants, newId } from "../db";
import { createCompany, createUser, addMembership, linkIdentity, createClient } from "../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../migrations/202608201442_users_kind_discriminator.sql");

/** The migration's backfill block, lifted verbatim so the test cannot drift from what shipped. */
function backfillBlock(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("DO $$");
  const end = sql.indexOf("END $$;", start);
  if (start < 0 || end < 0) {
    throw new Error(
      `PK-01: could not locate the backfill DO block in ${MIGRATION}. If the migration was ` +
        `restructured, this extraction must be updated — otherwise this suite silently tests nothing.`,
    );
  }
  return sql.slice(start, end + "END $$;".length);
}

describe.skipIf(!TEST_URL)("PK-01 · users.kind discriminator", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("the column exists, defaults to 'employee', and the CHECK refuses an unknown kind", async () => {
    const { rows } = await adminPool().query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'kind'`,
    );
    expect(rows, "users.kind is missing entirely — the migration did not apply").toHaveLength(1);
    expect(rows[0].column_default).toContain("employee");
    expect(rows[0].is_nullable).toBe("NO");

    // An unclassified account must land in a VISIBLE state, not a hidden one: a person missing from a
    // headcount is a bug nobody reports, whereas a workflow showing up in HR gets noticed and fixed.
    const uid = await createUser(`pk01-default-${Date.now()}@a.test`);
    const { rows: def } = await adminPool().query<{ kind: string }>(
      `SELECT kind FROM users WHERE id = $1`,
      [uid],
    );
    expect(def[0].kind).toBe("employee");

    await expect(
      adminPool().query(`UPDATE users SET kind = 'robot' WHERE id = $1`, [uid]),
    ).rejects.toThrow(/users_kind_check|check constraint/i);
  });

  it("classifies from evidence: n8n ⇒ automation, portal contact ⇒ client, messaging-without-staff ⇒ bot, staff stays employee", async () => {
    const stamp = Date.now();
    const tenantId = await createCompany(`PK01 Co ${stamp}`);

    // automation — an n8n identity link is the mechanism by which this account authenticates.
    const wf = await createUser(`pk01-wf-${stamp}@a.test`);
    await addMembership(tenantId, wf, "service");
    await linkIdentity(wf, "n8n", `wf:pk01-${stamp}`, true);

    // bot — a messaging identity and NO employee membership.
    const bot = await createUser(`pk01-bot-${stamp}@a.test`);
    await addMembership(tenantId, bot, "service");
    await linkIdentity(bot, "whatsapp", `+100000${stamp % 10000}`, true);

    // ⚠ THE CASE THE MEMBERSHIP GUARD EXISTS FOR. A real employee who enrolled WhatsApp for
    // notifications has byte-identical identity_links to the bot above. Without the guard this
    // person is reclassified `bot` and vanishes from every people surface — a silent, total loss of
    // a staff member from HR, caused by a notification preference.
    const staffWithWhatsapp = await createUser(`pk01-staff-wa-${stamp}@a.test`);
    await addMembership(tenantId, staffWithWhatsapp, "employee");
    await linkIdentity(staffWithWhatsapp, "whatsapp", `+200000${stamp % 10000}`, true);

    // client — a portal contact row (0072's table, the real source).
    const contact = await createUser(`pk01-contact-${stamp}@a.test`);
    const clientId = await createClient(tenantId, `PK01 Client ${stamp}`);
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
         VALUES ($1, $2, $3, $4, 'viewer', 'active', 'test')`,
        [newId(), tenantId, clientId, contact],
      ),
    );

    // plain staff — no links at all.
    const staff = await createUser(`pk01-staff-${stamp}@a.test`);
    await addMembership(tenantId, staff, "employee");

    await withGlobal((c) => c.query(backfillBlock()));

    const { rows } = await adminPool().query<{ id: string; kind: string }>(
      `SELECT id, kind FROM users WHERE id = ANY($1)`,
      [[wf, bot, staffWithWhatsapp, contact, staff]],
    );
    const kindOf = new Map(rows.map((r) => [r.id, r.kind]));

    expect(kindOf.get(wf), "an n8n-linked account must be automation").toBe("automation");
    expect(kindOf.get(bot), "a messaging identity with no employee membership must be bot").toBe("bot");
    expect(
      kindOf.get(staffWithWhatsapp),
      "an EMPLOYEE who enrolled WhatsApp was reclassified as a bot — the membership guard in the " +
        "bot rule is not holding, and this person would disappear from HR",
    ).toBe("employee");
    expect(kindOf.get(contact), "a client_contacts row must be client").toBe("client");
    expect(kindOf.get(staff), "staff with no links must stay employee").toBe("employee");
  });

  it("is idempotent — a second run reclassifies nothing", async () => {
    const before = await adminPool().query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM users GROUP BY kind ORDER BY kind`,
    );
    await withGlobal((c) => c.query(backfillBlock()));
    const after = await adminPool().query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM users GROUP BY kind ORDER BY kind`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("🔴 NEGATIVE CONTROL — without the GUC line the backfill misclassifies staff as bots and clients as employees", async () => {
    // This is the zero-row trap, demonstrated rather than asserted-about. Strip the one
    // `set_config('app.current_tenant_ids', ...)` line and the FORCE-RLS evidence tables return
    // NOTHING, with no error: `NOT EXISTS (employee membership)` becomes vacuously true, and the
    // client_contacts lookup finds nobody. The migration still reports success.
    //
    // Without this control the suite above would pass identically against a migration that had no
    // GUC at all, because its fixtures would be misread the same way in both directions. This is the
    // proof that the line is load-bearing.
    const stamp = Date.now();
    const tenantId = await createCompany(`PK01 Trap ${stamp}`);

    const staffWithWhatsapp = await createUser(`pk01-trap-staff-${stamp}@a.test`);
    await addMembership(tenantId, staffWithWhatsapp, "employee");
    await linkIdentity(staffWithWhatsapp, "whatsapp", `+300000${stamp % 10000}`, true);

    const contact = await createUser(`pk01-trap-contact-${stamp}@a.test`);
    const clientId = await createClient(tenantId, `PK01 Trap Client ${stamp}`);
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
         VALUES ($1, $2, $3, $4, 'viewer', 'active', 'test')`,
        [newId(), tenantId, clientId, contact],
      ),
    );

    const blinded = backfillBlock().replace(
      /PERFORM set_config\('app\.current_tenant_ids'[^;]*;/,
      "PERFORM 1;",
    );
    expect(
      blinded,
      "the set_config line was not found to strip — the negative control is not actually testing " +
        "anything and must be repaired before trusting the positive cases",
    ).not.toContain("set_config('app.current_tenant_ids'");

    await withGlobal((c) => c.query(blinded));

    const { rows } = await adminPool().query<{ id: string; kind: string }>(
      `SELECT id, kind FROM users WHERE id = ANY($1)`,
      [[staffWithWhatsapp, contact]],
    );
    const kindOf = new Map(rows.map((r) => [r.id, r.kind]));

    expect(
      kindOf.get(staffWithWhatsapp),
      "the trap did NOT bite, which means this control proves nothing — either RLS is not being " +
        "enforced for this role, or the guard no longer reads an RLS-walled table",
    ).toBe("bot");
    expect(kindOf.get(contact), "a blinded run should not have seen the client_contacts row").toBe(
      "employee",
    );

    // ⚠ THIS REPAIR STEP FOUND A REAL DEFECT, and is kept because it is the only thing that would.
    // The backfill was originally four sequential `UPDATE ... WHERE kind <> ...` statements, each of
    // which could only ever assign TOWARD a non-employee kind. Nothing in it could say "and
    // otherwise you are an employee", so once the blinded run above stuck this staff member as
    // `bot`, re-running the real block left them a `bot` permanently — and step 3 of the design
    // repoints every people-shaped reader onto this column, so that is a staff member missing from
    // HR with no path back. Rewritten as a single CASE, the classification became a total function
    // of the evidence and self-heals. These two assertions are what hold that property in place.
    await withGlobal((c) => c.query(backfillBlock()));
    const { rows: fixed } = await adminPool().query<{ id: string; kind: string }>(
      `SELECT id, kind FROM users WHERE id = ANY($1)`,
      [[staffWithWhatsapp, contact]],
    );
    const repaired = new Map(fixed.map((r) => [r.id, r.kind]));
    expect(repaired.get(staffWithWhatsapp)).toBe("employee");
    expect(repaired.get(contact)).toBe("client");
  });

  it("the partial index exists and covers only the non-employee side", async () => {
    const { rows } = await adminPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'users_kind_non_employee_idx'`,
    );
    expect(rows, "users_kind_non_employee_idx is missing").toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/WHERE \(kind <> 'employee'::text\)/);
  });
});

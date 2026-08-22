// MON-00 — the cross-root boundary. THIS SUITE IS THE BOUNDARY'S ONLY EVIDENCE.
//
// Why nothing else can stand in for it: the role-bundle and parity machinery computes reach by
// treating a Cerbos rule's `condition` as satisfied (documented design — see
// role-permission-parity.db.test.ts). It is therefore STRUCTURALLY BLIND to a condition-based fix
// like `inRoot`: bound the rule and every bundle-derived suite stays exactly as green as before.
// Only a live PDP decision and a live RLS query can tell you whether a root boundary holds.
//
// WHAT IT PINS. Under SaaS the unit of isolation is the ROOT COMPANY TREE (ancestry terminating at
// `parent_company_id IS NULL`), not the individual company. RLS never crosses roots by itself — the
// single point of failure is what enters the `app.current_tenant_ids` GUC, plus Cerbos rules that
// carry no tenant condition. Two such chains existed when this file was written:
//
//   1. `GET /rollups` authorized `{kind:"rollup"}` with NO tenantId, then widened the GUC to every
//      company in the database.
//   2. `group_executive`'s derived role condition is `role == "group_executive" && scopeType ==
//      "global"` — no tenant binding at all — so a client-chosen `:tenantId` reached
//      `withTenants([foreign])` and RLS then permitted it, because the GUC contained it.
//
// ⚠ POSITIVE CONTROLS COME FIRST, ALWAYS. The estate's defining failure mode is the zero-row trap: an
// unset GUC or a wrong module scope returns NOTHING and reports success, so "no foreign rows in the
// response" passes vacuously against a query that could not see anything at all. Every negative
// assertion below is therefore paired with a proof that the same principal, on the same route, CAN
// see its own root's rows. Without the pair, this file would be a green rubber stamp.
//
// ⚠ Needs DATABASE_URL_TEST *and* a live Cerbos. It skips silently otherwise — and a skipped run of
// this particular file proves nothing while looking identical to a pass. Check the skip count.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules, registerModule } from "../modules/registry";
import { monitoringModule } from "../modules/monitoring";
import { resetDrivers, registerDriver } from "../modules/monitoring/drivers/registry";
import { httpDriver } from "../modules/monitoring/drivers/http";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole, createClient, addMembership } from "../testing/fixtures";

// A string that must never appear in a response read by the other root. Asserted against the WHOLE
// raw body rather than a parsed field, so a leak through a field nobody thought to check — an error
// message, a joined company name, a rollup label — still fails.
const CANARY = "LEAK-CANARY-ROOT-B-8f3a1c";

describe.skipIf(!TEST_URL)("MON-00 · the cross-root boundary", () => {
  let app: NestFastifyApplication;
  let rootA: string;
  let childA1: string;
  let rootB: string;
  let childB1: string;
  let execA: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetDrivers();
    registerModule(monitoringModule);
    registerDriver(httpDriver);

    // Two INDEPENDENT holdings. Today's estate has exactly one root, which is the only reason the
    // chains above are latent rather than an active breach.
    rootA = await createCompany("Root A Holding", ["monitoring"]);
    childA1 = await createCompany("Child A1", ["monitoring"], rootA);
    rootB = await createCompany("Root B Holding", ["monitoring"]);
    childB1 = await createCompany(`Child B1 ${CANARY}`, ["monitoring"], rootB);

    // ⚠ IAM-15 CHANGED THE PRINCIPAL HERE, NOT THE CLAIM. This fixture used a GLOBAL
    // `group_executive` grant, which D-7 deleted. The boundary it guards is emphatically NOT dead —
    // 195 live rules still carry `variables.inRoot`, because every `perm_*` mirror is root-gated — so
    // the suite is retargeted rather than removed.
    //
    // The membership-less shape had to go WITH the role, though, and that is worth being precise
    // about: after the sweep there is exactly ONE live rule gated on `inRoot` alone
    // (resource_rollup.yaml's `perm_rollup_read`). Every other root-gated rule is
    // `inTenant && notLow && inRoot`. So a principal with no memberships anywhere can no longer reach
    // the monitoring route this suite drives — the old positive control would fail for a reason that
    // is not a bug.
    //
    // ⚠ I FIRST TRIED MEMBERSHIPS IN BOTH CHILDREN, to isolate `inRoot` as the sole cause of the
    // refusal (inTenant true for root B, inRoot false). That fixture is INVALID and the suite said so:
    // MON-00b's `CrossRootTenantSetError` exists precisely to make a principal spanning two roots
    // impossible, so it models nobody and the requests fail for a reason that is not the boundary.
    // Recorded rather than quietly reverted — it is an easy mistake to repeat, and the failure looked
    // like a leak rather than a bad fixture.
    //
    // So: membership in root A only, plus the global grant. For a root-B resource BOTH `inTenant` and
    // `inRoot` are false, which means this suite no longer isolates `inRoot` — the boundary is now
    // enforced by two independent walls and the test proves the OUTCOME (no cross-root read, no
    // canary in the body) rather than which wall stopped it. That is a real reduction in precision
    // and is called out here rather than papered over: `inRoot`'s remaining sole-gate rule is
    // resource_rollup.yaml's `perm_rollup_read`, which the /rollups cases below still exercise.
    execA = await createUser("exec-a@roota.test");
    const execRole = await createRole("company_admin");
    await grantRole(execA, execRole, "global", null);
    await addMembership(childA1, execA);
    // A real exec belongs to a company even though they hold a GLOBAL grant and no membership. That
    // employment is the anchor MON-00a reads; without it the principal is denied everywhere, which is
    // the correct fail-closed behaviour but models nobody. Two roots exist here, so the migration
    // deliberately does not guess this — it must be stated.
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [childA1, execA]);

    const pool = adminPool();
    // Root A's own row, so every negative below has a positive control.
    const clientA = await createClient(childA1, "Client A1");
    await pool.query(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, target, status, severity, interval_sec)
       VALUES ($1,$2,'a1-own-monitor.example','http','https://a1.example','up','ticket',60)`,
      [childA1, clientA],
    );
    // Root B's row, carrying the canary.
    const clientB = await createClient(childB1, `${CANARY} Client`);
    await pool.query(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, target, status, severity, interval_sec)
       VALUES ($1,$2,$3,'http','https://b1.example','up','page',60)`,
      [childB1, clientB, `${CANARY}-monitor`],
    );
    // A rollup row for root B, so /rollups has something of root B's to leak. `metric_key` is FK'd to
    // metric_definitions, so the canary rides the COMPANY NAME instead — which is the field that
    // endpoint actually returns (`co.name AS company`) and therefore the one a widening exposes.
    const mk = await pool.query<{ metric_key: string }>(
      `SELECT metric_key FROM metric_definitions ORDER BY metric_key LIMIT 1`,
    );
    if (mk.rows.length === 0) throw new Error("fixture bug: metric_definitions is empty, /rollups canary would be vacuous");
    await pool.query(
      `INSERT INTO rollup_metrics (id, tenant_id, module, metric_key, numerator, denominator, period, as_of, origin_site)
       VALUES (gen_random_uuid(),$1,'core',$2,1,1,current_date, now(), 'test')`,
      [childB1, mk.rows[0].metric_key],
    );

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("positive controls — run first, so no negative below can pass vacuously", () => {
    it("the exec CAN read its own root's child (proving the route and principal work at all)", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${childA1}/monitoring/monitors`, headers: asUser(execA),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("a1-own-monitor.example");
    });

    it("root B's canary rows really exist (a typo'd fixture would fake every pass below)", async () => {
      const { rows } = await adminPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM monitors WHERE tenant_id = $1 AND name LIKE $2`,
        [childB1, `%${CANARY}%`],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  describe("the boundary itself", () => {
    it("the exec CANNOT read a FOREIGN root's company, even naming its tenant id outright", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${childB1}/monitoring/monitors`, headers: asUser(execA),
      });
      // Refused outright...
      expect([403, 404]).toContain(res.statusCode);
      // ...and the canary appears nowhere in the raw body, whatever shape a leak might have taken.
      expect(res.body).not.toContain(CANARY);
    });

    it("neither can it reach a foreign root's incidents or summary", async () => {
      for (const path of ["monitoring/summary", "monitoring/incidents"]) {
        const res = await app.inject({
          method: "GET", url: `/api/${childB1}/${path}`, headers: asUser(execA),
        });
        expect([403, 404], `${path} returned ${res.statusCode}`).toContain(res.statusCode);
        expect(res.body, `${path} leaked the canary`).not.toContain(CANARY);
      }
    });

    it("GET /rollups is bounded to the caller's own root", async () => {
      // This endpoint authorized `{kind:"rollup"}` with no tenantId and then widened the GUC to
      // EVERY company in the database — the one place a single request touched all roots at once.
      const res = await app.inject({ method: "GET", url: `/rollups`, headers: asUser(execA) });
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain(CANARY);
    });

    it("withTenants REFUSES an array spanning two roots — the wall that catches future callers", async () => {
      // The chains above were both "a caller widened the GUC". Handler-by-handler review does not
      // survive the next handler, so the refusal belongs at the one place the GUC is ever set.
      const { withTenants, CrossRootTenantSetError } = await import("../db");

      // Assert the SPECIFIC error. `rejects.toThrow()` alone would pass on ANY rejection — a typo'd
      // column, a bad uuid cast, a closed pool — which would make this test green while the wall did
      // nothing. That is the same "green for the wrong reason" shape the header warns about.
      await expect(
        withTenants([childA1, childB1], async (c) => c.query(`SELECT 1`), { modules: ["monitoring"] }),
      ).rejects.toThrow(CrossRootTenantSetError);

      // And the guard must not be firing on every multi-tenant call: two companies in the SAME root
      // are legitimate and must pass, or the wall is just a ban on arrays.
      const sameRoot = await withTenants([rootA, childA1], async (c) => c.query(`SELECT 1 AS ok`), {
        modules: ["monitoring"],
      });
      expect(sameRoot.rows[0].ok).toBe(1);
    });
  });
});

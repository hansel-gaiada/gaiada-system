// IAM-03b — measured, not asserted. `assemblePrincipal()` runs on EVERY request; this file
// measures the marginal cost of the `perms` expansion IAM-03a added (one more query, joined
// through `role_permissions` (925 rows) -> `permissions` (230 rows)) against a realistic seed —
// roughly the LIVE role distribution documented in `2026-08-10-iam-phase1-tickets.md` §6 (member
// 18, manager 11, company_admin 9, client 9, agency_approver 1, it_admin 1, platform_admin 1,
// group_executive 1) — and reports real numbers so the cache decision in the IAM-03 report is
// backed by evidence, not assurance.
//
// What this file does NOT do: benchmark a "before" build of `assemblePrincipal()` by literally
// running two versions of the module. That would require either a git stash dance (this repo has
// no VCS access from the harness — cwd may not even be a git root, see the ticket's own header) or
// a duplicated copy of the old function. Instead it isolates the MARGINAL query IAM-03a added —
// the exact SQL text is reproduced here as a literal, unconnected to principal.ts's own copy, so a
// future edit to principal.ts's query can't silently drift this benchmark's "before" baseline —
// and separately times the full, real, current `assemblePrincipal()` end-to-end. Together these
// two numbers answer the ticket's question ("how much did this ticket add to the hot path?")
// without needing two source trees.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PoolClient } from "pg";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole } from "../testing/fixtures";
import { getPool } from "../db";
import { assemblePrincipal } from "./principal";

const ITERATIONS = 300;
const WARMUP = 20;

/** Legacy shape, reproduced literally (see file header) — IAM-02a's pre-existing roles-only query. */
const ROLES_ONLY_SQL = `SELECT r.name AS role, ur.scope_type AS "scopeType", ur.scope_id AS "scopeId"
   FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`;

/** IAM-03a's addition. */
const PERMS_SQL = `SELECT DISTINCT p.key AS key, ur.scope_type AS "scopeType", ur.scope_id AS "scopeId"
   FROM user_roles ur
   JOIN role_permissions rp ON rp.role_id = ur.role_id
   JOIN permissions p ON p.id = rp.permission_id
   WHERE ur.user_id = $1 AND p.class = 'grantable'`;

interface Stats {
  n: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function stats(samplesMs: number[]): Stats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    n: sorted.length,
    meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms: pct(50),
    p95Ms: pct(95),
    maxMs: sorted[sorted.length - 1],
  };
}

async function timeQuery(client: PoolClient, sql: string, params: unknown[], n: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await client.query(sql, params);
    samples.push(performance.now() - t0);
  }
  return samples;
}

async function timeAsync(fn: () => Promise<unknown>, n: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}

function fmt(label: string, s: Stats): string {
  return `${label}: n=${s.n} mean=${s.meanMs.toFixed(3)}ms p50=${s.p50Ms.toFixed(3)}ms p95=${s.p95Ms.toFixed(3)}ms max=${s.maxMs.toFixed(3)}ms`;
}

describe.skipIf(!TEST_URL)("IAM-03b · assemblePrincipal() perms-resolution performance", () => {
  let companyAdminId: string;
  let platformAdminId: string;
  let memberId: string;

  beforeAll(async () => {
    await initTestDb();

    // Realistic table sizes: seed roughly the live distribution (18 member / 11 manager / 9
    // company_admin / 9 client / 1 each of agency_approver/it_admin/platform_admin/group_executive
    // -> ~51 users) rather than benchmarking against a near-empty table, so the planner sees the
    // same row counts (user_roles, role_permissions×925, permissions×230) a real deploy would.
    const companies = await Promise.all(Array.from({ length: 5 }, (_, i) => createCompany(`IAM-03b Co ${i}`)));
    const roleIds = {
      platform_admin: await createRole("platform_admin"),
      group_executive: await createRole("group_executive"),
      company_admin: await createRole("company_admin"),
      manager: await createRole("manager"),
      member: await createRole("member"),
      client: await createRole("client"),
      it_admin: await createRole("it_admin"),
      agency_approver: await createRole("agency_approver"),
    };

    async function seedTier(role: string, roleId: string, count: number, scope: "global" | "company"): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const uid = await createUser(`iam03b-${role}-${i}@test.local`);
        const companyId = companies[i % companies.length];
        await grantRole(uid, roleId, scope, scope === "global" ? null : companyId);
        ids.push(uid);
      }
      return ids;
    }

    const memberIds = await seedTier("member", roleIds.member, 18, "company");
    const managerIds = await seedTier("manager", roleIds.manager, 11, "company");
    const companyAdminIds = await seedTier("company_admin", roleIds.company_admin, 9, "company");
    await seedTier("client", roleIds.client, 9, "company");
    const platformAdminIds = await seedTier("platform_admin", roleIds.platform_admin, 1, "global");
    await seedTier("group_executive", roleIds.group_executive, 1, "global");
    await seedTier("it_admin", roleIds.it_admin, 1, "company");
    await seedTier("agency_approver", roleIds.agency_approver, 1, "company");

    memberId = memberIds[0];
    companyAdminId = companyAdminIds[0];
    platformAdminId = platformAdminIds[0];
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("EXPLAIN ANALYZE on the perms query — records the real plan and its execution time", async () => {
    const { rows } = await adminPool().query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${PERMS_SQL}`,
      [companyAdminId],
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    console.log("\n--- IAM-03b EXPLAIN ANALYZE (company_admin, 199-perm bundle) ---\n" + plan + "\n");
    // The planner hash-joins a full Seq Scan of role_permissions (925 rows) against permissions
    // (215 after the class='grantable' filter), THEN nested-loops into user_roles via its existing
    // (user_id, role_id, scope_type, scope_id) unique index to filter down to this one user's rows
    // — verified by reading the actual plan above, not assumed. That is the CORRECT and CHEAPER
    // plan at this table size (both tables fit in a handful of pages), not a missing-index defect:
    // an index on role_permissions(role_id) already exists (it's the PK's leading column) and the
    // planner had it available and still preferred the seq scan, because reading ~925 8-byte-ish
    // rows sequentially is cheaper than one index probe per candidate role. Asserting "no seq
    // scan" here would be asserting for a WORSE plan. The only assertion worth making at this
    // scale is on wall-clock time, not on which physical operator Postgres picked.
    const execTimeMatch = plan.match(/Execution Time: ([\d.]+) ms/);
    expect(execTimeMatch).not.toBeNull();
    const execMs = Number(execTimeMatch![1]);
    expect(execMs).toBeLessThan(20);
  });

  it("measures the MARGINAL query cost the perms expansion added, per persona, on a single reused connection", async () => {
    const client = await getPool().connect();
    try {
      const personas: Array<[string, string]> = [
        ["member (74 perms)", memberId],
        ["company_admin (199 perms)", companyAdminId],
        ["platform_admin (215 perms)", platformAdminId],
      ];
      const lines: string[] = [];
      for (const [label, userId] of personas) {
        await timeQuery(client, ROLES_ONLY_SQL, [userId], WARMUP);
        await timeQuery(client, PERMS_SQL, [userId], WARMUP);
        const rolesOnly = stats(await timeQuery(client, ROLES_ONLY_SQL, [userId], ITERATIONS));
        const withPerms = stats(await timeQuery(client, PERMS_SQL, [userId], ITERATIONS));
        const marginal = withPerms.meanMs - rolesOnly.meanMs;
        lines.push(fmt(`${label} roles-only (BEFORE)`, rolesOnly));
        lines.push(fmt(`${label} perms-query (ADDED)`, withPerms));
        lines.push(`${label} marginal mean added latency: ${marginal.toFixed(3)}ms\n`);
        // Generous ceiling (>>10x the measured mean on dev hardware) — this is a regression guard,
        // not a precision claim; the real numbers are in the console output above and quoted
        // verbatim in the IAM-03 report.
        expect(withPerms.p95Ms).toBeLessThan(25);
      }
      console.log("\n--- IAM-03b marginal query-cost benchmark ---\n" + lines.join("\n"));
    } finally {
      client.release();
    }
  });

  it("measures the full end-to-end assemblePrincipal() cost per persona (real request-path timing)", async () => {
    const personas: Array<[string, string]> = [
      ["member (74 perms)", memberId],
      ["company_admin (199 perms)", companyAdminId],
      ["platform_admin (215 perms)", platformAdminId],
    ];
    const lines: string[] = [];
    for (const [label, userId] of personas) {
      await timeAsync(() => assemblePrincipal(userId, "high"), WARMUP);
      const full = stats(await timeAsync(() => assemblePrincipal(userId, "high"), ITERATIONS));
      lines.push(fmt(`${label} assemblePrincipal() end-to-end`, full));
      expect(full.p95Ms).toBeLessThan(50);
    }
    console.log("\n--- IAM-03b end-to-end assemblePrincipal() benchmark ---\n" + lines.join("\n"));
  });
});

// Task 4.7 (D12): governed definitions, ratio as num/den, idempotent recompute,
// group_executive management view gated to the rollup layer only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { buildApp } from "../main";
import {
  recomputeRollups,
  syncMetricDefinitions,
  registerCoreRollupProvider,
  resetCoreRollupProviders,
  coreTaskRollups,
} from "./engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import {
  createCompany, createUser, addMembership, createRole, grantRole, createProject, createTask,
} from "../testing/fixtures";

describe.skipIf(!TEST_URL)("rollups (D12)", () => {
  let app: NestFastifyApplication;
  let tenantA: string;
  let tenantB: string;
  let exec: string;
  let member: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerCoreRollupProvider(coreTaskRollups);
    await syncMetricDefinitions();

    tenantA = await createCompany("Agency A");
    tenantB = await createCompany("Resort B");
    exec = await createUser("exec@gaiada.test");
    member = await createUser("member2@a.test");
    await addMembership(tenantA, member);
    const execRole = await createRole("group_executive");
    const memberRole = await createRole("member");
    await grantRole(exec, execRole, "global", null);
    await grantRole(member, memberRole, "company", tenantA);

    const pA = await createProject(tenantA, "P-A");
    await createTask(tenantA, pA, "t1", "todo");
    await createTask(tenantA, pA, "t2", "in_progress");
    await createTask(tenantA, pA, "t3", "done");
    const pB = await createProject(tenantB, "P-B");
    await createTask(tenantB, pB, "t4", "todo");

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("recompute writes num/den ratio rows and is idempotent", async () => {
    const period = "2026-07-05";
    await recomputeRollups(tenantA, period);
    await recomputeRollups(tenantA, period); // second run must not duplicate

    const rows = await withTenants([tenantA], (c) =>
      c.query(`SELECT metric_key, numerator, denominator, dimensions FROM rollup_metrics WHERE period = $1`, [period]),
    );
    const ratio = rows.rows.find((r) => r.metric_key === "core.tasks.open_ratio");
    expect(Number(ratio.numerator)).toBe(2); // todo + in_progress
    expect(Number(ratio.denominator)).toBe(3); // never a pre-divided percentage
    const statusRows = rows.rows.filter((r) => r.metric_key === "core.tasks.by_status");
    expect(statusRows.length).toBe(3); // one row per status, not duplicated by rerun
  });

  it("undeclared metrics are rejected by the registry FK (D12 governance)", async () => {
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO rollup_metrics (id, tenant_id, module, metric_key, period, numerator, dimensions, as_of, origin_site)
           VALUES (gen_random_uuid(), $1, 'core', 'rogue.metric', '2026-07-05', 1, '{}', now(), 'x')`,
          [tenantA],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("group_executive reads the cross-company view; a member cannot", async () => {
    const period = "2026-07-05";
    await recomputeRollups(tenantB, period);

    const execView = await app.inject({ method: "GET", url: `/api/rollups?period=${period}`, headers: asUser(exec) });
    expect(execView.statusCode).toBe(200);
    const companies = new Set((execView.json() as Array<{ company: string }>).map((r) => r.company));
    expect(companies).toEqual(new Set(["Agency A", "Resort B"]));

    const memberView = await app.inject({ method: "GET", url: `/api/rollups?period=${period}`, headers: asUser(member) });
    expect(memberView.statusCode).toBe(403);
  });

  it("member can trigger recompute for their own tenant only via the manager path", async () => {
    const denied = await app.inject({
      method: "POST",
      url: `/api/${tenantB}/rollups/recompute`,
      headers: asUser(member),
      payload: { period: "2026-07-05" },
    });
    expect(denied.statusCode).toBe(403);
  });
});

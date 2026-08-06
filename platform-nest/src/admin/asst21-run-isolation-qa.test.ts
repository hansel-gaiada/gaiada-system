// ASST-24 QA GATE — adversarial re-proof of ASST-21 (handoff-run isolation) against live
// Postgres + Cerbos. Does NOT modify production code. Complements the existing coverage in
// intelligence.test.ts's "ASST-21: handoff-owner additive carve-out" block (owner-allow,
// different-same-company-user deny, company_admin deny, and the same-tenant regression guard
// are already proven there) — this file adds the two checks the QA ticket calls out that were
// NOT already covered:
//   (d) cross-tenant: a handoff/run belonging to tenant X must not be readable via tenant Y's
//       route, even by a caller who IS a real member of Y.
//   (e) a malformed (non-uuid) runId hit through the REAL HTTP route must come back as a clean
//       deny, never a 500 from a Postgres "invalid input syntax for type uuid" error leaking
//       through `fetchHandoffByRunId`'s query.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("ASST-24 QA gate / ASST-21 adversarial: handoff-run isolation (cross-tenant + malformed runId)", () => {
  let app: NestFastifyApplication;
  let X: string;
  let Y: string;
  let ownerX: string;
  let memberY: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    // Deliberately UNSET the agents runner for this whole file: every scenario below must be
    // decided (denied) before the controller ever reaches out to the runner, so a stray runner
    // config could only ever mask a bug, never cause a false pass.
    config.services.agents = { url: "", token: "" };

    X = await createCompany("ASST21-QA Tenant X", ["assistant"]);
    Y = await createCompany("ASST21-QA Tenant Y", ["assistant"]);
    ownerX = await createUser("asst21qa-ownerX@a.test");
    memberY = await createUser("asst21qa-memberY@a.test");
    await addMembership(X, ownerX);
    await addMembership(Y, memberY);
    const memberRole = await createRole("member");
    await grantRole(ownerX, memberRole, "company", X);
    await grantRole(memberY, memberRole, "company", Y);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("(d) cross-tenant: a handoff run that belongs to tenant X is denied/not-found when requested via tenant Y's route by a REAL member of Y", async () => {
    const runIdX = newId();

    // The handoff row lives entirely under tenant X's RLS scope.
    await withTenants(
      [X],
      (c) =>
        c.query(
          `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, origin_site) VALUES ($1,$2,$3,'central')`,
          [newId(), X, ownerX],
        ),
      { modules: ["assistant"] },
    );
    const threadRow = await withTenants(
      [X],
      (c) => c.query<{ id: string }>(`SELECT id FROM assistant_threads WHERE tenant_id = $1 AND owner_user_id = $2`, [X, ownerX]),
      { modules: ["assistant"] },
    );
    await withTenants(
      [X],
      (c) =>
        c.query(
          `INSERT INTO assistant_handoffs
             (id, tenant_id, thread_id, owner_user_id, agent, goal_text, goal_id, run_id, status, origin_site)
           VALUES ($1,$2,$3,$4,'status-reporter','status please',$5,$6,'ok','central')`,
          [newId(), X, threadRow.rows[0].id, ownerX, newId(), runIdX],
        ),
      { modules: ["assistant"] },
    );

    // Sanity: the OWNER, reading through tenant X's OWN route, can see it (proves the row/setup is
    // real and the deny below is about tenant isolation, not a broken fixture). Runner is
    // unconfigured, so a successful authz decision surfaces as 404 ("run not found" from the
    // runner proxy), never 403/500 — that 404 is what we compare the cross-tenant attempt against.
    const sameTenantAsOwner = await app.inject({ method: "GET", url: `/api/${X}/agents/runs/${runIdX}`, headers: asUser(ownerX) });
    expect(sameTenantAsOwner.statusCode).toBe(404); // authorized, but the (unconfigured) runner can't serve it

    // The actual adversarial request: tenant Y's route, a REAL member of Y, asking for tenant X's
    // run id. `fetchHandoffByRunId` is scoped by `withTenants([tenantId=Y], ...)` — X's row must be
    // invisible under Y's RLS session regardless of matching on `run_id` alone.
    const crossTenant = await app.inject({ method: "GET", url: `/api/${Y}/agents/runs/${runIdX}`, headers: asUser(memberY) });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json()).not.toHaveProperty("steps"); // never a transcript body under any status
  });

  it("(e) a malformed (non-uuid) runId through the REAL HTTP route is a clean 403, never a 500 from a Postgres uuid-cast error", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/${Y}/agents/runs/${encodeURIComponent("../../not-a-uuid; DROP TABLE assistant_handoffs;--")}`,
      headers: asUser(memberY),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: "platform admin required" });

    // A second, simpler malformed shape (plain non-uuid token) — same clean deny.
    const r2 = await app.inject({ method: "GET", url: `/api/${Y}/agents/runs/not-a-uuid-at-all`, headers: asUser(memberY) });
    expect(r2.statusCode).toBe(403);

    // The table must still exist and be queryable — proves no injection/crash occurred.
    const stillThere = await withTenants([Y], (c) => c.query(`SELECT 1 FROM assistant_handoffs LIMIT 1`), { modules: ["assistant"] });
    expect(stillThere).toBeDefined();
  });
});

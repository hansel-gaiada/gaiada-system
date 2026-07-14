// Phase B admin backend: per-company org structure + compliance gates — against live
// Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const sampleOrg = {
  root: {
    id: "root",
    name: "Agency A",
    kind: "company",
    children: [
      { id: "d1", name: "Web Dev", kind: "department", children: [{ id: "r1", name: "Lead Dev", kind: "role", children: [] }] },
      { id: "d2", name: "SEO", kind: "department", children: [] },
    ],
  },
};

describe.skipIf(!TEST_URL)("company-admin API (Phase B)", () => {
  let app: NestFastifyApplication;
  let tenantA: string;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenantA = await createCompany("Agency A", ["agency"]);
    admin = await createUser("admin@a.test");
    member = await createUser("member@a.test");
    await addMembership(tenantA, admin);
    await addMembership(tenantA, member);

    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, adminRole, "company", tenantA);
    await grantRole(member, memberRole, "company", tenantA);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("GET org-structure is 404 before anything is set", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${tenantA}/org-structure`, headers: asUser(member) });
    expect(r.statusCode).toBe(404);
  });

  it("admin PUTs a structure; any member can then read it; an outbox event is emitted", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/api/${tenantA}/org-structure`,
      headers: asUser(admin),
      payload: sampleOrg,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true });

    const got = await app.inject({ method: "GET", url: `/api/${tenantA}/org-structure`, headers: asUser(member) });
    expect(got.statusCode).toBe(200);
    const body = got.json() as { root: { kind: string; children: unknown[] }; updatedAt: string | null };
    expect(body.root.kind).toBe("company");
    expect(body.root.children).toHaveLength(2);
    expect(body.updatedAt).toBeTruthy();

    const ev = await withTenants([tenantA], (c) =>
      c.query(`SELECT event_type FROM outbox_events WHERE entity_type = 'org_structure' AND tenant_id = $1`, [tenantA]),
    );
    expect(ev.rows).toContainEqual({ event_type: "org_structure.updated" });
  });

  it("a non-elevated member cannot PUT the structure (403)", async () => {
    const r = await app.inject({
      method: "PUT",
      url: `/api/${tenantA}/org-structure`,
      headers: asUser(member),
      payload: sampleOrg,
    });
    expect(r.statusCode).toBe(403);
  });

  it("PUT sanitizes: invalid kind coerced, root forced to company, depth/name bounded", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/${tenantA}/org-structure`,
      headers: asUser(admin),
      payload: { root: { id: "root", name: "X", kind: "bogus", children: [{ id: "a", name: "  spaced  ", kind: "alien", children: [] }] } },
    });
    const got = await app.inject({ method: "GET", url: `/api/${tenantA}/org-structure`, headers: asUser(admin) });
    const body = got.json() as { root: { kind: string; children: Array<{ kind: string; name: string }> } };
    expect(body.root.kind).toBe("company"); // forced
    expect(body.root.children[0].kind).toBe("role"); // invalid -> role
    expect(body.root.children[0].name).toBe("spaced"); // trimmed
  });

  it("compliance gates: GET returns the 6-gate template (default open); non-admin denied", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/${tenantA}/compliance-gates`, headers: asUser(admin) });
    expect(ok.statusCode).toBe(200);
    const gates = ok.json() as Array<{ key: string; status: string; title: string }>;
    expect(gates.map((g) => g.key)).toEqual(["G.1", "G.2", "G.3", "G.4", "G.5", "G.6"]);
    expect(gates.every((g) => g.status === "open")).toBe(true);
    expect(gates[0].title).toBeTruthy();

    const denied = await app.inject({ method: "GET", url: `/api/${tenantA}/compliance-gates`, headers: asUser(member) });
    expect(denied.statusCode).toBe(403);
  });

  it("PATCH a gate persists status + evidence; unknown gate 404; bad status 400", async () => {
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/${tenantA}/compliance-gates/G.4`,
      headers: asUser(admin),
      payload: { status: "passed", evidence_url: "https://example.test/evidence" },
    });
    expect(patched.statusCode).toBe(200);

    const gates = (
      await app.inject({ method: "GET", url: `/api/${tenantA}/compliance-gates`, headers: asUser(admin) })
    ).json() as Array<{ key: string; status: string; evidence_url: string | null }>;
    const g4 = gates.find((g) => g.key === "G.4")!;
    expect(g4.status).toBe("passed");
    expect(g4.evidence_url).toBe("https://example.test/evidence");

    expect(
      (await app.inject({ method: "PATCH", url: `/api/${tenantA}/compliance-gates/G.99`, headers: asUser(admin), payload: { status: "passed" } })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "PATCH", url: `/api/${tenantA}/compliance-gates/G.4`, headers: asUser(admin), payload: { status: "nope" } })).statusCode,
    ).toBe(400);
  });
});

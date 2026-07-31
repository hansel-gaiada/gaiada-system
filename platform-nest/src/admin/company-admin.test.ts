// Phase B admin backend: per-company org structure + compliance gates — against live
// Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { todayIso, addDaysIso } from "../core/dept-resolution";

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

  // ─────────────────────────── TR-04 — the org-structure PUT membership sweep ───────────────────────────
  describe("TR-04: org-structure PUT sweeps org_unit_memberships", () => {
    type MembershipRow = {
      unit_node_id: string;
      is_primary: boolean;
      valid_from: string;
      valid_to: string | null;
      source: string;
      origin_site: string;
    };
    const membershipRows = async (userId: string): Promise<MembershipRow[]> => {
      const { rows } = await withTenants([tenantA], (c) =>
        c.query<MembershipRow>(
          `SELECT unit_node_id, is_primary, valid_from::text, valid_to::text, source, origin_site
             FROM org_unit_memberships WHERE tenant_id = $1 AND user_id = $2
            ORDER BY valid_from`,
          [tenantA, userId],
        ),
      );
      return rows;
    };
    const today = todayIso();

    it("a PUT that newly places a person opens one org_blob row dated today", async () => {
      const dana = await createUser("dana-oum@a.test", "Dana");
      await addMembership(tenantA, dana);

      const put = await app.inject({
        method: "PUT",
        url: `/api/${tenantA}/org-structure`,
        headers: asUser(admin),
        payload: {
          root: {
            id: "root", name: "Agency A", kind: "company",
            children: [
              { id: "d1", name: "Web Dev", kind: "department", children: [] },
              { id: "d3", name: "Design", kind: "department", children: [
                { id: "d3-p1", name: "Dana", kind: "person", assigneeId: dana, children: [] },
              ] },
            ],
          },
        },
      });
      expect(put.statusCode).toBe(200);

      const rows = await membershipRows(dana);
      expect(rows).toEqual([
        { unit_node_id: "d3", is_primary: true, valid_from: today, valid_to: null, source: "org_blob", origin_site: config.originSite },
      ]);
    });

    it("a second PUT the SAME day moves dana again -> amends the row in place (no duplicate)", async () => {
      const [dana] = (
        await withTenants([tenantA], (c) =>
          c.query<{ user_id: string }>(
            `SELECT user_id FROM org_unit_memberships WHERE tenant_id = $1 AND unit_node_id = 'd3'`,
            [tenantA],
          ),
        )
      ).rows;
      expect(dana).toBeDefined();
      const danaId = dana.user_id;

      const put = await app.inject({
        method: "PUT",
        url: `/api/${tenantA}/org-structure`,
        headers: asUser(admin),
        payload: {
          root: {
            id: "root", name: "Agency A", kind: "company",
            children: [
              { id: "d4", name: "Video Editor", kind: "department", children: [
                { id: "d4-p1", name: "Dana", kind: "person", assigneeId: danaId, children: [] },
              ] },
            ],
          },
        },
      });
      expect(put.statusCode).toBe(200);

      const rows = await membershipRows(danaId);
      // Still exactly ONE row (amended, not close+open) -- same valid_from as before (today),
      // now pointing at d4.
      expect(rows).toEqual([
        { unit_node_id: "d4", is_primary: true, valid_from: today, valid_to: null, source: "org_blob", origin_site: config.originSite },
      ]);

      // ── removal case, reusing dana: a PUT that drops her entirely closes the open row and
      // opens nothing (no new row appears; the existing one gains a valid_to of today).
      const putRemoved = await app.inject({
        method: "PUT",
        url: `/api/${tenantA}/org-structure`,
        headers: asUser(admin),
        payload: { root: { id: "root", name: "Agency A", kind: "company", children: [] } },
      });
      expect(putRemoved.statusCode).toBe(200);

      const afterRemoval = await membershipRows(danaId);
      expect(afterRemoval).toEqual([
        { unit_node_id: "d4", is_primary: true, valid_from: today, valid_to: today, source: "org_blob", origin_site: config.originSite },
      ]);
    });

    it("a genuine transfer (pre-existing stale open row) closes the OLD row the day before today and opens a NEW one dated today", async () => {
      const evan = await createUser("evan-oum@a.test", "Evan");
      await addMembership(tenantA, evan);

      // Seed a stale open primary membership directly (simulates a placement that predates
      // today's sweep -- e.g. TR-03's backfill, or an earlier PUT on a prior day).
      await withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships
             (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, 'legacy-dept', true, '2020-01-01', NULL, 'manual', 'test')`,
          [tenantA, evan],
        ),
      );

      const put = await app.inject({
        method: "PUT",
        url: `/api/${tenantA}/org-structure`,
        headers: asUser(admin),
        payload: {
          root: {
            id: "root", name: "Agency A", kind: "company",
            children: [
              { id: "d1", name: "Web Dev", kind: "department", children: [
                { id: "d1-p1", name: "Evan", kind: "person", assigneeId: evan, children: [] },
              ] },
            ],
          },
        },
      });
      expect(put.statusCode).toBe(200);

      const rows = await membershipRows(evan);
      expect(rows).toEqual([
        { unit_node_id: "legacy-dept", is_primary: true, valid_from: "2020-01-01", valid_to: addDaysIso(today, -1), source: "manual", origin_site: "test" },
        { unit_node_id: "d1", is_primary: true, valid_from: today, valid_to: null, source: "org_blob", origin_site: config.originSite },
      ]);
    });

    it("an assigneeId that isn't a real user (legacy placeholder ref) is defensively skipped, not inserted or errored", async () => {
      const countRows = async (): Promise<number> =>
        Number(
          (
            await withTenants([tenantA], (c) =>
              c.query<{ n: string }>(`SELECT count(*) AS n FROM org_unit_memberships WHERE tenant_id = $1`, [tenantA]),
            )
          ).rows[0].n,
        );
      const before = await countRows();

      const put = await app.inject({
        method: "PUT",
        url: `/api/${tenantA}/org-structure`,
        headers: asUser(admin),
        payload: {
          root: {
            id: "root", name: "Agency A", kind: "company",
            children: [
              { id: "d1", name: "Web Dev", kind: "department", children: [
                // Non-uuid ref (legacy seed-data shape, see org.ts's own "u-dev"/"u-pm" defaults) --
                // must be skipped defensively, never cast to uuid, never abort the PUT.
                { id: "d1-ghost", name: "Ghost", kind: "person", assigneeId: "u-legacy-placeholder", children: [] },
              ] },
            ],
          },
        },
      });
      expect(put.statusCode).toBe(200); // must not 500 / abort the PUT

      expect(await countRows()).toBe(before); // no row inserted for the unrepresentable ref
    });
  });
});

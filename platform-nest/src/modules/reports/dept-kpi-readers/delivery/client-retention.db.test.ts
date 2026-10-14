// DW-6n6 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3 row n6, §40.5.6) — `clients.retention` against live Postgres + RLS. The reader is
// called directly. SEO's unit is `d-seo` with a child `d-seo-sub`; `d-web` is its sibling. Window: October 2026, start 2026-10-01.
//
// Cohort at start (6 of 11 seeded clients):
//   A  signed contract, open-ended, + a completed project in d-seo          retained
//   B  signed contract ending 2026-10-15                                    retained until 10-15, churned from 10-16
//   G  only a planned/active project in d-seo (no contract)                 retained (a project keeps a client active)
//   I  only a planned project in the child unit d-seo-sub                   retained (S(u) is the subtree)
//   K  signed v1 ending 09-30, signed v2 (supersedes v1) from 10-01         retained (continuous)
//   N  signed contract ending 10-15 + an ACTIVE project in sibling d-web    churned from 10-16 (that project is not in S(u))
// Not in the cohort: C (contract starts 10-10), F (void contract), H (expired contract), E (internal), D (sibling unit only),
// Z (contract ended before the window) and the other tenant's client.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { newId, withTenants } from "../../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createClient, createCompany, createProject } from "../../../../testing/fixtures";
import { rebuildOrgUnitClosure } from "../../../../core/org-unit-closure";
import type { ReaderCtx } from "../types";
import { clientRetention } from "./client-retention";

const SHA = "a".repeat(64);

describe.skipIf(!TEST_URL)("DW-6n6 clients.retention (live PG)", () => {
  let co: string;
  let other: string;

  const structure = (name: string) => ({
    id: "d-corp",
    kind: "company",
    name,
    children: [
      { id: "d-seo", kind: "department", name: "SEO", children: [{ id: "d-seo-sub", kind: "division", name: "Local SEO", children: [] }] },
      { id: "d-web", kind: "department", name: "Web Dev", children: [] },
      { id: "d-empty", kind: "department", name: "Empty", children: [] },
    ],
  });
  const seedTree = async (tenant: string, name: string) => {
    const root = structure(name);
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
        [tenant, JSON.stringify({ root }), config.originSite],
      ),
    );
    await withTenants([tenant], (c) => rebuildOrgUnitClosure(c, tenant, root));
  };
  const project = async (tenant: string, client: string, unit: string, status: string, start: string | null, name = `P ${unit} ${status}`) => {
    const id = await createProject(tenant, name, undefined, client);
    await withTenants([tenant], (c) => c.query(`UPDATE projects SET department_id = $2, status = $3, start_date = $4::date WHERE id = $1`, [id, unit, status, start]));
    return id;
  };
  const contract = async (tenant: string, client: string, status: string, startsOn: string | null, endsOn: string | null, supersedes?: string, signedAt: string | null = new Date().toISOString()) => {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO contracts (id, tenant_id, client_id, title, version, supersedes_id, status, starts_on, ends_on, sent_at, signed_at,
                                body_md, content_sha256, content_fixed_at, signature_tier, origin_site)
         VALUES ($1,$2,$3,'MSA',$4,$5,$6,$7::date,$8::date, now(), CASE WHEN $6 = 'signed' THEN $11::timestamptz END, 'Terms.', $9, now(), 'attested', $10)`,
        [id, tenant, client, supersedes ? 2 : 1, supersedes ?? null, status, startsOn, endsOn, SHA, config.originSite, signedAt],
      ),
    );
    return id;
  };
  const createdAt = (tenant: string, projectId: string, at: string) =>
    withTenants([tenant], (c) => c.query(`UPDATE projects SET created_at = $2::timestamptz WHERE id = $1`, [projectId, at]));
  const read = (over: Partial<ReaderCtx> = {}, tenant = () => co) =>
    clientRetention({ tenantId: tenant(), unitId: "d-seo", periodKind: "month", start: "2026-10-01", end: "2026-10-31", asOf: "2026-10-20", ...over });

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("DW-6n6 Co", ["pm"]);
    other = await createCompany("DW-6n6 Other", ["pm"]);
    await seedTree(co, "DW-6n6 Co");
    await seedTree(other, "DW-6n6 Other");

    const A = await createClient(co, "A retained");
    await contract(co, A, "signed", "2026-01-01", null);
    await project(co, A, "d-seo", "completed", "2026-01-01");

    const B = await createClient(co, "B ends 10-15");
    await contract(co, B, "signed", "2026-01-01", "2026-10-15");
    await project(co, B, "d-seo", "completed", "2026-01-01");

    const C = await createClient(co, "C starts after the window opens");
    await contract(co, C, "signed", "2026-10-10", null);
    await project(co, C, "d-seo", "completed", "2026-01-01");

    const D = await createClient(co, "D sibling unit only");
    await contract(co, D, "signed", "2026-01-01", null);
    await project(co, D, "d-web", "active", "2026-01-01");

    const E = await createClient(co, "E internal");
    await withTenants([co], (c) => c.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [E]));
    await project(co, E, "d-seo", "active", "2026-01-01");

    const F = await createClient(co, "F void contract");
    await contract(co, F, "void", "2026-01-01", null);
    await project(co, F, "d-seo", "completed", "2026-01-01");

    const G = await createClient(co, "G project only");
    await project(co, G, "d-seo", "active", "2026-06-01");

    const H = await createClient(co, "H expired contract");
    await contract(co, H, "expired", "2026-01-01", null);
    await project(co, H, "d-seo", "completed", "2026-01-01");

    const I = await createClient(co, "I child unit project");
    await project(co, I, "d-seo-sub", "planned", "2026-09-01");

    const K = await createClient(co, "K superseded");
    const v1 = await contract(co, K, "signed", "2026-01-01", "2026-09-30");
    await contract(co, K, "signed", "2026-10-01", null, v1);
    await project(co, K, "d-seo", "completed", "2026-01-01");

    const N = await createClient(co, "N sibling project keeps nothing");
    await contract(co, N, "signed", "2026-01-01", "2026-10-15");
    await project(co, N, "d-seo", "completed", "2026-01-01");
    await project(co, N, "d-web", "active", "2026-01-01", "N web project");

    const Z = await createClient(co, "Z ended before the window");
    await contract(co, Z, "signed", "2026-01-01", "2026-09-15");
    await project(co, Z, "d-seo", "completed", "2026-01-01");

    // Another tenant: same unit id, a client that would be retained. Never counted for `co`.
    const O = await createClient(other, "O other tenant");
    await contract(other, O, "signed", "2026-01-01", null);
    await project(other, O, "d-seo", "active", "2026-01-01");
  }, 60_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("a running window (asOf < end): the cohort of 6, the churned one out once its contract has ended", async () => {
    // asOf 10-20: B and N (ended 10-15) are gone; A, G, I, K remain.
    expect(await read({ asOf: "2026-10-20" })).toEqual({ value: 4 / 6, numerator: 4, denominator: 6 });
    // asOf 10-10: nobody has left yet.
    expect(await read({ asOf: "2026-10-10" })).toEqual({ value: 1, numerator: 6, denominator: 6 });
  });

  it("asOf = end of a past window gives the same cohort and the final retention", async () => {
    expect(await read({ asOf: "2026-10-31" })).toEqual({ value: 4 / 6, numerator: 4, denominator: 6 });
  });

  it("a contract's ends_on is inclusive: still active ON its last day, gone the day after", async () => {
    expect(await read({ asOf: "2026-10-15" })).toMatchObject({ numerator: 6, denominator: 6 });
    expect(await read({ asOf: "2026-10-16" })).toMatchObject({ numerator: 4, denominator: 6 });
  });

  it("a client that only became active after the window opened is not in the cohort, and not counted when it joins", async () => {
    // C starts 10-10: present on asOf 10-20 but never in the denominator.
    const r = await read({ asOf: "2026-10-20" });
    expect(r?.denominator).toBe(6);
  });

  it("a later window start moves the cohort: on 2026-10-10 C joins it", async () => {
    // start 10-10: A, B, C, G, I, K, N active (7); Z, F, H, E, D, other never. asOf 10-31: B and N gone.
    expect(await read({ start: "2026-10-10", end: "2026-10-31", asOf: "2026-10-31" })).toEqual({ value: 5 / 7, numerator: 5, denominator: 7 });
  });

  it("an active project in a SIBLING unit does not keep a client active (N), and a sibling-only client is no cohort member (D)", async () => {
    const r = await read({ asOf: "2026-10-20" });
    // N is in the cohort (denominator 6) and churned (numerator 4); D is in neither.
    expect([r?.numerator, r?.denominator]).toEqual([4, 6]);
  });

  it("a void or expired contract never makes a client active, and an internal client is never counted", async () => {
    // F (void), H (expired) and E (internal) are absent from every cohort: the denominator never exceeds 6 at start 10-01.
    expect((await read({ asOf: "2026-10-01" }))?.denominator).toBe(6);
  });

  it("the child unit's own read sees only its subtree's clients", async () => {
    // d-seo-sub: only I (a planned project there). C(u) of the child is {I}; retained.
    expect(await read({ unitId: "d-seo-sub", asOf: "2026-10-20" })).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("another tenant's clients are never counted, and the other tenant reads its own", async () => {
    expect(await read({ asOf: "2026-10-20" }, () => other)).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("an empty cohort is null (no clients, or none active at the window's start), never 100%", async () => {
    expect(await read({ unitId: "d-empty" })).toBeNull();
    // 2025: nobody was active a year earlier
    expect(await read({ start: "2025-10-01", end: "2025-10-31", asOf: "2025-10-31" })).toBeNull();
  });

  // The common creation paths never set `start_date`/`starts_on`: the start falls back to created_at / signed_at (REPORTS_TZ date).
  describe("fallback starts", () => {
    let co2: string;
    beforeAll(async () => {
      co2 = await createCompany("DW-6n6 Fallback Co", ["pm"]);
      await seedTree(co2, "DW-6n6 Fallback Co");
      const early = await createClient(co2, "project created before the window");
      await createdAt(co2, await project(co2, early, "d-seo", "active", null, "early"), "2026-09-01T12:00:00Z");
      const late = await createClient(co2, "project created after the window opened");
      await createdAt(co2, await project(co2, late, "d-seo", "active", null, "late"), "2026-10-10T12:00:00Z");
      const signedEarly = await createClient(co2, "contract with no starts_on, signed before the window");
      await contract(co2, signedEarly, "signed", null, null, undefined, "2026-09-01T12:00:00Z");
      await project(co2, signedEarly, "d-seo", "completed", "2026-01-01", "done");
      const neither = await createClient(co2, "signed contract with neither a start nor a signing time");
      await contract(co2, neither, "signed", null, null, undefined, null);
      await project(co2, neither, "d-seo", "completed", "2026-01-01", "done2");
    }, 60_000);

    it("a NULL start_date project created before start puts its client in the cohort; created after start it does not", async () => {
      // cohort at 10-01: the early project, and the contract signed 09-01 (starts_on NULL). The late project and the contract with
      // neither date are out. Both cohort members are still active on asOf.
      expect(await read({ asOf: "2026-10-20" }, () => co2)).toEqual({ value: 1, numerator: 2, denominator: 2 });
      // Moving the window start past the late project's creation brings its client in.
      expect(await read({ start: "2026-10-11", end: "2026-10-31", asOf: "2026-10-20" }, () => co2)).toMatchObject({ numerator: 3, denominator: 3 });
    });
  });

  it("a window that has not begun as of asOf is null", async () => {
    expect(await read({ start: "2026-10-20", asOf: "2026-10-10" })).toBeNull();
  });
});

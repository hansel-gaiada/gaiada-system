// M5-V3-d — the consented-visitor-profile schema (202610131600_search_visitor_profiles.sql) against LIVE Postgres.
// Needs DATABASE_URL_TEST (see platform-nest/CLAUDE.md; skipped without it: NOT run on the dev laptop, runs on the
// Linux gate). initTestDb() applies the real migration runner and then repoints the app at a NOSUPERUSER NOBYPASSRLS
// role, so every withTenants() call below is subject to FORCE RLS; adminPool() (superuser) is used only to re-apply
// the file and to read catalogs.
// Covers: the file re-applies cleanly, FORCE RLS + the composed policy on all five tables, cross-tenant and unset-GUC
// and missing-module-scope reads return 0 rows and refuse writes, the unique keys hold, the CHECKs (path only, data
// allow-list, kind-dependent NOT NULL), events cascade from their profile, a tombstoned visitor/consent id cannot
// be re-created, no ip/user-agent column exists, the agency_leads index exists and is partial, the file holds no DML.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";
import { searchModule } from "./index";

const MIGRATION = "202610131600_search_visitor_profiles.sql";
const MIGRATION_PATH = join(__dirname, "..", "..", "..", "migrations", MIGRATION);
const S = { modules: ["search"] };
const TABLES = [
  "search_visitor_profiles", "search_visitor_events", "search_visitor_tombstones",
  "search_interest_rules", "search_visitor_ingest_state",
] as const;
/** The hash contract from the migration header: sha256 of the lower-case canonical uuid text. */
const idHash = (id: string): Buffer => createHash("sha256").update(id.toLowerCase(), "utf8").digest();

describe("M5-V3-d · the migration file (no database needed)", () => {
  it("is registered in the search module and holds no data changes", () => {
    expect(searchModule.migrations).toContain(MIGRATION);
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");
    // DDL only: no top-level INSERT INTO / UPDATE .. SET / DELETE FROM / TRUNCATE (ON DELETE CASCADE and
    // BEFORE INSERT OR UPDATE in DDL do not match these shapes)
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).not.toMatch(/\bBYPASSRLS\b/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
  });
});

describe.skipIf(!TEST_URL)("M5-V3-d · visitor profile schema", () => {
  let A: string;
  let C: string;
  let propA: string;
  let propA2: string;
  let propC: string;

  const mkProp = async (tenant: string, client: string, domain: string): Promise<string> => {
    const id = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
      [id, tenant, client, domain, `https://${domain}`],
    ), S);
    return id;
  };
  const mkProfile = (tenant: string, property: string, visitor = newId(), consent = newId()) =>
    withTenants([tenant], async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO search_visitor_profiles (id, tenant_id, property_id, visitor_id, consent_id, first_seen_at, last_seen_at, visits, pageviews)
         VALUES ($1,$2,$3,$4,$5, now(), now(), 1, 1) RETURNING id`,
        [newId(), tenant, property, visitor, consent]);
      return { id: r.rows[0]!.id, visitor, consent };
    }, S);
  let eventSeq = 1000;
  const mkEvent = (tenant: string, property: string, profile: string, o: { kind?: string; path?: string | null; name?: string | null; data?: unknown } = {}) =>
    withTenants([tenant], (c) => c.query(
      `INSERT INTO search_visitor_events (id, tenant_id, property_id, profile_id, collector_event_id, occurred_at, kind, path, name, data)
       VALUES ($1,$2,$3,$4,$5, now(), $6, $7, $8, $9)`,
      [newId(), tenant, property, profile, ++eventSeq, o.kind ?? "pageview", o.path === undefined ? "/a/" : o.path, o.name ?? null,
        o.data === undefined ? null : JSON.stringify(o.data)]), S);
  const tombstone = (tenant: string, property: string, kind: "visitor" | "consent", id: string, reason: "withdraw" | "erase" = "withdraw") =>
    withTenants([tenant], (c) => c.query(
      `INSERT INTO search_visitor_tombstones (tenant_id, property_id, kind, id_hash, reason) VALUES ($1,$2,$3,$4,$5)`,
      [tenant, property, kind, idHash(id), reason]), S);
  const count = async (table: string, tenant: string | null, scoped: boolean): Promise<number> => {
    const sql = `SELECT count(*)::text AS n FROM ${table}`;
    const r = tenant === null
      ? await withGlobal((c) => c.query<{ n: string }>(sql))
      : await withTenants([tenant], (c) => c.query<{ n: string }>(sql), scoped ? S : undefined);
    return Number(r.rows[0]!.n);
  };

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("M5V3D Co A", ["search"]);
    C = await createCompany("M5V3D Co C", ["search"]);
    const clientA = await createClient(A, "M5V3D Client A");
    const clientC = await createClient(C, "M5V3D Client C");
    propA = await mkProp(A, clientA, "a1.example.com");
    propA2 = await mkProp(A, clientA, "a2.example.com");
    propC = await mkProp(C, clientC, "c1.example.com");
  });
  afterAll(async () => { await teardownTestDb(); });

  it("the app role really is NOBYPASSRLS (otherwise nothing below tests anything)", async () => {
    const r = await withGlobal((c) => c.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("re-applying the file is a no-op: no error, no duplicate policy, trigger or index", async () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    await adminPool().query(sql);
    await adminPool().query(sql);
    const pol = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies WHERE tablename = ANY($1) AND policyname = 'tenant_isolation'`, [[...TABLES]]);
    expect(Number(pol.rows[0]!.n)).toBe(5);
    const trg = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_trigger WHERE tgname = 'search_visitor_profiles_tombstone_guard' AND NOT tgisinternal`);
    expect(Number(trg.rows[0]!.n)).toBe(1);
  });

  it("all five tables are ENABLE + FORCE RLS with the composed tenant + module policy (USING and WITH CHECK)", async () => {
    const rls = await adminPool().query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`, [[...TABLES]]);
    expect(rls.rows).toHaveLength(5);
    for (const r of rls.rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await adminPool().query<{ tablename: string; qual: string; with_check: string }>(
      `SELECT tablename, qual, with_check FROM pg_policies WHERE tablename = ANY($1) AND policyname = 'tenant_isolation'`, [[...TABLES]]);
    expect(pol.rows).toHaveLength(5);
    for (const p of pol.rows) {
      for (const part of [p.qual, p.with_check]) {
        expect(part, p.tablename).toContain("app_current_tenants");
        expect(part, p.tablename).toContain("app_module_allowed");
      }
    }
  });

  it("cross-tenant, unset-GUC and missing-module-scope reads return 0 rows on every table; own scope reads rows", async () => {
    const p = await mkProfile(A, propA);
    await mkEvent(A, propA, p.id);
    await tombstone(A, propA, "visitor", newId());
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_interest_rules (id, tenant_id, property_id, match, pattern, facet, tag, weight) VALUES ($1,$2,$3,'path_prefix','/services/','service','web-dev',5)`,
      [newId(), A, propA]), S);
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_visitor_ingest_state (tenant_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [A, propA]), S);
    for (const t of TABLES) {
      expect(await count(t, A, true), `${t} own scope`).toBeGreaterThan(0);
      expect(await count(t, C, true), `${t} other tenant`).toBe(0);
      expect(await count(t, null, false), `${t} unset tenant GUC`).toBe(0);
      expect(await count(t, A, false), `${t} module scope missing`).toBe(0);
    }
  });

  it("an unset tenant GUC, a missing module scope and another tenant all refuse WRITES (and an unset-GUC DELETE touches 0 rows)", async () => {
    const row = (tenant: string) => [newId(), tenant, propA, newId(), newId()];
    const sql = `INSERT INTO search_visitor_profiles (id, tenant_id, property_id, visitor_id, consent_id, first_seen_at, last_seen_at) VALUES ($1,$2,$3,$4,$5, now(), now())`;
    await expect(withGlobal((c) => c.query(sql, row(A)))).rejects.toThrow(/row-level security/);
    await expect(withTenants([A], (c) => c.query(sql, row(A)))).rejects.toThrow(/row-level security/);
    await expect(withTenants([C], (c) => c.query(sql, row(A)), S)).rejects.toThrow(/row-level security/);
    await expect(withGlobal((c) => c.query(
      `INSERT INTO search_visitor_tombstones (tenant_id, property_id, kind, id_hash, reason) VALUES ($1,$2,'visitor',$3,'erase')`, [A, propA, idHash(newId())]),
    )).rejects.toThrow(/row-level security/);
    const del = await withGlobal((c) => c.query(`DELETE FROM search_visitor_profiles`));
    expect(del.rowCount).toBe(0);
    expect(await count("search_visitor_profiles", A, true)).toBeGreaterThan(0);
  });

  it("the unique keys hold: one profile per (tenant, property, visitor); one event per (property, collector id); one rule; one tombstone", async () => {
    const p = await mkProfile(A, propA);
    await expect(mkProfile(A, propA, p.visitor)).rejects.toThrow(/duplicate key/);
    await mkProfile(A, propA2, p.visitor); // the same visitor id on ANOTHER property is a different profile
    await mkEvent(A, propA, p.id);
    const dup = eventSeq;
    await expect(withTenants([A], (c) => c.query(
      `INSERT INTO search_visitor_events (id, tenant_id, property_id, profile_id, collector_event_id, occurred_at, kind, path) VALUES ($1,$2,$3,$4,$5, now(),'pageview','/b/')`,
      [newId(), A, propA, p.id, dup]), S)).rejects.toThrow(/duplicate key/);
    const rule = (w: number) => withTenants([A], (c) => c.query(
      `INSERT INTO search_interest_rules (id, tenant_id, property_id, match, pattern, facet, tag, weight) VALUES ($1,$2,$3,'section_prefix','pricing.','service','pricing',$4)`,
      [newId(), A, propA, w]), S);
    await rule(3);
    await expect(rule(4)).rejects.toThrow(/duplicate key/);
    const t = newId();
    await tombstone(A, propA, "visitor", t);
    await expect(tombstone(A, propA, "visitor", t, "erase")).rejects.toThrow(/duplicate key/);
  });

  it("CHECKs: path only, data allow-list and size, kind-dependent NOT NULL, a profile's ranges and enums, rule tag and weight", async () => {
    const p = await mkProfile(A, propA);
    await expect(mkEvent(A, propA, p.id, { path: "/a?utm=x" })).rejects.toThrow(/check/);
    await expect(mkEvent(A, propA, p.id, { path: "/a#frag" })).rejects.toThrow(/check/);
    await expect(mkEvent(A, propA, p.id, { path: "https://x.test/a" })).rejects.toThrow(/check/);
    await expect(mkEvent(A, propA, p.id, { kind: "pageview", path: null })).rejects.toThrow(/check/);
    await expect(mkEvent(A, propA, p.id, { kind: "event", path: "/a/", name: null })).rejects.toThrow(/check/);
    await expect(mkEvent(A, propA, p.id, { kind: "event", name: "cta_click", data: { email: "x@y.test" } })).rejects.toThrow(/check/);
    await expect(mkEvent(A, propA, p.id, { kind: "event", name: "cta_click", data: { section_id: "x".repeat(1500) } })).rejects.toThrow(/check/);
    await mkEvent(A, propA, p.id, { kind: "event", name: "cta_click", data: { section_id: "home.hero", step_index: 2 } });
    const upd = (set: string) => withTenants([A], (c) => c.query(`UPDATE search_visitor_profiles SET ${set} WHERE id = '${p.id}'`), S);
    await expect(upd(`device = 'tv'`)).rejects.toThrow(/check/);
    await expect(upd(`country = 'id'`)).rejects.toThrow(/check/);
    await expect(upd(`score = 101`)).rejects.toThrow(/check/);
    await expect(upd(`last_seen_at = first_seen_at - interval '1 day'`)).rejects.toThrow(/check/);
    await expect(upd(`interests = '[]'::jsonb`)).rejects.toThrow(/check/);
    await upd(`country = NULL, city = NULL, first_source = NULL, network = NULL, company = NULL`); // nullable on purpose
    await upd(`country = 'ID', city = 'Jakarta', network = '{"asn":64500,"name":"ExampleNet"}'::jsonb, score = 40`);
    const rule = (tag: string, weight: number) => withTenants([A], (c) => c.query(
      `INSERT INTO search_interest_rules (id, tenant_id, property_id, match, pattern, facet, tag, weight) VALUES ($1,$2,$3,'path_prefix','/zz/','industry',$4,$5)`,
      [newId(), A, propA, tag, weight]), S);
    await expect(rule("Bad Tag", 5)).rejects.toThrow(/check/);
    await expect(rule("ok-tag", 11)).rejects.toThrow(/check/);
    await expect(rule("ok-tag", 0)).rejects.toThrow(/check/);
  });

  it("an event cannot point at a profile of another tenant or property (composite FK)", async () => {
    const p = await mkProfile(A, propA);
    await expect(withTenants([C], (c) => c.query(
      `INSERT INTO search_visitor_events (id, tenant_id, property_id, profile_id, collector_event_id, occurred_at, kind, path) VALUES ($1,$2,$3,$4,$5, now(),'pageview','/z/')`,
      [newId(), C, propC, p.id, ++eventSeq]), S)).rejects.toThrow(/foreign key/);
    await expect(withTenants([A], (c) => c.query(
      `INSERT INTO search_visitor_events (id, tenant_id, property_id, profile_id, collector_event_id, occurred_at, kind, path) VALUES ($1,$2,$3,$4,$5, now(),'pageview','/z/')`,
      [newId(), A, propA2, p.id, ++eventSeq]), S)).rejects.toThrow(/foreign key/);
  });

  it("deleting a profile cascades its events (and only its events)", async () => {
    const p = await mkProfile(A, propA);
    const other = await mkProfile(A, propA);
    await mkEvent(A, propA, p.id);
    await mkEvent(A, propA, p.id, { kind: "event", name: "cta_click" });
    await mkEvent(A, propA, other.id);
    const ev = (id: string) => withTenants([A], async (c) =>
      Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM search_visitor_events WHERE profile_id = $1`, [id])).rows[0]!.n), S);
    expect(await ev(p.id)).toBe(2);
    await withTenants([A], (c) => c.query(`DELETE FROM search_visitor_profiles WHERE id = $1`, [p.id]), S);
    expect(await ev(p.id)).toBe(0);
    expect(await ev(other.id)).toBe(1);
  });

  it("a tombstoned visitor id, or a tombstoned consent id, cannot get a profile; other ids and other properties still can", async () => {
    const v = newId();
    const k = newId();
    await tombstone(A, propA, "visitor", v, "withdraw");
    await expect(mkProfile(A, propA, v, newId())).rejects.toThrow(/tombstoned/);
    await tombstone(A, propA, "consent", k, "erase");
    await expect(mkProfile(A, propA, newId(), k)).rejects.toThrow(/tombstoned/);
    await mkProfile(A, propA, newId(), newId()); // an unrelated visitor
    await mkProfile(A, propA2, v, newId());      // the tombstone is per property
    // moving an existing profile onto a tombstoned id is refused as well
    const p = await mkProfile(A, propA);
    await expect(withTenants([A], (c) => c.query(`UPDATE search_visitor_profiles SET consent_id = $2 WHERE id = $1`, [p.id, k]), S)).rejects.toThrow(/tombstoned/);
    // another tenant's tombstones are invisible, so they cannot block (and cannot be probed): C reads none
    expect(await count("search_visitor_tombstones", C, true)).toBe(0);
  });

  it("tombstones keep a hash only: 32 bytes, no readable id, and nothing but the hash identifies the person", async () => {
    await expect(withTenants([A], (c) => c.query(
      `INSERT INTO search_visitor_tombstones (tenant_id, property_id, kind, id_hash, reason) VALUES ($1,$2,'visitor',$3,'erase')`,
      [A, propA, Buffer.from("not-32-bytes")]), S)).rejects.toThrow(/check/);
    const cols = await adminPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'search_visitor_tombstones' ORDER BY 1`);
    expect(cols.rows.map((r) => r.column_name)).toEqual(["created_at", "id_hash", "kind", "property_id", "reason", "tenant_id"]);
  });

  it("no column named like an IP address or a user agent exists on any new table", async () => {
    const r = await adminPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name = ANY($1)
          AND column_name ~* '(^|_)(ip|ips|ua|user_?agent|ip_?addr(ess)?|remote_?addr|forwarded.*)($|_)'`, [[...TABLES]]);
    expect(r.rows).toEqual([]);
    const all = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name = ANY($1)`, [[...TABLES]]);
    expect(Number(all.rows[0]!.n)).toBeGreaterThan(30); // the scan looked at something
  });

  it("the profile table has the columns the score and interests need (§4.6) and the indexes the reads need (§4.5)", async () => {
    const cols = await adminPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'search_visitor_profiles'`);
    const have = new Set(cols.rows.map((c) => c.column_name));
    for (const c of ["visitor_id", "consent_id", "first_seen_at", "last_seen_at", "visits", "pageviews", "device", "country", "city",
      "first_source", "network", "company", "interests", "score", "score_parts"]) expect(have.has(c), c).toBe(true);
    const idx = await adminPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = ANY($1)`, [[...TABLES]]);
    const names = new Set(idx.rows.map((i) => i.indexname));
    for (const i of ["ix_visitor_consent", "ix_visitor_recent", "ix_visitor_score", "ix_visitor_events_profile", "ix_visitor_tombstones_age", "ix_interest_rules_property"]) {
      expect(names.has(i), i).toBe(true);
    }
  });

  it("the agency_leads link index exists and is partial", async () => {
    const r = await adminPool().query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_lead_consent_id' AND tablename = 'agency_leads'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.indexdef).toMatch(/visitor_consent/);
    expect(r.rows[0]!.indexdef).toMatch(/consentId/);
    expect(r.rows[0]!.indexdef).toMatch(/WHERE/);
  });
});

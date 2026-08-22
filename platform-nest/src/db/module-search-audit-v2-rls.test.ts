// SM-76 — search audit v2 schema (202608221727_search_audit_v2_finding_states_checks_facts.sql):
// RLS for the 3 new tables (search_finding_states, search_audit_checks, search_property_facts) +
// the search_audits/search_audit_findings widenings. Same idiom as db/module-search-rls.test.ts
// (SM-01) — verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), RLS actually
// exercised, not read off the policy text.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createClient } from "../testing/fixtures";
import type { PoolClient } from "pg";

const NEW_TABLES = ["search_finding_states", "search_audit_checks", "search_property_facts"];

async function withSearch<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, fn, { modules: ["search"] });
}

describe.skipIf(!TEST_URL)("search audit v2 schema RLS + constraints (SM-76)", () => {
  let B: string; // served company — owns its data
  let C: string; // second served / unrelated company — cross-tenant probe
  let clientB: string;
  let propertyB: string;
  let auditB: string; // a completed search_audits row (kind widened to 'security', source 'psi')

  beforeAll(async () => {
    await initTestDb();
    B = await createCompany("Served B (SM-76)");
    C = await createCompany("Served C (SM-76)");
    clientB = await createClient(B, "Client of B");

    propertyB = newId();
    await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url)
         VALUES ($1,$2,$3,'sm76.example.com','https://sm76.example.com')`,
        [propertyB, B, clientB],
      ),
    );

    auditB = newId();
    await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_audits (id, tenant_id, property_id, kind, source, status, group_id)
         VALUES ($1,$2,$3,'security','psi','completed',$4)`,
        [auditB, B, propertyB, newId()],
      ),
    );
  });
  afterAll(teardownTestDb);

  // ── FORCE-RLS sweep for exactly the 3 new tables ──────────────────────────────────────────────
  it("all 3 new tables FORCE RLS with exactly one FOR-ALL tenant_isolation policy", async () => {
    const { rows: rls } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class WHERE relkind='r' AND relname = ANY($1::text[])`,
        [NEW_TABLES],
      ),
    );
    expect(rls.length).toBe(3);
    for (const r of rls) expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);

    const { rows: pol } = await withGlobal((c) =>
      c.query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename = ANY($1::text[]) ORDER BY tablename`,
        [NEW_TABLES],
      ),
    );
    expect(pol.length).toBe(3);
    for (const p of pol) {
      expect(p.policyname, p.tablename).toBe("tenant_isolation");
      expect(p.cmd, p.tablename).toBe("ALL");
    }
  });

  // ── (a) right-tenant + module scope → rows visible, for all 3 tables ──────────────────────────
  it("search_finding_states: visible under withSearch([B]) once seeded", async () => {
    const stateId = newId();
    await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_finding_states
           (id, tenant_id, client_id, property_id, check_key, severity, first_seen_audit_id, last_seen_audit_id, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,'security.hsts','medium',$5,$5, now(), now())`,
        [stateId, B, clientB, propertyB, auditB],
      ),
    );
    const res = await withSearch([B], (c) => c.query(`SELECT tenant_id FROM search_finding_states WHERE id=$1`, [stateId]));
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].tenant_id).toBe(B);

    // cross-tenant → zero rows, even WITH the search scope declared
    const fromC = await withSearch([C], (c) => c.query(`SELECT id FROM search_finding_states WHERE id=$1`, [stateId]));
    expect(fromC.rows.length).toBe(0);

    // right tenant but NO module scope declared → zero rows (the third wall)
    const noScope = await withTenants([B], (c) => c.query(`SELECT id FROM search_finding_states WHERE id=$1`, [stateId]));
    expect(noScope.rows.length).toBe(0);
  });

  it("search_audit_checks: visible under withSearch([B]); UNIQUE(audit_id, check_key) + outcome/source CHECKs enforced", async () => {
    const checkId = newId();
    await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_audit_checks (id, tenant_id, client_id, audit_id, check_key, outcome, source)
         VALUES ($1,$2,$3,$4,'security.hsts','failed','crawler')`,
        [checkId, B, clientB, auditB],
      ),
    );
    const res = await withSearch([B], (c) => c.query(`SELECT tenant_id FROM search_audit_checks WHERE id=$1`, [checkId]));
    expect(res.rows.length).toBe(1);

    const fromC = await withSearch([C], (c) => c.query(`SELECT id FROM search_audit_checks WHERE id=$1`, [checkId]));
    expect(fromC.rows.length).toBe(0);
    const noScope = await withTenants([B], (c) => c.query(`SELECT id FROM search_audit_checks WHERE id=$1`, [checkId]));
    expect(noScope.rows.length).toBe(0);

    // UNIQUE(audit_id, check_key) — a second row for the SAME audit+check is refused.
    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_audit_checks (id, tenant_id, client_id, audit_id, check_key, outcome, source)
           VALUES ($1,$2,$3,$4,'security.hsts','passed','crawler')`,
          [newId(), B, clientB, auditB],
        ),
      ),
    ).rejects.toThrow(/search_audit_checks_audit_id_check_key_key|duplicate key/);

    // outcome CHECK — the 5 outcomes are the only legal ones.
    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_audit_checks (id, tenant_id, client_id, audit_id, check_key, outcome, source)
           VALUES ($1,$2,$3,$4,'security.other','bogus','crawler')`,
          [newId(), B, clientB, auditB],
        ),
      ),
    ).rejects.toThrow(/search_audit_checks_outcome_check|check constraint/);

    // source CHECK — the refinement over the design's bare comment (see the migration header).
    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_audit_checks (id, tenant_id, client_id, audit_id, check_key, outcome, source)
           VALUES ($1,$2,$3,$4,'security.other','passed','some-vendor-nobody-approved')`,
          [newId(), B, clientB, auditB],
        ),
      ),
    ).rejects.toThrow(/search_audit_checks_source_check|check constraint/);
  });

  it("search_property_facts: visible under withSearch([B]); the partial-unique 'current fact' index holds", async () => {
    const factId = newId();
    await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_property_facts (id, tenant_id, client_id, property_id, key, value, source)
         VALUES ($1,$2,$3,$4,'cms','"wordpress"','detected')`,
        [factId, B, clientB, propertyB],
      ),
    );
    const res = await withSearch([B], (c) => c.query(`SELECT tenant_id FROM search_property_facts WHERE id=$1`, [factId]));
    expect(res.rows.length).toBe(1);

    const fromC = await withSearch([C], (c) => c.query(`SELECT id FROM search_property_facts WHERE id=$1`, [factId]));
    expect(fromC.rows.length).toBe(0);
    const noScope = await withTenants([B], (c) => c.query(`SELECT id FROM search_property_facts WHERE id=$1`, [factId]));
    expect(noScope.rows.length).toBe(0);

    // TWO CURRENT (superseded_at IS NULL) rows for the SAME (tenant, property, key) is impossible —
    // the partial unique index (ux_search_property_facts_current) is the design's own honesty
    // mechanism (§2.3): "the current value is the row with superseded_at IS NULL".
    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_property_facts (id, tenant_id, client_id, property_id, key, value, source)
           VALUES ($1,$2,$3,$4,'cms','"drupal"','detected')`,
          [newId(), B, clientB, propertyB],
        ),
      ),
    ).rejects.toThrow(/ux_search_property_facts_current|duplicate key/);

    // Superseding the first row (a real chain-supersede) makes a NEW current row legal —
    // proving the partial index only blocks two SIMULTANEOUSLY-current rows, not history.
    await withSearch([B], (c) => c.query(`UPDATE search_property_facts SET superseded_at = now() WHERE id=$1`, [factId]));
    const secondId = newId();
    await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_property_facts (id, tenant_id, client_id, property_id, key, value, source)
         VALUES ($1,$2,$3,$4,'cms','"drupal"','detected')`,
        [secondId, B, clientB, propertyB],
      ),
    );
    const cur = await withSearch([B], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM search_property_facts WHERE tenant_id=$1 AND property_id=$2 AND key='cms' AND superseded_at IS NULL`,
        [B, propertyB],
      ),
    );
    expect(cur.rows.length).toBe(1);
    expect(cur.rows[0].id).toBe(secondId);
  });

  // ── empty tenant set → zero rows, never an error, on all 3 new tables ─────────────────────────
  it("empty tenant set → zero rows on every new table, no error (even with search scope)", async () => {
    for (const t of NEW_TABLES) {
      const res = await withSearch([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withSearch([]) must be empty, not error`).toBe(0);
    }
  });

  // ── WITH CHECK blocks a smuggled cross-tenant write ────────────────────────────────────────────
  it("WITH CHECK blocks INSERT into a tenant outside the authorized set (search_finding_states)", async () => {
    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_finding_states
             (id, tenant_id, client_id, property_id, check_key, severity, first_seen_audit_id, last_seen_audit_id, first_seen_at, last_seen_at)
           VALUES ($1,$2,$3,$4,'security.hsts','medium',$5,$5, now(), now())`,
          [newId(), C, clientB, propertyB, auditB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── search_audits constraint surgery: group_id + widened kind/source ──────────────────────────
  it("search_audits accepts kind='security' + source='psi' (constraint surgery) and still rejects bogus values", async () => {
    const res = await withSearch([B], (c) => c.query(`SELECT kind, source, group_id FROM search_audits WHERE id=$1`, [auditB]));
    expect(res.rows[0].kind).toBe("security");
    expect(res.rows[0].source).toBe("psi");
    expect(res.rows[0].group_id).toBeTruthy();

    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_audits (id, tenant_id, property_id, kind, source, status)
           VALUES ($1,$2,$3,'not-a-real-kind','psi','completed')`,
          [newId(), B, propertyB],
        ),
      ),
    ).rejects.toThrow(/search_audits_kind_check|check constraint/);

    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_audits (id, tenant_id, property_id, kind, source, status)
           VALUES ($1,$2,$3,'security','not-a-real-source','completed')`,
          [newId(), B, propertyB],
        ),
      ),
    ).rejects.toThrow(/search_audits_source_check|check constraint/);

    // The pre-existing (0034/202608201518) legal values remain legal — additive-only proof.
    for (const kind of ["technical", "cwv", "content", "links", "geo"]) {
      const r = await withSearch([B], (c) =>
        c.query(`INSERT INTO search_audits (id, tenant_id, property_id, kind, source, status) VALUES ($1,$2,$3,$4,'crawler','queued') RETURNING id`, [
          newId(),
          B,
          propertyB,
          kind,
        ]),
      );
      expect(r.rows.length, kind).toBe(1);
    }
    for (const source of ["seonaut", "crawler", "unlighthouse", "ai", "nexus-import"]) {
      const r = await withSearch([B], (c) =>
        c.query(`INSERT INTO search_audits (id, tenant_id, property_id, kind, source, status) VALUES ($1,$2,$3,'technical',$4,'queued') RETURNING id`, [
          newId(),
          B,
          propertyB,
          source,
        ]),
      );
      expect(r.rows.length, source).toBe(1);
    }
  });

  // ── search_audit_findings.state_id links to search_finding_states, FK-enforced ────────────────
  it("search_audit_findings.state_id links to a real search_finding_states row and rejects a bogus one", async () => {
    const stateId = newId();
    await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_finding_states
           (id, tenant_id, client_id, property_id, check_key, severity, first_seen_audit_id, last_seen_audit_id, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,'security.wp_debug_exposed','high',$5,$5, now(), now())`,
        [stateId, B, clientB, propertyB, auditB],
      ),
    );
    const findingId = newId();
    const ok = await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_audit_findings (id, tenant_id, audit_id, code, message, state_id)
         VALUES ($1,$2,$3,'wp_debug_exposed','debug output reachable',$4) RETURNING state_id`,
        [findingId, B, auditB, stateId],
      ),
    );
    expect(ok.rows[0].state_id).toBe(stateId);

    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_audit_findings (id, tenant_id, audit_id, code, message, state_id)
           VALUES ($1,$2,$3,'wp_debug_exposed','debug output reachable',$4)`,
          [newId(), B, auditB, newId()],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });
});

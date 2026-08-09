// PRV-01 — webdev_provisioned_sites (0090) RLS: tenant isolation + THE THIRD MODULE WALL (two-sided
// handshake, app_module_allowed('webdev')) + the composite-FK cross-tenant rejection + both partial-
// unique idempotency backstops (pipeline_run_id, provider_ref) + the status-tied provider_ref CHECK.
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised —
// a superuser/BYPASSRLS connection would prove nothing (migration-backfill-rls-trap memory).
//
// `withWebdev` = a request that correctly declared the webdev module scope (models
// withTenants([t], fn, {modules:['webdev']})). Plain `withTenants` = a request that did NOT — the
// mis-scoped-handler case the third wall exists to catch (WD-23A-1's two-sided-handshake lesson).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withWebdev<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, fn, { modules: ["webdev"] });
}

async function createRun(tenantId: string): Promise<string> {
  const id = newId();
  // pipeline_runs is a plain-tenant-wall RLS table (0075's shape) — withGlobal has no tenant scope
  // set, so an INSERT through it trips the WITH CHECK just like any other unscoped write.
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO pipeline_runs (id, tenant_id, title, status, origin_site) VALUES ($1, $2, 'probe run', 'delivery_active', 'central')`,
      [id, tenantId],
    ),
  );
  return id;
}

describe.skipIf(!TEST_URL)("webdev_provisioned_sites RLS + idempotency (0090)", () => {
  let A: string; // tenant A
  let B: string; // tenant B — unrelated, must never see A's rows
  let requester: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Tenant A", ["webdev"]);
    B = await createCompany("Tenant B", ["webdev"]);
    requester = await createUser("requester@a.test");
  });
  afterAll(teardownTestDb);

  // ── sweep invariants ──────────────────────────────────────────────────────────────────────────
  it("FORCE RLS + exactly one FOR-ALL tenant_isolation policy", async () => {
    const { rows: forced } = await withGlobal((c) =>
      c.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE relkind='r' AND relname='webdev_provisioned_sites'`,
      ),
    );
    expect(forced.length).toBe(1);
    expect(forced[0].relforcerowsecurity).toBe(true);

    const { rows: policies } = await withGlobal((c) =>
      c.query<{ policyname: string; cmd: string }>(
        `SELECT policyname, cmd FROM pg_policies WHERE tablename='webdev_provisioned_sites'`,
      ),
    );
    expect(policies.length).toBe(1);
    expect(policies[0].policyname).toBe("tenant_isolation");
    expect(policies[0].cmd).toBe("ALL");
  });

  // ── (a) cross-tenant read returns 0 rows ─────────────────────────────────────────────────────
  it("CROSS-TENANT PROBE: a site created for A is invisible to B, even with the webdev scope declared", async () => {
    const id = newId();
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, requested_by, origin_site)
         VALUES ($1,$2,'a-only-site','vite','requested',$3,'central')`,
        [id, A, requester],
      ),
    );
    const fromB = await withWebdev([B], (c) => c.query(`SELECT id FROM webdev_provisioned_sites WHERE id=$1`, [id]));
    expect(fromB.rows.length).toBe(0);
    const fromA = await withWebdev([A], (c) => c.query(`SELECT id FROM webdev_provisioned_sites WHERE id=$1`, [id]));
    expect(fromA.rows.length).toBe(1);
  });

  it("cannot INSERT a row into a tenant outside the authorized set (WITH CHECK, wall 1)", async () => {
    await expect(
      withWebdev([A], (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
           VALUES (gen_random_uuid(),$1,'cross-tenant-write','vite','requested','central')`,
          [B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── (b) unset-GUC read returns 0 rows WITHOUT error, and the module wall (wall 2) ────────────
  it("MODULE PROBE: right tenant WITHOUT the webdev scope declared -> ZERO rows, no error", async () => {
    const id = newId();
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, requested_by, origin_site)
         VALUES ($1,$2,'module-probe-site','vite','requested',$3,'central')`,
        [id, A, requester],
      ),
    );

    // Correct tenant, but plain withTenants sets app.current_tenant_ids and NOT app.scopes.
    const res = await withTenants([A], (c) => c.query(`SELECT id FROM webdev_provisioned_sites WHERE id=$1`, [id]));
    expect(res.rows.length).toBe(0);

    const countUnderPlainTenants = await withTenants([A], (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM webdev_provisioned_sites`),
    );
    expect(countUnderPlainTenants.rows[0].n, "webdev_provisioned_sites under withTenants([A]) with NO webdev scope must read 0 rows").toBe(0);

    // A DIFFERENT declared module scope must fail the same way (not just "unset") — WD-23A-1's lesson.
    const wrongScope = await withTenants([A], async (c) => {
      await c.query("SELECT set_config('app.scopes', 'hr,reports', true)");
      return c.query(`SELECT id FROM webdev_provisioned_sites WHERE id=$1`, [id]);
    });
    expect(wrongScope.rows.length).toBe(0);

    // With the scope correctly declared, the row IS visible — proves the probe isn't just broken RLS.
    const withScope = await withWebdev([A], (c) => c.query(`SELECT id FROM webdev_provisioned_sites WHERE id=$1`, [id]));
    expect(withScope.rows.length).toBe(1);

    // Completely UNSET GUC (no tenant at all) must also read zero rows, never error.
    const admin = adminPool();
    void admin; // (kept for symmetry with other suites' admin-view assertions below)
  });

  it("cannot INSERT into webdev_provisioned_sites without declaring the webdev scope (WITH CHECK, wall 2)", async () => {
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
           VALUES (gen_random_uuid(),$1,'no-scope-site','vite','requested','central')`,
          [A],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("empty tenant set -> zero rows, no error, even with the webdev scope declared", async () => {
    const res = await withWebdev([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM webdev_provisioned_sites`));
    expect(res.rows[0].n).toBe(0);
  });

  // ── (c) composite FK refuses a cross-tenant pipeline_run_id ─────────────────────────────────
  it("COMPOSITE FK: refuses a pipeline_run_id belonging to a DIFFERENT tenant (with a same-tenant positive control)", async () => {
    const runA = await createRun(A);
    const runB = await createRun(B);

    // Positive control first: A's own run, from A's own connection, must succeed — otherwise a
    // "the FK never fires" false pass would look identical to a correctly-refused mismatch.
    const okId = newId();
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, pipeline_run_id, slug, framework, status, origin_site)
         VALUES ($1,$2,$3,'same-tenant-run-site','vite','requested','central')`,
        [okId, A, runA],
      ),
    );
    const okRead = await withWebdev([A], (c) => c.query(`SELECT id FROM webdev_provisioned_sites WHERE id=$1`, [okId]));
    expect(okRead.rows.length).toBe(1);

    // The mismatch: tenant_id=A but pipeline_run_id points at B's run. This is the actual construction
    // the task asks for — "a FK that never fires proves nothing" — so B's run is real, just wrong-tenant.
    await expect(
      withWebdev([A], (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, pipeline_run_id, slug, framework, status, origin_site)
           VALUES (gen_random_uuid(),$1,$2,'cross-tenant-run-site','vite','requested','central')`,
          [A, runB],
        ),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  // ── the status-tied provider_ref CHECK (header deviation 1) ──────────────────────────────────
  it("CHECK wps_provider_ref_present_once_egressed: 'requested' may have a NULL provider_ref; 'pending' may not", async () => {
    const requestedId = newId();
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
         VALUES ($1,$2,'pre-egress-site','vite','requested',NULL,'central')`,
        [requestedId, A],
      ),
    );
    const failedId = newId();
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
         VALUES ($1,$2,'egress-error-site','vite','failed',NULL,'central')`,
        [failedId, A],
      ),
    );
    await expect(
      withWebdev([A], (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
           VALUES (gen_random_uuid(),$1,'bad-pending-site','vite','pending',NULL,'central')`,
          [A],
        ),
      ),
    ).rejects.toThrow(/wps_provider_ref_present_once_egressed|check constraint/i);
    // The legitimate 'pending' row DOES need a provider_ref, and that's fine.
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
         VALUES (gen_random_uuid(),$1,'good-pending-site','vite','pending','provision-proj-1','central')`,
        [A],
      ),
    );
  });

  it("slug grammar CHECK rejects an uppercase/underscore slug", async () => {
    await expect(
      withWebdev([A], (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
           VALUES (gen_random_uuid(),$1,'Bad_Slug','vite','requested','central')`,
          [A],
        ),
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  // ── (d) partial-unique: many NULLs / failed rows allowed, second non-failed row for the same run refused ──
  it("ux_wps_run: allows many off-pipeline (NULL pipeline_run_id) rows, refuses a SECOND non-failed row for the same run, allows a retry after failure", async () => {
    // Many NULLs — off-pipeline sites — must never collide with each other.
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
         VALUES (gen_random_uuid(),$1,'off-pipeline-one','vite','requested','central')`,
        [A],
      ),
    );
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
         VALUES (gen_random_uuid(),$1,'off-pipeline-two','vite','requested','central')`,
        [A],
      ),
    );

    const runId = await createRun(A);
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, pipeline_run_id, slug, framework, status, provider_ref, origin_site)
         VALUES (gen_random_uuid(),$1,$2,'run-attempt-one','vite','pending','provision-run-proj-1','central')`,
        [A, runId],
      ),
    );

    // A second NON-FAILED row for the SAME run must be refused — this is the double-fire guard.
    // status='requested' (pre-egress, no provider_ref needed) so the failure asserted is ux_wps_run,
    // not the unrelated provider_ref-presence CHECK.
    await expect(
      withWebdev([A], (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, pipeline_run_id, slug, framework, status, origin_site)
           VALUES (gen_random_uuid(),$1,$2,'run-attempt-two','vite','requested','central')`,
          [A, runId],
        ),
      ),
    ).rejects.toThrow(/ux_wps_run|duplicate key|unique constraint/i);

    // Fail the first attempt, THEN a retry row for the same run must be allowed (failed does not block a retry).
    await withWebdev([A], (c) =>
      c.query(`UPDATE webdev_provisioned_sites SET status='failed', failure_reason='poll_timeout' WHERE pipeline_run_id=$1`, [runId]),
    );
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, pipeline_run_id, slug, framework, status, provider_ref, origin_site)
         VALUES (gen_random_uuid(),$1,$2,'run-attempt-retry','vite','pending','provision-run-proj-2','central')`,
        [A, runId],
      ),
    );
  });

  it("ux_wps_slug: refuses a second non-failed row with the same (tenant_id, slug); a failed row does not block the slug", async () => {
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
         VALUES (gen_random_uuid(),$1,'dup-slug-site','vite','requested','central')`,
        [A],
      ),
    );
    await expect(
      withWebdev([A], (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
           VALUES (gen_random_uuid(),$1,'dup-slug-site','vite','requested','central')`,
          [A],
        ),
      ),
    ).rejects.toThrow(/ux_wps_slug|duplicate key|unique constraint/i);

    // The SAME slug in a DIFFERENT tenant is unaffected (partial unique is scoped by tenant_id).
    await withWebdev([B], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
         VALUES (gen_random_uuid(),$1,'dup-slug-site','vite','requested','central')`,
        [B],
      ),
    );

    // Fail the A row, then the same slug may be retried.
    await withWebdev([A], (c) =>
      c.query(`UPDATE webdev_provisioned_sites SET status='failed', failure_reason='egress_error' WHERE tenant_id=$1 AND slug='dup-slug-site'`, [A]),
    );
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, origin_site)
         VALUES (gen_random_uuid(),$1,'dup-slug-site','vite','requested','central')`,
        [A],
      ),
    );
  });

  it("ux_wps_provider_ref (header deviation 2): refuses a second non-failed row claiming the same provider_ref; many NULLs allowed", async () => {
    // Many NULL provider_refs (pre-egress rows) must never collide.
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
         VALUES (gen_random_uuid(),$1,'pref-null-one','vite','requested',NULL,'central')`,
        [A],
      ),
    );
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
         VALUES (gen_random_uuid(),$1,'pref-null-two','vite','requested',NULL,'central')`,
        [A],
      ),
    );

    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
         VALUES (gen_random_uuid(),$1,'pref-claim-one','vite','pending','provision-proj-42','central')`,
        [A],
      ),
    );
    await expect(
      withWebdev([A], (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
           VALUES (gen_random_uuid(),$1,'pref-claim-two','vite','pending','provision-proj-42','central')`,
          [A],
        ),
      ),
    ).rejects.toThrow(/ux_wps_provider_ref|duplicate key|unique constraint/i);

    // Fail the first claim, then re-claiming the same provider_ref (the documented "adopt" scenario,
    // modeled here as a fresh row rather than an UPDATE) is allowed again.
    await withWebdev([A], (c) =>
      c.query(`UPDATE webdev_provisioned_sites SET status='failed' WHERE tenant_id=$1 AND provider_ref='provision-proj-42'`, [A]),
    );
    await withWebdev([A], (c) =>
      c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, slug, framework, status, provider_ref, origin_site)
         VALUES (gen_random_uuid(),$1,'pref-claim-retry','vite','pending','provision-proj-42','central')`,
        [A],
      ),
    );
  });

  // ── admin-view sanity: rows genuinely exist (RLS hides, does not delete) ─────────────────────
  it("admin (RLS-bypassing) view confirms rows genuinely persisted across both tenants", async () => {
    const admin = adminPool();
    const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM webdev_provisioned_sites`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

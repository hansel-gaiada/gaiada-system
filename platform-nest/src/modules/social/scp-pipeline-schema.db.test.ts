// SCP-1b — the content pipeline's data (202610261500_social_pipeline.sql, BFF §63.1 file 1) against LIVE Postgres.
// Needs DATABASE_URL_TEST (platform-nest/CLAUDE.md). Skipped without it: NOT run on the dev laptop, runs on the Linux
// CI gate. initTestDb() hands us a fully migrated database and repoints the app at a NOSUPERUSER NOBYPASSRLS role, so
// every withTenants() call below is subject to FORCE RLS; adminPool() (superuser) only re-applies the file and reads
// what is really stored.
//
// Proves (§63.21 "the migration suite"): every CHECK refuses its bad combination and admits its good one, NULL cases
// included; the value lists match the fixture (statuses, blockable statuses, the six change cases, the ten must-haves);
// the third wall on the four new tables (unset GUC, wrong tenant and missing module scope all read zero rows, without
// an error); the plain wall on social_post_client_reviews is unchanged; social_post_copy_edits refuses UPDATE and
// DELETE; the unique keys; and that rows written by today's insert paths read pipeline_status NULL and the new
// defaults, and that re-applying the file changes no existing row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient, createUser, createProject } from "../../testing/fixtures";
import { config } from "../../config";
import { socialModule } from "./index";
import fixture from "./scp-stage-machine.json";

const MIGRATION = "202610261500_social_pipeline.sql";
const MIGRATION_PATH = join(__dirname, "..", "..", "..", "migrations", MIGRATION);
const S = { modules: ["social"] };
const NEW_TABLES = ["social_settings", "social_cycles", "social_post_designs", "social_post_copy_edits"] as const;

type Row = Record<string, unknown>;
const J = (v: unknown): string => JSON.stringify(v);
const site = () => config.originSite;
const now = () => new Date().toISOString();

const STATUSES: string[] = fixture.statuses;
const BLOCKABLE: string[] = fixture.blockableStatuses;
const CHANGE_CASES = fixture.changeCases.map((c) => ({ by: c.changeBy, kind: c.changeKind, ret: c.returnTo }));
const MUST_HAVES: string[] = (() => {
  const rule = fixture.handoffChecks.find((h) => h.code === "must_haves_unticked")!.rule;
  return rule.slice(rule.indexOf(":") + 1).split(",").map((s) => s.trim()).filter(Boolean);
})();

describe("SCP-1b · the migration file (no database needed)", () => {
  it("is registered in the social module, holds no data changes and widens nothing", () => {
    expect(socialModule.migrations).toContain(MIGRATION);
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).not.toMatch(/\bBYPASSRLS\b/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(code).not.toMatch(/\r/);
  });

  it("the fixture lists the CHECKs are written against are the ones this suite expects", () => {
    expect(STATUSES).toHaveLength(12);
    expect(BLOCKABLE).toEqual(["planned", "drafting", "proofread", "hod", "design", "final", "changes"]);
    expect(CHANGE_CASES).toHaveLength(6);
    expect(MUST_HAVES).toHaveLength(10);
  });
});

describe.skipIf(!TEST_URL)("SCP-1b · the pipeline schema", () => {
  let A: string;
  let B: string;
  let u1: string;
  let u2: string;
  let clientA: string;
  let clientB: string;
  let engA: string;
  let engB: string;
  let engCyc: string;
  let cycA: string;
  let cycB: string;
  let wrA: string;
  let wrA2: string;
  let assetA: string;
  let accountA: string;
  let monthSeq = 0;

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────────
  const insert = (table: string, row: Row, tenant: string, opts: { scoped?: boolean } = {}) =>
    withTenants([tenant], async (c) => {
      const cols = Object.keys(row);
      const r = await c.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        cols.map((k) => row[k]),
      );
      return r.rows[0] as Row;
    }, opts.scoped === false ? undefined : S);
  const update = (table: string, id: string, set: Row, tenant: string, opts: { scoped?: boolean; key?: string } = {}) =>
    withTenants([tenant], async (c) => {
      const cols = Object.keys(set);
      const r = await c.query(
        `UPDATE ${table} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE ${opts.key ?? "id"} = $1 RETURNING *`,
        [id, ...cols.map((k) => set[k])],
      );
      return r;
    }, opts.scoped === false ? undefined : S);
  const refuses = async (p: Promise<unknown>, constraint: string) => {
    await expect(p).rejects.toThrow(new RegExp(`violates check constraint "${constraint}"`));
  };
  // `ofTenant` counts only that tenant's rows (B has rows of its own, which B may of course read).
  const count = async (table: string, tenant: string | null, scoped: boolean, ofTenant?: string): Promise<number> => {
    const sql = `SELECT count(*)::text AS n FROM ${table}${ofTenant ? " WHERE tenant_id = $1" : ""}`;
    const args = ofTenant ? [ofTenant] : [];
    const r = tenant === null
      ? await withGlobal((c) => c.query<{ n: string }>(sql, args))
      : await withTenants([tenant], (c) => c.query<{ n: string }>(sql, args), scoped ? S : undefined);
    return Number(r.rows[0]!.n);
  };

  // A Composer post: only the columns today's routes write.
  const composer = (over: Row = {}): Row => ({
    id: newId(), tenant_id: A, engagement_id: engA, title: "SCP probe post", origin_site: site(), ...over,
  });
  // What each status needs beyond cycle_id + status_since, so the post is valid in that status.
  const NEEDS: Record<string, Row> = {
    design: { creative_state: "not_started", creative_source: "creatives" },
    scheduled: { schedule_via: "manual" },
    live: { schedule_via: "publisher", live_url: "https://instagram.example.test/p/1", went_live_at: "2026-11-03T10:00:00Z" },
    changes: { change_by: "hod", change_kind: "copy", return_to: "hod", change_note: "Tighten the hook" },
    blocked: { blocked_from: "drafting", block_reason: "Waiting for the product photos", block_waiting_on: "client", blocked_at: "2026-11-02T08:00:00Z" },
  };
  const pipe = (status: string, over: Row = {}): Row =>
    composer({ cycle_id: cycA, pipeline_status: status, status_since: now(), ...(NEEDS[status] ?? {}), ...over });
  const post = (row: Row, tenant = A) => insert("social_posts", row, tenant);

  const engagement = (over: Row = {}): Row => ({
    id: newId(), tenant_id: A, client_id: clientA, name: "SCP probe engagement", origin_site: site(), ...over,
  });
  // A month no other cycle of engCyc has used, with a deadline and ready-by inside its window.
  const nextMonth = (): string => {
    monthSeq += 1;
    const y = 2040 + Math.floor(monthSeq / 12);
    const m = (monthSeq % 12) + 1;
    return `${y}-${String(m).padStart(2, "0")}-01`;
  };
  const cycle = (over: Row = {}): Row => {
    const month = (over.month as string | undefined) ?? nextMonth();
    return {
      id: newId(), tenant_id: A, engagement_id: engCyc, month, deadline: month, ready_by: month,
      origin_site: site(), ...over,
    };
  };
  const design = (postId: string, over: Row = {}): Row => ({
    id: newId(), tenant_id: A, post_id: postId, position: 1, asset_group_id: assetA, added_by: u1, origin_site: site(), ...over,
  });
  const copyEdit = (postId: string, over: Row = {}): Row => ({
    id: newId(), tenant_id: A, post_id: postId, field: "caption", before: J("Old caption"), after: J("New caption"),
    via: "fix", edited_by: u1, stage: "changes", origin_site: site(), ...over,
  });
  let handleSeq = 0;
  // A Composer post with one variant, for one client review (UNIQUE (variant_id) on the review table).
  const mkVariant = async (): Promise<string> => {
    const p = await post(composer());
    const id = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, args_sha256, status, origin_site)
       VALUES ($1,$2,$3,$4,'copy',$5,'draft',$6)`,
      [id, A, p.id, accountA, "a".repeat(64), site()],
    ), S);
    return id;
  };
  const review = async (over: Row = {}): Promise<Row> => ({
    id: newId(), tenant_id: A, variant_id: await mkVariant(), client_id: clientA, origin_site: site(), ...over,
  });
  // The review table takes the PLAIN wall: written with a tenant and NO module scope, as the portal writes it.
  const insertReview = (row: Row) => insert("social_post_client_reviews", row, A, { scoped: false });

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("SCP1B Co A", ["social"]);
    B = await createCompany("SCP1B Co B", ["social"]);
    u1 = await createUser("scp1b-officer@a.test", "Mock Officer");
    u2 = await createUser("scp1b-copywriter@a.test", "Mock Copywriter");
    clientA = await createClient(A, "SCP1B Mock Client A");
    clientB = await createClient(B, "SCP1B Mock Client B");
    engA = (await insert("social_engagements", engagement({ owner_id: u1 }), A)).id as string;
    engCyc = (await insert("social_engagements", engagement({ name: "SCP probe cycles" }), A)).id as string;
    engB = (await insert("social_engagements", engagement({ tenant_id: B, client_id: clientB }), B)).id as string;
    cycA = (await insert("social_cycles", cycle({ engagement_id: engA, month: "2026-11-01", deadline: "2026-10-25", ready_by: "2026-10-24" }), A)).id as string;
    cycB = (await insert("social_cycles", cycle({ tenant_id: B, engagement_id: engB, month: "2026-11-01", deadline: "2026-10-25", ready_by: "2026-10-24" }), B)).id as string;

    // A Creatives month request (an `assets` work request needs its PM task).
    const project = await createProject(A, "SCP1B Mock Project");
    const mkRequest = async (): Promise<string> => {
      const task = newId();
      const id = newId();
      await withTenants([A], async (c) => {
        await c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, origin_site) VALUES ($1,$2,$3,'Content month','todo',$4)`,
          [task, A, project, site()]);
        await c.query(
          `INSERT INTO work_requests (id, tenant_id, kind, to_unit_id, requested_by, title, origin_site, pm_task_id)
           VALUES ($1,$2,'assets','d-creative',$3,'November designs',$4,$5)`,
          [id, A, u1, site(), task]);
      }, { modules: ["pm", "social"] });
      return id;
    };
    wrA = await mkRequest();
    wrA2 = await mkRequest();

    const asset = await withTenants([A], (c) => c.query<{ id: string }>(
      `INSERT INTO creative_assets (tenant_id, name, grade, graded_key, origin_site) VALUES ($1,'Mock hero','{}'::jsonb,'k/scp1b-hero',$2) RETURNING id`,
      [A, site()]));
    assetA = asset.rows[0]!.id;

    const org = newId();
    accountA = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz','scp1b-org','default','active',$4)`, [org, A, clientA, site()]);
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram',$5,'connected','{}',$6)`, [accountA, A, clientA, org, `@scp1b-${++handleSeq}`, site()]);
    }, S);
  });
  afterAll(async () => { await teardownTestDb(); });

  it("the app role really is NOBYPASSRLS (otherwise nothing below tests anything)", async () => {
    const r = await withGlobal((c) => c.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  // ── today's insert paths, and no existing row changed ───────────────────────────────────────────────
  describe("Composer rows and today's insert paths", () => {
    it("an engagement written by today's create route reads the allocation defaults", async () => {
      const id = newId();
      await withTenants([A], (c) => c.query(
        `INSERT INTO social_engagements
           (id, tenant_id, client_id, project_id, name, tool_scope, usage_budget_usd, owner_id, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [id, A, clientA, null, "Today's engagement", J({ networks: { instagram: true } }), 10, u1, site()]), S);
      const r = (await adminPool().query(`SELECT * FROM social_engagements WHERE id = $1`, [id])).rows[0];
      expect(r).toMatchObject({
        posts_per_cycle: null, creative_source: "creatives", delivery_batch: null, report_format: null,
        report_due_day: null, platforms: [], formats: [], default_post_time: null, step_estimates: {},
      });
    });

    it("a brand profile written by today's upsert reads the brand-book defaults", async () => {
      const id = newId();
      const sql = `INSERT INTO social_brand_profiles (id, tenant_id, client_id, tone, hashtag_strategy, knowledge_source_ids, origin_site)
         VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb),COALESCE($5::jsonb,'{}'::jsonb),COALESCE($6::jsonb,'[]'::jsonb),$7)
         ON CONFLICT (tenant_id, client_id) DO UPDATE SET
           tone = COALESCE($4::jsonb, social_brand_profiles.tone),
           hashtag_strategy = COALESCE($5::jsonb, social_brand_profiles.hashtag_strategy),
           knowledge_source_ids = COALESCE($6::jsonb, social_brand_profiles.knowledge_source_ids),
           updated_at = now()`;
      await withTenants([A], (c) => c.query(sql, [id, A, clientA, J({ traits: ["warm"] }), null, null, site()]), S);
      await withTenants([A], (c) => c.query(sql, [newId(), A, clientA, null, J({ maxCount: 10 }), null, site()]), S);
      const r = (await adminPool().query(`SELECT * FROM social_brand_profiles WHERE tenant_id = $1 AND client_id = $2`, [A, clientA])).rows[0];
      expect(r).toMatchObject({
        tone: { traits: ["warm"] }, hashtag_strategy: { maxCount: 10 },
        content_pillars: [], must_have_notes: [], brand_rules: [], channels: [], key_dates: [], links: [],
      });
    });

    it("a Composer post written by today's create, idea and import paths reads pipeline_status NULL and the new defaults", async () => {
      const ids = [newId(), newId(), newId()];
      await withTenants([A], async (c) => {
        await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, campaign_id, title, brief, source, scheduled_at, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [ids[0], A, engA, null, "Composer post", "brief", "human", "2026-11-05T09:00:00Z", u1, site()]);
        await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, campaign_id, title, brief, source, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,'agent','idea',$7) ON CONFLICT (id) DO NOTHING`,
          [ids[1], A, engA, null, "Agent idea", "brief", site()]);
        await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, title, source, status, scheduled_at, created_by, origin_site)
           VALUES ($1,$2,$3,$4,'native_import','published',$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [ids[2], A, engA, "Posted by hand", "2026-10-01T09:00:00Z", u1, site()]);
      }, S);
      const rows = (await adminPool().query(`SELECT * FROM social_posts WHERE id = ANY($1::uuid[])`, [ids])).rows;
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r, r.title).toMatchObject({
          cycle_id: null, pipeline_status: null, status_since: null, format: null, caption: "", hashtags: [],
          raw_assets: [], placement: [], must_haves: [], skipped_checks: [], suggestions: {},
          change_by: null, change_kind: null, return_to: null, change_note: null, changed_only: false, copy_before: null,
          block_reason: null, block_waiting_on: null, blocked_from: null, blocked_at: null,
          creative_source: null, creative_state: null, creative_request_id: null, is_extra: false, idea_id: null,
          author_id: null, client_first_sent_at: null, schedule_via: null, live_url: null, went_live_at: null,
          simulated: false, archived_at: null, archived_by: null, archive_reason: null, last_action_id: null, last_action_at: null,
        });
      }
      // Today's lifecycle writes on a Composer post still pass every new CHECK.
      await update("social_posts", ids[0]!, { status: "scheduled", scheduled_at: "2026-11-06T09:00:00Z", updated_at: now() }, A);
      await update("social_posts", ids[0]!, { status: "archived", deleted_at: now() }, A);
    });

    it("today's client-review request upsert and the portal decision still work and leave the new columns NULL", async () => {
      const variantId = await mkVariant();
      const upsert = (id: string) => withTenants([A], (c) => c.query<{ id: string }>(
        `INSERT INTO social_post_client_reviews
           (id, tenant_id, variant_id, client_id, status, requested_at, updated_at, origin_site)
         VALUES ($1, $2, $3, $4, 'pending', now(), now(), $5)
         ON CONFLICT (variant_id) DO UPDATE SET
           status = 'pending', comment = NULL, reviewed_args_sha256 = NULL,
           decided_by = NULL, decided_at = NULL, requested_at = now(), updated_at = now()
         RETURNING id`,
        [id, A, variantId, clientA, site()]), S);
      const first = (await upsert(newId())).rows[0]!.id;
      // The portal's decision (core, no module scope: the plain wall).
      const dec = await withTenants([A], (c) => c.query(
        `UPDATE social_post_client_reviews
            SET status = $2, comment = COALESCE($3, comment), reviewed_args_sha256 = $4,
                decided_by = $5, decided_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING status`,
        [first, "changes_requested", "Brighter, please", "b".repeat(64), u2]));
      expect(dec.rowCount).toBe(1);
      expect((await upsert(newId())).rows[0]!.id).toBe(first); // re-request: same row, back to pending
      const r = (await adminPool().query(`SELECT * FROM social_post_client_reviews WHERE id = $1`, [first])).rows[0];
      expect(r).toMatchObject({
        status: "pending", change_kind: null, anchor: null, recorded_by: null, channel: null, decision_id: null, undo_until: null,
      });
    });

    it("re-applying the file is clean and changes no existing row", async () => {
      const snap = async () => {
        const out: Record<string, string[]> = {};
        for (const t of ["social_engagements", "social_brand_profiles", "social_posts", "social_post_client_reviews", "social_cycles"]) {
          out[t] = (await adminPool().query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM ${t} x ORDER BY id`)).rows.map((r) => r.j);
        }
        return out;
      };
      const before = await snap();
      expect(before.social_posts!.length).toBeGreaterThan(0);
      const sql = readFileSync(MIGRATION_PATH, "utf8");
      await adminPool().query(sql);
      await adminPool().query(sql);
      expect(await snap()).toEqual(before);
      const pol = await adminPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_policies WHERE tablename = ANY($1)`, [[...NEW_TABLES]]);
      expect(Number(pol.rows[0]!.n)).toBe(4);
      const trg = await adminPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_trigger WHERE tgrelid = 'social_post_copy_edits'::regclass AND NOT tgisinternal`);
      expect(Number(trg.rows[0]!.n)).toBe(1);
    });
  });

  // ── the walls ───────────────────────────────────────────────────────────────────────────────────────
  describe("walls", () => {
    it("the four new tables are ENABLE + FORCE RLS with the composed tenant + module policy on USING and WITH CHECK", async () => {
      const rls = await adminPool().query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'`, [[...NEW_TABLES]]);
      expect(rls.rows).toHaveLength(4);
      for (const r of rls.rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = await adminPool().query<{ tablename: string; qual: string; with_check: string }>(
        `SELECT tablename, qual, with_check FROM pg_policies WHERE tablename = ANY($1)`, [[...NEW_TABLES]]);
      expect(pol.rows).toHaveLength(4);
      for (const p of pol.rows) {
        for (const part of [p.qual, p.with_check]) {
          expect(part, p.tablename).toContain("app_current_tenants()");
          expect(part, p.tablename).toContain("app_module_allowed('social'::text)");
        }
      }
    });

    it("unset GUC, another tenant and a missing module scope read zero rows on every new table, with no error", async () => {
      const p = await post(pipe("design"));
      await insert("social_settings", { tenant_id: A, updated_by: u1 }, A);
      await insert("social_post_designs", design(p.id as string), A);
      await insert("social_post_copy_edits", copyEdit(p.id as string), A);
      for (const t of NEW_TABLES) {
        expect(await count(t, A, true), `${t} own scope`).toBeGreaterThan(0);
        expect(await count(t, A, true, A), `${t} own scope, own rows`).toBeGreaterThan(0);
        expect(await count(t, B, true, A), `${t} other tenant reading A's rows`).toBe(0);
        expect(await count(t, null, false), `${t} unset tenant GUC`).toBe(0);
        expect(await count(t, A, false), `${t} module scope missing`).toBe(0);
      }
      // Tenant B's own cycle is visible to B only.
      expect(await count("social_cycles", B, true)).toBe(1);
    });

    it("the new tables refuse writes without the tenant, under another tenant, and without the module scope", async () => {
      const row = () => cycle();
      await expect(withGlobal((c) => c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1,$2,$3,'2040-01-01','2040-01-01','2040-01-01',$4)`,
        [newId(), A, engCyc, site()]))).rejects.toThrow(/row-level security/);
      await expect(insert("social_cycles", row(), A, { scoped: false })).rejects.toThrow(/row-level security/);
      await expect(insert("social_cycles", row(), B)).rejects.toThrow(/row-level security/);
      await expect(insert("social_settings", { tenant_id: B }, A)).rejects.toThrow(/row-level security/);
      const del = await withGlobal((c) => c.query(`DELETE FROM social_cycles`));
      expect(del.rowCount).toBe(0);
    });

    it("social_post_client_reviews keeps its PLAIN wall: one policy, no module clause, tenant-only reads", async () => {
      const pol = await adminPool().query<{ policyname: string; qual: string; with_check: string }>(
        `SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'social_post_client_reviews'`);
      expect(pol.rows).toHaveLength(1);
      expect(pol.rows[0]!.policyname).toBe("tenant_isolation");
      expect(pol.rows[0]!.qual).not.toContain("app_module_allowed");
      expect(pol.rows[0]!.with_check).not.toContain("app_module_allowed");
      await insertReview(await review());
      expect(await count("social_post_client_reviews", A, false)).toBeGreaterThan(0); // no module scope needed
      expect(await count("social_post_client_reviews", B, false)).toBe(0);
      expect(await count("social_post_client_reviews", null, false)).toBe(0);
    });
  });

  // ── social_engagements, social_brand_profiles, social_settings ──────────────────────────────────────
  describe("allocation, brand book and settings", () => {
    it("engagement CHECKs: target range, creative route, batch, report format and day, platforms, formats, estimates", async () => {
      const e = (over: Row) => insert("social_engagements", engagement(over), A);
      await refuses(e({ posts_per_cycle: 201 }), "social_engagements_posts_per_cycle_ck");
      await refuses(e({ posts_per_cycle: -1 }), "social_engagements_posts_per_cycle_ck");
      await e({ posts_per_cycle: 0 });
      await e({ posts_per_cycle: 200 });
      await e({ posts_per_cycle: null });
      await refuses(e({ creative_source: "agency" }), "social_engagements_creative_source_ck");
      await e({ creative_source: "in_team" });
      await refuses(e({ delivery_batch: "C" }), "social_engagements_delivery_batch_ck");
      await e({ delivery_batch: "B" });
      await refuses(e({ report_format: "fax" }), "social_engagements_report_format_ck");
      await e({ report_format: "meeting" });
      await refuses(e({ report_due_day: 0 }), "social_engagements_report_due_day_ck");
      await refuses(e({ report_due_day: 32 }), "social_engagements_report_due_day_ck");
      await e({ report_due_day: 31 });
      await refuses(e({ platforms: ["instagram", "myspace"] }), "social_engagements_platforms_ck");
      await e({ platforms: ["instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "threads", "pinterest", "bluesky", "mastodon"] });
      await refuses(e({ formats: ["tweet"] }), "social_engagements_formats_ck");
      await e({ formats: ["feed", "carousel", "reel", "story"] });
      await refuses(e({ step_estimates: J([1]) }), "social_engagements_step_estimates_ck");
      await e({ step_estimates: J({ proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 }), default_post_time: "18:30" });
    });

    it("the officer index exists and is partial over live engagements", async () => {
      const r = await adminPool().query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_social_engagements_owner'`);
      expect(r.rows[0]!.indexdef).toContain("(tenant_id, owner_id)");
      expect(r.rows[0]!.indexdef).toContain("WHERE (deleted_at IS NULL)");
    });

    it("brand-book CHECKs: the array counts and the jsonb array kinds", async () => {
      const clientP = await createClient(A, "SCP1B Mock Client P");
      const id = (await insert("social_brand_profiles", { id: newId(), tenant_id: A, client_id: clientP, origin_site: site() }, A)).id as string;
      const u = (set: Row) => update("social_brand_profiles", id, set, A);
      const many = (n: number) => Array.from({ length: n }, (_, i) => `item ${i}`);
      await refuses(u({ content_pillars: many(21) }), "social_brand_profiles_content_pillars_ck");
      await u({ content_pillars: many(20) });
      await refuses(u({ must_have_notes: many(21) }), "social_brand_profiles_must_have_notes_ck");
      await u({ must_have_notes: many(20) });
      await refuses(u({ brand_rules: many(31) }), "social_brand_profiles_brand_rules_ck");
      await u({ brand_rules: many(30) });
      await refuses(u({ channels: J({ network: "instagram" }) }), "social_brand_profiles_channels_ck");
      await refuses(u({ key_dates: J("11-11") }), "social_brand_profiles_key_dates_ck");
      await refuses(u({ links: J({}) }), "social_brand_profiles_links_ck");
      const ok = await u({
        channels: J([{ network: "instagram", handle: "@mock" }]),
        key_dates: J([{ date: "11-11", label: "Singles day" }]),
        links: J([{ label: "Brand book", url: "https://drive.example.test/x" }]),
        tone: J({ summary: "Warm and direct" }),
        hashtag_strategy: J({ sets: [{ name: "Core", tags: ["mockbrand"] }] }),
      });
      expect(ok.rowCount).toBe(1);
    });

    it("settings: one row per company, the defaults, and the ranges", async () => {
      // A's row was inserted by the wall test; a second one is a duplicate key.
      await expect(insert("social_settings", { tenant_id: A }, A)).rejects.toThrow(/duplicate key value violates unique constraint "social_settings_pkey"/);
      const r = (await adminPool().query(`SELECT * FROM social_settings WHERE tenant_id = $1`, [A])).rows[0];
      expect(r.buffer_working_days).toBe(1);
      expect(r.boost_candidate_factor).toBe("1.25");
      const u = (set: Row) => update("social_settings", A, set, A, { key: "tenant_id" });
      await refuses(u({ buffer_working_days: 11 }), "social_settings_buffer_ck");
      await refuses(u({ buffer_working_days: -1 }), "social_settings_buffer_ck");
      await u({ buffer_working_days: 0 });
      await u({ buffer_working_days: 10 });
      await refuses(u({ boost_candidate_factor: 0.99 }), "social_settings_boost_factor_ck");
      await refuses(u({ boost_candidate_factor: 10.01 }), "social_settings_boost_factor_ck");
      await u({ boost_candidate_factor: 1.0 });
      await u({ boost_candidate_factor: 10.0 });
    });
  });

  // ── social_cycles ───────────────────────────────────────────────────────────────────────────────────
  describe("cycles", () => {
    it("month, deadline window and ready-by CHECKs, with the window's edges admitted", async () => {
      const c = (over: Row) => insert("social_cycles", cycle(over), A);
      await refuses(c({ month: "2031-03-15", deadline: "2031-03-10", ready_by: "2031-03-09" }), "social_cycles_month_ck");
      await refuses(c({ month: "2031-04-01", deadline: "2030-12-31", ready_by: "2030-12-30" }), "social_cycles_deadline_ck");
      await c({ month: "2031-05-01", deadline: "2031-02-01", ready_by: "2031-01-30" });  // month - 3 months
      await refuses(c({ month: "2031-06-01", deadline: "2031-07-01", ready_by: "2031-06-30" }), "social_cycles_deadline_ck");
      await c({ month: "2031-07-01", deadline: "2031-07-31", ready_by: "2031-07-31" });  // the month's last day
      await c({ month: "2031-02-01", deadline: "2031-02-28", ready_by: "2031-02-27" });  // a short month's last day
      await refuses(c({ month: "2031-08-01", deadline: "2031-07-20", ready_by: "2031-07-21" }), "social_cycles_ready_by_ck");
    });

    it("one live cycle per client and month; a soft-deleted month can be planned again", async () => {
      const month = "2032-03-01";
      const first = await insert("social_cycles", cycle({ month }), A);
      await expect(insert("social_cycles", cycle({ month }), A)).rejects.toThrow(/duplicate key value violates unique constraint "ux_social_cycles_month"/);
      // Another client's cycle in the same month is fine.
      await insert("social_cycles", cycle({ month, engagement_id: engA }), A);
      await update("social_cycles", first.id as string, { deleted_at: now() }, A);
      await insert("social_cycles", cycle({ month }), A);
    });

    it("one cycle per Creatives request", async () => {
      await insert("social_cycles", cycle({ creative_request_id: wrA }), A);
      await expect(insert("social_cycles", cycle({ creative_request_id: wrA }), A))
        .rejects.toThrow(/duplicate key value violates unique constraint "ux_social_cycles_request"/);
      await insert("social_cycles", cycle({ creative_request_id: null }), A);
      await insert("social_cycles", cycle({ creative_request_id: null }), A);
    });

    it("a cycle cannot name another company's engagement, and a post cannot name another company's cycle", async () => {
      await expect(insert("social_cycles", cycle({ engagement_id: engB }), A))
        .rejects.toThrow(/violates foreign key constraint "fk_social_cycles_engagement_tenant"/);
      await expect(post(pipe("planned", { cycle_id: cycB })))
        .rejects.toThrow(/violates foreign key constraint "fk_social_posts_cycle_tenant"/);
    });
  });

  // ── social_posts ────────────────────────────────────────────────────────────────────────────────────
  describe("posts", () => {
    it("every fixture status is admitted with what it needs; anything else is refused", async () => {
      for (const s of STATUSES) {
        const r = await post(pipe(s));
        expect(r.pipeline_status, s).toBe(s);
      }
      await refuses(post(pipe("idea")), "social_posts_pipeline_status_ck");
      await refuses(post(pipe("published")), "social_posts_pipeline_status_ck");
    });

    it("a pipeline post needs a cycle, and status_since is set exactly when pipeline_status is", async () => {
      await post(composer({ cycle_id: null }));
      await refuses(post(pipe("planned", { cycle_id: null })), "social_posts_pipeline_needs_cycle_ck");
      await refuses(post(pipe("planned", { status_since: null })), "social_posts_status_since_ck");
      await refuses(post(composer({ status_since: now() })), "social_posts_status_since_ck");
    });

    it("the change columns are all or none (a NULL in one of them does not slip past the case check)", async () => {
      const hod = { change_by: "hod", change_kind: "copy", return_to: "hod", change_note: "Tighten the hook" };
      await refuses(post(pipe("changes", { ...hod, change_note: null })), "social_posts_change_all_or_none_ck");
      await refuses(post(pipe("changes", { ...hod, change_kind: null })), "social_posts_change_all_or_none_ck");
      await refuses(post(pipe("changes", { ...hod, return_to: null })), "social_posts_change_all_or_none_ck");
      await refuses(post(pipe("proofread", { change_note: "orphan note" })), "social_posts_change_all_or_none_ck");
    });

    it("only the six change cases of the fixture are admitted", async () => {
      const ok = new Set(CHANGE_CASES.map((c) => `${c.by}/${c.kind}/${c.ret}`));
      for (const c of CHANGE_CASES) {
        await post(pipe("changes", { change_by: c.by, change_kind: c.kind, return_to: c.ret, change_note: "note" }));
      }
      let refused = 0;
      for (const by of ["copywriter", "hod", "final", "client"]) {
        for (const kind of ["copy", "design"]) {
          for (const ret of ["proofread", "hod", "final"]) {
            if (ok.has(`${by}/${kind}/${ret}`)) continue;
            await refuses(post(pipe("changes", { change_by: by, change_kind: kind, return_to: ret, change_note: "note" })), "social_posts_change_case_ck");
            refused += 1;
          }
        }
      }
      expect(refused).toBe(18);
      await refuses(post(pipe("changes", { change_by: "officer", change_kind: "copy", return_to: "proofread", change_note: "note" })), "social_posts_change_case_ck");
      await refuses(post(pipe("changes", { change_by: "client", change_kind: "visual", return_to: "final", change_note: "note" })), "social_posts_change_case_ck");
    });

    it("`changes` needs a change; a change is held only in `changes` or blocked from `changes`", async () => {
      const hod = { change_by: "hod", change_kind: "copy", return_to: "hod", change_note: "Tighten the hook" };
      await refuses(post(pipe("changes", { change_by: null, change_kind: null, return_to: null, change_note: null })), "social_posts_changes_needs_change_ck");
      await refuses(post(pipe("proofread", hod)), "social_posts_change_only_in_changes_ck");
      await refuses(post(composer(hod)), "social_posts_change_only_in_changes_ck"); // NULL pipeline_status
      await post(pipe("blocked", { ...hod, blocked_from: "changes" }));
      await refuses(post(pipe("blocked", { ...hod, blocked_from: "design" })), "social_posts_change_only_in_changes_ck");
    });

    it("loop e: changed_only exactly with copy_before, and only for a client change", async () => {
      const keep = J({ caption: "As the client saw it", on_asset_text: null, cta: null, hashtags: ["mock"] });
      await refuses(post(pipe("proofread", { changed_only: true })), "social_posts_changed_only_ck");
      await refuses(post(pipe("proofread", { copy_before: keep })), "social_posts_changed_only_ck");
      await post(pipe("proofread", { changed_only: true, copy_before: keep }));
      await post(pipe("changes", { change_by: "client", change_kind: "copy", return_to: "proofread", change_note: "n", changed_only: true, copy_before: keep }));
      await refuses(post(pipe("changes", { changed_only: true, copy_before: keep })), "social_posts_changed_only_client_ck"); // hod
      await refuses(post(pipe("proofread", { changed_only: true, copy_before: J(["x"]) })), "social_posts_copy_before_ck");
    });

    it("`blocked` exactly with all four block columns; blocked_from is blockable and waiting_on is a known party", async () => {
      for (const col of ["blocked_from", "block_reason", "block_waiting_on", "blocked_at"]) {
        await refuses(post(pipe("blocked", { [col]: null })), "social_posts_blocked_ck");
      }
      await refuses(post(pipe("planned", { block_reason: "stale" })), "social_posts_blocked_ck");
      await refuses(post(composer({ blocked_at: now() })), "social_posts_blocked_ck");
      for (const from of BLOCKABLE) await post(pipe("blocked", { blocked_from: from }));
      for (const from of STATUSES.filter((s) => !BLOCKABLE.includes(s))) {
        await refuses(post(pipe("blocked", { blocked_from: from })), "social_posts_block_values_ck");
      }
      for (const who of ["client", "designer", "copywriter", "approver", "officer", "external"]) {
        await post(pipe("blocked", { block_waiting_on: who }));
      }
      await refuses(post(pipe("blocked", { block_waiting_on: "nobody" })), "social_posts_block_values_ck");
    });

    it("design needs creative_state and creative_source; both take their value lists", async () => {
      await refuses(post(pipe("design", { creative_state: null })), "social_posts_design_ck");
      await refuses(post(pipe("design", { creative_source: null })), "social_posts_design_ck");
      for (const st of ["not_started", "in_progress", "revision", "submitted"]) {
        await post(pipe("design", { creative_state: st, creative_source: "in_team" }));
      }
      await refuses(post(pipe("design", { creative_state: "done" })), "social_posts_creative_values_ck");
      await refuses(post(pipe("design", { creative_source: "agency" })), "social_posts_creative_values_ck");
      // A post that has left design keeps its route (and its state may be NULL or kept).
      await post(pipe("final", { creative_source: "in_team", creative_state: "submitted" }));
    });

    it("a Creatives request only on a post whose design goes through Creatives (NULL creative_source refused)", async () => {
      await refuses(post(pipe("design", { creative_source: "in_team", creative_request_id: wrA2 })), "social_posts_request_needs_creatives_ck");
      await refuses(post(pipe("planned", { creative_request_id: wrA2 })), "social_posts_request_needs_creatives_ck");
      await post(pipe("design", { creative_source: "creatives", creative_request_id: wrA2 }));
      await post(pipe("design", { creative_source: "creatives", creative_request_id: wrA2 })); // many posts join one request
    });

    it("schedule_via exactly while scheduled or live; live needs its URL and time", async () => {
      await refuses(post(pipe("scheduled", { schedule_via: null })), "social_posts_schedule_via_ck");
      await refuses(post(pipe("approved", { schedule_via: "manual" })), "social_posts_schedule_via_ck");
      await refuses(post(pipe("live", { schedule_via: null })), "social_posts_schedule_via_ck");
      await post(composer({ schedule_via: "manual" })); // a Composer post is not held to it
      await post(pipe("scheduled", { schedule_via: "publisher" }));
      await refuses(post(pipe("scheduled", { schedule_via: "fax" })), "social_posts_schedule_via_values_ck");
      await refuses(post(pipe("live", { live_url: null })), "social_posts_live_ck");
      await refuses(post(pipe("live", { went_live_at: null })), "social_posts_live_ck");
      await refuses(post(pipe("live", { live_url: "ftp://files.example.test/p" })), "social_posts_live_url_ck");
      await refuses(post(pipe("live", { live_url: `https://x.example.test/${"p".repeat(480)}` })), "social_posts_live_url_ck");
      await post(pipe("live", { live_url: "http://x.example.test/p/2" }));
    });

    it("archived_at, archived_by and archive_reason come together, and archiving keeps the status", async () => {
      await refuses(post(pipe("hod", { archived_at: now() })), "social_posts_archived_ck");
      await refuses(post(pipe("hod", { archived_at: now(), archived_by: u1 })), "social_posts_archived_ck");
      await refuses(post(pipe("hod", { archived_by: u1, archive_reason: "dropped" })), "social_posts_archived_ck");
      const r = await post(pipe("hod", { archived_at: now(), archived_by: u1, archive_reason: "The client dropped the launch" }));
      expect(r.pipeline_status).toBe("hod");
    });

    it("value lists and lengths: format, the text fields, caption, placement, must-haves", async () => {
      for (const f of ["feed", "carousel", "reel", "story"]) await post(pipe("planned", { format: f }));
      await refuses(post(pipe("planned", { format: "tweet" })), "social_posts_format_ck");
      const limits: Array<[string, number]> = [
        ["pillar", 60], ["angle", 500], ["objective", 200], ["key_message", 500], ["visual_direction", 2000],
        ["on_asset_text", 500], ["cta", 120], ["caption", 5000],
      ];
      for (const [col, max] of limits) {
        await post(pipe("planned", { [col]: "x".repeat(max) }));
        await refuses(post(pipe("planned", { [col]: "x".repeat(max + 1) })), "social_posts_text_lengths_ck");
      }
      await refuses(post(pipe("changes", { change_note: "x".repeat(2001) })), "social_posts_text_lengths_ck");
      await refuses(post(pipe("blocked", { block_reason: "x".repeat(501) })), "social_posts_text_lengths_ck");
      await refuses(post(pipe("hod", { archived_at: now(), archived_by: u1, archive_reason: "x".repeat(501) })), "social_posts_text_lengths_ck");
      await post(pipe("planned", { placement: ["instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "threads", "pinterest", "bluesky", "mastodon"] }));
      await refuses(post(pipe("planned", { placement: ["instagram", "myspace"] })), "social_posts_placement_ck");
      await post(pipe("planned", { must_haves: MUST_HAVES }));
      await refuses(post(pipe("planned", { must_haves: ["logo", "mascot"] })), "social_posts_must_haves_ck");
    });

    it("hashtags: at most 60, none NULL, none with '#'", async () => {
      await post(pipe("planned", { hashtags: ["mockbrand", "summer_sale", "bali"] }));
      await post(pipe("planned", { hashtags: Array.from({ length: 60 }, (_, i) => `t${i}`) }));
      await refuses(post(pipe("planned", { hashtags: ["#mockbrand"] })), "social_posts_hashtags_ck");
      await refuses(post(pipe("planned", { hashtags: ["ok", "mid#dle"] })), "social_posts_hashtags_ck");
      await refuses(post(pipe("planned", { hashtags: ["ok", null] })), "social_posts_hashtags_ck");
      await refuses(post(pipe("planned", { hashtags: Array.from({ length: 61 }, (_, i) => `t${i}`) })), "social_posts_hashtags_ck");
    });

    it("raw_assets: an array of at most 10 entries, each with a known source", async () => {
      const asset = (source: unknown) => ({ url: "https://drive.example.test/a", label: "Hero", source });
      await post(pipe("planned", { raw_assets: J([asset("own"), asset("client"), asset("stock"), { ...asset("ai"), aiNote: "Sky extended" }, asset("unknown")]) }));
      await post(pipe("planned", { raw_assets: J([{ source: "unknown" }]) })); // a draft may lack its link (the hand-off check)
      await post(pipe("planned", { raw_assets: J(Array.from({ length: 10 }, () => asset("own"))) }));
      await refuses(post(pipe("planned", { raw_assets: J(Array.from({ length: 11 }, () => asset("own"))) })), "social_posts_raw_assets_ck");
      await refuses(post(pipe("planned", { raw_assets: J([asset("stolen")]) })), "social_posts_raw_assets_ck");
      await refuses(post(pipe("planned", { raw_assets: J([{ url: "https://drive.example.test/a" }]) })), "social_posts_raw_assets_ck");
      await refuses(post(pipe("planned", { raw_assets: J([asset(5)]) })), "social_posts_raw_assets_ck");
      await refuses(post(pipe("planned", { raw_assets: J([asset(null)]) })), "social_posts_raw_assets_ck");
      await refuses(post(pipe("planned", { raw_assets: J(["https://drive.example.test/a"]) })), "social_posts_raw_assets_ck");
      await refuses(post(pipe("planned", { raw_assets: J(asset("own")) })), "social_posts_raw_assets_ck");
    });

    it("skipped_checks is an array; suggestions is an object keyed by the four copy fields only", async () => {
      await post(pipe("final", { skipped_checks: J([{ codes: ["location_tag"], reason: "No venue", by: u1, at: now() }]) }));
      await refuses(post(pipe("final", { skipped_checks: J({}) })), "social_posts_skipped_checks_ck");
      const sg = { value: "New", base: "Old", by: u2, at: now() };
      await post(pipe("proofread", { suggestions: J({ caption: sg, on_asset_text: sg, cta: sg, hashtags: { ...sg, value: ["a"], base: [] } }) }));
      await refuses(post(pipe("proofread", { suggestions: J({ title: sg }) })), "social_posts_suggestions_ck");
      await refuses(post(pipe("proofread", { suggestions: J([sg]) })), "social_posts_suggestions_ck");
    });

    it("the four feed indexes exist with their partial predicates", async () => {
      const r = await adminPool().query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'social_posts' AND indexname = ANY($1)`,
        [["ix_social_posts_pipeline", "ix_social_posts_cycle", "ix_social_posts_request", "ix_social_posts_engagement_date"]]);
      const by = new Map(r.rows.map((x) => [x.indexname, x.indexdef]));
      expect(by.get("ix_social_posts_pipeline")).toMatch(/\(tenant_id, pipeline_status, status_since\) WHERE \(\(pipeline_status IS NOT NULL\) AND \(deleted_at IS NULL\) AND \(archived_at IS NULL\)\)/);
      expect(by.get("ix_social_posts_cycle")).toMatch(/\(tenant_id, cycle_id, pipeline_status\) WHERE \(\(cycle_id IS NOT NULL\) AND \(deleted_at IS NULL\)\)/);
      expect(by.get("ix_social_posts_request")).toMatch(/\(tenant_id, creative_request_id\) WHERE \(\(creative_request_id IS NOT NULL\) AND \(deleted_at IS NULL\)\)/);
      expect(by.get("ix_social_posts_engagement_date")).toMatch(/\(tenant_id, engagement_id, scheduled_at\) WHERE \(\(pipeline_status IS NOT NULL\) AND \(deleted_at IS NULL\)\)/);
    });
  });

  // ── social_post_designs ─────────────────────────────────────────────────────────────────────────────
  describe("designs", () => {
    let postD: string;
    beforeAll(async () => { postD = (await post(pipe("design"))).id as string; });
    const d = (over: Row) => insert("social_post_designs", design(postD, over), A);
    let pos = 0;
    const at = () => { pos += 1; if (pos > 20) throw new Error("design positions exhausted"); return pos; };

    it("an asset or a link, never both and never neither", async () => {
      await refuses(d({ position: 1, link_url: "https://drive.example.test/d", link_source: "own" }), "social_post_designs_target_ck");
      await refuses(d({ position: 1, asset_group_id: null }), "social_post_designs_target_ck");
      await d({ position: at() });
      await d({ position: at(), asset_group_id: null, link_url: "https://drive.example.test/d", link_source: "client" });
    });

    it("a link's source and AI note: only on a link, the source required, the note required for 'ai'", async () => {
      await refuses(d({ position: 1, link_source: "own" }), "social_post_designs_link_meta_ck");                 // an asset
      await refuses(d({ position: 1, link_ai_note: "made with a model" }), "social_post_designs_link_meta_ck");  // an asset
      const link = { asset_group_id: null, link_url: "https://drive.example.test/d" };
      await refuses(d({ position: 1, ...link }), "social_post_designs_link_source_required_ck");
      await refuses(d({ position: 1, ...link, link_source: "ai" }), "social_post_designs_ai_note_ck");
      await d({ position: at(), ...link, link_source: "ai", link_ai_note: "Background generated" });
      await refuses(d({ position: 1, ...link, link_source: "stolen" }), "social_post_designs_link_values_ck");
      await refuses(d({ position: 1, ...link, link_source: "ai", link_ai_note: "x".repeat(1001) }), "social_post_designs_link_values_ck");
      await refuses(d({ position: 1, ...link, link_url: "javascript:alert(1)", link_source: "own" }), "social_post_designs_link_values_ck");
      await refuses(d({ position: 1, ...link, link_url: `https://d.example.test/${"x".repeat(480)}`, link_source: "own" }), "social_post_designs_link_values_ck");
    });

    it("position 1 to 20, the removal pair, and one live design per position", async () => {
      await refuses(d({ position: 0 }), "social_post_designs_position_ck");
      await refuses(d({ position: 21 }), "social_post_designs_position_ck");
      await refuses(d({ position: 20, removed_at: now() }), "social_post_designs_removed_ck");
      const p = at();
      const first = await d({ position: p });
      await expect(d({ position: p })).rejects.toThrow(/duplicate key value violates unique constraint "ux_social_post_designs_position"/);
      await update("social_post_designs", first.id as string, { removed_at: now(), removed_by: u1 }, A);
      await d({ position: p });
    });

    it("a design cannot name another company's post", async () => {
      const pb = await post(pipe("design", { tenant_id: B, engagement_id: engB, cycle_id: cycB }), B);
      await expect(d({ position: 1, post_id: pb.id })).rejects.toThrow(/violates foreign key constraint "fk_social_post_designs_post_tenant"/);
    });
  });

  // ── social_post_copy_edits ──────────────────────────────────────────────────────────────────────────
  describe("copy edits", () => {
    let postE: string;
    beforeAll(async () => { postE = (await post(pipe("changes"))).id as string; });
    const e = (over: Row) => insert("social_post_copy_edits", copyEdit(postE, over), A);

    it("CHECKs: field, via, a suggestion names its suggester, the jsonb shape per field, the stage", async () => {
      await e({});
      await e({ via: "suggestion", suggested_by: u2, stage: "proofread" });
      await refuses(e({ via: "suggestion", suggested_by: null }), "social_post_copy_edits_suggested_by_ck");
      await refuses(e({ via: "magic" }), "social_post_copy_edits_via_ck");
      await refuses(e({ field: "title" }), "social_post_copy_edits_field_ck");
      await e({ field: "hashtags", before: J(["old"]), after: J(["new", "tags"]) });
      await refuses(e({ field: "hashtags", before: J("old") }), "social_post_copy_edits_shape_ck");
      await refuses(e({ field: "caption", after: J(["new"]) }), "social_post_copy_edits_shape_ck");
      await e({ field: "on_asset_text", before: J(null), after: J("50% off") });
      await e({ field: "cta" });
      for (const s of STATUSES) await e({ stage: s });
      await refuses(e({ stage: "idea" }), "social_post_copy_edits_stage_ck");
    });

    it("is append-only: UPDATE and DELETE raise, for the app role and for the owner alike", async () => {
      const row = await e({});
      await expect(update("social_post_copy_edits", row.id as string, { after: J("Rewritten") }, A)).rejects.toThrow(/append-only: UPDATE/);
      await expect(withTenants([A], (c) => c.query(`DELETE FROM social_post_copy_edits WHERE id = $1`, [row.id]), S)).rejects.toThrow(/append-only: DELETE/);
      await expect(adminPool().query(`UPDATE social_post_copy_edits SET stage = 'live' WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
      await expect(adminPool().query(`DELETE FROM social_post_copy_edits WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
      const still = await adminPool().query(`SELECT after FROM social_post_copy_edits WHERE id = $1`, [row.id]);
      expect(still.rows[0]!.after).toBe("New caption");
    });

    it("the log index exists", async () => {
      const r = await adminPool().query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_social_post_copy_edits_post'`);
      expect(r.rows[0]!.indexdef).toContain("(tenant_id, post_id, edited_at DESC)");
    });
  });

  // ── social_post_client_reviews ──────────────────────────────────────────────────────────────────────
  describe("client reviews", () => {
    const decided = { status: "changes_requested", decided_at: "2026-11-04T10:00:00Z" };

    it("change_kind only on a changes_requested review, and only copy or design", async () => {
      await refuses(insertReview(await review({ change_kind: "copy" })), "spcr_change_kind_ck"); // pending
      await refuses(insertReview(await review({ status: "approved", decided_at: now(), decided_by: u2, change_kind: "design" })), "spcr_change_kind_ck");
      await refuses(insertReview(await review({ ...decided, decided_by: u2, change_kind: "layout" })), "spcr_change_kind_ck");
      await insertReview(await review({ ...decided, decided_by: u2, change_kind: "copy" }));
      await insertReview(await review({ ...decided, decided_by: u2, change_kind: "design" }));
      await insertReview(await review({ ...decided, decided_by: u2 })); // a change with no kind yet (today's portal)
    });

    it("the pin: an object with numeric x and y between 0 and 1", async () => {
      await insertReview(await review({ ...decided, decided_by: u2, anchor: J({ x: 0.5, y: 0, fileId: newId() }) }));
      await insertReview(await review({ ...decided, decided_by: u2, anchor: J({ x: 1, y: 1 }) }));
      for (const bad of [{ x: 1.5, y: 0.5 }, { x: -0.1, y: 0.5 }, { x: 0.5, y: 2 }, { x: "0.5", y: 0.5 }, { x: 0.5 }, { y: 0.5 }, [0.5, 0.5], "pin", 1]) {
        await refuses(insertReview(await review({ ...decided, decided_by: u2, anchor: J(bad) })), "spcr_anchor_ck");
      }
    });

    it("a recorded decision: recorded_by and channel together, a known channel, decided_by NULL", async () => {
      const rec = { status: "approved", decided_at: now(), decided_by: null };
      await refuses(insertReview(await review({ ...rec, recorded_by: u1 })), "spcr_recorded_ck");
      await refuses(insertReview(await review({ ...rec, channel: "email" })), "spcr_recorded_ck");
      await refuses(insertReview(await review({ ...rec, recorded_by: u1, channel: "sms" })), "spcr_channel_ck");
      for (const ch of ["whatsapp", "email", "meeting"]) {
        const r = await insertReview(await review({ ...rec, recorded_by: u1, channel: ch }));
        expect(r.decided_by).toBeNull();
      }
    });

    it("one decision id may cover several reviews, with an undo window; the decision index exists", async () => {
      const decision = newId();
      const until = new Date(Date.now() + 10_000).toISOString();
      await insertReview(await review({ ...decided, decided_by: u2, decision_id: decision, undo_until: until }));
      await insertReview(await review({ ...decided, decided_by: u2, decision_id: decision, undo_until: until }));
      const n = await withTenants([A], (c) => c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM social_post_client_reviews WHERE decision_id = $1`, [decision]));
      expect(Number(n.rows[0]!.n)).toBe(2);
      const r = await adminPool().query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_spcr_decision'`);
      expect(r.rows[0]!.indexdef).toContain("(tenant_id, decision_id) WHERE (decision_id IS NOT NULL)");
    });
  });
});

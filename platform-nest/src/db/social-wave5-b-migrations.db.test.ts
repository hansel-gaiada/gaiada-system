// SCP-5 W5-B1 — 202610301100_social_ideas.sql, 202610301101_social_saved_items.sql and 202610301102_social_audits.sql (BFF §63.25.1,
// §63.26.1, §63.28.2, with §63.30.3's rules_ref) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it (the file-text checks
// at the top always run). initTestDb() hands us a fully migrated database of our own (a copy of the template); the CHECKs, keys and FKs
// are proved through the superuser pool, which bypasses RLS but never a CHECK, a NOT NULL, a unique index or a foreign key; the WALL is
// proved through `withTenants` / `withGlobal` (the runtime role, which RLS binds).
//
// Proves: the files apply onto existing rows and change none of them, and apply again cleanly; every CHECK refuses its bad combination
// and admits its good one, the NULL cases written out; the partial UNIQUEs (and NULLs not colliding); the composite FKs refuse another
// company's row; an unset tenant GUC reads ZERO rows with no error; the third wall (no module scope reads zero, another company never,
// a write into another company refused).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createClient, createCompany, createUser } from "../testing/fixtures";
import { APP_ROLE } from "../testing/db-names";
import { socialModule } from "../modules/social/index";

const FILES = ["202610301100_social_ideas.sql", "202610301101_social_saved_items.sql", "202610301102_social_audits.sql"] as const;
const pathOf = (f: string) => join(__dirname, "..", "..", "migrations", f);
const TABLES = ["social_ideas", "social_saved_items", "social_audits"] as const;

describe("SCP-5 W5-B1 · the migration files (no database needed)", () => {
  it("are registered in the social module, in order, after the monthly report's file", () => {
    const m = socialModule.migrations as string[];
    const at = FILES.map((f) => m.indexOf(f));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at[0]).toBeGreaterThan(m.indexOf("202610291600_social_reports_monthly.sql"));
  });

  it.each(FILES)("%s holds no data change, no grant and no ledger write, takes the third wall, and is LF only", (f) => {
    const sql = readFileSync(pathOf(f), "utf8");
    const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(code).not.toMatch(/set_config|current_tenant_ids/i);
    expect(code).toMatch(/USING \(tenant_id = ANY\(app_current_tenants\(\)\) AND app_module_allowed\(''social''\)\)/);
    expect(code).toMatch(/WITH CHECK \(tenant_id = ANY\(app_current_tenants\(\)\) AND app_module_allowed\(''social''\)\)/);
    expect(code).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/\r/);
  });
});

describe.skipIf(!TEST_URL)("SCP-5 W5-B1 · social_ideas, social_saved_items, social_audits", () => {
  let A: string;
  let C: string;
  let user: string;
  let user2: string;
  let engA: string;
  let engA2: string;
  let engC: string;
  let cycleA: string;
  let cycleC: string;
  let reportA: string;
  let reportC: string;
  let assetA: string;
  let assetC: string;
  let postC: string;
  const db = () => adminPool();
  const q = (sql: string, params: unknown[] = []) => db().query(sql, params);
  const refusedWith = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };
  const CHECK = "23514";
  const NOT_NULL = "23502";
  const FK = "23503";
  const UNIQUE = "23505";

  async function engagement(tenant: string, name: string): Promise<string> {
    const id = newId();
    const client = await createClient(tenant, name);
    await q(`INSERT INTO social_engagements (id, tenant_id, client_id, name) VALUES ($1, $2, $3, 'Mock engagement')`, [id, tenant, client]);
    return id;
  }
  async function cycle(tenant: string, eng: string, month: string): Promise<string> {
    const id = newId();
    await q(`INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by) VALUES ($1, $2, $3, $4::date, $4::date, $4::date)`,
      [id, tenant, eng, month]);
    return id;
  }
  async function post(tenant = A, eng = () => engA, cyc: string | null = null): Promise<string> {
    const id = newId();
    await q(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, cycle_id) VALUES ($1, $2, $3, 'Mock post', $4)`, [id, tenant, eng(), cyc]);
    return id;
  }
  async function report(tenant: string, eng: string): Promise<string> {
    const id = newId();
    await q(`INSERT INTO social_reports (id, tenant_id, engagement_id, period) VALUES ($1, $2, $3, '2026-09')`, [id, tenant, eng]);
    return id;
  }
  async function asset(tenant: string): Promise<string> {
    return (await q(`INSERT INTO creative_assets (tenant_id, name, grade, graded_key, origin_site) VALUES ($1, 'Mock asset', '{}'::jsonb, 'k/mock', 'central') RETURNING id`,
      [tenant])).rows[0].id;
  }
  /** A row of `table` from the default columns, `over` replacing columns by SQL literals ("NULL" drops nothing: it writes NULL). */
  async function insert(table: string, base: Record<string, string>, over: Record<string, string>): Promise<string> {
    const id = newId();
    const cols: Record<string, string> = { id: `'${id}'`, ...base, ...over };
    await q(`INSERT INTO ${table} (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
    return id;
  }
  const idea = (over: Record<string, string> = {}) =>
    insert("social_ideas", { tenant_id: `'${A}'`, engagement_id: `'${engA}'`, saw: "'Reels doubled reach'", metric: "'Reach +40%'",
      suggestion: "'Two reels a week'", created_by: `'${user}'` }, over);
  /** The four planned columns for `postId` in cycleA. */
  const planned = (postId: string, cyc = () => cycleA) => ({ status: "'planned'", post_id: `'${postId}'`, cycle_id: `'${cyc()}'`,
    planned_at: "now()", planned_by: `'${user}'` });
  const saved = (over: Record<string, string> = {}) =>
    insert("social_saved_items", { tenant_id: `'${A}'`, engagement_id: `'${engA}'`, holds: "'text'", category: "'captions'",
      title: "'Mock caption'", body: "'Hello there'", created_by: `'${user}'` }, over);
  const asAsset = (over: Record<string, string> = {}) =>
    saved({ holds: "'asset'", category: "'photos'", body: "NULL", asset_group_id: `'${assetA}'`, ...over });
  const asLink = (over: Record<string, string> = {}) =>
    saved({ holds: "'link'", category: "'references'", body: "NULL", url: "'https://drive.example.test/x'", source: "'client'", ...over });
  const audit = (over: Record<string, string> = {}) =>
    insert("social_audits", { tenant_id: `'${A}'`, subject: "'client'", engagement_id: `'${engA}'`, month: "'2026-09-01'",
      rules_ref: "'default:scp-5a'", created_by: `'${user}'` }, over);
  const prospect = (over: Record<string, string> = {}) =>
    audit({ subject: "'prospect'", engagement_id: "NULL", month: "NULL", prospect_name: "'Mock Prospect Cafe'", ...over });
  const final = (): Record<string, string> => ({ status: "'final'", finalized_at: "now()", finalized_by: `'${user}'`, frozen: `'{"dimensions": []}'::jsonb`,
    overall: "62", band: "'fair'" });

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency", ["social"]);
    C = await createCompany("Mock Other", ["social"]);
    user = await createUser("w5b1-mig@mock.test", "Mock Officer");
    user2 = await createUser("w5b1-mig2@mock.test", "Mock Lead");
    engA = await engagement(A, "Mock Client A");
    engA2 = await engagement(A, "Mock Client A2");
    engC = await engagement(C, "Mock Client C");
    cycleA = await cycle(A, engA, "2026-11-01");
    cycleC = await cycle(C, engC, "2026-11-01");
    reportA = await report(A, engA);
    reportC = await report(C, engC);
    assetA = await asset(A);
    assetC = await asset(C);
    postC = await post(C, () => engC, cycleC);
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  // ── Rollout: the files land on a database that already holds rows, and change none of them ─────────────────────────────────
  it("applies onto existing posts, reports and assets (objects dropped first), changes none of them, and applies again cleanly", async () => {
    await post(A, () => engA, cycleA);
    const snapshot = async () => {
      const out: Record<string, unknown[]> = {};
      for (const t of ["social_posts", "social_reports", "creative_assets", "social_engagements", "social_cycles"]) {
        out[t] = (await q(`SELECT to_jsonb(r) AS j FROM ${t} r ORDER BY id`)).rows.map((r) => r.j);
      }
      return out;
    };
    const before = await snapshot();
    expect(before.social_posts.length).toBeGreaterThanOrEqual(2);
    expect(before.social_reports.length).toBeGreaterThanOrEqual(2);
    expect(before.creative_assets.length).toBeGreaterThanOrEqual(2);
    // Back to the state before W5-B1: no new tables, no FK on idea_id, no (id, tenant_id) keys on reports and assets.
    await q(`DROP TABLE social_audits, social_saved_items, social_ideas CASCADE`);
    await q(`DROP INDEX ux_social_posts_idea`);
    await q(`ALTER TABLE social_reports DROP CONSTRAINT ux_social_reports_id_tenant`);
    await q(`ALTER TABLE creative_assets DROP CONSTRAINT ux_creative_assets_id_tenant`);
    for (const f of FILES) await q(readFileSync(pathOf(f), "utf8")); // each file's own DO block asserts its catalogue
    // The harness grants the runtime role DML on every table once, after the template migrates (global-setup.ts); tables re-created here
    // by the superuser get no such grant, so restore exactly that harness step (live grants come from the owner's default privileges).
    await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON social_ideas, social_saved_items, social_audits TO ${APP_ROLE}`);
    expect(await snapshot()).toEqual(before);
    for (const f of FILES) await q(readFileSync(pathOf(f), "utf8"));
    expect(await snapshot()).toEqual(before);
  });

  // ── social_ideas ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("social_ideas", () => {
    it("admits each good shape: proposed (metric optional), shared, planned (from proposed or shared), a soft-deleted one", async () => {
      const id = await idea({ metric: "NULL", report_id: `'${reportA}'` });
      const r = (await q(`SELECT status, metric, report_id FROM social_ideas WHERE id = $1`, [id])).rows[0];
      expect(r).toEqual({ status: "proposed", metric: null, report_id: reportA });
      await idea({ status: "'shared'", shared_at: "now()", shared_by: `'${user}'` });
      await idea(planned(await post()));
      await idea({ ...planned(await post()), shared_at: "now()", shared_by: `'${user2}'` });
      await idea({ status: "'shared'", shared_at: "now()", shared_by: `'${user}'`, deleted_at: "now()", deleted_by: `'${user}'` });
      await idea({ saw: `'${"s".repeat(500)}'`, metric: `'${"m".repeat(300)}'`, suggestion: `'${"g".repeat(500)}'` });
    });

    it("refuses a bad status and the NULL ones (status, saw, suggestion, engagement, created_by)", async () => {
      await refusedWith(idea({ status: "'archived'" }), CHECK);
      for (const col of ["status", "saw", "suggestion", "engagement_id", "created_by"]) await refusedWith(idea({ [col]: "NULL" }), NOT_NULL);
    });

    it("planned exactly when it has a post; post, cycle, planned_at and planned_by all or none", async () => {
      const p = await post();
      await refusedWith(idea({ status: "'planned'" }), CHECK); // planned, nothing set (post NULL)
      await refusedWith(idea({ ...planned(p), status: "'proposed'" }), CHECK); // a post on a proposed idea
      await refusedWith(idea({ ...planned(p), status: "'shared'", shared_at: "now()", shared_by: `'${user}'` }), CHECK);
      await refusedWith(idea({ ...planned(p), cycle_id: "NULL" }), CHECK); // post without cycle
      await refusedWith(idea({ cycle_id: `'${cycleA}'` }), CHECK); // cycle without post
      await refusedWith(idea({ ...planned(p), planned_at: "NULL" }), CHECK);
      await refusedWith(idea({ ...planned(p), planned_by: "NULL" }), CHECK);
      await refusedWith(idea({ planned_at: "now()" }), CHECK); // planned_at without post
      await refusedWith(idea({ planned_by: `'${user}'` }), CHECK); // planned_by without post
    });

    it("shared_at and shared_by together; shared needs shared_at; deleted_at and deleted_by together; a planned idea is never deleted", async () => {
      await refusedWith(idea({ shared_at: "now()" }), CHECK);
      await refusedWith(idea({ shared_by: `'${user}'` }), CHECK);
      await refusedWith(idea({ status: "'shared'" }), CHECK); // both NULL
      await refusedWith(idea({ deleted_at: "now()" }), CHECK);
      await refusedWith(idea({ deleted_by: `'${user}'` }), CHECK);
      await refusedWith(idea({ ...planned(await post()), deleted_at: "now()", deleted_by: `'${user}'` }), CHECK);
    });

    it("refuses the lengths: empty and too long", async () => {
      for (const over of <Record<string, string>[]>[{ saw: "''" }, { saw: `'${"s".repeat(501)}'` }, { metric: "''" }, { metric: `'${"m".repeat(301)}'` },
        { suggestion: "''" }, { suggestion: `'${"g".repeat(501)}'` }]) {
        await refusedWith(idea(over), CHECK);
      }
    });

    it("every composite FK refuses another company's row and an unknown one", async () => {
      await refusedWith(idea({ engagement_id: `'${engC}'` }), FK);
      await refusedWith(idea({ report_id: `'${reportC}'` }), FK);
      await refusedWith(idea({ report_id: `'${newId()}'` }), FK);
      await refusedWith(idea({ ...planned(postC), cycle_id: `'${cycleA}'` }), FK); // C's post
      await refusedWith(idea(planned(await post(), () => cycleC)), FK); // C's cycle
    });

    it("one idea per post (ux_social_ideas_post); ideas with no post never collide", async () => {
      const p = await post();
      await idea(planned(p));
      await refusedWith(idea(planned(p)), UNIQUE);
      await idea();
      await idea();
    });

    it("social_posts.idea_id: the FK carries the tenant, and one post per idea (ux_social_posts_idea)", async () => {
      const mine = await idea();
      const theirs = await insert("social_ideas", { tenant_id: `'${C}'`, engagement_id: `'${engC}'`, saw: "'x'", suggestion: "'y'",
        created_by: `'${user}'` }, {});
      const p = await post();
      await q(`UPDATE social_posts SET idea_id = $1 WHERE id = $2`, [mine, p]);
      await refusedWith(q(`UPDATE social_posts SET idea_id = $1 WHERE id = $2`, [mine, await post()]), UNIQUE);
      await refusedWith(q(`UPDATE social_posts SET idea_id = $1 WHERE id = $2`, [theirs, await post()]), FK);
      await refusedWith(q(`UPDATE social_posts SET idea_id = $1 WHERE id = $2`, [newId(), await post()]), FK);
      // Both pointers, as "Add to next plan" writes them; and the post's NULL idea_id never collides.
      const both = await post(A, () => engA, cycleA);
      const linked = await idea(planned(both));
      await q(`UPDATE social_posts SET idea_id = $1 WHERE id = $2`, [linked, both]);
      await post();
      await post();
      // The idea a post points at cannot be removed from under it.
      await refusedWith(q(`DELETE FROM social_ideas WHERE id = $1`, [mine]), FK);
    });
  });

  // ── social_saved_items ─────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("social_saved_items", () => {
    it("admits each kind's good shape", async () => {
      await saved();
      await saved({ holds: "'text'", category: "'templates'", pillar: "'Behind the scenes'", body: `'${"b".repeat(5000)}'`, title: `'${"t".repeat(120)}'` });
      await asAsset();
      await asLink();
      await asLink({ media: "'video'", url: "'http://drive.example.test/v'" });
      await asLink({ media: "'photo'", source: "'ai'", ai_note: "'Generated, then retouched'" });
      await saved({ use_count: "3", last_used_at: "now()", last_used_post_id: `'${await post()}'` });
      await saved({ category: "'my_category_2'", deleted_at: "now()", deleted_by: `'${user}'`, updated_by: `'${user2}'` });
      const r = (await q(`SELECT use_count, last_used_at FROM social_saved_items WHERE id = $1`, [await saved()])).rows[0];
      expect(r).toEqual({ use_count: 0, last_used_at: null });
    });

    it("refuses a bad holds, a bad category and the NULL ones", async () => {
      await refusedWith(saved({ holds: "'video'" }), CHECK);
      for (const c of ["'Photos'", "'1photos'", "''", "'with space'", `'${"c".repeat(41)}'`]) await refusedWith(saved({ category: c }), CHECK);
      await saved({ category: `'${"c".repeat(40)}'` });
      for (const col of ["holds", "category", "title", "use_count", "engagement_id", "created_by"]) await refusedWith(saved({ [col]: "NULL" }), NOT_NULL);
    });

    it("asset: the group is required and nothing of a link or a text may be set", async () => {
      await refusedWith(asAsset({ asset_group_id: "NULL" }), CHECK);
      for (const over of <Record<string, string>[]>[{ url: "'https://x.test/a'" }, { body: "'text'" }, { media: "'photo'" }, { source: "'own'" }, { ai_note: "'note'" }]) {
        await refusedWith(asAsset(over), CHECK);
      }
    });

    it("link: url and source are required, no group and no body; media photo, video or NULL; http(s) only", async () => {
      await refusedWith(asLink({ url: "NULL" }), CHECK);
      await refusedWith(asLink({ source: "NULL" }), CHECK);
      await refusedWith(asLink({ asset_group_id: `'${assetA}'` }), CHECK);
      await refusedWith(asLink({ body: "'text'" }), CHECK);
      await refusedWith(asLink({ media: "'audio'" }), CHECK);
      await refusedWith(asLink({ url: "'ftp://drive.example.test/x'" }), CHECK);
      await refusedWith(asLink({ url: `'https://x.test/${"u".repeat(490)}'` }), CHECK);
      await refusedWith(asLink({ source: "'web'" }), CHECK);
    });

    it("text: the body is required and nothing of an asset or a link may be set", async () => {
      await refusedWith(saved({ body: "NULL" }), CHECK);
      for (const over of <Record<string, string>[]>[{ url: "'https://x.test/a'" }, { asset_group_id: `'${assetA}'` }, { media: "'photo'" }, { source: "'own'" }, { ai_note: "'n'" }]) {
        await refusedWith(saved(over), CHECK);
      }
    });

    it("an AI source needs its note; use_count >= 0; last_used_at with its post; deleted_at with deleted_by; the lengths", async () => {
      await refusedWith(asLink({ source: "'ai'" }), CHECK); // ai_note NULL
      await refusedWith(saved({ use_count: "-1" }), CHECK);
      await refusedWith(saved({ last_used_at: "now()" }), CHECK);
      await refusedWith(saved({ last_used_post_id: `'${await post()}'` }), CHECK);
      await refusedWith(saved({ deleted_at: "now()" }), CHECK);
      await refusedWith(saved({ deleted_by: `'${user}'` }), CHECK);
      for (const over of <Record<string, string>[]>[{ title: "''" }, { title: `'${"t".repeat(121)}'` }, { body: "''" }, { body: `'${"b".repeat(5001)}'` },
        { pillar: `'${"p".repeat(61)}'` }]) {
        await refusedWith(saved(over), CHECK);
      }
      await refusedWith(asLink({ ai_note: `'${"n".repeat(1001)}'` }), CHECK);
    });

    it("the composite FKs refuse another company's asset group, post and engagement", async () => {
      await refusedWith(asAsset({ asset_group_id: `'${assetC}'` }), FK);
      await refusedWith(saved({ last_used_at: "now()", last_used_post_id: `'${postC}'` }), FK);
      await refusedWith(saved({ engagement_id: `'${engC}'` }), FK);
    });

    it("one live asset item per client and group (ux_social_saved_items_asset); a deleted one, another client and links do not collide", async () => {
      const group = await asset(A);
      const first = await asAsset({ asset_group_id: `'${group}'` });
      await refusedWith(asAsset({ asset_group_id: `'${group}'`, category: "'references'" }), UNIQUE);
      await asAsset({ asset_group_id: `'${group}'`, engagement_id: `'${engA2}'` });
      await q(`UPDATE social_saved_items SET deleted_at = now(), deleted_by = $1 WHERE id = $2`, [user, first]);
      await asAsset({ asset_group_id: `'${group}'` });
      await asLink();
      await asLink();
    });
  });

  // ── social_audits ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("social_audits", () => {
    it("admits each good shape: a client's draft and final, a prospect's draft, attached and final, a summary", async () => {
      const d = await audit({ engagement_id: `'${engA2}'` });
      const r = (await q(`SELECT status, scores, public_numbers, simulated, overall, band FROM social_audits WHERE id = $1`, [d])).rows[0];
      expect(r).toEqual({ status: "draft", scores: {}, public_numbers: {}, simulated: false, overall: null, band: null });
      await audit({ ...final(), simulated: "true", business_type: "'cafe'", rules_ref: "'company:3'" });
      await audit({ ...final(), band: "'needs_work'", overall: "0" });
      await prospect({ public_numbers: `'{"followers": 1200}'::jsonb`, business_type: "'cafe'" });
      await prospect({ engagement_id: `'${engA}'` });
      await prospect({ ...final(), overall: "100", band: "'strong'", summary: "'Strong start.'", summary_via: "'ai'" });
      await audit({ engagement_id: `'${engA2}'`, ...final(), summary: `'${"s".repeat(3000)}'`, summary_via: "'typed'" });
      await prospect({ prospect_name: `'${"p".repeat(200)}'`, business_type: `'${"b".repeat(60)}'` });
    });

    it("refuses a bad subject, status, summary_via and band, and the NULL ones", async () => {
      await refusedWith(audit({ subject: "'lead'" }), CHECK);
      await refusedWith(audit({ status: "'archived'" }), CHECK);
      await refusedWith(audit({ summary: "'x'", summary_via: "'human'" }), CHECK);
      await refusedWith(audit({ ...final(), band: "'Strong'" }), CHECK);
      for (const col of ["subject", "status", "rules_ref", "public_numbers", "scores", "simulated", "created_by"]) {
        await refusedWith(audit({ [col]: "NULL" }), NOT_NULL);
      }
    });

    it("a client: engagement and month required, no prospect name, no public numbers", async () => {
      await refusedWith(audit({ engagement_id: "NULL" }), CHECK);
      await refusedWith(audit({ month: "NULL" }), CHECK);
      await refusedWith(audit({ prospect_name: "'Mock'" }), CHECK);
      await refusedWith(audit({ public_numbers: `'{"followers": 1}'::jsonb` }), CHECK);
    });

    it("a prospect: the name required, no month; the month is the first of a month", async () => {
      await refusedWith(prospect({ prospect_name: "NULL" }), CHECK);
      await refusedWith(prospect({ month: "'2026-09-01'" }), CHECK);
      await refusedWith(audit({ engagement_id: `'${engA2}'`, month: "'2026-09-15'" }), CHECK);
    });

    it("final exactly when finalized_at, finalized_by and frozen are all set; overall only when final, with its band", async () => {
      for (const missing of ["finalized_at", "finalized_by", "frozen"]) await refusedWith(audit({ ...final(), [missing]: "NULL" }), CHECK);
      await refusedWith(prospect({ finalized_at: "now()" }), CHECK);
      await refusedWith(prospect({ finalized_by: `'${user}'` }), CHECK);
      await refusedWith(prospect({ frozen: "'{}'::jsonb" }), CHECK);
      await refusedWith(prospect({ overall: "50", band: "'fair'" }), CHECK); // a draft with an overall
      await refusedWith(audit({ ...final(), band: "NULL" }), CHECK);
      await refusedWith(audit({ ...final(), overall: "NULL" }), CHECK);
      await refusedWith(audit({ ...final(), overall: "101" }), CHECK);
      await refusedWith(audit({ ...final(), overall: "-1" }), CHECK);
    });

    it("summary with its via; deleted_at with deleted_by; a final audit is never deleted; the lengths and JSON shapes", async () => {
      await refusedWith(prospect({ summary: "'x'" }), CHECK);
      await refusedWith(prospect({ summary_via: "'typed'" }), CHECK);
      await refusedWith(prospect({ summary: `'${"s".repeat(3001)}'`, summary_via: "'typed'" }), CHECK);
      await refusedWith(prospect({ deleted_at: "now()" }), CHECK);
      await refusedWith(prospect({ deleted_by: `'${user}'` }), CHECK);
      await refusedWith(prospect({ ...final(), deleted_at: "now()", deleted_by: `'${user}'` }), CHECK);
      await prospect({ deleted_at: "now()", deleted_by: `'${user}'` });
      await refusedWith(prospect({ prospect_name: "''" }), CHECK);
      await refusedWith(prospect({ prospect_name: `'${"p".repeat(201)}'` }), CHECK);
      await refusedWith(prospect({ business_type: `'${"b".repeat(61)}'` }), CHECK);
      await refusedWith(prospect({ public_numbers: "'[]'::jsonb" }), CHECK);
      await refusedWith(prospect({ scores: "'null'::jsonb" }), CHECK);
      await refusedWith(prospect({ ...final(), frozen: "'[]'::jsonb" }), CHECK);
    });

    it("rules_ref is 'company:<version>' (1 or more) or 'default:<defaultsVersion>'", async () => {
      for (const ok of ["'company:1'", "'company:42'", "'default:scp-5a'", "'default:2026.10.30'"]) await prospect({ rules_ref: ok });
      for (const bad of ["''", "'company:0'", "'company:'", "'company:01'", "'default:'", "'v1'", "'company:1 '"]) {
        await refusedWith(prospect({ rules_ref: bad }), CHECK);
      }
    });

    it("the composite FK refuses another company's engagement", async () => {
      await refusedWith(audit({ engagement_id: `'${engC}'` }), FK);
      await refusedWith(prospect({ engagement_id: `'${engC}'` }), FK);
    });

    it("one live draft per client (ux_social_audits_client_draft); finals, a deleted draft and prospects do not collide", async () => {
      const eng = await engagement(A, "Mock Client Draft");
      const first = await audit({ engagement_id: `'${eng}'` });
      await refusedWith(audit({ engagement_id: `'${eng}'`, month: "'2026-08-01'" }), UNIQUE);
      await audit({ engagement_id: `'${eng}'`, ...final() });
      await audit({ engagement_id: `'${eng}'`, ...final(), month: "'2026-08-01'" });
      await q(`UPDATE social_audits SET deleted_at = now(), deleted_by = $1 WHERE id = $2`, [user, first]);
      await audit({ engagement_id: `'${eng}'` });
      await prospect({ engagement_id: `'${eng}'` });
      await prospect({ engagement_id: `'${eng}'` });
      await prospect();
      await prospect();
    });
  });

  // ── The third wall, on all three ────────────────────────────────────────────────────────────────────────────────────────────
  describe("the third wall", () => {
    const ids: Record<string, { mine: string; theirs: string }> = {};
    beforeAll(async () => {
      ids.social_ideas = {
        mine: await idea(),
        theirs: await insert("social_ideas", { tenant_id: `'${C}'`, engagement_id: `'${engC}'`, saw: "'x'", suggestion: "'y'", created_by: `'${user}'` }, {}),
      };
      ids.social_saved_items = {
        mine: await saved(),
        theirs: await insert("social_saved_items", { tenant_id: `'${C}'`, engagement_id: `'${engC}'`, holds: "'text'", category: "'captions'",
          title: "'t'", body: "'b'", created_by: `'${user}'` }, {}),
      };
      ids.social_audits = {
        mine: await prospect(),
        theirs: await insert("social_audits", { tenant_id: `'${C}'`, subject: "'prospect'", prospect_name: "'p'", rules_ref: "'default:scp-5a'",
          created_by: `'${user}'` }, {}),
      };
    });

    it.each(TABLES)("%s: RLS enabled and forced, one policy", async (t) => {
      const r = (await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`, [t])).rows[0];
      expect(r).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect(Number((await q(`SELECT count(*) FROM pg_policies WHERE tablename = $1`, [t])).rows[0].count)).toBe(1);
    });

    it.each(TABLES)("%s: an unset GUC reads ZERO rows with no error; no module scope reads zero; a company reads only its own", async (t) => {
      const both = [ids[t].mine, ids[t].theirs];
      const count = `SELECT count(*)::int AS n FROM ${t} WHERE id = ANY($1::uuid[])`;
      expect((await q(count, [both])).rows[0].n, "truth, as the superuser").toBe(2);
      const unset = await withGlobal((c) => c.query<{ n: number }>(count, [both]));
      expect(unset.rows[0].n, "unset GUC").toBe(0);
      const noModule = await withTenants([A], (c) => c.query<{ n: number }>(count, [both]));
      expect(noModule.rows[0].n, "no module scope").toBe(0);
      const scoped = await withTenants([A], (c) => c.query<{ id: string }>(`SELECT id::text AS id FROM ${t} WHERE id = ANY($1::uuid[])`, [both]),
        { modules: ["social"] });
      expect(scoped.rows).toEqual([{ id: ids[t].mine }]);
      const other = await withTenants([C], (c) => c.query<{ id: string }>(`SELECT id::text AS id FROM ${t} WHERE id = ANY($1::uuid[])`, [both]),
        { modules: ["social"] });
      expect(other.rows).toEqual([{ id: ids[t].theirs }]);
      // Neither an update nor a delete reaches the other company's row.
      const touched = await withTenants([A], (c) => c.query(`UPDATE ${t} SET updated_at = now() WHERE id = $1`, [ids[t].theirs]), { modules: ["social"] });
      expect(touched.rowCount).toBe(0);
    });

    it("a write into another company is refused by WITH CHECK", async () => {
      await expect(withTenants([A], (c) => c.query(
        `INSERT INTO social_ideas (tenant_id, engagement_id, saw, suggestion, created_by) VALUES ($1, $2, 'x', 'y', $3)`, [C, engC, user]),
      { modules: ["social"] })).rejects.toMatchObject({ code: "42501" });
      await expect(withTenants([A], (c) => c.query(
        `INSERT INTO social_saved_items (tenant_id, engagement_id, holds, category, title, body, created_by) VALUES ($1, $2, 'text', 'captions', 't', 'b', $3)`,
        [C, engC, user]), { modules: ["social"] })).rejects.toMatchObject({ code: "42501" });
      await expect(withTenants([A], (c) => c.query(
        `INSERT INTO social_audits (tenant_id, subject, prospect_name, rules_ref, created_by) VALUES ($1, 'prospect', 'p', 'default:scp-5a', $2)`,
        [C, user]), { modules: ["social"] })).rejects.toMatchObject({ code: "42501" });
      // And the company's own write, in scope, goes through.
      await withTenants([A], (c) => c.query(
        `INSERT INTO social_audits (tenant_id, subject, prospect_name, rules_ref, created_by) VALUES ($1, 'prospect', 'p', 'default:scp-5a', $2)`,
        [A, user]), { modules: ["social"] });
    });
  });

  // ── Re-run with rows in every table ─────────────────────────────────────────────────────────────────────────────────────────
  it("applying the three files again changes no row of the new tables or of the tables they touch", async () => {
    const snapshot = async () => {
      const out: Record<string, unknown[]> = {};
      for (const t of [...TABLES, "social_posts", "social_reports", "creative_assets"]) {
        out[t] = (await q(`SELECT to_jsonb(r) AS j FROM ${t} r ORDER BY id`)).rows.map((r) => r.j);
      }
      return out;
    };
    const before = await snapshot();
    for (const t of TABLES) expect(before[t].length, t).toBeGreaterThan(3);
    for (const f of FILES) await q(readFileSync(pathOf(f), "utf8"));
    expect(await snapshot()).toEqual(before);
  });
});

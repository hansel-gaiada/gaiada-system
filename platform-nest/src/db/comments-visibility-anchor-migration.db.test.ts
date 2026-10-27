// SCP-1l — 202610271300_comments_visibility_anchor.sql (BFF §63.1 file 3) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped
// without it (the file-text checks at the top always run). initTestDb() hands us a fully migrated database; the CHECKs are
// proved through the superuser pool, which bypasses RLS but never a CHECK, and the file is re-applied the way CI's sync-engine-go
// job applies every migration: plain `psql -f` semantics, no ledger (here: one multi-statement simple query).
//
// Proves: every CHECK refuses its bad case and admits its good one, NULL cases included (a pin missing a key is refused, never
// waved through by a NULL); a row written by today's insert (no visibility, no anchor) reads 'team' and NULL; the file applies
// again without error and changes nothing; the index and the wall are as the file says.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { socialModule } from "../modules/social/index";

const MIGRATION = "202610271300_comments_visibility_anchor.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);
const FILE = "11111111-1111-4111-8111-111111111111";

describe("SCP-1l · the migration file (no database needed)", () => {
  const sql = readFileSync(PATH, "utf8");
  const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

  it("is registered in the social module", () => {
    expect(socialModule.migrations).toContain(MIGRATION);
  });

  it("holds no data changes, no grant and no ledger write, and is LF only", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(sql).not.toMatch(/\r/);
  });

  it("never counts rows of the FORCE-RLS table (the unset-GUC zero-row trap): it asserts the catalogue", () => {
    expect(code).not.toMatch(/count\(\*\)[^;]*\bFROM\s+comments\b/i);
  });
});

describe.skipIf(!TEST_URL)("SCP-1l · comments visibility and anchor", () => {
  let A: string;
  let author: string;
  const pool = () => adminPool();

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency", ["social"]);
    author = await createUser("scp1l-mig@mock.test", "Mock Author");
  });
  afterAll(async () => { await teardownTestDb(); });

  async function insert(over: { type?: string; visibility?: string; anchor?: unknown; omit?: boolean }) {
    const id = newId();
    const type = over.type ?? "social_post";
    if (over.omit) {
      // What today's insert paths write: no visibility, no anchor.
      await pool().query(
        `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'Mock comment', 'central')`,
        [id, A, author, type, newId()],
      );
    } else {
      await pool().query(
        `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, origin_site, visibility, anchor)
         VALUES ($1, $2, $3, $4, $5, 'Mock comment', 'central', $6, $7::jsonb)`,
        [id, A, author, type, newId(), over.visibility ?? "team", over.anchor === undefined ? null : JSON.stringify(over.anchor)],
      );
    }
    return id;
  }
  const refuses = (p: Promise<unknown>, name: string) => expect(p).rejects.toThrow(new RegExp(`violates check constraint "${name}"`));
  const pin = (over: Record<string, unknown> = {}) => ({ x: 0.25, y: 0.5, fileId: FILE, ...over });

  it("a row written the way today's routes write it reads team and no pin, on any thread", async () => {
    for (const type of ["task", "project", "creative_asset", "social_post"]) {
      const id = await insert({ type, omit: true });
      const r = await pool().query(`SELECT visibility, anchor FROM comments WHERE id = $1`, [id]);
      expect(r.rows[0]).toEqual({ visibility: "team", anchor: null });
    }
  });

  it("visibility is team or client, nothing else", async () => {
    await insert({ visibility: "team" });
    await insert({ visibility: "client" });
    await refuses(insert({ visibility: "everyone" }), "comments_visibility_ck");
    await refuses(insert({ visibility: "" }), "comments_visibility_ck");
    await refuses(insert({ visibility: "CLIENT" }), "comments_visibility_ck");
  });

  it("visibility is NOT NULL", async () => {
    await expect(pool().query(
      `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, origin_site, visibility)
       VALUES ($1, $2, $3, 'social_post', $4, 'x', 'central', NULL)`, [newId(), A, author, newId()],
    )).rejects.toThrow(/null value in column "visibility"/);
  });

  it("a client-visible comment is only for a social_post thread: no other thread can leak to a portal", async () => {
    await insert({ type: "social_post", visibility: "client" });
    for (const type of ["task", "project", "creative_asset", "deal", "invoice"]) {
      await insert({ type, visibility: "team" });
      await refuses(insert({ type, visibility: "client" }), "comments_visibility_scope_ck");
    }
  });

  it("a pin is only for a social_post thread", async () => {
    await insert({ type: "social_post", anchor: pin() });
    await refuses(insert({ type: "task", anchor: pin() }), "comments_anchor_scope_ck");
    await refuses(insert({ type: "creative_asset", anchor: pin() }), "comments_anchor_scope_ck");
    await insert({ type: "task", anchor: undefined }); // NULL anchor is fine anywhere
  });

  it("a pin is {x, y, fileId}: x and y numbers from 0 to 1 (both ends admitted), fileId a string", async () => {
    await insert({ anchor: pin({ x: 0, y: 0 }) });
    await insert({ anchor: pin({ x: 1, y: 1 }) });
    await insert({ anchor: pin({ x: 0.333, y: 0.999 }) });
    await insert({ anchor: undefined });
    const bad: Array<[string, unknown]> = [
      ["x above 1", pin({ x: 1.0001 })],
      ["x below 0", pin({ x: -0.1 })],
      ["y above 1", pin({ y: 2 })],
      ["y below 0", pin({ y: -1 })],
      ["x a string", pin({ x: "0.5" })],
      ["y a string", pin({ y: "0.5" })],
      ["x null", pin({ x: null })],
      ["x missing", { y: 0.5, fileId: FILE }],
      ["y missing", { x: 0.5, fileId: FILE }],
      ["fileId missing", { x: 0.5, y: 0.5 }],
      ["fileId a number", pin({ fileId: 7 })],
      ["fileId null", pin({ fileId: null })],
      ["an empty object", {}],
      ["an array", [0.5, 0.5, FILE]],
      ["a string", "pin"],
      ["a number", 0.5],
      ["a JSON null", null],
    ];
    for (const [label, anchor] of bad) {
      // `insert` maps undefined to SQL NULL; a JSON null must reach the column as the jsonb value, so send it explicitly.
      const p = anchor === null
        ? pool().query(
            `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, origin_site, visibility, anchor)
             VALUES ($1, $2, $3, 'social_post', $4, 'x', 'central', 'team', 'null'::jsonb)`, [newId(), A, author, newId()],
          )
        : insert({ anchor });
      await expect(p, label).rejects.toThrow(/violates check constraint "comments_anchor_shape_ck"/);
    }
  });

  it("an UPDATE is held to the same checks", async () => {
    const id = await insert({ type: "task" });
    await expect(pool().query(`UPDATE comments SET visibility = 'client' WHERE id = $1`, [id])).rejects.toThrow(/comments_visibility_scope_ck/);
    await expect(pool().query(`UPDATE comments SET anchor = $2::jsonb WHERE id = $1`, [id, JSON.stringify(pin())])).rejects.toThrow(/comments_anchor_scope_ck/);
    const sp = await insert({ type: "social_post" });
    await pool().query(`UPDATE comments SET visibility = 'client', anchor = $2::jsonb WHERE id = $1`, [sp, JSON.stringify(pin())]);
    const r = await pool().query(`SELECT visibility, anchor FROM comments WHERE id = $1`, [sp]);
    expect(r.rows[0]).toEqual({ visibility: "client", anchor: pin() });
  });

  it("the index is on the thread read, partial on live rows", async () => {
    const r = await pool().query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'comments' AND indexname = 'ix_comments_target'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].indexdef).toContain("(tenant_id, target_entity_type, target_entity_id, created_at)");
    expect(r.rows[0].indexdef).toContain("WHERE (deleted_at IS NULL)");
  });

  it("applies again on its own with plain psql semantics, changes no row, and leaves one of each constraint and the wall", async () => {
    const id = await insert({ type: "social_post", visibility: "client", anchor: pin() });
    const before = await pool().query(`SELECT visibility, anchor, body FROM comments WHERE id = $1`, [id]);
    await pool().query(readFileSync(PATH, "utf8"));
    const after = await pool().query(`SELECT visibility, anchor, body FROM comments WHERE id = $1`, [id]);
    expect(after.rows).toEqual(before.rows);
    const cons = await pool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'comments'::regclass AND conname LIKE 'comments\\_%\\_ck' ORDER BY conname`,
    );
    expect(cons.rows.map((x) => x.conname)).toEqual([
      "comments_anchor_scope_ck", "comments_anchor_shape_ck", "comments_visibility_ck", "comments_visibility_scope_ck",
    ]);
    const wall = await pool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'comments'::regclass`);
    expect(wall.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

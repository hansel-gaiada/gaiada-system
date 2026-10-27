// SCP-1h — 202610271400_creative_assets_source.sql (BFF §63.1 file 4) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it (the
// file-text checks at the top always run). initTestDb() hands us a fully migrated database; the CHECKs are proved through the superuser pool, which
// bypasses RLS but never a CHECK, and the file is re-applied the way CI's sync-engine-go job applies every migration: plain `psql -f` semantics,
// no ledger (here: one multi-statement simple query).
//
// Proves: the default (`unknown`, no note), each CHECK refuses its bad case and admits its good one (NULL cases included: a NULL source is refused,
// never waved through, and an AI row with no note is refused whatever the note's shape), a new version starts `unknown` whatever the version it
// replaces was, an UPDATE is held to the same checks, and the file applies again without error, changes nothing and leaves one of each constraint.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { socialModule } from "../modules/social/index";

const MIGRATION = "202610271400_creative_assets_source.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);

describe("SCP-1h · the migration file (no database needed)", () => {
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
    expect(code).not.toMatch(/count\(\*\)[^;]*\bFROM\s+creative_assets\b/i);
  });

  it("declares exactly the contract's columns and CHECKs", () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'unknown'/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS ai_note text/);
    expect(code).toMatch(/CHECK \(source IN \('own', 'client', 'stock', 'ai', 'unknown'\)\)/);
    expect(code).toMatch(/CHECK \(ai_note IS NULL OR char_length\(ai_note\) BETWEEN 1 AND 1000\)/);
    expect(code).toMatch(/CHECK \(source <> 'ai' OR ai_note IS NOT NULL\)/);
  });
});

describe.skipIf(!TEST_URL)("SCP-1h · creative_assets source and ai_note", () => {
  let A: string;
  let uploader: string;
  const pool = () => adminPool();

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency", ["social"]);
    uploader = await createUser("scp1h-mig@mock.test", "Mock Designer");
  });
  afterAll(async () => { await teardownTestDb(); });

  /** One live asset row, with only the columns a save wrote before this file existed, plus what the case sets. */
  async function insert(over: { source?: string | null; aiNote?: string | null; omit?: boolean; group?: string; versionNo?: number; supersedes?: string } = {}) {
    const id = newId();
    const cols = ["id", "tenant_id", "uploader_id", "name", "content_type", "grade", "graded_key", "graded_byte_size", "origin_site"];
    const vals: unknown[] = [id, A, uploader, "Mock picture", "image/webp", "{}", `mock/${id}`, 10, "central"];
    if (over.group) { cols.push("version_group_id", "version_no", "supersedes_id"); vals.push(over.group, over.versionNo ?? 2, over.supersedes ?? over.group); }
    if (!over.omit) {
      if ("source" in over) { cols.push("source"); vals.push(over.source); }
      if ("aiNote" in over) { cols.push("ai_note"); vals.push(over.aiNote); }
    }
    await pool().query(
      `INSERT INTO creative_assets (${cols.join(", ")}) VALUES (${cols.map((c, i) => (c === "grade" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ")})`,
      vals,
    );
    return id;
  }
  const read = async (id: string) => (await pool().query(`SELECT source, ai_note FROM creative_assets WHERE id = $1`, [id])).rows[0] as { source: string; ai_note: string | null };
  const refuses = (p: Promise<unknown>, name: string) => expect(p).rejects.toThrow(new RegExp(`violates check constraint "${name}"`));

  it("a row written the way today's save writes it reads unknown and no note", async () => {
    expect(await read(await insert({ omit: true }))).toEqual({ source: "unknown", ai_note: null });
  });

  it("source is one of the five, nothing else", async () => {
    for (const source of ["own", "client", "stock", "unknown"]) expect((await read(await insert({ source }))).source).toBe(source);
    expect(await read(await insert({ source: "ai", aiNote: "Made with an image model." }))).toEqual({ source: "ai", ai_note: "Made with an image model." });
    for (const source of ["AI", "", "generated", "Own", " own"]) await refuses(insert({ source }), "creative_assets_source_ck");
  });

  it("source is NOT NULL", async () => {
    await expect(insert({ source: null })).rejects.toThrow(/null value in column "source"/);
  });

  it("an AI asset must carry a note, whatever shape the missing note takes", async () => {
    await refuses(insert({ source: "ai" }), "creative_assets_ai_needs_note_ck");
    await refuses(insert({ source: "ai", aiNote: null }), "creative_assets_ai_needs_note_ck");
    // An empty note is not a note: the length CHECK refuses it first, so no empty string stands in for one.
    await refuses(insert({ source: "ai", aiNote: "" }), "creative_assets_ai_note_ck");
  });

  it("a note is 1 to 1,000 characters, counted as characters (a pair of emoji is two)", async () => {
    expect((await read(await insert({ source: "ai", aiNote: "x" }))).ai_note).toBe("x");
    expect((await read(await insert({ source: "ai", aiNote: "x".repeat(1000) }))).ai_note).toHaveLength(1000);
    expect((await read(await insert({ source: "ai", aiNote: "\u{1F600}".repeat(1000) }))).ai_note).toHaveLength(2000);
    await refuses(insert({ source: "ai", aiNote: "x".repeat(1001) }), "creative_assets_ai_note_ck");
    await refuses(insert({ source: "own", aiNote: "" }), "creative_assets_ai_note_ck");
    await refuses(insert({ source: "own", aiNote: "x".repeat(1001) }), "creative_assets_ai_note_ck");
  });

  it("a note may sit on a non-AI source (the contract forbids no such row)", async () => {
    expect(await read(await insert({ source: "stock", aiNote: "Licensed from a stock library." }))).toEqual({ source: "stock", ai_note: "Licensed from a stock library." });
  });

  it("a new version starts unknown, whatever the version it replaces was", async () => {
    const first = await insert({ source: "ai", aiNote: "Made with an image model." });
    const second = await insert({ omit: true, group: first, versionNo: 2, supersedes: first });
    expect(await read(second)).toEqual({ source: "unknown", ai_note: null });
    expect(await read(first)).toEqual({ source: "ai", ai_note: "Made with an image model." });
    const third = await insert({ source: "own", group: first, versionNo: 3, supersedes: second });
    expect(await read(third)).toEqual({ source: "own", ai_note: null });
  });

  it("an UPDATE is held to the same checks", async () => {
    const id = await insert({ source: "own" });
    await refuses(pool().query(`UPDATE creative_assets SET source = 'ai' WHERE id = $1`, [id]), "creative_assets_ai_needs_note_ck");
    await refuses(pool().query(`UPDATE creative_assets SET source = 'bogus' WHERE id = $1`, [id]), "creative_assets_source_ck");
    await pool().query(`UPDATE creative_assets SET source = 'ai', ai_note = 'Made with an image model.' WHERE id = $1`, [id]);
    await refuses(pool().query(`UPDATE creative_assets SET ai_note = NULL WHERE id = $1`, [id]), "creative_assets_ai_needs_note_ck");
    await pool().query(`UPDATE creative_assets SET source = 'own', ai_note = NULL WHERE id = $1`, [id]);
    expect(await read(id)).toEqual({ source: "own", ai_note: null });
  });

  it("applies again on its own with plain psql semantics, changes no row, and leaves one of each constraint and the wall", async () => {
    const id = await insert({ source: "ai", aiNote: "Made with an image model." });
    const before = await pool().query(`SELECT source, ai_note, name FROM creative_assets WHERE id = $1`, [id]);
    await pool().query(readFileSync(PATH, "utf8"));
    const after = await pool().query(`SELECT source, ai_note, name FROM creative_assets WHERE id = $1`, [id]);
    expect(after.rows).toEqual(before.rows);
    const cons = await pool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'creative_assets'::regclass AND conname IN ('creative_assets_source_ck', 'creative_assets_ai_note_ck', 'creative_assets_ai_needs_note_ck') ORDER BY conname`,
    );
    expect(cons.rows.map((x) => x.conname)).toEqual(["creative_assets_ai_needs_note_ck", "creative_assets_ai_note_ck", "creative_assets_source_ck"]);
    const wall = await pool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'creative_assets'::regclass`);
    expect(wall.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

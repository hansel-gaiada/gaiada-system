// M5-P5b2 — the pull job's ingest script against LIVE Postgres: a run stores rows and one activity; the same input run
// twice is "duplicate" the second time. Skipped without DATABASE_URL_TEST (runs on the Linux gate and in CI).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createClient } from "../testing/fixtures";
import { runIngest, type RunDeps } from "./ai-crawler-ingest";
import { ingestAiCrawlerChunk } from "../modules/search/ai-crawler-store";
import { verifierFromEnv } from "../modules/search/ai-crawler-verify";
import { writeActivity } from "../core/http";

const S = { modules: ["search"] };
const today = new Date().toISOString().slice(0, 10);
const [y, m, d] = today.split("-");
const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
const ts = `${d}/${mon}/${y}:10:00:00 +0000`;
const GPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)";
const LOG = [
  `203.0.113.55 - - [${ts}] "GET /pricing/ HTTP/1.1" 200 100 "-" "${GPT_UA}"`,
  `203.0.113.55 - - [${ts}] "GET /pricing/ HTTP/1.1" 200 100 "-" "${GPT_UA}"`,
].join("\n");

describe.skipIf(!TEST_URL)("M5-P5b2 · ai-crawler-ingest script", () => {
  let A: string;
  let prop: string;
  const deps: RunDeps = {
    ingest: ingestAiCrawlerChunk,
    verifier: verifierFromEnv,
    activity: async (t, p, s, verification) => {
      await writeActivity(t, null, "ai_crawler_ingest", "search_property", p, { ...s, verification, source: "pull" });
    },
  };
  const hits = async (): Promise<number> => {
    const r = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT coalesce(sum(hits),0) AS n FROM search_ai_crawler_daily WHERE property_id = $1`, [prop]), S);
    return Number(r.rows[0]!.n);
  };
  const acts = async (): Promise<number> => {
    const r = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM activities WHERE target_entity_id = $1 AND verb = 'ai_crawler_ingest' AND actor_id IS NULL`, [prop]));
    return Number(r.rows[0]!.n);
  };

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("M5P5b2 Co", ["search"]);
    const client = await createClient(A, "M5P5b2 Client");
    prop = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, verified_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [prop, A, client, "pull.example.com", "https://pull.example.com", new Date("2026-01-01T00:00:00Z")],
    ), S);
  });
  afterAll(async () => { await teardownTestDb(); });

  it("stores rows and one actor-less activity; the same input again is duplicate", async () => {
    const first = await runIngest(LOG, { tenantId: A, propertyId: prop }, deps);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.summary).toMatchObject({ chunks: 1, new: 1, duplicate: 0, rows: 1 });
    expect(await hits()).toBe(2);
    expect(await acts()).toBe(1);

    const second = await runIngest(LOG, { tenantId: A, propertyId: prop }, deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.summary).toMatchObject({ chunks: 1, new: 0, duplicate: 1, rows: 0 });
    expect(await hits()).toBe(2);
  });

  it("an unknown property is no_property", async () => {
    const r = await runIngest(LOG, { tenantId: A, propertyId: newId() }, deps);
    expect(r).toEqual({ ok: false, code: 3, reason: "no_property" });
  });
});

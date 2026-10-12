// M5-P5b — the AI-crawler log against LIVE Postgres + the real HTTP layer (needs DATABASE_URL_TEST and the Cerbos
// env, see platform-nest/CLAUDE.md; skipped without it — NOT run on the dev laptop, runs on the Linux gate).
// Covers: ingest keeps only AI crawlers, NO IP / User-Agent of a human request is persisted anywhere in the two
// tables, a re-ingested chunk changes nothing, a second chunk adds, RLS, the summary reads (words for no data),
// the AI-visibility summary, and the routes (authz kind/action captured, a denial with a VALID body, cross-company,
// a positive control).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";

const calls: Array<{ kind: string; action: string; tenantId?: string }> = [];
let denyAll = false;
let useRealCerbos = false;
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...actual,
    check: vi.fn(async (p: never, resource: { kind: string; tenantId?: string }, action: string, ...rest: unknown[]) => {
      if (useRealCerbos) return (actual.check as (...a: unknown[]) => Promise<unknown>)(p, resource, action, ...rest) as never;
      calls.push({ kind: resource.kind, action, tenantId: resource.tenantId });
      return denyAll ? { allow: false as const, reason: "test-forced-deny" } : { allow: true as const };
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["search"] };
const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const GPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)";
const CLAUDE_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";
const HUMAN_IP = "198.51.100.77";
const BOT_IP = "203.0.113.55";
const today = new Date().toISOString().slice(0, 10);
const stamp = (d: string): string => {
  const [y, m, dd] = d.split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return `${dd}/${mon}/${y}:10:00:00 +0000`;
};
const ln = (ip: string, ua: string, path: string, status = 200, ref = "-") =>
  `${ip} - - [${stamp(today)}] "GET ${path} HTTP/1.1" ${status} 100 "${ref}" "${ua}"`;

describe.skipIf(!TEST_URL)("M5-P5b · AI-crawler log", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let prop: string;
  let emptyProp: string;

  const mkProp = async (domain: string): Promise<string> => {
    const id = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, verified_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, A, clientA, domain, `https://${domain}`, new Date("2026-01-01T00:00:00Z")],
    ), S);
    return id;
  };
  const base = (p: string, t = A): string => `/api/${t}/modules/search/properties/${p}`;
  const ingest = (p: string, log: string, user = uA, t = A) =>
    app.inject({ method: "POST", url: `${base(p, t)}/ai-crawlers/ingest`, headers: asUser(user), payload: { log } });
  const hits = async (p: string): Promise<number> => {
    const r = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT coalesce(sum(hits),0) AS n FROM search_ai_crawler_daily WHERE property_id = $1`, [p]), S);
    return Number(r.rows[0]!.n);
  };

  const chunk1 = [
    ln(HUMAN_IP, HUMAN_UA, "/human-only/?email=person@example.com", 200, "https://www.google.com/search?q=secret"),
    ln(BOT_IP, GPT_UA, "/pricing/?utm_source=x"),
    ln(BOT_IP, GPT_UA, "/pricing/"),
    ln(BOT_IP, GPT_UA, "/admin/", 403),
    ln("203.0.113.56", CLAUDE_UA, "/blog/a/", 200),
    ln("203.0.113.56", CLAUDE_UA, "/gone/", 404),
  ].join("\n");

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("M5P5b Co A", ["search"]);
    C = await createCompany("M5P5b Co C", ["search"]);
    uA = await createUser("m5p5b-a@a.test");
    uC = await createUser("m5p5b-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "M5P5b Client");
    app = await buildApp();
    prop = await mkProp("crawl.example.com");
    emptyProp = await mkProp("empty.example.com");
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });
  beforeEach(() => { calls.length = 0; denyAll = false; useRealCerbos = false; });

  it("summary of a property with no ingest says so in words and has no numbers", async () => {
    const r = await app.inject({ method: "GET", url: `${base(emptyProp)}/ai-crawlers/summary`, headers: asUser(uA) });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { state: string; message: string; totalHits?: number; byBot?: unknown };
    expect(j.state).toBe("no_data");
    expect(j.message).toContain("No AI-crawler log");
    expect(j.totalHits).toBeUndefined();
    expect(j.byBot).toBeUndefined();
  });

  it("ingest keeps only AI crawlers, is MEDIUM-gated by update, and answers counts only", async () => {
    const r = await ingest(prop, chunk1);
    expect(r.statusCode).toBe(200);
    const j = r.json() as { chunk: string; rows: number; stats: { dropped: number; kept: number }; verification: string };
    expect(j).toMatchObject({ chunk: "new", rows: 4, verification: "claimed" });
    expect(j.stats).toMatchObject({ dropped: 1, kept: 5 });
    expect(calls).toContainEqual({ kind: "resource_search_property", action: "update", tenantId: A });
    expect(JSON.stringify(j)).not.toContain(BOT_IP);
    expect(await hits(prop)).toBe(5);
  });

  it("NO IP and no User-Agent of any request, human or bot, is persisted in either table or the activity trail", async () => {
    const dump = await withTenants([A], async (c) => {
      const d = await c.query(`SELECT t::text AS j FROM search_ai_crawler_daily t WHERE property_id = $1`, [prop]);
      const k = await c.query(`SELECT t::text AS j FROM search_ai_crawler_chunks t WHERE property_id = $1`, [prop]);
      const a = await c.query(`SELECT metadata::text AS j FROM activities WHERE target_entity_id = $1 AND verb = 'ai_crawler_ingest'`, [prop]);
      return [...d.rows, ...k.rows, ...a.rows].map((r) => r.j as string).join(" | ");
    }, S);
    expect(dump.length).toBeGreaterThan(0);
    for (const bad of [HUMAN_IP, BOT_IP, "203.0.113.56", "Mozilla", "AppleWebKit", "Chrome", "claudebot@anthropic.com", "human-only", "person@example.com", "google.com", "utm_source", "secret"]) {
      expect(dump, bad).not.toContain(bad);
    }
    // the columns themselves: nothing in either table can hold an IP or a User-Agent
    const cols = await withGlobal((c) => c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('search_ai_crawler_daily','search_ai_crawler_chunks')`));
    expect(cols.rows.map((r) => r.column_name).filter((n) => /ip|agent|ua|referr|line|raw/i.test(n))).toEqual([]);
  });

  it("re-ingesting the same chunk (even with CRLF) is a no-op; a different chunk adds", async () => {
    const again = await ingest(prop, chunk1.replace(/\n/g, "\r\n") + "\r\n");
    expect((again.json() as { chunk: string }).chunk).toBe("duplicate");
    expect(await hits(prop)).toBe(5);
    const more = await ingest(prop, ln(BOT_IP, GPT_UA, "/pricing/"));
    expect((more.json() as { chunk: string }).chunk).toBe("new");
    expect(await hits(prop)).toBe(6);
    const row = await withTenants([A], (c) => c.query<{ hits: number }>(
      `SELECT hits FROM search_ai_crawler_daily WHERE property_id = $1 AND bot = 'GPTBot' AND path = '/pricing/' AND status = 200`, [prop]), S);
    expect(row.rows[0]!.hits).toBe(3);
  });

  it("the summary: by day and bot, by bot, top paths, status mix", async () => {
    const r = await app.inject({ method: "GET", url: `${base(prop)}/ai-crawlers/summary`, headers: asUser(uA) });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { state: string; totalHits: number; byBot: Array<{ bot: string; hits: number; claimed: number }>; topPaths: Array<{ path: string; hits: number }>; statusMix: Array<{ status: number; hits: number }>; byDay: Array<{ day: string; bot: string }> };
    expect(j.state).toBe("ok");
    expect(j.totalHits).toBe(6);
    expect(j.byBot[0]).toMatchObject({ bot: "GPTBot", hits: 4, claimed: 4 });
    expect(j.topPaths[0]).toEqual({ path: "/pricing/", hits: 3 });
    expect(j.statusMix).toEqual([{ status: 200, hits: 4 }, { status: 403, hits: 1 }, { status: 404, hits: 1 }]);
    expect(j.byDay.every((x) => x.day === today)).toBe(true);
    // the path-range form the MCP tool uses
    const rr = await app.inject({ method: "GET", url: `${base(prop)}/ai-crawlers/summary/range/${today}/${today}`, headers: asUser(uA) });
    expect((rr.json() as { totalHits: number }).totalHits).toBe(6);
    // a range with no data is words, not zeros
    const none = await app.inject({ method: "GET", url: `${base(prop)}/ai-crawlers/summary/range/2026-01-01/2026-01-02`, headers: asUser(uA) });
    const nj = none.json() as { state: string; message: string; totalHits?: number };
    expect(nj.state).toBe("no_data_in_range");
    expect(nj.message).toContain("No AI-crawler requests");
    expect(nj.totalHits).toBeUndefined();
    expect((await app.inject({ method: "GET", url: `${base(prop)}/ai-crawlers/summary?from=nope`, headers: asUser(uA) })).statusCode).toBe(400);
  });

  it("RLS: an unset tenant scope, a missing module scope and another company read 0 rows; a cross-tenant write is refused", async () => {
    for (const t of ["search_ai_crawler_daily", "search_ai_crawler_chunks"]) {
      expect((await withGlobal((c) => c.query(`SELECT 1 FROM ${t}`))).rows).toHaveLength(0);
      expect((await withTenants([A], (c) => c.query(`SELECT 1 FROM ${t}`))).rows).toHaveLength(0);
      expect((await withTenants([C], (c) => c.query(`SELECT 1 FROM ${t}`), S)).rows).toHaveLength(0);
      expect((await withTenants([A], (c) => c.query(`SELECT 1 FROM ${t}`), S)).rows.length).toBeGreaterThan(0);
    }
    await expect(withTenants([C], (c) => c.query(
      `INSERT INTO search_ai_crawler_daily (tenant_id, property_id, day, bot, path, status, verification, hits) VALUES ($1,$2,$3,'GPTBot','/x',200,'claimed',1)`,
      [A, prop, today]), S)).rejects.toThrow();
  });

  it("the AI-visibility summary: the newest row per engine and query, with the change against the one before; words when none", async () => {
    const empty = await app.inject({ method: "GET", url: `${base(prop)}/ai-visibility-summary`, headers: asUser(uA) });
    expect((empty.json() as { state: string; message: string }).state).toBe("no_data");
    const ins = (engine: string, q: string, m: boolean, c2: boolean, at: string, sim = false) => withTenants([A], (c) => c.query(
      `INSERT INTO search_ai_visibility (id, tenant_id, property_id, engine, query, brand_mentioned, cited, captured_at, simulated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [newId(), A, prop, engine, q, m, c2, at, sim]), S);
    await ins("chatgpt", "best agency", false, false, "2026-10-01T00:00:00Z");
    await ins("chatgpt", "best agency", true, false, "2026-10-08T00:00:00Z"); // changed
    await ins("perplexity", "best agency", true, true, "2026-10-08T00:00:00Z", true);
    const r = await app.inject({ method: "GET", url: `${base(prop)}/ai-visibility-summary`, headers: asUser(uA) });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { state: string; anySimulated: boolean; engines: Array<{ engine: string; mentioned: number; cited: number; changed: number }>; latest: Array<{ engine: string; brandMentioned: boolean; changed: boolean; simulated: boolean }> };
    expect(j.state).toBe("ok");
    expect(j.anySimulated).toBe(true);
    expect(j.latest).toHaveLength(2);
    expect(j.latest.find((x) => x.engine === "chatgpt")).toMatchObject({ brandMentioned: true, changed: true, simulated: false });
    expect(j.latest.find((x) => x.engine === "perplexity")).toMatchObject({ changed: false, simulated: true });
    expect(j.engines.find((e) => e.engine === "chatgpt")).toMatchObject({ mentioned: 1, cited: 0, changed: 1 });
  });

  describe("authz", () => {
    it("a Cerbos denial is 403 on all four routes with VALID bodies and ids, and nothing is written", async () => {
      denyAll = true;
      const before = await hits(prop);
      const fresh = ln(BOT_IP, GPT_UA, "/denied-path/");
      expect((await ingest(prop, fresh)).statusCode).toBe(403);
      for (const u of [`${base(prop)}/ai-crawlers/summary`, `${base(prop)}/ai-crawlers/summary/range/${today}/${today}`, `${base(prop)}/ai-visibility-summary`]) {
        expect((await app.inject({ method: "GET", url: u, headers: asUser(uA) })).statusCode, u).toBe(403);
      }
      denyAll = false;
      expect(await hits(prop)).toBe(before);
      // positive control: the same body, allowed, is accepted
      expect((await ingest(prop, fresh)).statusCode).toBe(200);
      expect(await hits(prop)).toBe(before + 1);
    });

    it("cross-company: C's user is refused by the real policy, and RLS makes A's property 404 under C's tenant", async () => {
      useRealCerbos = true;
      expect((await ingest(prop, ln(BOT_IP, GPT_UA, "/x-co/"), uC, A)).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: `${base(prop)}/ai-crawlers/summary`, headers: asUser(uC) })).statusCode).toBe(403);
      useRealCerbos = false;
      expect((await ingest(prop, ln(BOT_IP, GPT_UA, "/x-co/"), uC, C)).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `${base(prop, C)}/ai-crawlers/summary`, headers: asUser(uC) })).statusCode).toBe(404);
    });

    it("bad bodies and ids are 400, an unknown property is 404", async () => {
      for (const payload of [{}, { log: "" }, { log: 5 }]) {
        expect((await app.inject({ method: "POST", url: `${base(prop)}/ai-crawlers/ingest`, headers: asUser(uA), payload })).statusCode).toBe(400);
      }
      expect((await ingest("not-a-uuid", ln(BOT_IP, GPT_UA, "/a/"))).statusCode).toBe(400);
      expect((await ingest(newId(), ln(BOT_IP, GPT_UA, "/a/"))).statusCode).toBe(404);
    });
  });
});

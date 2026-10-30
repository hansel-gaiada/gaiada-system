// AIP-03b — POST /api/internal/ai-usage over the real Nest app (app.inject) against real Postgres with RLS on. Needs DATABASE_URL_TEST;
// it SKIPS without one, and a skip is not a pass. The guard and the 1..100 bound alone are also in ingest.controller.test.ts (no database).
//
// What is read back is what COMMITTED (the superuser pool, around RLS), never the response alone: a 200 is not a pass.
// Proves: no token, a wrong token and a user-session credential are refused and write nothing; a valid batch is accepted and lands under the
// right company with the right surface, capability, task, tokens and cost; a surface a service may not write (assistant, compaction, search),
// an unknown key and an unknown company are each rejected per index (the rest of the batch still lands); a person from another company is
// stored as NULL and counted while a member is kept; a supplied department is ignored; the price table costs an event with tokens but no
// cost (cost_source 'table') and a provider cost is kept; more than 100 events, or none, is 400 and writes nothing.
// AIP-15a: a member whose primary placement is a node with NO org_units row is stored with that node in unit_node_id (org_unit_id NULL),
// and a supplied unitNodeId is ignored.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomUUID } from "node:crypto";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { clearUnitCacheForTests } from "./gateway-usage";

const TOKEN = "aip03b-http-service-token";
const URL = "/api/internal/ai-usage";

describe.skipIf(!TEST_URL)("AIP-03b · POST /api/internal/ai-usage (HTTP, real Postgres)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let memberA: string;
  let memberB: string;
  const saved = config.serviceToken;

  const good = { authorization: `Bearer ${TOKEN}` };
  const post = (payload: unknown, headers: Record<string, string> = good) => app.inject({ method: "POST", url: URL, headers, payload: payload as object });
  const ev = (over: Record<string, unknown> = {}) => ({
    tenantId: A, surface: "agent", capability: "llm", tokensSource: "provider", outcome: "ok", task: "statusReporter",
    promptTokens: 120, completionTokens: 30, provider: "openai", ...over,
  });
  const rows = async (where = "true", args: unknown[] = []) =>
    (await adminPool().query(
      `SELECT tenant_id, user_id, org_unit_id, unit_node_id, surface, capability, task, provider, model, prompt_tokens, completion_tokens, tokens_source,
              cost_usd::text AS cost_usd, cost_source, outcome, run_id FROM ai_usage_events WHERE ${where} ORDER BY occurred_at, id`, args,
    )).rows;
  const total = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM ai_usage_events`)).rows[0].n);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = TOKEN;
    A = await createCompany("AIP03b Company A");
    B = await createCompany("AIP03b Company B");
    memberA = await createUser("aip03b-a@mock.test", "AIP03b A");
    memberB = await createUser("aip03b-b@mock.test", "AIP03b B");
    await addMembership(A, memberA);
    await addMembership(B, memberB);
    app = await buildApp();
  });
  afterAll(async () => {
    config.serviceToken = saved;
    await app.close();
    await teardownTestDb();
  });
  beforeEach(async () => {
    // The table is append-only (a row trigger refuses DELETE); TRUNCATE, as the superuser, fires no row trigger.
    await adminPool().query(`TRUNCATE ai_usage_events`);
  });

  it("refuses no token, a wrong token and a user session, and writes nothing", async () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln";
    const sessions: Array<Record<string, string>> = [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${jwt}` }, { cookie: "session=abc", "x-user-id": memberA }];
    for (const headers of sessions) {
      const r = await post({ events: [ev()] }, headers);
      expect([401, 403], JSON.stringify(headers)).toContain(r.statusCode);
    }
    expect(await total()).toBe(0);
  });

  it("accepts a valid batch and stores each event under its own company", async () => {
    const run = randomUUID();
    const r = await post({
      events: [
        ev({ runId: run, userId: memberA }),
        ev({ tenantId: B, surface: "knowledge", capability: "embed", tokensSource: "none", promptTokens: null, completionTokens: null, task: "knowledge.ingest", provider: null }),
        ev({ surface: "bot", capability: "llm", outcome: "blocked_budget", promptTokens: null, completionTokens: null, tokensSource: "none", task: "bot.reply" }),
        ev({ surface: "other", costUsd: 0.0123, costSource: "provider" }),
      ],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ accepted: 4, rejected: [], counted: {} });
    const stored = await rows();
    expect(stored).toHaveLength(4);
    expect(stored.map((s) => [s.tenant_id, s.surface, s.capability, s.outcome])).toEqual([
      [A, "agent", "llm", "ok"], [B, "knowledge", "embed", "ok"], [A, "bot", "llm", "blocked_budget"], [A, "other", "llm", "ok"],
    ]);
    expect(stored[0]).toMatchObject({ user_id: memberA, task: "statusReporter", prompt_tokens: 120, completion_tokens: 30, tokens_source: "provider", run_id: run });
    expect(stored[1]).toMatchObject({ prompt_tokens: null, completion_tokens: null, tokens_source: "none", cost_usd: null });
    expect(stored[3]).toMatchObject({ cost_usd: "0.01230000", cost_source: "provider" });
  });

  it("rejects a forbidden surface, an unknown key and an unknown company per index, and still writes the rest", async () => {
    const r = await post({
      events: [
        ev({ surface: "assistant" }), ev(), ev({ surface: "compaction" }), ev({ content: "summarise the Q3 contract" }), ev({ tenantId: randomUUID() }), ev({ surface: "search" }),
      ],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      accepted: 1,
      rejected: [
        { index: 0, reason: "surface_not_allowed" }, { index: 2, reason: "surface_not_allowed" }, { index: 3, reason: "unknown_field" },
        { index: 4, reason: "unknown_tenant" }, { index: 5, reason: "surface_not_allowed" },
      ],
      counted: {},
    });
    expect(r.body).not.toContain("summarise");
    expect(await total()).toBe(1);
  });

  it("stores a person who is not a member of the company as null, counted; keeps a member; ignores a supplied department", async () => {
    const r = await post({
      events: [ev({ userId: memberA, orgUnitId: randomUUID() }), ev({ userId: memberB }), ev({ userId: randomUUID() })],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ accepted: 3, rejected: [], counted: { user_not_member: 2 } });
    const stored = await rows();
    expect(stored.map((s) => s.user_id).sort()).toEqual([memberA, null, null].sort());
    expect(stored.every((s) => s.org_unit_id === null)).toBe(true);
  });

  it("AIP-15a: records the member's HOME node from a placement with no org_units row, and ignores a supplied unitNodeId", async () => {
    await adminPool().query(
      `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, origin_site)
       VALUES ($1, $2, 'd-aip15a-home', true, current_date - 3, $3)`,
      [A, memberA, config.originSite],
    );
    clearUnitCacheForTests(); // an earlier test cached memberA's (empty) placement for 10 minutes
    try {
      const r = await post({ events: [ev({ userId: memberA, unitNodeId: "d-forged" }), ev({ unitNodeId: "d-forged" })] });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ accepted: 2, rejected: [], counted: {} });
      const stored = await rows();
      expect(stored.map((x) => [x.user_id, x.org_unit_id, x.unit_node_id])).toEqual([[memberA, null, "d-aip15a-home"], [null, null, null]]);
    } finally {
      await adminPool().query(`DELETE FROM org_unit_memberships WHERE tenant_id = $1 AND user_id = $2`, [A, memberA]);
      clearUnitCacheForTests();
    }
  });

  it("costs an event with tokens and no cost from the price table, and keeps a provider cost", async () => {
    await adminPool().query(
      `INSERT INTO ai_model_prices (provider, model, prompt_usd_per_mtok, completion_usd_per_mtok, effective_from, note) VALUES ('openai', 'aip03b-model', 2, 4, '2026-01-01', 'test')`,
    );
    const r = await post({
      events: [
        ev({ model: "aip03b-model", promptTokens: 1000, completionTokens: 500 }),
        ev({ model: "aip03b-model", promptTokens: 1000, completionTokens: 500, costUsd: 0.5, costSource: "provider" }),
      ],
    });
    expect(r.json().accepted).toBe(2);
    const stored = await rows();
    expect(stored[0]).toMatchObject({ cost_usd: "0.00400000", cost_source: "table" });
    expect(stored[1]).toMatchObject({ cost_usd: "0.50000000", cost_source: "provider" });
  });

  it("is 400 for more than 100 events, none, or a body that is not {events: [...]}, and writes nothing", async () => {
    expect((await post({ events: Array.from({ length: 101 }, () => ev()) })).statusCode).toBe(400);
    expect((await post({ events: [] })).statusCode).toBe(400);
    expect((await post({ events: ev() })).statusCode).toBe(400);
    expect((await post(ev())).statusCode).toBe(400);
    expect(await total()).toBe(0);
    expect((await post({ events: Array.from({ length: 100 }, () => ev()) })).json().accepted).toBe(100);
  });
});

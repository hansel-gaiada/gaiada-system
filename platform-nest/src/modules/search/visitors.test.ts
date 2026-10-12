// M5-V3-g — the pure half of the visitor routes: filters, cursor, rule bodies, the MCP tool defs and the bot-count reader.
// The DB half (app.inject: 403 vs 404, the lead link, the three non-ok status states) is visitors.db.test.ts (Linux gate).
import { describe, it, expect } from "vitest";
import {
  VisitorRequestError, decodeCursor, encodeCursor, parseListFilters, parseRulesBody, STATUS_WORDS, LIST_MAX_LIMIT, MAX_RULES,
} from "./visitors.service";
import { VISITOR_MCP_TOOLS } from "./visitors-mcp-tools";
import { readBotCounts, InsightsBadResponseError, InsightsNotConfiguredError, InsightsUnreachableError, type InsightsSettings } from "./insights-client";
import { searchModule } from "./index";

const V = "11111111-1111-4111-8111-111111111111";
const S: InsightsSettings = { baseUrl: "http://collector.test", readKey: "rk", forgetKey: "fk", timeoutMs: 1000 };
const reason = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as VisitorRequestError).reason; }
  return "no-throw";
};

describe("parseListFilters", () => {
  it("defaults: score order, 25 rows, no filters", () => {
    expect(parseListFilters({})).toEqual({ minScore: null, facet: null, tag: null, hasLead: null, seenFrom: null, order: "score", limit: 25, cursor: null });
  });
  it("accepts every filter", () => {
    const f = parseListFilters({ minScore: "40", facet: "industry", tag: "dental-care", hasLead: "false", seenFrom: "2026-10-01", order: "recent", limit: "50" });
    expect(f).toMatchObject({ minScore: 40, facet: "industry", tag: "dental-care", hasLead: false, order: "recent", limit: 50, seenFrom: "2026-10-01T00:00:00.000Z" });
  });
  it.each([
    [{ order: "random" }, "order_invalid"], [{ minScore: "101" }, "min_score_invalid"], [{ minScore: "1.5" }, "min_score_invalid"],
    [{ facet: "color" }, "facet_invalid"], [{ tag: "Bad Tag" }, "tag_invalid"], [{ hasLead: "yes" }, "has_lead_invalid"],
    [{ seenFrom: "yesterday" }, "seen_from_invalid"], [{ limit: "0" }, "limit_invalid"], [{ limit: String(LIST_MAX_LIMIT + 1) }, "limit_invalid"],
    [{ cursor: "not-a-cursor" }, "cursor_invalid"],
  ])("refuses %j with a typed reason", (q, r) => {
    expect(reason(() => parseListFilters(q as Record<string, string>))).toBe(r);
  });
});

describe("cursor", () => {
  it("round-trips for each order and refuses a cursor of the wrong order", () => {
    const c = { s: 55, t: "2026-10-13 10:00:00.123456+00", v: V };
    expect(decodeCursor(encodeCursor(c), "score")).toEqual(c);
    const r = { s: null, t: c.t, v: V };
    expect(decodeCursor(encodeCursor(r), "recent")).toEqual(r);
    expect(reason(() => decodeCursor(encodeCursor(c), "recent"))).toBe("cursor_invalid");
    expect(reason(() => decodeCursor(encodeCursor(r), "score"))).toBe("cursor_invalid");
  });
  it("refuses an injected timestamp or id", () => {
    expect(reason(() => decodeCursor(encodeCursor({ s: 1, t: "x\"; DROP TABLE a;--", v: V }), "score"))).toBe("cursor_invalid");
    expect(reason(() => decodeCursor(encodeCursor({ s: 1, t: "2026-10-13 10:00:00+00", v: "nope" }), "score"))).toBe("cursor_invalid");
  });
});

describe("parseRulesBody", () => {
  const rule = { match: "path_prefix", pattern: "/services/web/", facet: "service", tag: "web-design", weight: 5 };
  it("accepts a complete set, including the empty one (clears every rule)", () => {
    expect(parseRulesBody({ rules: [rule] })).toEqual([rule]);
    expect(parseRulesBody({ rules: [] })).toEqual([]);
  });
  it.each([
    [undefined, "rules_invalid"], [{ rules: "x" }, "rules_invalid"],
    [{ rules: [{ ...rule, match: "regex" }] }, "rule_match_invalid"], [{ rules: [{ ...rule, pattern: "" }] }, "rule_pattern_invalid"],
    [{ rules: [{ ...rule, pattern: "x".repeat(201) }] }, "rule_pattern_invalid"], [{ rules: [{ ...rule, facet: "x" }] }, "rule_facet_invalid"],
    [{ rules: [{ ...rule, tag: "Web Design" }] }, "rule_tag_invalid"], [{ rules: [{ ...rule, weight: 0 }] }, "rule_weight_invalid"],
    [{ rules: [{ ...rule, weight: 11 }] }, "rule_weight_invalid"], [{ rules: [{ ...rule, weight: 2.5 }] }, "rule_weight_invalid"],
    [{ rules: [rule, { ...rule, weight: 9 }] }, "rule_duplicate"],
    [{ rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ ...rule, pattern: `/p${i}` })) }, "rules_too_many"],
  ])("refuses %j with %s", (b, r) => {
    expect(reason(() => parseRulesBody(b))).toBe(r);
  });
});

describe("STATUS_WORDS", () => {
  it("every non-ok state has its own sentence", () => {
    const states = ["not_configured", "disabled", "no_website", "unreachable", "rejected"] as const;
    expect(new Set(states.map((s) => STATUS_WORDS[s])).size).toBe(states.length);
    for (const s of states) expect(STATUS_WORDS[s].length).toBeGreaterThan(30);
  });
});

describe("MCP tools (the hub's fillPath rules: every :param is an input, a GET carries only path params)", () => {
  it("names, impacts and where they sit on the search module", () => {
    expect(VISITOR_MCP_TOOLS.map((t) => t.name)).toEqual([
      "search.visitors.list", "search.visitors.get", "search.visitors.rules.list", "search.visitors.rules.set", "search.visitors.status",
    ]);
    const set = VISITOR_MCP_TOOLS.find((t) => t.name === "search.visitors.rules.set") as { write?: boolean; impact?: string; method?: string; minAssurance?: string };
    expect(set).toMatchObject({ write: true, impact: "low", method: "POST", minAssurance: "verified" });
    for (const t of VISITOR_MCP_TOOLS.filter((x) => x.name !== "search.visitors.rules.set")) {
      const d = t as { write?: boolean; impact?: string; method?: string };
      expect(d.write, t.name).not.toBe(true);
      expect(d.impact, t.name).toBeUndefined();
      expect(d.method, t.name).toBe("GET");
    }
    const names = new Set((searchModule.mcpTools ?? []).map((t) => t.name));
    for (const t of VISITOR_MCP_TOOLS) expect(names.has(t.name), t.name).toBe(true);
  });
  it("every path parameter is a required input", () => {
    for (const t of VISITOR_MCP_TOOLS) {
      const params = [...(t.pathTemplate as string).matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      const schema = t.inputSchema as { required: string[]; properties: Record<string, unknown> };
      for (const p of params) {
        expect(schema.required, `${t.name}:${p}`).toContain(p);
        expect(schema.properties[p]).toBeDefined();
      }
      expect(t.pathTemplate).toMatch(/^\/api\/:tenantId\/modules\/search\/properties\/:propertyId\/visitors/);
    }
  });
});

describe("readBotCounts (GET /ops/v1/bots, read key)", () => {
  const WEB = "22222222-2222-4222-8222-222222222222";
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("sums the daily rows by reason and sends only the read key", async () => {
    let seen: { url: string; auth: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization };
      return new Response(JSON.stringify({
        website: WEB, from: "2026-09-14", to: "2026-10-13",
        days: [{ day: "2026-10-12", reason: "ua", count: 4 }, { day: "2026-10-13", reason: "ua", count: 3 }, { day: "2026-10-13", reason: "asn", count: 2 }],
      }));
    }) as unknown as typeof fetch;
    const r = await readBotCounts(WEB, { from: "2026-09-14", to: "2026-10-13" }, { settings: S, fetchImpl });
    expect(r).toEqual({ from: "2026-09-14", to: "2026-10-13", total: 9, byReason: { ua: 7, asn: 2 } });
    expect(seen!.url).toBe(`http://collector.test/ops/v1/bots?website=${WEB}&from=2026-09-14&to=2026-10-13`);
    expect(seen!.auth).toBe("Bearer rk");
  });
  it("typed failures: not configured, unreachable, off-contract", async () => {
    await expect(readBotCounts(WEB, {}, { settings: null })).rejects.toBeInstanceOf(InsightsNotConfiguredError);
    await expect(readBotCounts(WEB, {}, { settings: S, fetchImpl: reply({}, 503) })).rejects.toBeInstanceOf(InsightsUnreachableError);
    await expect(readBotCounts(WEB, {}, { settings: S, fetchImpl: reply({ days: [{ reason: "ua", count: "x" }] }) })).rejects.toBeInstanceOf(InsightsBadResponseError);
    await expect(readBotCounts(WEB, {}, { settings: S, fetchImpl: reply({ nope: 1 }) })).rejects.toBeInstanceOf(InsightsBadResponseError);
    await expect(readBotCounts("not-a-uuid", {}, { settings: S })).rejects.toBeInstanceOf(InsightsBadResponseError);
  });
});

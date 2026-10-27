// PV7-07 — the account summary's pure parts, run anywhere (no database): the period, the money filter, the snapshot's
// mapping and its client-wide scope binding, the document and the narrative. The real SQL and the real isolation are proven
// against Postgres in account-summary.db.test.ts (Linux CI gate).
//
// THE TOOTH (recorded in the PV7-07 hand-back): in snapshot.ts, make `buildAccountSummarySnapshot` store `composed` instead of
// `stripMoneyKpis(composed)`. "the whole output carries no money" goes red with `conversion_value`, `USD` and the planted
// amount named. Restored; not committed.
import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import {
  buildAccountSummarySnapshot, clientWideScope, isMoneyKpi, parseSummaryPeriod, stripMoneyKpis, summaryPeriodLabel,
  type AccountSummarySnapshot,
} from "./snapshot";
import {
  buildAccountSummaryDocument, buildSummaryNarrativePrompt, deterministicSummaryNarrative, summaryGroundingFacts,
} from "./document";
import { draftSummaryNarrative } from "./draft";
import type { BusinessResults, ServiceCard } from "../centre/results/types";
import type { BallRow } from "../client-ball";
import type { ProjectHealth, TurnaroundPair } from "../client-health";

/** AIP-03a: a tenantId that is not a uuid records nothing. */
const ATTR = { tenantId: "no-company", userId: null, surface: "other" } as const;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-10-03T09:00:00.000Z");
const PERIOD = parseSummaryPeriod("2026-09")!;

describe("PV7-07 · the period", () => {
  it("parses a real month to its first and last day (UTC) and the half-open instants", () => {
    expect(PERIOD.periodStart).toBe("2026-09-01");
    expect(PERIOD.periodEnd).toBe("2026-09-30");
    expect(PERIOD.startAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(PERIOD.endExclusive.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(parseSummaryPeriod("2028-02")!.periodEnd).toBe("2028-02-29");
    expect(parseSummaryPeriod("2026-12")!.endExclusive.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(summaryPeriodLabel("2026-09")).toBe("September 2026");
  });
  it("refuses anything that is not YYYY-MM of a real month", () => {
    for (const bad of ["2026-13", "2026-00", "2026-9", "26-09", "2026-09-01", " 2026-09", "", null, undefined, 202609, {}, "1999-12", "2101-01"]) {
      expect(parseSummaryPeriod(bad), String(bad)).toBeNull();
    }
  });
});

describe("PV7-07 · money: the summary shows none (PV-D38, PV7-Q3)", () => {
  const kpi = (key: string, label: string) => ({ key, label, value: 1, unit: "count" as const, period: null, previous: null, target: null, asOf: null });
  it("flags the conversion value, any currency label and any money-named key, and keeps the ordinary counts", () => {
    expect(isMoneyKpi(kpi("search_ads.conversion_value", "Conversion value (USD)"))).toBe(true);
    expect(isMoneyKpi(kpi("search_ads.conversion_value", "Whatever"))).toBe(true);
    expect(isMoneyKpi(kpi("x.something", "Result (IDR)"))).toBe(true);
    expect(isMoneyKpi(kpi("x.ad_spend", "Ad things"))).toBe(true);
    expect(isMoneyKpi(kpi("x.something", "Total cost"))).toBe(true);
    for (const [k, l] of [
      ["search_ads.clicks", "Ad clicks"], ["search_ads.conversions", "Conversions"], ["analytics.sessions", "Sessions"],
      ["analytics.engaged_sessions", "Engaged sessions"], ["search.organic_clicks", "Organic clicks"], ["search.avg_position", "Average position"],
      ["search.ai_citations", "AI citations"], ["website.cert_days", "Days until the certificate expires"], ["website.open_incidents", "Open incidents"],
    ]) expect(isMoneyKpi(kpi(k, l)), k).toBe(false);
  });
  it("stripMoneyKpis removes only the money KPIs and keeps the card", () => {
    const card = (kpis: ServiceCard["kpis"]): ServiceCard => ({
      service: "search_ads", areaId: "a", title: "Search ads", status: "active", since: null, items: [{ label: "Acme", detail: "Google Ads" }],
      kpis, clientVisible: true,
    });
    const out = stripMoneyKpis({
      generatedAt: NOW.toISOString(), unavailable: [],
      services: [card([kpi("search_ads.clicks", "Ad clicks"), kpi("search_ads.conversion_value", "Conversion value (USD)")])],
    });
    expect(out.services[0].kpis.map((k) => k.key)).toEqual(["search_ads.clicks"]);
    expect(out.services[0].items).toHaveLength(1);
  });
});

// ── fixtures for the snapshot ────────────────────────────────────────────────────────────────────────

const PLANTED = {
  taskTitle: "SECRET task title: refactor auth before the demo",
  person: "Ada Admin",
  amount: "98765.43",
  gate: "INTERNAL gate: margin review",
  time: "TIMEENTRY 480 minutes",
};

const project = (over: Partial<ProjectHealth> = {}): ProjectHealth => ({
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Website rebuild", status: "active", clientVisible: true,
  milestones: { total: 5, done: 3, upcoming: 1, late: 1, undated: 0 },
  deliverables: { total: 4, delivered: 2, late: 0 },
  nextMilestone: { id: "m1", name: "Launch", dueDate: "2026-10-20" },
  ...over,
});
const pair = (): TurnaroundPair => ({
  windowDays: 90,
  client: { medianDays: 2.5, n: 6, withheld: false, parts: [] },
  ours: { medianDays: null, n: 1, withheld: true, parts: [] },
});
// A ball whose items carry a person's name, an amount and an internal gate in their labels and contexts: none may be copied.
const ballRow = (over: Partial<BallRow>): BallRow => ({
  kind: "request", id: "r", label: PLANTED.person, context: `${PLANTED.amount} ${PLANTED.gate}`, href: "/x",
  since: new Date("2026-09-10T00:00:00Z"), clientVisible: true, clientId: CLIENT, projectId: null, ...over,
});
const results = (): BusinessResults => ({
  clientId: CLIENT, generatedAt: NOW.toISOString(), visible: true, unavailable: ["website"],
  services: [{
    service: "search_ads", areaId: "search", title: "Search ads", status: "active", since: "2026-01-01",
    items: [{ label: "Acme ads", detail: "Google Ads" }],
    kpis: [
      { key: "search_ads.clicks", label: "Ad clicks", value: 1200, unit: "count", period: null, previous: null, target: null, asOf: null },
      { key: "search_ads.conversion_value", label: "Conversion value (USD)", value: Number(PLANTED.amount), unit: "count", period: null, previous: null, target: null, asOf: null },
    ],
    clientVisible: true,
  }],
});

type Canned = Partial<Record<string, unknown>>;
function cannedRead(canned: Canned, failing: string[] = []) {
  return async (_t: string, source: string, _m: string[] | undefined, _fn: (c: PoolClient) => Promise<unknown>) => {
    if (failing.includes(source)) throw new Error("boom: SELECT secret FROM somewhere");
    return canned[source];
  };
}
const baseCanned = (): Canned => ({
  projectHealth: new Map([[CLIENT, [project(), project({ projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "SEO retainer", status: "completed", nextMilestone: null })]]]),
  ball: new Map([[CLIENT, {
    needsUs: [ballRow({ id: "u1" })],
    needsClient: [ballRow({ id: "c1", since: new Date("2026-09-12T00:00:00Z") }), ballRow({ id: "c2", since: new Date("2026-09-05T00:00:00Z") }), ballRow({ id: "c3", clientVisible: false })],
  }]]),
  turnaround: new Map([[CLIENT, pair()]]),
  milestones: [{ id: "m", name: "Design approved", projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectName: "Website rebuild", completedOn: "2026-09-14", total: 2 }],
  deliverables: [{ id: "d", name: "Brand guide", projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectName: "Website rebuild", status: "delivered", on: "2026-09-20", total: 1 }],
  reports: [{ id: "rep", title: "Social media report, August 2026", source: "social_report", periodStart: "2026-08-01", periodEnd: "2026-08-31", publishedOn: "2026-09-04" }],
});

const build = (canned: Canned, failing: string[] = [], knownSince: string | null = "2026-09-01T00:00:00.000Z") =>
  buildAccountSummarySnapshot(
    { tenantId: TENANT, clientId: CLIENT, clientName: "Acme Hotels", period: PERIOD },
    { now: NOW, read: cannedRead(canned, failing), compose: async () => results(), knownSince: async () => knownSince },
  );

describe("PV7-07 · the snapshot", () => {
  it("maps each source, reduces the ball to a count and the oldest instant, and strips the money KPI", async () => {
    const s = await build(baseCanned());
    expect(s.version).toBe(1);
    expect(s).toMatchObject({ clientId: CLIENT, clientName: "Acme Hotels", period: "2026-09", periodStart: "2026-09-01", periodEnd: "2026-09-30", generatedAt: NOW.toISOString() });
    expect(s.projects!.map((p) => p.name)).toEqual(["Website rebuild", "SEO retainer"]);
    expect(s.projects![0]).toEqual({
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Website rebuild", status: "active",
      milestones: { total: 5, done: 3, upcoming: 1, late: 1, undated: 0 }, deliverables: { total: 4, delivered: 2, late: 0 },
      nextMilestone: { name: "Launch", dueDate: "2026-10-20" },
    });
    expect(s.waiting).toEqual({
      onClient: { count: 2, oldestSince: "2026-09-05T00:00:00.000Z" }, // the not-client-visible row is not counted
      onUs: { count: 1, oldestSince: "2026-09-10T00:00:00.000Z" },
    });
    expect(s.turnaround).toEqual({
      windowDays: 90, windowEnd: "2026-09-30",
      client: { medianDays: 2.5, n: 6, withheld: false }, ours: { medianDays: null, n: 1, withheld: true },
    });
    expect(s.completed.milestones).toMatchObject({ count: 2, knownSince: "2026-09-01", wholeMonthKnown: true });
    expect(s.completed.milestones!.items).toEqual([{ projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectName: "Website rebuild", name: "Design approved", completedOn: "2026-09-14" }]);
    expect(s.completed.deliverables).toMatchObject({ count: 1, basis: "status_changed_in_month" });
    expect(s.results!.services[0].kpis.map((k) => k.key)).toEqual(["search_ads.clicks"]);
    expect(s.results!.unavailable).toEqual(["website"]);
    expect(s.reports).toHaveLength(1);
    expect(s.unavailable).toEqual([]);
  });

  it("says which part of the month completion dates are known: before the column's date it is NOT a whole month", async () => {
    const late = await build(baseCanned(), [], "2026-09-15T08:00:00.000Z");
    expect(late.completed.milestones).toMatchObject({ knownSince: "2026-09-15", wholeMonthKnown: false });
    const unknown = await build(baseCanned(), [], null);
    expect(unknown.completed.milestones).toMatchObject({ knownSince: null, wholeMonthKnown: null });
  });

  it("a failed source is null and named, never zero; the others still return", async () => {
    const s = await build(baseCanned(), ["ball", "milestones", "reports"]);
    expect(s.waiting).toBeNull();
    expect(s.completed.milestones).toBeNull();
    expect(s.reports).toBeNull();
    expect(s.unavailable.sort()).toEqual(["ball", "milestones", "reports"]);
    expect(s.projects).not.toBeNull();
    expect(s.completed.deliverables).not.toBeNull();
    // The error text (which can carry SQL) is never returned.
    expect(JSON.stringify(s)).not.toContain("SELECT secret");
  });

  it("a results composer that throws marks `results` unavailable", async () => {
    const s = await buildAccountSummarySnapshot(
      { tenantId: TENANT, clientId: CLIENT, clientName: "Acme Hotels", period: PERIOD },
      { now: NOW, read: cannedRead(baseCanned()), compose: async () => { throw new Error("nope"); }, knownSince: async () => null },
    );
    expect(s.results).toBeNull();
    expect(s.unavailable).toEqual(["results"]);
  });

  it("the whole output carries no money, no task, no person, no internal gate, no time (the tooth)", async () => {
    const s = await build(baseCanned());
    const doc = buildAccountSummaryDocument({ tenantId: TENANT, snapshot: s, narrativeMd: deterministicSummaryNarrative(s), narrativeSource: "deterministic" });
    const facts = summaryGroundingFacts(s);
    const everything = JSON.stringify([s, doc, facts, buildSummaryNarrativePrompt(facts), deterministicSummaryNarrative(s)]);
    for (const banned of [...Object.values(PLANTED), "conversion_value", "Conversion value", "USD", "98765", "98,765"]) {
      expect(everything, banned).not.toContain(banned);
    }
    // And no key that names one of them.
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
    };
    walk(s);
    for (const k of keys) expect(k, k).not.toMatch(/task|effort|minutes|assignee|owner|person|people|author|gate|amount|currency|money|invoice|payment|price|cost|spend/i);
  });
});

describe("PV7-07 · the snapshot reads through the client-wide portal scope, with dense parameters", () => {
  /** A connection that records every statement and returns no rows. */
  function recorder() {
    const seen: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => { seen.push({ sql, values }); return { rows: [], rowCount: 0 }; },
    } as unknown as PoolClient;
    return { client, seen };
  }

  it("clientWideScope is exactly a client-wide contact of ONE client", () => {
    expect(clientWideScope(CLIENT)).toEqual({ clientIds: [CLIENT], wideClientIds: [CLIENT], projectIds: [], signerClientIds: [] });
  });

  it("every statement references $1.. densely and is handed exactly that many values; the scope arrays are the synthetic one", async () => {
    const { client, seen } = recorder();
    await buildAccountSummarySnapshot(
      { tenantId: TENANT, clientId: CLIENT, clientName: "Acme", period: PERIOD },
      { now: NOW, read: async (_t, _s, _m, fn) => fn(client), compose: async () => results(), knownSince: async () => null },
    );
    expect(seen.length).toBeGreaterThan(10);
    for (const { sql, values } of seen) {
      const refs = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
      const head = sql.replace(/\s+/g, " ").trim().slice(0, 80);
      expect(refs, head).toEqual(Array.from({ length: refs.length }, (_, i) => i + 1));
      expect(values.length, head).toBe(refs.length);
    }
    // Every scope array bound anywhere is the one client (client-wide) or empty (no explicit projects): never another id.
    const flat = seen.flatMap((s) => s.values).filter(Array.isArray) as unknown[][];
    for (const arr of flat) for (const v of arr) {
      if (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)) expect(v).toBe(CLIENT);
    }
    // The month's range reached the month-bound reads, and the turnaround's window ends at the month's end.
    const withRange = seen.filter((s) => s.values.includes("2026-09-01T00:00:00.000Z") && s.values.includes("2026-10-01T00:00:00.000Z"));
    expect(withRange.length).toBeGreaterThanOrEqual(3); // milestones, deliverables, reports
    const turnaround = seen.find((s) => s.sql.includes("percentile_cont"));
    expect(turnaround!.values.at(-1)).toBe("2026-10-01T00:00:00.000Z");
    expect(turnaround!.sql).toContain("answered_at <");
  });
});

describe("PV7-07 · the document and the narrative", () => {
  it("is a client-grain month document with the snapshot's own figures, no series, and honest notes", async () => {
    const s = await build(baseCanned(), [], "2026-09-15T08:00:00.000Z");
    const doc = buildAccountSummaryDocument({ tenantId: TENANT, snapshot: s, narrativeMd: "Hello.", narrativeSource: "human" });
    expect(doc.header).toMatchObject({ grain: "client", scopeRef: CLIENT, scopeName: "Acme Hotels", periodKind: "month", periodStart: "2026-09-01", periodEnd: "2026-09-30", dayCount: 30, periodLabel: "September 2026", sealed: false });
    const byKey = Object.fromEntries(doc.kpis.map((k) => [k.metricKey, k]));
    expect(byKey["summary.projects"].value).toBe(2);
    expect(byKey["summary.milestones_completed"]).toMatchObject({ value: 2 });
    expect(byKey["summary.milestones_completed"].label).toContain("2026-09-15"); // not a whole month: the tile says from when
    expect(byKey["summary.waiting_on_you"].value).toBe(2);
    expect(byKey["summary.turnaround_you_days"].value).toBe(2.5);
    expect(byKey["summary.turnaround_us_days"]).toBeUndefined(); // withheld, so omitted rather than shown as 0
    expect(byKey["results.search_ads.clicks"]).toMatchObject({ value: 1200 });
    expect(doc.kpis.some((k) => k.metricKey.includes("conversion_value"))).toBe(false);
    expect(doc.series).toEqual([]);
    expect(doc.highlights.map((h) => h.text).join(" ")).toContain("recorded from 2026-09-15");
    expect(doc.highlights.map((h) => h.text).join(" ")).toContain("status last changed");
    expect(doc.tables.map((t) => t.key)).toEqual(["summary_projects", "summary_milestones", "summary_deliverables", "summary_reports"]);
    // A staff-edited narrative reads as a non-AI narrative; an AI one stays AI.
    expect(doc.narrative).toEqual({ source: "deterministic", text: "Hello." });
    expect(buildAccountSummaryDocument({ tenantId: TENANT, snapshot: s, narrativeMd: "x", narrativeSource: "ai" }).narrative.source).toBe("ai");
  });

  it("the deterministic narrative states only the snapshot's numbers", async () => {
    const s = await build(baseCanned());
    const text = deterministicSummaryNarrative(s);
    expect(text).toContain("September 2026");
    expect(text).toContain("2 milestones were completed and 1 deliverable was delivered across 2 projects");
    expect(text).toContain("2 items are waiting on you and 1 on us");
    expect(text).toContain("You took a median of 2.5 days to answer (6 items)");
    expect(text).not.toContain("We took"); // our side is withheld (n = 1)
  });

  describe("the draft's narrative: one gateway call, never a failed draft", () => {
    it("keeps a model text that states no number the facts do not hold", async () => {
      const s = await build(baseCanned());
      let prompt = "";
      const r = await draftSummaryNarrative(s, ATTR, { complete: async (p) => { prompt = p; return { text: "The month went steadily for your team.", provider: "test-model" }; } });
      expect(r).toEqual({ text: "The month went steadily for your team.", source: "ai", model: "test-model" });
      expect(prompt).toContain("Milestones completed");
      for (const banned of Object.values(PLANTED)) expect(prompt).not.toContain(banned);
    });
    it("keeps a model text whose numbers are all in the facts", async () => {
      const s = await build(baseCanned());
      const r = await draftSummaryNarrative(s, ATTR, { complete: async () => ({ text: "2 milestones were completed and 1 deliverable was delivered." }) });
      expect(r.source).toBe("ai");
    });
    it("a number that is not in the facts rejects the whole text: the deterministic narrative stands", async () => {
      const s = await build(baseCanned());
      const r = await draftSummaryNarrative(s, ATTR, { complete: async () => ({ text: "A record 4711 milestones were completed." }) });
      expect(r.source).toBe("deterministic");
      expect(r.text).toBe(deterministicSummaryNarrative(s));
      expect(r.model).toBeNull();
    });
    it("a gateway that throws, an empty completion and an over-long one all give the deterministic narrative", async () => {
      const s = await build(baseCanned());
      for (const complete of [
        async () => { throw new Error("gateway down"); },
        async () => ({ text: "   " }),
        async () => ({ text: "word ".repeat(400) }),
      ]) {
        const r = await draftSummaryNarrative(s, ATTR, { complete });
        expect(r.source).toBe("deterministic");
        expect(r.text).toBe(deterministicSummaryNarrative(s));
      }
    });
    it("an unconfigured gateway (the default call) is a gateway failure, not a thrown draft", async () => {
      const s = await build(baseCanned());
      const r = await draftSummaryNarrative(s, ATTR);
      expect(["ai", "deterministic"]).toContain(r.source);
      expect(r.text.length).toBeGreaterThan(0);
    });
  });
});

// Typing guard: the snapshot's top-level keys are the contract's (BFF §56.1).
describe("PV7-07 · the snapshot's top-level keys are the contract's", () => {
  it("lists exactly the keys §56.1 names", async () => {
    const s: AccountSummarySnapshot = await build(baseCanned());
    expect(Object.keys(s).sort()).toEqual([
      "clientId", "clientName", "completed", "generatedAt", "period", "periodEnd", "periodStart", "projects", "reports", "results",
      "turnaround", "unavailable", "version", "waiting",
    ]);
  });
});

// PV6-02 — Services & results: the parts that need no database. Pure helpers, the composer's three outcomes against
// fake builders, the area map pinned to the registry, and static guards over the builder files (every read declares
// its module, no cost column is read for paid search, one top-10 SQL, one uptime SQL). The real-database proofs
// (numbers, the module wall, `simulated`, both routes) are centre-results.db.test.ts.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import registry from "../registry.json";
import { SERVICE_AREA, areaFor } from "./area-map";
import { engagementStatus, isoDate, kpi, num, round, windows } from "./kpi";
import { hostBelongsToDomain, hostOf } from "./website";
import { minorExponent } from "./search-ads";
import { composeBusinessResults, hiddenBusinessResults } from "./compose";
import { SERVICE_KEYS, type ResultsBuilder, type ServiceCard, type ServiceKey } from "./types";
import { UPTIME_RATIO_SQL } from "../../../monitoring/monitoring.controller";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("windows", () => {
  const now = new Date("2026-10-13T15:30:00Z");

  it("the current window ends today (inclusive) and the previous one ends the day before it starts", () => {
    const w = windows(now, 30);
    expect(w.current).toEqual({ from: "2026-09-14", to: "2026-10-13" });
    expect(w.previous).toEqual({ from: "2026-08-15", to: "2026-09-13" });
  });

  it("both windows are exactly `days` long and touch without overlapping", () => {
    for (const days of [7, 28, 30]) {
      const { current, previous } = windows(now, days);
      const len = (a: { from: string; to: string }) => (Date.parse(a.to) - Date.parse(a.from)) / 86_400_000 + 1;
      expect(len(current)).toBe(days);
      expect(len(previous)).toBe(days);
      expect(Date.parse(current.from) - Date.parse(previous.to)).toBe(86_400_000);
    }
  });
});

describe("small helpers", () => {
  it("num: unknown is null, never 0", () => {
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num("12.50")).toBe(12.5);
    expect(num("x")).toBeNull();
    expect(num(0)).toBe(0);
  });

  it("round and isoDate", () => {
    expect(round(7.04, 1)).toBe(7);
    expect(round(null, 1)).toBeNull();
    expect(isoDate("2026-10-12")).toBe("2026-10-12");
    expect(isoDate(null)).toBeNull();
    expect(isoDate("garbage")).toBeNull();
  });

  it("kpi fills the absent pieces with null, never undefined", () => {
    expect(kpi("k", "K", "count", null)).toEqual({ key: "k", label: "K", value: null, unit: "count", period: null, previous: null, target: null, asOf: null });
  });

  it("engagement status reads as the client reads it", () => {
    expect(engagementStatus("draft")).toBe("setting_up");
    expect(engagementStatus("active")).toBe("active");
    expect(engagementStatus("paused")).toBe("paused");
    expect(engagementStatus("closed")).toBe("ended");
    expect(engagementStatus("anything else")).toBe("setting_up");
  });

  it("minorExponent follows the currency", () => {
    expect(minorExponent("USD")).toBe(2);
    expect(minorExponent("JPY")).toBe(0);
    expect(minorExponent("KWD")).toBe(3);
    expect(minorExponent("not a currency")).toBe(2);
  });
});

describe("matching a probe to a site by host", () => {
  it("reads the host from a URL, a host:port and a bracketed address, without www", () => {
    expect(hostOf("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(hostOf("example.com:443")).toBe("example.com");
    expect(hostOf("[::1]:443")).toBe("::1");
    expect(hostOf("example.com.")).toBe("example.com");
    expect(hostOf(null)).toBeNull();
    expect(hostOf("")).toBeNull();
  });

  it("a probe belongs to a site when its host is the domain or a subdomain, and not a look-alike", () => {
    expect(hostBelongsToDomain("example.com", "example.com")).toBe(true);
    expect(hostBelongsToDomain("example.com", "www.example.com")).toBe(true);
    expect(hostBelongsToDomain("api.example.com", "example.com")).toBe(true);
    expect(hostBelongsToDomain("notexample.com", "example.com")).toBe(false);
    expect(hostBelongsToDomain("example.com.evil.test", "example.com")).toBe(false);
    expect(hostBelongsToDomain(null, "example.com")).toBe(false);
  });
});

describe("the area map", () => {
  type Node = { id?: string; pages?: Node[] };
  /** Every area and sub-area id in the registry, whichever side of PV6-01's rename this tree is on. */
  const ids = (() => {
    const reg = registry as unknown as { areas?: Array<Node & { subAreas?: Node[] }>; departments?: Node[] };
    const out = new Set<string>();
    const walk = (n: Node & { subAreas?: Node[] }) => {
      if (n.id) out.add(n.id);
      for (const c of n.subAreas ?? []) walk(c);
      for (const c of n.pages ?? []) walk(c);
    };
    for (const a of reg.areas ?? reg.departments ?? []) walk(a);
    return out;
  })();

  it("maps every service, and nothing else", () => {
    expect(Object.keys(SERVICE_AREA).sort()).toEqual([...SERVICE_KEYS].sort());
  });

  it("every mapped area id exists in the registry (a rename cannot silently orphan a card)", () => {
    for (const k of SERVICE_KEYS) expect(ids.has(areaFor(k)), `${k} -> ${areaFor(k)}`).toBe(true);
  });

  it("the five ids the ticket names", () => {
    expect(SERVICE_AREA).toEqual({ social: "mk_social", search: "se", search_ads: "mk_paid", analytics: "mk_analytics", website: "mk_web" });
  });
});

describe("the composer: offered, not offered, unavailable", () => {
  const card = (service: ServiceKey): ServiceCard => ({
    service, areaId: areaFor(service), title: service, status: "active", since: null, items: [], kpis: [], clientVisible: true,
  });
  const ok = (service: ServiceKey, requires: string[] = [service]): ResultsBuilder => ({ service, requires, build: async () => [card(service)] });
  const empty = (service: ServiceKey): ResultsBuilder => ({ service, requires: [service], build: async () => [] });
  const boom = (service: ServiceKey): ResultsBuilder => ({ service, requires: [service], build: async () => { throw new Error("secret sql detail"); } });
  const run = (builders: ResultsBuilder[], enabled: string[]) =>
    composeBusinessResults("t", "c", { builders, enabled: new Set(enabled), now: new Date("2026-10-13T00:00:00Z") });

  it("a service whose module is not enabled is absent and NOT unavailable", async () => {
    const r = await run([ok("social"), ok("search")], ["search"]);
    expect(r.services.map((s) => s.service)).toEqual(["search"]);
    expect(r.unavailable).toEqual([]);
  });

  it("a builder with nothing to show is absent and NOT unavailable", async () => {
    const r = await run([empty("social"), ok("search")], ["social", "search"]);
    expect(r.services.map((s) => s.service)).toEqual(["search"]);
    expect(r.unavailable).toEqual([]);
  });

  it("a builder that throws is unavailable, the rest return, and the error text is not returned", async () => {
    const r = await run([ok("social"), boom("search"), ok("website", ["website"])], ["social", "search", "website"]);
    expect(r.unavailable).toEqual(["search"]);
    expect(r.services.map((s) => s.service)).toEqual(["social", "website"]);
    expect(JSON.stringify(r)).not.toContain("secret sql detail");
  });

  it("a service needing two modules is offered only when both are enabled", async () => {
    const b = ok("website", ["webdev", "monitoring"]);
    expect((await run([b], ["webdev"])).services).toEqual([]);
    expect((await run([b], ["webdev", "monitoring"])).services).toHaveLength(1);
  });

  it("services come back in the fixed order whatever order the builders ran in", async () => {
    const r = await run([ok("website"), ok("social"), ok("search_ads", ["search"]), ok("search")], ["website", "social", "search"]);
    expect(r.services.map((s) => s.service)).toEqual(["social", "search", "search_ads", "website"]);
  });

  it("the payload shape: ids, a timestamp, visible true", async () => {
    const r = await run([], []);
    expect(r).toEqual({ clientId: "c", generatedAt: "2026-10-13T00:00:00.000Z", visible: true, services: [], unavailable: [] });
  });

  it("the hidden payload has no services and nothing unavailable", () => {
    expect(hiddenBusinessResults("c", new Date("2026-10-13T00:00:00Z"))).toEqual({
      clientId: "c", generatedAt: "2026-10-13T00:00:00.000Z", visible: false, services: [], unavailable: [],
    });
  });
});

// ═══════════════════════════════ static guards over the builder files ═══════════════════════════════
const DIR = __dirname;
const SEARCH_DIR = join(__dirname, "..", "..", "..", "search");
const BUILDER_FILES = ["social.ts", "search.ts", "search-ads.ts", "analytics.ts", "website.ts"];
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const code = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

describe("guards", () => {
  it("every builder reads through ctx.read with a module list, and none opens its own transaction", () => {
    for (const f of BUILDER_FILES) {
      const c = code(read(f));
      expect(c, f).toMatch(/ctx\.read\(\s*(?:MODULES|\[\s*"[a-z]+")/);
      expect(c, f).not.toMatch(/withTenants|withGlobal|getPool/);
    }
  });

  it("the paid-search builder never reads a cost, budget, bid or CPA column", () => {
    const c = code(read("search-ads.ts"));
    for (const col of ["cost_minor", "budget_minor", "cost_usd", "bid_strategy", "target_cpa_minor", "target_roas", "media_budget_minor"]) {
      expect(c, col).not.toContain(col);
    }
  });

  it("every search read of a table that carries `simulated` filters it", () => {
    for (const f of ["search.ts", "search-ads.ts", "analytics.ts"]) {
      const c = code(read(f));
      for (const t of ["search_gsc_performance", "search_ai_visibility", "search_ga4_metrics", "search_campaign_metrics_daily"]) {
        const at = c.indexOf(`FROM ${t}`);
        if (at < 0) continue;
        expect(c.slice(at, at + 400), `${f} ${t}`).toMatch(/simulated = false/);
      }
    }
  });

  it("the top-10 count has ONE definition (rank-top10.ts); no results file and no other search file types it again", () => {
    const files = [
      ...readdirSync(SEARCH_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(SEARCH_DIR, f)),
      ...BUILDER_FILES.map((f) => join(DIR, f)),
    ];
    const defining = files.filter((f) => /DISTINCT ON \(keyword_id, engine, device\) position/.test(readFileSync(f, "utf8")));
    expect(defining.map((f) => f.replace(/^.*[\\/]/, ""))).toEqual(["rank-top10.ts"]);
  });

  it("the website builder reuses the monitoring console's uptime SQL and does not restate it", () => {
    const c = code(read("website.ts"));
    expect(c).toMatch(/import \{ UPTIME_RATIO_SQL \} from "..\/..\/..\/monitoring\/monitoring\.controller"/);
    expect(c).toContain("${UPTIME_RATIO_SQL}");
    expect(c).not.toMatch(/NOT IN \('maintenance','unknown'\)/);
  });

  it("the exported uptime SQL is the expression uptime-parity.test.ts pins to runner.ts uptimeRatio()", () => {
    // Copied from uptime-parity.test.ts on purpose: importing it would let a mistake agree with itself.
    const pinned = `CASE WHEN count(*) FILTER (WHERE r.status NOT IN ('maintenance','unknown')) = 0 THEN NULL
                  ELSE count(*) FILTER (WHERE r.status = 'up')::numeric
                       / count(*) FILTER (WHERE r.status NOT IN ('maintenance','unknown'))
             END`;
    expect(norm(UPTIME_RATIO_SQL)).toBe(norm(pinned));
  });

  it("the portal route takes its client-wide test from portal-visibility.ts, never inline SQL", () => {
    const src = readFileSync(join(DIR, "..", "..", "..", "..", "core", "portal-centre-results.controller.ts"), "utf8");
    const c = code(src);
    expect(c).toMatch(/callerClientWideFor\(/);
    expect(c).not.toMatch(/project_id\s+IS\s+NULL/);
    expect(c).not.toMatch(/client_contacts/);
  });

  it("the portal route authorizes, then checks scope, then client-wide, then composes (in that order)", () => {
    const c = code(readFileSync(join(DIR, "..", "..", "..", "..", "core", "portal-centre-results.controller.ts"), "utf8"));
    const at = (needle: string) => c.indexOf(needle);
    expect(at("authorize(")).toBeGreaterThan(-1);
    expect(at("authorize(")).toBeLessThan(at("resolvePortalScope("));
    expect(at("resolvePortalScope(")).toBeLessThan(at("callerClientWideFor("));
    expect(at("callerClientWideFor(")).toBeLessThan(at("composeBusinessResults("));
  });
});

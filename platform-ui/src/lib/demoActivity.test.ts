import { describe, it, expect } from "vitest";
import { activityDemo } from "./demoActivity";
import { getDemoResponse } from "./demoFixtures";
import { parseActivityDay, parseActivitySeries } from "./activitySeries";
import { dayVolume, type ActivityDay, type ActivitySeries } from "./activitySeriesFormat";

// DW-4h-3 / DW-4i: the demo twin of GET /activity/series and GET /activity/day, with the real person-axis gate.
const T = "co-agency";
const TO = "2026-10-15";

function call(path: string, userId = "demo-hansel") {
  const url = new URL(path, "http://demo");
  return activityDemo("GET", url.pathname, url.searchParams, userId);
}
const series = (subject: string, caller = "demo-hansel", query = `to=${TO}`) => {
  const r = call(`/api/${T}/activity/series?userId=${subject}&${query}`, caller)!;
  expect(r.status).toBe(200);
  return r.json as ActivitySeries;
};
const kindsWithWork = (s: ActivitySeries) => Object.keys(s.totals).filter((k) => s.totals[k] > 0);

describe("GET /activity/series", () => {
  it("answers the contract's shape, zero-filled over the default year ending on `to`, with no total and no score", () => {
    const s = series("demo-hansel");
    expect(parseActivitySeries(s, "demo-hansel")).not.toBeNull();
    expect(s.to).toBe(TO);
    expect(s.days).toHaveLength(365);
    expect(s.days[0].date).toBe("2025-10-16");
    expect(s.days[364].date).toBe(TO);
    expect(Object.keys(s).sort()).toEqual(["days", "from", "kinds", "timezone", "to", "totals", "userId"]);
    expect(JSON.stringify(s)).not.toMatch(/score|"total"/);
  });

  it("defaults `to` to today (the demo server's own today) when the request carries none", () => {
    const r = call(`/api/${T}/activity/series?userId=demo-hansel`)!.json as ActivitySeries;
    expect(r.to).toBe(new Date().toISOString().slice(0, 10));
    expect(r.days).toHaveLength(365);
  });

  it("lists the kinds with a key, a label and a source, and every count is of a listed kind", () => {
    const s = series("u-dev");
    expect(s.kinds.length).toBeGreaterThan(10);
    for (const k of s.kinds) expect([typeof k.key, typeof k.label, typeof k.source]).toEqual(["string", "string", "string"]);
    const keys = new Set(s.kinds.map((k) => k.key));
    for (const d of s.days) for (const k of Object.keys(d.counts)) expect(keys.has(k)).toBe(true);
  });

  it("has totals that equal the sum of the days, per kind", () => {
    const s = series("u-dev");
    const sum: Record<string, number> = {};
    for (const d of s.days) for (const [k, n] of Object.entries(d.counts)) sum[k] = (sum[k] ?? 0) + n;
    expect(s.totals).toEqual(sum);
  });

  it("is deterministic: the same request answers the same", () => {
    expect(series("u-dev")).toEqual(series("u-dev"));
  });

  it("honours from and to exactly", () => {
    const s = series("u-dev", "demo-hansel", "from=2026-10-01&to=2026-10-15");
    expect(s.days.map((d) => d.date)[0]).toBe("2026-10-01");
    expect(s.days).toHaveLength(15);
  });

  it("shows plausible work across several kinds, and a different mix for different people", () => {
    const dev = series("u-dev");
    const seo = series("seo-staff");
    expect(kindsWithWork(dev).length).toBeGreaterThanOrEqual(5);
    expect(kindsWithWork(dev)).toEqual(expect.arrayContaining(["github.commits", "webdesk.edits", "pm.tasks_completed"]));
    expect(kindsWithWork(seo)).toEqual(expect.arrayContaining(["seo.briefs"]));
    expect(kindsWithWork(seo)).not.toContain("github.commits");
    expect(kindsWithWork(series("demo-hansel")).length).toBeGreaterThanOrEqual(5);
    expect(dev.totals).not.toEqual(seo.totals);
    // Not every day: some days are quiet.
    expect(dev.days.some((d) => dayVolume(d.counts) === 0)).toBe(true);
    expect(dev.days.some((d) => dayVolume(d.counts) > 0)).toBe(true);
  });

  it("answers the same shape the UI reader accepts for every demo identity", () => {
    for (const who of ["demo-hansel", "u-dev", "u-pm", "u-webhead", "gede-ic", "seo-staff", "dept-manager", "demo-owner"]) {
      expect(parseActivitySeries(series(who, who), who), who).not.toBeNull();
    }
  });
});

describe("the gate (BFF 44.3)", () => {
  const path = (subject: string) => `/api/${T}/activity/series?userId=${subject}&to=${TO}`;

  it("lets a person read themselves, and a company-wide identity read anyone", () => {
    expect(call(path("u-dev"), "u-dev")!.status).toBe(200);
    expect(call(path("u-dev"), "demo-hansel")!.status).toBe(200);
    expect(call(path("seo-staff"), "demo-owner")!.status).toBe(200);
  });

  it("lets a head read the people on the roster of their unit, and nobody else", () => {
    expect(call(path("u-dev"), "u-webhead")!.status).toBe(200);
    expect(call(path("u-pm"), "u-webhead")!.status).toBe(200);
    expect(call(path("gede-ic"), "u-webhead")).toMatchObject({ status: 403, json: { error: "outside your reporting line" } });
    expect(call(path("seo-staff"), "dept-manager")!.status).toBe(200);
    expect(call(path("u-dev"), "dept-manager")!.status).toBe(403);
  });

  it("refuses a peer, and a head reading another head", () => {
    expect(call(path("u-pm"), "u-dev")!.status).toBe(403);
    expect(call(path("u-webhead"), "dept-manager")!.status).toBe(403);
  });

  it("refuses a client-portal identity outright, even for themselves", () => {
    expect(call(path("demo-client"), "demo-client")!.status).toBe(403);
  });

  it("asks for a userId (400 with its field) and checks the gate before the dates", () => {
    expect(call(`/api/${T}/activity/series?to=${TO}`)).toMatchObject({ status: 400, json: { field: "userId" } });
    expect(call(`/api/${T}/activity/series?userId=u-pm&to=nonsense`, "u-dev")!.status).toBe(403);
  });

  it("answers a bad date or a window over 400 days with a 400 naming the field", () => {
    expect(call(`/api/${T}/activity/series?userId=u-dev&to=2026-02-30`)).toMatchObject({ status: 400, json: { field: "to" } });
    expect(call(`/api/${T}/activity/series?userId=u-dev&from=x&to=${TO}`)).toMatchObject({ status: 400, json: { field: "from" } });
    expect(call(`/api/${T}/activity/series?userId=u-dev&from=2026-10-16&to=${TO}`)).toMatchObject({ status: 400, json: { field: "to" } });
    expect(call(`/api/${T}/activity/series?userId=u-dev&from=2025-01-01&to=${TO}`)).toMatchObject({ status: 400, json: { field: "from" } });
    expect(call(`/api/${T}/activity/day?userId=u-dev&date=nope`)).toMatchObject({ status: 400, json: { field: "date" } });
  });
});

describe("GET /activity/day", () => {
  const day = (subject: string, date: string, caller = "demo-hansel") => {
    const r = call(`/api/${T}/activity/day?userId=${subject}&date=${date}`, caller)!;
    expect(r.status).toBe(200);
    return r.json as ActivityDay;
  };
  /** The day of u-dev's year with the most work, so the list is long enough to mean something. */
  const busiest = () => {
    const s = series("u-dev");
    return s.days.reduce((best, d) => (dayVolume(d.counts) > dayVolume(best.counts) ? d : best));
  };

  it("answers the contract's shape for the right person and day, with the work's own names", () => {
    const b = busiest();
    const d = day("u-dev", b.date);
    expect(parseActivityDay(d, "u-dev", b.date)).not.toBeNull();
    expect(d.items.length).toBe(dayVolume(b.counts));
    for (const it of d.items) {
      expect(it.title.trim().length).toBeGreaterThan(0);
      expect(it.at.startsWith(b.date)).toBe(true);
    }
  });

  it("agrees with the series: the items of a day count the same kinds as the series says", () => {
    const b = busiest();
    const byKind: Record<string, number> = {};
    for (const it of day("u-dev", b.date).items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    expect(byKind).toEqual(b.counts);
  });

  it("lists newest first", () => {
    const items = day("u-dev", busiest().date).items;
    const ats = items.map((i) => i.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it("carries only kind, title, time and a link to a page on this site: never message or comment text", () => {
    const d = day("u-dev", busiest().date);
    for (const it of d.items) {
      expect(Object.keys(it).every((k) => ["kind", "title", "at", "link"].includes(k))).toBe(true);
      if (it.link) expect(it.link.startsWith("/")).toBe(true);
    }
  });

  it("is empty for a quiet day (never an error) and has the same gate", () => {
    const quiet = series("u-dev").days.find((x) => dayVolume(x.counts) === 0)!;
    expect(day("u-dev", quiet.date).items).toEqual([]);
    expect(call(`/api/${T}/activity/day?userId=u-pm&date=${quiet.date}`, "u-dev")!.status).toBe(403);
  });
});

describe("routing", () => {
  it("is GET only and only for these two paths", () => {
    expect(activityDemo("POST", `/api/${T}/activity/series`, new URLSearchParams("userId=u-dev"), "demo-hansel")).toBeNull();
    expect(activityDemo("GET", `/api/${T}/activity`, new URLSearchParams(), "demo-hansel")).toBeNull();
    expect(activityDemo("GET", `/api/${T}/activity/other`, new URLSearchParams("userId=u-dev"), "demo-hansel")).toBeNull();
  });

  it("is reached through the demo backend, and does not change the old /activity feed route", () => {
    const r = getDemoResponse("GET", `/api/${T}/activity/series?userId=u-dev&to=${TO}`, "u-dev");
    expect(r.status).toBe(200);
    expect(parseActivitySeries(r.json, "u-dev")).not.toBeNull();
    expect(getDemoResponse("GET", `/api/${T}/activity/series?userId=u-pm&to=${TO}`, "u-dev").status).toBe(403);
    expect(Array.isArray(getDemoResponse("GET", `/api/${T}/activity`, "demo-hansel").json)).toBe(true);
  });
});

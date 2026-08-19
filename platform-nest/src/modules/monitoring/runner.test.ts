// MON-12 — runner decision tests. Pure: no DB, no network, `now` injected. This suite cannot skip for
// want of DATABASE_URL_TEST, which matters because scheduling and state-transition logic is exactly
// where "green because nothing ran" would be most dangerous.
import { describe, it, expect } from "vitest";
import { isDue, inMaintenance, decideTransition, uptimeRatio, partitionSpecs } from "./runner";

const T0 = new Date("2026-08-19T12:00:00.000Z");
const ago = (s: number) => new Date(T0.getTime() - s * 1000);

describe("isDue", () => {
  it("a never-checked monitor is due immediately", () => {
    // Otherwise a monitor created at 09:00 with a 24h interval shows `unknown` until tomorrow and the
    // operator reasonably concludes monitoring is broken.
    expect(isDue({ intervalSec: 86400, lastCheckedAt: null, enabled: true, now: T0 })).toBe(true);
  });

  it("respects the interval, inclusive at the boundary", () => {
    expect(isDue({ intervalSec: 60, lastCheckedAt: ago(59), enabled: true, now: T0 })).toBe(false);
    expect(isDue({ intervalSec: 60, lastCheckedAt: ago(60), enabled: true, now: T0 })).toBe(true);
    expect(isDue({ intervalSec: 60, lastCheckedAt: ago(61), enabled: true, now: T0 })).toBe(true);
  });

  it("a disabled monitor is NEVER due", () => {
    // `enabled: false` means "stop checking", not "check and hide the result".
    expect(isDue({ intervalSec: 60, lastCheckedAt: null, enabled: false, now: T0 })).toBe(false);
    expect(isDue({ intervalSec: 60, lastCheckedAt: ago(9999), enabled: false, now: T0 })).toBe(false);
  });
});

describe("inMaintenance", () => {
  const win = (from: number, to: number, monitorId: string | null = null) => ({
    startsAt: ago(from), endsAt: ago(to), monitorId,
  });

  it("matches a tenant-wide window (monitorId null) for any monitor", () => {
    expect(inMaintenance([win(60, -60)], "m1", T0)).toBe(true);
  });

  it("matches only the named monitor when scoped", () => {
    expect(inMaintenance([win(60, -60, "m1")], "m1", T0)).toBe(true);
    expect(inMaintenance([win(60, -60, "m1")], "m2", T0)).toBe(false);
  });

  it("is exclusive at the end so a window genuinely ends", () => {
    // endsAt == now must be OVER. An inclusive end would leave alerting suppressed for one extra
    // evaluation, which is the direction that hides an outage.
    expect(inMaintenance([{ startsAt: ago(60), endsAt: T0, monitorId: null }], "m1", T0)).toBe(false);
  });

  it("ignores a future window", () => {
    expect(inMaintenance([{ startsAt: ago(-60), endsAt: ago(-120), monitorId: null }], "m1", T0)).toBe(false);
  });
});

describe("decideTransition — the only place that decides whether someone gets woken", () => {
  it("opens an incident on the FIRST failure only", () => {
    const first = decideTransition({ previous: "up", observed: "down", hasOpenIncident: false, suppressed: false });
    expect(first).toEqual({ status: "down", openIncident: true, closeIncident: false });
    // Second consecutive failure must NOT try again. The partial unique index would reject it, and
    // relying on a constraint violation as control flow means every later probe of a down monitor
    // throws.
    const second = decideTransition({ previous: "down", observed: "down", hasOpenIncident: true, suppressed: false });
    expect(second.openIncident).toBe(false);
  });

  it("treats degraded as a failure worth an incident", () => {
    const r = decideTransition({ previous: "up", observed: "degraded", hasOpenIncident: false, suppressed: false });
    expect(r.status).toBe("degraded");
    expect(r.openIncident).toBe(true);
  });

  it("closes the incident on recovery", () => {
    const r = decideTransition({ previous: "down", observed: "up", hasOpenIncident: true, suppressed: false });
    expect(r).toEqual({ status: "up", openIncident: false, closeIncident: true });
  });

  it("does NOT close an incident on `unknown` — the most important rule here", () => {
    // "We stopped being able to check" is not "it got better". Closing on unknown would silently
    // resolve an outage at the exact moment the checker itself broke.
    const r = decideTransition({ previous: "down", observed: "unknown", hasOpenIncident: true, suppressed: false });
    expect(r.closeIncident).toBe(false);
    expect(r.status).toBe("unknown");
  });

  it("suppression yields `maintenance` and opens nothing", () => {
    const r = decideTransition({ previous: "up", observed: "down", hasOpenIncident: false, suppressed: true });
    expect(r).toEqual({ status: "maintenance", openIncident: false, closeIncident: false });
  });

  it("suppression does not close an already-open incident", () => {
    // Scheduling maintenance must not be a way to make an existing outage disappear from the record.
    const r = decideTransition({ previous: "down", observed: "down", hasOpenIncident: true, suppressed: true });
    expect(r.closeIncident).toBe(false);
  });
});

describe("uptimeRatio", () => {
  const s = (...st: string[]) => st.map((status) => ({ status: status as never }));

  it("returns NULL for an empty window, not 1 or 0", () => {
    // With no observations we do not know. Both 100% and 0% would be a fabricated claim about a period
    // that was never measured — the exact class of lie this module exists to prevent.
    expect(uptimeRatio([])).toBeNull();
  });

  it("computes a plain ratio", () => {
    expect(uptimeRatio(s("up", "up", "up", "down"))).toBeCloseTo(0.75);
  });

  it("EXCLUDES maintenance and unknown from both numerator and denominator", () => {
    // Counting maintenance as up flatters the figure; as down it punishes the client for scheduled
    // work. The honest answer is that the window was not measured.
    expect(uptimeRatio(s("up", "up", "maintenance", "maintenance"))).toBe(1);
    expect(uptimeRatio(s("up", "down", "unknown"))).toBeCloseTo(0.5);
    expect(uptimeRatio(s("maintenance", "unknown"))).toBeNull();
  });

  it("degraded counts against uptime", () => {
    // It is a failure of the check, so it must not quietly count as success.
    expect(uptimeRatio(s("up", "degraded"))).toBeCloseTo(0.5);
  });
});

describe("partitionSpecs", () => {
  it("covers this month plus three, with month-aligned UTC bounds", () => {
    const p = partitionSpecs(new Date("2026-08-19T12:00:00Z"));
    expect(p.map((x) => x.name)).toEqual([
      "monitor_results_202608", "monitor_results_202609", "monitor_results_202610", "monitor_results_202611",
    ]);
    expect(p[0].from).toBe("2026-08-01");
    expect(p[0].to).toBe("2026-09-01");
  });

  it("rolls the year correctly", () => {
    // December + 3 must become the next year, not month 13. Off-by-one here means a missing partition
    // in January and a runner that stops inserting on New Year's Day.
    const p = partitionSpecs(new Date("2026-11-15T00:00:00Z"));
    expect(p.map((x) => x.name)).toEqual([
      "monitor_results_202611", "monitor_results_202612", "monitor_results_202701", "monitor_results_202702",
    ]);
    expect(p[3].to).toBe("2027-03-01");
  });
});

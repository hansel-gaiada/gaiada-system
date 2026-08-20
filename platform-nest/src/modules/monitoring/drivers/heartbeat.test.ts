// MON-13 — heartbeat driver tests. Pure: no network, no DB, no clock dependency (now is injected), so
// this suite cannot skip and cannot flake.
import { describe, it, expect } from "vitest";
import {
  evaluateHeartbeat,
  validateHeartbeatConfig,
  heartbeatDriver,
  MIN_GRACE_SEC,
} from "./heartbeat";
import type { ProbeCtx } from "./registry";

const T0 = new Date("2026-08-19T12:00:00.000Z");
const at = (secondsAgo: number) => new Date(T0.getTime() - secondsAgo * 1000);
const ctx = (): ProbeCtx => ({ allowlistHosts: [], timeoutMs: 1000, audit: () => {} });

describe("never-pinged is unknown, not down", () => {
  it("returns unknown with an actionable reason", () => {
    // A heartbeat monitor that has never been pinged is almost always a job whose URL was not wired
    // up yet — a configuration state, not an outage. Calling it `down` would page someone at creation
    // and teach them the alert means nothing.
    const r = evaluateHeartbeat({ graceSec: 300 }, { lastSeenAt: null, now: T0 });
    expect(r.status).toBe("unknown");
    expect(r.detail).toMatch(/no heartbeat has ever been received/);
    expect(r.detail).toMatch(/push URL/);
  });
});

describe("the grace boundary", () => {
  it("is up inside grace, including exactly at the boundary", () => {
    expect(evaluateHeartbeat({ graceSec: 300 }, { lastSeenAt: at(0), now: T0 }).status).toBe("up");
    expect(evaluateHeartbeat({ graceSec: 300 }, { lastSeenAt: at(299), now: T0 }).status).toBe("up");
    // Inclusive on purpose: a job that pings exactly on its grace interval is healthy, and an
    // exclusive boundary would make a correctly-behaving job flap.
    expect(evaluateHeartbeat({ graceSec: 300 }, { lastSeenAt: at(300), now: T0 }).status).toBe("up");
  });

  it("is down one second past grace", () => {
    const r = evaluateHeartbeat({ graceSec: 300 }, { lastSeenAt: at(301), now: T0 });
    expect(r.status).toBe("down");
  });

  it("names how far overdue it is, because 40s and 9 hours need different responses", () => {
    const r = evaluateHeartbeat({ graceSec: 300 }, { lastSeenAt: at(900), now: T0 });
    expect(r.detail).toMatch(/no heartbeat for 900s/);
    expect(r.detail).toMatch(/600s past the 300s grace/);
  });

  it("handles a long grace, so a nightly job is not permanently down", () => {
    const day = 24 * 3600;
    expect(evaluateHeartbeat({ graceSec: day + 3600 }, { lastSeenAt: at(day), now: T0 }).status).toBe("up");
  });
});

describe("clock skew is surfaced, not silently normalised", () => {
  it("treats a future timestamp as up but SAYS so", () => {
    // Silently normalising it would hide skew that eventually produces a false alert nobody can
    // explain. A negative silence must not be arithmetic-ed into a huge "overdue" either.
    const r = evaluateHeartbeat({ graceSec: 300 }, { lastSeenAt: at(-120), now: T0 });
    expect(r.status).toBe("up");
    expect(r.detail).toMatch(/120s in the future/);
    expect(r.detail).toMatch(/clock skew/);
  });
});

describe("config validation protects the signal", () => {
  it("defaults to 300s", () => {
    expect(validateHeartbeatConfig({}).graceSec).toBe(300);
    expect(validateHeartbeatConfig(undefined).graceSec).toBe(300);
  });

  it("refuses a grace short enough that jitter becomes a page", () => {
    // An alert that cries wolf gets muted, which costs the very signal this driver exists to provide.
    expect(() => validateHeartbeatConfig({ graceSec: MIN_GRACE_SEC - 1 })).toThrow(/at least 30s/);
    expect(() => validateHeartbeatConfig({ graceSec: 0 })).toThrow();
    expect(() => validateHeartbeatConfig({ graceSec: -60 })).toThrow();
  });

  it("refuses non-integer input rather than coercing it", () => {
    expect(() => validateHeartbeatConfig({ graceSec: 45.5 })).toThrow(/integer/);
    expect(() => validateHeartbeatConfig({ graceSec: "soon" })).toThrow();
    // NaN is the case that would otherwise sail through a naive `< MIN` comparison — every
    // comparison against NaN is false, so a bad value would read as an acceptable one. That exact
    // fail-open cost the search module a ticket (config.ts moneyEnv).
    expect(() => validateHeartbeatConfig({ graceSec: NaN })).toThrow();
  });
});

describe("the driver refuses to guess when the runner forgets state", () => {
  it("THROWS rather than reporting a status", async () => {
    // A heartbeat monitor reporting "up" with no state would silently invert the only thing it is
    // for. Throwing surfaces a wiring bug; defaulting would hide one forever.
    await expect(heartbeatDriver.probe({ graceSec: 300 }, ctx())).rejects.toThrow(/without heartbeat state/);
  });

  it("evaluates normally when state is supplied", async () => {
    const r = await heartbeatDriver.probe({ graceSec: 300 }, {
      ...ctx(),
      heartbeat: { lastSeenAt: at(10), now: T0 },
    } as ProbeCtx);
    expect(r.status).toBe("up");
  });

  it("declares only the grace_period capability, so no body assertion can be attached", () => {
    expect(heartbeatDriver.capabilities).toEqual(["grace_period"]);
  });
});

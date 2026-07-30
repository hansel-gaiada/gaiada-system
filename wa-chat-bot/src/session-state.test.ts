import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import {
  recordSessionEvent,
  handleSessionEvent,
  lastEvent,
  lastKnownStatus,
  transitions,
  resetSessionState,
  observeStatus,
  loadSessionEvents,
} from "./session-state";
import type { InboundEvent } from "./gateway/events";

const DIR = "data/test-session-state";
const FILE = join(DIR, "session-events.json");

describe("session-state", () => {
  beforeEach(() => {
    config.sessionEventsFile = FILE;
    rmSync(DIR, { recursive: true, force: true });
    resetSessionState();
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("starts unknown with no events recorded", () => {
    expect(lastKnownStatus()).toBe("unknown");
    expect(lastEvent()).toBeNull();
    expect(transitions()).toEqual([]);
  });

  it("records a status and surfaces it as last-known + last event", () => {
    recordSessionEvent("STARTING", 100);
    expect(lastKnownStatus()).toBe("STARTING");
    expect(lastEvent()).toEqual({ status: "STARTING", ts: 100 });
    expect(transitions()).toEqual([{ status: "STARTING", ts: 100 }]);
  });

  it("keeps only the last 20 transitions (ring buffer)", () => {
    for (let i = 0; i < 25; i++) recordSessionEvent(`S${i}`, i);
    const t = transitions();
    expect(t.length).toBe(20);
    expect(t[0]).toEqual({ status: "S5", ts: 5 });
    expect(t[19]).toEqual({ status: "S24", ts: 24 });
    expect(lastKnownStatus()).toBe("S24");
  });

  it("warns on a WORKING -> FAILED transition (ban/logout visibility)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordSessionEvent("WORKING", 1);
    recordSessionEvent("FAILED", 2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("WORKING -> FAILED");
    warn.mockRestore();
  });

  it("warns on a WORKING -> STOPPED transition", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordSessionEvent("WORKING", 1);
    recordSessionEvent("STOPPED", 2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not warn on a benign transition (e.g. STARTING -> WORKING)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordSessionEvent("STARTING", 1);
    recordSessionEvent("WORKING", 2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not warn on repeated WORKING (no transition)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordSessionEvent("WORKING", 1);
    recordSessionEvent("WORKING", 2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("handleSessionEvent is a no-op for non-session event kinds", () => {
    const message: InboundEvent = { kind: "message", message: {} as never };
    handleSessionEvent(message);
    expect(lastKnownStatus()).toBe("unknown");

    const member: InboundEvent = { kind: "member", chatId: "g@g.us", userId: "u@c.us", change: "joined", ts: 1 };
    handleSessionEvent(member);
    expect(lastKnownStatus()).toBe("unknown");
  });

  it("handleSessionEvent records kind:session events", () => {
    const ev: InboundEvent = { kind: "session", session: "default", status: "WORKING", ts: 5 };
    handleSessionEvent(ev);
    expect(lastKnownStatus()).toBe("WORKING");
    expect(lastEvent()).toEqual({ status: "WORKING", ts: 5 });
  });

  it("persists the timeline and restores it on the next boot", () => {
    recordSessionEvent("STARTING", 100);
    recordSessionEvent("WORKING", 200);
    expect(existsSync(FILE)).toBe(true);

    // Simulate a restart: process memory gone, file left behind.
    resetSessionState();
    expect(transitions()).toEqual([]); // nothing until the boot hook runs
    loadSessionEvents();

    expect(transitions()).toEqual([
      { status: "STARTING", ts: 100 },
      { status: "WORKING", ts: 200 },
    ]);
    expect(lastKnownStatus()).toBe("WORKING");
  });

  it("loadSessionEvents on a missing or corrupt file leaves state empty (no throw)", () => {
    expect(() => loadSessionEvents()).not.toThrow();
    expect(lastKnownStatus()).toBe("unknown");
  });

  it("observeStatus records a polled status once, then de-duplicates it", () => {
    // The gap this closes: WAHA only pushes `session.status` on a CHANGE, so a session that was
    // already WORKING before boot never produces a webhook event.
    expect(observeStatus("WORKING", 10)).toBe(true);
    expect(lastKnownStatus()).toBe("WORKING");
    expect(observeStatus("WORKING", 20)).toBe(false); // ERP polling must not spam the ring
    expect(observeStatus("WORKING", 30)).toBe(false);
    expect(transitions()).toEqual([{ status: "WORKING", ts: 10 }]);

    expect(observeStatus("STOPPED", 40)).toBe(true); // a real change is still recorded
    expect(transitions()).toHaveLength(2);
  });

  it("observeStatus never lets a WAHA outage overwrite the last known status", () => {
    observeStatus("WORKING", 10);
    expect(observeStatus("unreachable", 20)).toBe(false);
    expect(observeStatus("unknown", 30)).toBe(false);
    expect(observeStatus("", 40)).toBe(false);
    expect(lastKnownStatus()).toBe("WORKING");
    expect(transitions()).toHaveLength(1);
  });
});

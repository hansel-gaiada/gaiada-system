import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordSessionEvent,
  handleSessionEvent,
  lastEvent,
  lastKnownStatus,
  transitions,
  resetSessionState,
} from "./session-state";
import type { InboundEvent } from "./gateway/events";

describe("session-state", () => {
  beforeEach(() => {
    resetSessionState();
  });

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
});

import { describe, it, expect, vi } from "vitest";
import { createAccessRecorder, ACCESS_WRITE_INTERVAL_MS, type AccessSeen } from "./access-recorder";

// DW-7h (BFF §52.3): the connection record's throttle and its never-in-the-way rule. The upsert itself is in
// request-guard.db.test.ts.
const row = (over: Partial<AccessSeen> = {}): AccessSeen => ({
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-00000000000a",
  sessionId: "sess-1",
  ip: "203.0.113.7",
  userAgent: "Firefox",
  ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("createAccessRecorder", () => {
  it("writes a key at most once per 60 seconds, and the next write carries the requests held back", async () => {
    let t = 1_000_000;
    const write = vi.fn(async () => {});
    const rec = createAccessRecorder({ write, now: () => t });
    rec.record(row());
    rec.record(row());
    rec.record(row());
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith(row(), 1);
    t += ACCESS_WRITE_INTERVAL_MS;
    rec.record(row({ userAgent: "Firefox 2" }));
    await settle();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(row({ userAgent: "Firefox 2" }), 3);
  });

  it("keys on (company, user, session, address): a new address or session is written at once", async () => {
    const write = vi.fn(async () => {});
    const rec = createAccessRecorder({ write });
    rec.record(row());
    rec.record(row({ ip: "198.51.100.1" }));
    rec.record(row({ ip: null }));
    rec.record(row({ sessionId: "" }));
    rec.record(row({ tenantId: "00000000-0000-4000-8000-000000000002" }));
    await settle();
    expect(write).toHaveBeenCalledTimes(5);
  });

  it("is bounded: past the cap the oldest key is forgotten", async () => {
    const write = vi.fn(async () => {});
    const rec = createAccessRecorder({ write, maxKeys: 2 });
    rec.record(row({ ip: "198.51.100.1" }));
    rec.record(row({ ip: "198.51.100.2" }));
    rec.record(row({ ip: "198.51.100.3" })); // evicts .1
    rec.record(row({ ip: "198.51.100.1" })); // forgotten, so written again
    rec.record(row({ ip: "198.51.100.3" })); // still throttled
    await settle();
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("returns before the write finishes and never throws, even when the write does", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let finished = false;
    const rec = createAccessRecorder({ write: async () => { await settle(); finished = true; throw new Error("db down"); } });
    expect(() => rec.record(row())).not.toThrow();
    expect(finished).toBe(false);
    await settle();
    await settle();
    expect(finished).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

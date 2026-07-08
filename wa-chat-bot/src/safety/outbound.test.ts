import { describe, it, expect } from "vitest";
import { sendWithRetry } from "./outbound";

const noSleep = async () => {};

describe("sendWithRetry", () => {
  it("succeeds on the first try", async () => {
    let calls = 0;
    const gw = { sendText: async () => { calls++; } };
    const r = await sendWithRetry(gw, "c", "hi", { sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries then succeeds", async () => {
    let calls = 0;
    const gw = { sendText: async () => { calls++; if (calls < 3) throw new Error("flaky"); } };
    const r = await sendWithRetry(gw, "c", "hi", { attempts: 3, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it("gives up after all attempts and reports the error (never throws)", async () => {
    const gw = { sendText: async () => { throw new Error("down"); } };
    const r = await sendWithRetry(gw, "c", "hi", { attempts: 2, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.error).toMatch(/down/);
  });
});

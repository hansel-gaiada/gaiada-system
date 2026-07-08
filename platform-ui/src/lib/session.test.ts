import { describe, it, expect, beforeAll } from "vitest";
import { sealSession, openSession } from "./session";

beforeAll(() => { process.env.SESSION_SECRET = "test-secret"; });

describe("session sealing", () => {
  it("round-trips a userId", () => {
    const sealed = sealSession("user-123");
    expect(openSession(sealed)).toBe("user-123");
  });
  it("rejects tampered values", () => {
    const sealed = sealSession("user-123");
    expect(openSession(sealed.replace("user-123", "user-666"))).toBeNull();
    expect(openSession("garbage")).toBeNull();
  });
});

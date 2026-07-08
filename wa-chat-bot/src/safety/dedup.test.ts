import { describe, it, expect, beforeEach } from "vitest";
import { seenBefore, dedupKey, resetDedup } from "./dedup";

describe("inbound dedup", () => {
  beforeEach(() => resetDedup());

  it("first sighting is unseen, second is seen", () => {
    const k = dedupKey("whatsapp", "MSG1");
    expect(seenBefore(k)).toBe(false);
    expect(seenBefore(k)).toBe(true);
  });

  it("distinct keys are independent", () => {
    expect(seenBefore(dedupKey("whatsapp", "A"))).toBe(false);
    expect(seenBefore(dedupKey("telegram", "A"))).toBe(false);
  });

  it("entries expire after the TTL window", () => {
    const k = dedupKey("whatsapp", "OLD");
    expect(seenBefore(k, 0)).toBe(false);
    // 25h later the key has expired and reads as unseen again
    expect(seenBefore(k, 25 * 60 * 60 * 1000)).toBe(false);
  });
});

// The empty-string case is the whole point of this file. `MONITORING_RUNNER_INTERVAL_MS` reaches the
// process through compose's `${VAR:-}` idiom, which supplies "" (not undefined) when the var is
// absent from `.env` — and `Number("")` is 0. A 0 ms interval makes the monitoring runner dial
// CLIENT WEBSITES in a tight loop, so this is a third-party-impact bug, not a local perf one.
import { describe, it, expect } from "vitest";
import { readIntervalMs } from "./config";

describe("readIntervalMs — the compose ${VAR:-} hazard", () => {
  it("EMPTY STRING falls back (the case `?? ` cannot catch)", () => {
    expect(readIntervalMs("", 60_000, 1_000)).toBe(60_000);
    expect(readIntervalMs("   ", 60_000, 1_000)).toBe(60_000);
  });

  it("undefined falls back", () => {
    expect(readIntervalMs(undefined, 60_000, 1_000)).toBe(60_000);
  });

  it("0 and negatives fall back rather than becoming a busy loop", () => {
    expect(readIntervalMs("0", 60_000, 1_000)).toBe(60_000);
    expect(readIntervalMs("-5000", 60_000, 1_000)).toBe(60_000);
  });

  it("a value under the floor falls back — a typo'd `10` must not become a stampede", () => {
    expect(readIntervalMs("10", 60_000, 1_000)).toBe(60_000);
    expect(readIntervalMs("999", 60_000, 1_000)).toBe(60_000);
  });

  it("non-numeric junk falls back", () => {
    expect(readIntervalMs("soon", 60_000, 1_000)).toBe(60_000);
    expect(readIntervalMs("60s", 60_000, 1_000)).toBe(60_000);
  });

  it("honours a real value, including exactly the floor", () => {
    expect(readIntervalMs("1000", 60_000, 1_000)).toBe(1_000);
    expect(readIntervalMs("30000", 60_000, 1_000)).toBe(30_000);
  });
});

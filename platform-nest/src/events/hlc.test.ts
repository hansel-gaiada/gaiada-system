import { describe, it, expect } from "vitest";
import { HlcClock, formatHlc, parseHlc } from "./hlc";

describe("HlcClock", () => {
  it("is monotonic under identical wall time (counter bumps)", () => {
    const c = new HlcClock(() => 1000);
    const h1 = c.next();
    const h2 = c.next();
    expect(h2 > h1).toBe(true); // padded text ordering == logical ordering
  });

  it("resets the counter when wall time advances", () => {
    let wall = 1000;
    const c = new HlcClock(() => wall);
    const h1 = c.next();
    wall = 2000;
    const h2 = c.next();
    expect(parseHlc(h2)).toEqual({ wallMs: 2000, counter: 0 });
    expect(h2 > h1).toBe(true);
  });

  it("seedFromPersisted never lets the clock regress below the last known HLC", () => {
    const c = new HlcClock(() => 500); // simulate a regressed/skewed wall clock on restart
    c.seedFromPersisted(formatHlc(9000, 3));
    const h = c.next();
    expect(h > formatHlc(9000, 3)).toBe(true);
  });

  it("padded format keeps text ordering equal to logical ordering across digit widths", () => {
    // The bug this guards: unpadded "1000.0" < "999.0" lexicographically. Padded must not.
    expect(formatHlc(1000, 0) > formatHlc(999, 0)).toBe(true);
    expect(formatHlc(1000, 10) > formatHlc(1000, 9)).toBe(true);
  });

  it("round-trips through parseHlc", () => {
    expect(parseHlc(formatHlc(123456789, 7))).toEqual({ wallMs: 123456789, counter: 7 });
  });
});

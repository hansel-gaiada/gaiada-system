import { describe, it, expect } from "vitest";
import { asOverview, readingOfOverview, type SocialOverview } from "./socialOverview";

// SCP-3f: `GET overview` as the UI reads it. The parser is strict (a body that is not the contract's is "cannot tell", never zeroes); the readings keep a refused or
// failed read apart from a count, and carry the SIMULATED mark only while the server says the tiles count simulated rows.

const body = (over: Record<string, unknown> = {}) => ({
  tiles: { inProduction: 4, withClient: 2, late: 1, scheduledThisWeek: 3, failedPosts: 0, boostsWaiting: 1 }, simulatedIncluded: false, ...over,
});

describe("asOverview", () => {
  it("reads the six tiles and the simulated flag; a boosts tile that is not a count is refused", () => {
    expect(asOverview(body())).toEqual(body());
    expect(asOverview(body({ tiles: { ...body().tiles, boostsWaiting: 2 } })).tiles.boostsWaiting).toBe(2);
    expect(() => asOverview(body({ tiles: { ...body().tiles, boostsWaiting: null as unknown as number } }))).toThrow();
  });

  it("a real zero is a zero (the server counted nothing)", () => {
    expect(asOverview(body({ tiles: { ...body().tiles, late: 0, failedPosts: 0 } })).tiles.late).toBe(0);
  });

  it("throws on a body that is not an overview, so the reader says it cannot tell", () => {
    expect(() => asOverview(null)).toThrow();
    expect(() => asOverview([])).toThrow();
    expect(() => asOverview({ tiles: body().tiles })).toThrow(); // no simulatedIncluded
    expect(() => asOverview(body({ simulatedIncluded: "yes" }))).toThrow();
    expect(() => asOverview(body({ tiles: null }))).toThrow();
  });

  it("throws on a tile that is not a count (missing, negative, fractional, a string)", () => {
    for (const bad of [undefined, -1, 1.5, "3", null, Number.NaN]) {
      expect(() => asOverview(body({ tiles: { ...body().tiles, inProduction: bad } })), String(bad)).toThrow();
    }
    expect(() => asOverview(body({ tiles: { ...body().tiles, boostsWaiting: -2 } }))).toThrow();
  });
});

describe("readingOfOverview", () => {
  const ok = (over: Partial<SocialOverview> = {}) => ({ kind: "ok" as const, data: { ...asOverview(body()), ...over } });

  it("picks each tile's own count from the one read", () => {
    const r = ok();
    expect(readingOfOverview(r, "inProduction")).toEqual({ kind: "ok", value: 4 });
    expect(readingOfOverview(r, "withClient")).toEqual({ kind: "ok", value: 2 });
    expect(readingOfOverview(r, "late")).toEqual({ kind: "ok", value: 1 });
    expect(readingOfOverview(r, "scheduledThisWeek")).toEqual({ kind: "ok", value: 3 });
    expect(readingOfOverview(r, "failedPosts")).toEqual({ kind: "ok", value: 0 });
  });

  it("marks the count SIMULATED only while the answer says simulated rows are counted", () => {
    expect(readingOfOverview(ok({ simulatedIncluded: true }), "late")).toEqual({ kind: "ok", value: 1, simulated: true });
    expect(readingOfOverview(ok(), "late")).not.toHaveProperty("simulated");
  });

  it("a refusal is No access and any other failure is Unavailable: neither is a number", () => {
    expect(readingOfOverview({ kind: "forbidden" }, "late")).toEqual({ kind: "forbidden" });
    expect(readingOfOverview({ kind: "unavailable", reason: "500" }, "late")).toEqual({ kind: "unavailable" });
  });
});

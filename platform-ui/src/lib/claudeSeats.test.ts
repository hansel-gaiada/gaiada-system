import { describe, it, expect } from "vitest";
import { mySeat, launcherSeatProps, type SeatRow } from "./claudeSeats";

function seat(over: Partial<SeatRow>): SeatRow {
  return {
    id: "s1", tenantId: "t1", personId: "u1", codeSeatEmail: "u1@gaiada.com", designLogin: null,
    status: "linked", scopes: [], mapped: true, createdBy: "u1",
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

describe("mySeat", () => {
  it("finds this person's mapped seat", () => {
    const rows = [seat({ id: "s1", personId: "u1" }), seat({ id: "s2", personId: "u2" })];
    expect(mySeat(rows, "u1")?.id).toBe("s1");
  });
  it("ignores an unmapped row even if it belongs to this person", () => {
    const rows = [seat({ id: "s1", personId: "u1", mapped: false })];
    expect(mySeat(rows, "u1")).toBeUndefined();
  });
  it("undefined when the person has no row at all", () => {
    expect(mySeat([], "u1")).toBeUndefined();
  });
});

describe("launcherSeatProps", () => {
  it("omits seat props entirely when the read was unavailable (never guesses 'unmapped')", () => {
    expect(launcherSeatProps(seat({}), true)).toEqual({});
    expect(launcherSeatProps(undefined, true)).toEqual({});
  });
  it("mapped -> seatStatus='mapped' with an 'opens as' label", () => {
    expect(launcherSeatProps(seat({ codeSeatEmail: "hansel@gaiada.com" }), false)).toEqual({
      seatStatus: "mapped",
      seatLabel: "opens as hansel@gaiada.com",
    });
  });
  it("no seat row -> seatStatus='unmapped'", () => {
    expect(launcherSeatProps(undefined, false)).toEqual({ seatStatus: "unmapped" });
  });
  it("a mapped=false row also reads as unmapped", () => {
    expect(launcherSeatProps(seat({ mapped: false }), false)).toEqual({ seatStatus: "unmapped" });
  });
});

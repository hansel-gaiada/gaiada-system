import { describe, it, expect } from "vitest";
import {
  allDayEventDays, dayStartMs, timedEventDays, windowForDays, zoneDay, zoneOffsetMs, zoneTime, zonedToInstant,
} from "./zoneTime";

const SG = "Asia/Singapore"; // +08:00, no daylight saving
const NY = "America/New_York"; // -05:00 / -04:00
const AKL = "Pacific/Auckland"; // +13:00 in October (daylight saving)

describe("zoneDay / zoneTime: the midnight edges of the display zone", () => {
  it("puts an instant one second before local midnight on the old day, and local midnight on the new one", () => {
    // 2026-10-14 23:59:59 in Singapore is 15:59:59Z; a second later it is the 15th.
    expect(zoneDay("2026-10-14T15:59:59Z", SG)).toBe("2026-10-14");
    expect(zoneDay("2026-10-14T16:00:00Z", SG)).toBe("2026-10-15");
    expect(zoneTime("2026-10-14T15:59:00Z", SG)).toBe("23:59");
    expect(zoneTime("2026-10-14T16:00:00Z", SG)).toBe("00:00");
  });

  it("differs from the UTC day for the whole eight hours either side of the zone's midnight", () => {
    // 20:00Z on the 14th is already 04:00 on the 15th in Singapore, but still the 14th in UTC.
    expect(zoneDay("2026-10-14T20:00:00Z", SG)).toBe("2026-10-15");
    expect("2026-10-14T20:00:00Z".slice(0, 10)).toBe("2026-10-14");
    // And west of UTC the local day lags: 02:00Z on the 15th is still the evening of the 14th in New York.
    expect(zoneDay("2026-10-15T02:00:00Z", NY)).toBe("2026-10-14");
  });

  it("follows a daylight-saving change (New York, 2026-11-01: the clocks go back at 02:00)", () => {
    expect(zoneOffsetMs(Date.parse("2026-10-31T12:00:00Z"), NY)).toBe(-4 * 3_600_000);
    expect(zoneOffsetMs(Date.parse("2026-11-02T12:00:00Z"), NY)).toBe(-5 * 3_600_000);
    // The 1st of November is 25 hours long: local midnight to local midnight.
    expect(dayStartMs("2026-11-02", NY) - dayStartMs("2026-11-01", NY)).toBe(25 * 3_600_000);
  });
});

describe("zonedToInstant: wall time in the zone to a UTC instant", () => {
  it("converts Singapore wall time", () => {
    expect(zonedToInstant("2026-10-14", "09:30", SG)).toBe("2026-10-14T01:30:00.000Z");
    expect(zonedToInstant("2026-10-15", "00:00", SG)).toBe("2026-10-14T16:00:00.000Z");
  });

  it("converts across a daylight-saving change", () => {
    expect(zonedToInstant("2026-10-31", "09:00", NY)).toBe("2026-10-31T13:00:00.000Z");
    expect(zonedToInstant("2026-11-02", "09:00", NY)).toBe("2026-11-02T14:00:00.000Z");
    expect(zonedToInstant("2026-10-14", "09:00", AKL)).toBe("2026-10-13T20:00:00.000Z");
  });

  it("moves a wall time that does not exist forward by the gap (New York, 2026-03-08 02:30)", () => {
    expect(zonedToInstant("2026-03-08", "02:30", NY)).toBe("2026-03-08T07:30:00.000Z");
  });

  it("takes the first of a wall time that happens twice (New York, 2026-11-01 01:30)", () => {
    expect(zonedToInstant("2026-11-01", "01:30", NY)).toBe("2026-11-01T05:30:00.000Z");
  });

  it("round-trips through zoneDay and zoneTime", () => {
    const iso = zonedToInstant("2026-12-31", "23:45", SG) as string;
    expect(zoneDay(iso, SG)).toBe("2026-12-31");
    expect(zoneTime(iso, SG)).toBe("23:45");
  });

  it("refuses text that is not a real date or time, rather than rolling it over", () => {
    expect(zonedToInstant("2026-02-30", "09:00", SG)).toBeNull();
    expect(zonedToInstant("2026-10-14", "24:00", SG)).toBeNull();
    expect(zonedToInstant("2026-10-14", "9:00", SG)).toBeNull();
    expect(zonedToInstant("14/10/2026", "09:00", SG)).toBeNull();
  });
});

describe("windowForDays", () => {
  it("is [start of the first day, start of the day after the last) in the zone", () => {
    expect(windowForDays("2026-10-14", "2026-10-14", SG)).toEqual({ from: "2026-10-13T16:00:00.000Z", to: "2026-10-14T16:00:00.000Z" });
    expect(windowForDays("2026-10-12", "2026-10-18", SG).to).toBe("2026-10-18T16:00:00.000Z");
  });

  it("a month grid (six weeks) is well inside the endpoint's 92 days", () => {
    const w = windowForDays("2026-09-28", "2026-11-08", SG);
    expect((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000).toBe(42);
  });

  it("is 25 hours on the day the clocks go back", () => {
    const w = windowForDays("2026-11-01", "2026-11-01", NY);
    expect((Date.parse(w.to) - Date.parse(w.from)) / 3_600_000).toBe(25);
  });
});

describe("the days an event occupies", () => {
  it("a timed event in one day is one day", () => {
    expect(timedEventDays("2026-10-14T02:00:00Z", "2026-10-14T03:00:00Z", SG)).toEqual(["2026-10-14"]);
  });

  it("an event that ends exactly at local midnight does not spill onto the next day", () => {
    // 23:00 to 00:00 in Singapore.
    expect(timedEventDays("2026-10-14T15:00:00Z", "2026-10-14T16:00:00Z", SG)).toEqual(["2026-10-14"]);
    // One minute longer and it does.
    expect(timedEventDays("2026-10-14T15:00:00Z", "2026-10-14T16:01:00Z", SG)).toEqual(["2026-10-14", "2026-10-15"]);
  });

  it("an event on the UTC evening is on the NEXT local day in Singapore", () => {
    // 20:00Z to 21:00Z on the 14th is 04:00 to 05:00 on the 15th.
    expect(timedEventDays("2026-10-14T20:00:00Z", "2026-10-14T21:00:00Z", SG)).toEqual(["2026-10-15"]);
  });

  it("an overnight event spans both days", () => {
    expect(timedEventDays("2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z", SG)).toEqual(["2026-10-14", "2026-10-15"]);
  });

  it("an all-day event spans its dates, both ends inclusive, whatever the zone", () => {
    expect(allDayEventDays("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(allDayEventDays("2026-10-14", "2026-10-14")).toEqual(["2026-10-14"]);
  });
});

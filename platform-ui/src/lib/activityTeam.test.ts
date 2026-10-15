import { describe, it, expect } from "vitest";
import {
  DEFAULT_TEAM_PERIOD, TEAM_PERIODS, buildTeamActivity, countsInPeriod, parseTeamPeriod, periodStart, teamRequestFrom, unitOptions,
  type TeamRead,
} from "./activityTeam";
import { addDaysIso } from "./checkins";
import type { ActivitySeries } from "./activitySeriesFormat";

// 2026-10-15 is a Thursday: its Monday is 2026-10-12, its quarter began 2026-10-01.
const TO = "2026-10-15";
const KINDS = [
  { key: "github.commits", label: "Commits", source: "github" },
  { key: "webdesk.edits", label: "Site edits", source: "webdesk" },
  { key: "seo.briefs", label: "Content briefs", source: "seo" },
];

/** A zero-filled series from `from` to TO with `over` on chosen days. */
function series(over: Record<string, Record<string, number>>, from = "2026-06-01", to = TO): ActivitySeries {
  const days: ActivitySeries["days"] = [];
  const totals: Record<string, number> = {};
  for (let d = from; d <= to; d = addDaysIso(d, 1)) {
    const counts = over[d] ?? {};
    days.push({ date: d, counts });
    for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + n;
  }
  return { userId: "u", from, to, timezone: "UTC", kinds: KINDS, days, totals };
}
const ok = (s: ActivitySeries): TeamRead => ({ kind: "ok", data: s });

describe("periods", () => {
  it("offers week, month and quarter, and month by default", () => {
    expect(TEAM_PERIODS.map((p) => p.key)).toEqual(["week", "month", "quarter"]);
    expect(DEFAULT_TEAM_PERIOD).toBe("month");
  });

  it("reads only an exact period, taking the first of a repeated one", () => {
    expect(parseTeamPeriod("week")).toBe("week");
    expect(parseTeamPeriod("quarter")).toBe("quarter");
    expect(parseTeamPeriod(["week", "quarter"])).toBe("week");
    for (const bad of [undefined, null, "", "year", "WEEK", "month; drop"]) expect(parseTeamPeriod(bad)).toBe("month");
  });

  it("starts the week on Monday, the month on the 1st and the quarter on its first month", () => {
    expect(periodStart("week", TO)).toBe("2026-10-12");
    expect(periodStart("week", "2026-10-11")).toBe("2026-10-05"); // a Sunday belongs to the week before it
    expect(periodStart("month", TO)).toBe("2026-10-01");
    expect(periodStart("quarter", TO)).toBe("2026-10-01");
    expect(periodStart("quarter", "2026-08-20")).toBe("2026-07-01");
    expect(periodStart("quarter", "2026-03-31")).toBe("2026-01-01");
    expect(periodStart("quarter", "2026-05-02")).toBe("2026-04-01");
  });

  it("asks for 100 days, enough for the longest quarter, and leaves `to` to the server", () => {
    expect(teamRequestFrom("2026-10-15")).toBe("2026-07-07");
  });

  it("cuts a person's counts from the series' own `to`, whatever the clock here says", () => {
    const s = series({ "2026-09-30": { "github.commits": 9 }, "2026-10-01": { "github.commits": 2 }, "2026-10-14": { "github.commits": 1, "webdesk.edits": 1 } });
    const cut = countsInPeriod(s, "month");
    expect(cut).toEqual({ from: "2026-10-01", to: TO, counts: { "github.commits": 3, "webdesk.edits": 1 } });
    expect(countsInPeriod(s, "quarter").counts["github.commits"]).toBe(3);
    expect(countsInPeriod(series({ "2026-10-09": { "github.commits": 4 }, "2026-10-13": { "github.commits": 1 } }), "week").counts).toEqual({ "github.commits": 1 });
  });
});

describe("the rows of the team", () => {
  const people = [
    { userId: "u-3", name: "Zed Busy" },
    { userId: "u-1", name: "Ada Quiet" },
    { userId: "u-2", name: "Made Putra" },
  ];

  it("lists people by NAME, never by volume, even when the busiest person is last", () => {
    const reads = [
      ok(series({ "2026-10-14": { "github.commits": 50 } })), // Zed, the busiest
      ok(series({})),                                           // Ada, quiet
      ok(series({ "2026-10-14": { "github.commits": 5 } })),   // Made
    ];
    const t = buildTeamActivity(people, reads, "month");
    expect(t.rows.map((r) => r.name)).toEqual(["Ada Quiet", "Made Putra", "Zed Busy"]);
  });

  it("gives counts by kind in the server's order, and a quiet person an empty phrase (not a zero)", () => {
    const reads = [ok(series({ "2026-10-14": { "webdesk.edits": 1, "github.commits": 2 } })), ok(series({})), ok(series({}))];
    const t = buildTeamActivity(people, reads, "month");
    const zed = t.rows.find((r) => r.userId === "u-3")!;
    const ada = t.rows.find((r) => r.userId === "u-1")!;
    expect(zed).toMatchObject({ state: "ok", phrase: "Commits 2, Site edits 1" });
    expect(ada).toMatchObject({ state: "ok", phrase: "" });
  });

  it("makes a refused or failed person unavailable on their own row, and leaves the others as they are", () => {
    const reads: TeamRead[] = [{ kind: "forbidden" }, { kind: "error", reason: "boom" }, ok(series({ "2026-10-14": { "github.commits": 1 } }))];
    const t = buildTeamActivity(people, reads, "month");
    expect(t.rows.map((r) => [r.name, r.state])).toEqual([["Ada Quiet", "unavailable"], ["Made Putra", "ok"], ["Zed Busy", "unavailable"]]);
  });

  it("has no total, no score and no rank on any row", () => {
    const reads = [ok(series({ "2026-10-14": { "github.commits": 5 } })), ok(series({})), ok(series({}))];
    const t = buildTeamActivity(people, reads, "month");
    expect(JSON.stringify(t)).not.toMatch(/total|score|rank|rating/i);
  });

  it("states the period from the first person who could be read, and null when nobody could", () => {
    const some = buildTeamActivity(people, [{ kind: "forbidden" }, ok(series({})), { kind: "forbidden" }], "week");
    expect([some.from, some.to]).toEqual(["2026-10-12", TO]);
    const none = buildTeamActivity(people, [{ kind: "forbidden" }, { kind: "forbidden" }, { kind: "error", reason: "x" }], "week");
    expect([none.from, none.to]).toEqual([null, null]);
  });

  it("treats a missing read as unavailable, never as a quiet person", () => {
    expect(buildTeamActivity(people, [], "month").rows.every((r) => r.state === "unavailable")).toBe(true);
  });
});

describe("the units a caller may pick", () => {
  const root = {
    id: "root", name: "Agency", kind: "company",
    children: [
      { id: "d-web", name: "Web Dev", kind: "department", children: [{ id: "dv-fe", name: "Frontend", kind: "division", children: [] }, { id: "p-1", name: "A person", kind: "person", children: [] }] },
      { id: "d-seo", name: "SEO", kind: "department", children: [] },
    ],
  };

  it("lists every department and division for a company-wide reader, by name", () => {
    expect(unitOptions(root, null)).toEqual([
      { value: "dv-fe", label: "Frontend" }, { value: "d-seo", label: "SEO" }, { value: "d-web", label: "Web Dev" },
    ]);
  });

  it("lists a led unit and what is beneath it, and nothing else", () => {
    expect(unitOptions(root, ["d-web"])).toEqual([{ value: "dv-fe", label: "Frontend" }, { value: "d-web", label: "Web Dev" }]);
    expect(unitOptions(root, ["dv-fe"])).toEqual([{ value: "dv-fe", label: "Frontend" }]);
    expect(unitOptions(root, ["not-in-this-company"])).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import {
  addDeptEventHref, agendaDays, agendaEmptyText, asDeptCalendar, chipsByDay, dayLabel, eventUnitChoices, inMonth, isCurrentMonth, legNotes,
  monthTitle, monthWindow, parseMonth, scheduleHref, shiftMonth, sixWeekGrid, unitNameIn,
  type DeptCalendar,
} from "./deptCalendar";
import { areaFor } from "./areas";
import { agencyTree, lead, me, member, node, person } from "./workspaceFixtures";

const SG = "Asia/Singapore";

// DW-10c-3 (BFF section 59): the department calendar's pure parts. October 2026 starts on a Thursday, so its grid runs Mon 28 Sep to Sun 8 Nov.
const empty = <T,>(): { included: true; items: T[] } => ({ included: true, items: [] });
const cal = (over: Partial<DeptCalendar> = {}): DeptCalendar => ({
  unit: { id: "dept-1", name: "Web Dev" }, from: "2026-09-28", to: "2026-11-08",
  holidays: empty(), away: empty(), deadlines: empty(), events: empty(), ...over,
});

describe("the month math", () => {
  it("is six weeks of seven days, Monday first, for any month", () => {
    for (const month of ["2026-10", "2027-02", "2026-11", "2026-12", "2024-02", "2026-06"]) {
      const weeks = sixWeekGrid(month);
      expect(weeks, month).toHaveLength(6);
      for (const w of weeks) expect(w, month).toHaveLength(7);
      // Monday first: every row's first cell is a Monday, and the days run on without a gap.
      for (const w of weeks) expect(new Date(`${w[0]}T00:00:00Z`).getUTCDay(), month).toBe(1);
      const flat = weeks.flat();
      for (let i = 1; i < flat.length; i++) expect(Date.parse(`${flat[i]}T00:00:00Z`) - Date.parse(`${flat[i - 1]}T00:00:00Z`), month).toBe(86_400_000);
    }
  });

  it("starts on the Monday on or before the 1st and holds the whole month", () => {
    expect(sixWeekGrid("2026-10")[0][0]).toBe("2026-09-28"); // the 1st is a Thursday
    expect(sixWeekGrid("2027-02")[0][0]).toBe("2027-02-01"); // the 1st is a Monday: no leading days
    expect(sixWeekGrid("2026-11")[0][0]).toBe("2026-10-26"); // the 1st is a Sunday: six leading days
    for (const month of ["2026-10", "2027-02", "2026-11", "2026-12", "2024-02"]) {
      const flat = sixWeekGrid(month).flat();
      const inside = flat.filter((d) => inMonth(d, month));
      expect(inside[0], month).toBe(`${month}-01`);
      const [y, m] = month.split("-").map(Number);
      expect(inside, month).toHaveLength(new Date(Date.UTC(y, m, 0)).getUTCDate());
    }
  });

  it("asks for the 42 days of the grid, both ends counted: the server's longest window", () => {
    expect(monthWindow("2026-10")).toEqual({ from: "2026-09-28", to: "2026-11-08" });
    expect(monthWindow("2027-02")).toEqual({ from: "2027-02-01", to: "2027-03-14" });
    expect(monthWindow("2026-12")).toEqual({ from: "2026-11-30", to: "2027-01-10" });
    for (const month of ["2026-10", "2027-02", "2026-12", "2024-02"]) {
      const w = monthWindow(month);
      expect((Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000 + 1, month).toBe(42);
    }
  });

  it("steps by whole months across a year end, and words the month", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-10", 0)).toBe("2026-10");
    expect(shiftMonth("2026-10", 14)).toBe("2027-12");
    expect(monthTitle("2026-10")).toBe("October 2026");
    expect(dayLabel("2026-10-12")).toBe("Mon 12 Oct 2026");
  });

  it("reads ?month= strictly: anything but a real YYYY-MM is the current month", () => {
    expect(parseMonth("2026-11", "2026-10")).toBe("2026-11");
    for (const bad of [undefined, "", "2026-13", "2026-00", "2026-1", "2026-10-01", "abc", "26-10", "1800-01", "2500-01", "2026/10"]) {
      expect(parseMonth(bad, "2026-10"), String(bad)).toBe("2026-10");
    }
  });

  it("makes the current month the bare address and any other month a ?month= link", () => {
    expect(isCurrentMonth("2026-10", "2026-10-16")).toBe(true);
    expect(scheduleHref("dept-1", "2026-10", "2026-10-16")).toBe("/departments/dept-1/schedule");
    expect(scheduleHref("dept-1", "2026-11", "2026-10-16")).toBe("/departments/dept-1/schedule?month=2026-11");
    expect(scheduleHref("d/1", "2026-11", "2026-10-16")).toBe("/departments/d%2F1/schedule?month=2026-11");
  });

  it("links 'Add an event' to the schedule form with the department preselected", () => {
    expect(addDeptEventHref("dept-1")).toBe("/calendar/new?visibility=department&unit=dept-1");
  });

  it("lives under the department's workspace area, so it needs no area rule of its own", () => {
    expect(areaFor("/departments/dept-1/schedule")).toMatchObject({ kind: "workspace" });
    expect(areaFor("/departments/dept-1/calendar")).toMatchObject({ kind: "workspace" });
  });
});

describe("asDeptCalendar: the answer, checked", () => {
  const full = {
    unit: { id: "dept-1", name: "Web Dev" }, from: "2026-09-28", to: "2026-11-08",
    holidays: { included: true, items: [{ day: "2026-10-09", name: "Nyepi", kind: "public" }] },
    away: { included: true, items: [{ userId: "u1", name: "Andre", startsOn: "2026-10-13", endsOn: "2026-10-15", leaveType: "vacation" }] },
    deadlines: { included: true, items: [] },
    events: { included: true, items: [] },
  };

  it("keeps the four legs as they came", () => {
    expect(asDeptCalendar(full)).toEqual(full);
  });

  it("keeps `truncated` on an included leg, and only there", () => {
    const r = asDeptCalendar({ ...full, away: { included: true, items: [], truncated: true }, holidays: { included: true, items: [], truncated: false } });
    expect(r.away).toEqual({ included: true, items: [], truncated: true });
    expect(r.holidays).toEqual({ included: true, items: [] });
  });

  it("keeps a leg that was not read with its reason", () => {
    const r = asDeptCalendar({ ...full, away: { included: false, reason: "module_off" }, deadlines: { included: false, reason: "read_failed" } });
    expect(r.away).toEqual({ included: false, reason: "module_off" });
    expect(r.deadlines).toEqual({ included: false, reason: "read_failed" });
  });

  it("makes a malformed or missing leg a failed one, never an empty list", () => {
    for (const bad of [undefined, null, [], "x", {}, { included: true }, { included: true, items: "no" }, { included: false }, { included: false, reason: "because" }]) {
      const r = asDeptCalendar({ ...full, away: bad });
      expect(r.away, JSON.stringify(bad)).toEqual({ included: false, reason: "read_failed" });
      // ... and takes no other leg with it.
      expect(r.holidays.included).toBe(true);
    }
  });

  it("refuses an answer with no unit or window at all", () => {
    for (const bad of [null, undefined, [], "x", {}, { ...full, unit: null }, { ...full, from: undefined }, { ...full, to: 5 }, { ...full, unit: { name: "x" } }]) {
      expect(() => asDeptCalendar(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("chips and the agenda", () => {
  const events = [
    { id: "e1", title: "Sprint review", startsAt: "2026-10-11T06:00:00.000Z", endsAt: "2026-10-11T07:00:00.000Z", startsOn: null, endsOn: null, visibility: "department" as const, unitNodeId: "dept-1" },
    { id: "e2", title: "All-hands", startsAt: null, endsAt: null, startsOn: "2026-10-22", endsOn: "2026-10-23", visibility: "company" as const, unitNodeId: null },
  ];
  const full = cal({
    holidays: { included: true, items: [{ day: "2026-10-11", name: "Nyepi", kind: "public" }, { day: "2026-10-30", name: "Joint leave", kind: "joint_leave" }] },
    away: { included: true, items: [
      { userId: "u2", name: "Sari", startsOn: "2026-10-11", endsOn: "2026-10-11", leaveType: "sick" },
      { userId: "u1", name: "Andre", startsOn: "2026-10-09", endsOn: "2026-10-11", leaveType: "vacation" },
    ] },
    deadlines: { included: true, items: [{ milestoneId: "m1", name: "Staging sign-off", dueDate: "2026-10-11", projectId: "p-web-1", projectName: "Client site" }] },
    events: { included: true, items: events },
  });

  it("puts a chip of each kind on its day, in the order holiday, away (by name), milestone, event", () => {
    const day = chipsByDay(full, "co-a", SG).get("2026-10-11")!;
    expect(day.map((c) => [c.kind, c.label])).toEqual([
      ["holiday", "Nyepi"],
      ["away", "Andre · vacation"],
      ["away", "Sari · sick"],
      ["milestone", "Client site · Staging sign-off"],
      ["event", "14:00 · Sprint review"],
    ]);
  });

  it("links a milestone to its project and an event to its page in its company, and leaves holidays and leave as plain information", () => {
    const day = chipsByDay(full, "co-a", SG).get("2026-10-11")!;
    const by = (k: string) => day.find((c) => c.kind === k)!;
    expect(by("milestone").href).toBe("/projects/p-web-1");
    expect(by("event").href).toBe("/calendar/events/e1?company=co-a");
    expect(by("holiday").href).toBeNull();
    expect(by("away").href).toBeNull();
  });

  it("spreads a leave over each of its days, and an all-day event over each of its days", () => {
    const m = chipsByDay(full, "co-a", SG);
    expect(["2026-10-09", "2026-10-10", "2026-10-11"].map((d) => m.get(d)!.some((c) => c.label === "Andre · vacation"))).toEqual([true, true, true]);
    expect(m.get("2026-10-12")?.some((c) => c.label === "Andre · vacation") ?? false).toBe(false);
    expect(m.get("2026-10-22")![0].label).toBe("All day · All-hands");
    expect(m.get("2026-10-23")![0].label).toBe("All day · All-hands");
  });

  it("places a timed event in the display zone, and a multi-day one as 'from', 'All day' and 'until'", () => {
    // 23:30 on the 11th, Singapore, to 01:30 on the 13th.
    const late = cal({ events: { included: true, items: [{ ...events[0], id: "e3", startsAt: "2026-10-11T15:30:00.000Z", endsAt: "2026-10-12T17:30:00.000Z" }] } });
    const m = chipsByDay(late, "co-a", SG);
    expect(m.get("2026-10-11")![0].label).toBe("23:30 · Sprint review");
    expect(m.get("2026-10-12")![0].label).toBe("All day · Sprint review");
    expect(m.get("2026-10-13")![0].label).toBe("until 01:30 · Sprint review");
  });

  it("drops anything outside the window the answer is for", () => {
    const out = cal({ holidays: { included: true, items: [{ day: "2026-12-25", name: "Christmas", kind: "public" }] }, away: { included: true, items: [{ userId: "u1", name: "Andre", startsOn: "2026-09-20", endsOn: "2026-10-01", leaveType: "other" }] } });
    const m = chipsByDay(out, "co-a", SG);
    expect(m.has("2026-12-25")).toBe(false);
    expect([...m.keys()].sort()).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
  });

  it("gives a leg that was not included no chips at all", () => {
    const m = chipsByDay({ ...full, away: { included: false, reason: "read_failed" }, holidays: { included: false, reason: "module_off" } }, "co-a", SG);
    const kinds = new Set([...m.values()].flat().map((c) => c.kind));
    expect(kinds.has("away")).toBe(false);
    expect(kinds.has("holiday")).toBe(false);
    expect(kinds.has("milestone")).toBe(true);
  });

  it("makes the agenda the days that hold something, in date order, with the same items", () => {
    const m = chipsByDay(full, "co-a", SG);
    const days = agendaDays(m);
    expect(days.map((d) => d.day)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-22", "2026-10-23", "2026-10-30"]);
    expect(days.flatMap((d) => d.chips)).toHaveLength([...m.values()].flat().length);
    expect(agendaDays(new Map())).toEqual([]);
  });

  it("describes a holiday's kind and a leave's dates in the agenda detail", () => {
    const m = chipsByDay(full, "co-a", SG);
    expect(m.get("2026-10-30")![0].detail).toBe("Joint leave");
    expect(m.get("2026-10-11")!.find((c) => c.label === "Nyepi")!.detail).toBe("Public holiday");
    expect(m.get("2026-10-10")!.find((c) => c.label === "Andre · vacation")!.detail).toBe("9 Oct to 11 Oct");
    expect(m.get("2026-10-11")!.find((c) => c.label === "Sari · sick")!.detail).toBe("");
    expect(m.get("2026-10-11")!.find((c) => c.kind === "event")!.detail).toBe("Web Dev");
    expect(m.get("2026-10-22")![0].detail).toBe("Whole company");
  });
});

describe("what did not load", () => {
  it("says nothing when every leg was read", () => {
    expect(legNotes(cal())).toEqual([]);
  });

  it("words each leg that was not read, so a missing chip is never taken for 'nobody is away'", () => {
    const text = (over: Partial<DeptCalendar>) => legNotes(cal(over)).map((n) => n.text);
    expect(text({ away: { included: false, reason: "read_failed" } })).toEqual(["Leave could not be loaded, so who is away is not shown."]);
    expect(text({ holidays: { included: false, reason: "read_failed" } })).toEqual(["Holidays could not be loaded."]);
    expect(text({ deadlines: { included: false, reason: "read_failed" } })).toEqual(["Projects could not be loaded, so milestones are not shown."]);
    expect(text({ deadlines: { included: false, reason: "module_off" } })).toEqual(["The Projects module is off for this company, so milestones are not shown."]);
    expect(text({ events: { included: false, reason: "read_failed" } })).toEqual(["Events could not be loaded."]);
    expect(text({ away: { included: false, reason: "module_off" } })).toEqual(["The HR module is off for this company, so who is away is not shown."]);
    expect(text({ holidays: { included: false, reason: "module_off" } })).toEqual(["The HR module is off for this company, so holidays are not shown."]);
  });

  it("says the HR module once when it is off for both of its legs", () => {
    const notes = legNotes(cal({ holidays: { included: false, reason: "module_off" }, away: { included: false, reason: "module_off" } }));
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("The HR module is off for this company, so holidays and who is away are not shown.");
  });

  it("keeps two different reasons on the two HR legs separate", () => {
    const notes = legNotes(cal({ holidays: { included: false, reason: "module_off" }, away: { included: false, reason: "read_failed" } }));
    expect(notes.map((n) => n.leg)).toEqual(["holidays", "away"]);
  });

  it("says a leg was cut at 200, and says it only for an included leg that is truncated", () => {
    const notes = legNotes(cal({ away: { included: true, items: [], truncated: true }, events: { included: true, items: [], truncated: true } }));
    expect(notes.map((n) => n.text)).toEqual(["Only the first 200 leave entries are shown, so some may be missing.", "Only the first 200 events are shown, so some may be missing."]);
  });

  it("says 'Nothing is scheduled' only after every leg was read", () => {
    expect(agendaEmptyText(cal())).toBe("Nothing is scheduled for this period.");
    const partial = agendaEmptyText(cal({ away: { included: false, reason: "read_failed" } }));
    expect(partial).not.toMatch(/^Nothing is scheduled/);
    expect(partial).toMatch(/from what could be loaded/);
  });
});

describe("the department choices of the event form", () => {
  // d-web > dv-fe (Frontend) > the person; HR people sit directly under their department.
  const tree = node("root", "Agency", "company", [
    node("d-web", "Web Dev", "department", [node("dv-fe", "Frontend", "division", [node("r1", "Senior Developer", "role", [person("p1", "u-1")])]), node("dv-be", "Backend", "division")]),
    node("d-seo", "SEO", "department", [person("p2", "u-2")]),
    node("d-gm", "GM", "department"),
  ]);

  it("offers the units above a person's own placement, outermost first, and never their role or the root", () => {
    expect(eventUnitChoices(me([member()]), tree).map((c) => [c.id, c.label])).toEqual([["d-web", "My department: Web Dev"], ["dv-fe", "My department: Frontend"]]);
  });

  it("offers a unit the person leads, even when they are placed elsewhere, once", () => {
    const head = me([member(), lead("d-seo")]);
    expect(eventUnitChoices(head, tree).map((c) => c.id)).toEqual(["d-web", "dv-fe", "d-seo"]);
    const both = me([member(), lead("d-web")]);
    expect(eventUnitChoices(both, tree).map((c) => c.id)).toEqual(["d-web", "dv-fe"]);
  });

  it("offers nobody a unit they have no part in, and the root never", () => {
    const stranger = { ...me([member(), lead("root")]), userId: "u-9" };
    expect(eventUnitChoices(stranger, tree)).toEqual([]);
  });

  it("adds the unit the page linked here with, labelled as a department rather than as 'mine'", () => {
    const choices = eventUnitChoices({ ...me([member()]), userId: "u-9" }, tree, "d-seo");
    expect(choices).toEqual([{ id: "d-seo", name: "SEO", label: "Department: SEO" }]);
    // Already one of theirs: not offered twice. Not in the tree, or the root: not offered.
    expect(eventUnitChoices(me([member()]), tree, "d-web").map((c) => c.id)).toEqual(["d-web", "dv-fe"]);
    expect(eventUnitChoices(me([member()]), tree, "nowhere").map((c) => c.id)).toEqual(["d-web", "dv-fe"]);
    expect(eventUnitChoices(me([member()]), tree, "root").map((c) => c.id)).toEqual(["d-web", "dv-fe"]);
  });

  it("offers nothing without the org tree", () => {
    expect(eventUnitChoices(me([member(), lead("d-web")]), null, "d-web")).toEqual([]);
  });

  it("works on the shared workspace fixture tree too", () => {
    expect(eventUnitChoices(me([member()]), agencyTree({ web: ["u-1"] })).map((c) => c.name)).toEqual(["Web Dev"]);
  });

  it("names a unit from the tree, or null when it has left it", () => {
    expect(unitNameIn(tree, "dv-fe")).toBe("Frontend");
    expect(unitNameIn(tree, "gone")).toBeNull();
    expect(unitNameIn(null, "d-web")).toBeNull();
    expect(unitNameIn(tree, null)).toBeNull();
  });
});

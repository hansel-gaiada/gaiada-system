// SCP-6a — the sheet import's pure half (BFF §63.23): the cell readers, the names, the body, and the two previews, with no database and no Cerbos.
// The client names are invented ("Mock Bakery", "Demo Studio", ...); nothing here is a real client or a real person.
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { instantInTz } from "../../../core/activity-kinds";
import {
  DEFAULT_POST_TIME, cyclesToCreate, finishPlan, importPostId, isKnownTimeZone, matchClient, matchOfficer, normalizeName, parseImportBody,
  previewAllocation, readBatch, readCreativeSource, readDate, readFormat, readFormats, readHashtags, readNetworks, readReportFormat, readTime,
  readWholeNumber, readYesNo, stagePlanRows, suggestNames, titleFromCaption,
  type AllocationEngagement, type ImportBody, type Member, type PlanEngagement, type PlanLookups,
} from "./sheet-import";

const TODAY = "2026-10-29";
const TENANT = "11111111-1111-4111-8111-111111111111";
const E = { bakery: "aaaaaaaa-0000-4000-8000-000000000001", studio: "aaaaaaaa-0000-4000-8000-000000000002", garden: "aaaaaaaa-0000-4000-8000-000000000003", bakery2: "aaaaaaaa-0000-4000-8000-000000000004" };
const U = { ayu: "bbbbbbbb-0000-4000-8000-000000000001", budi: "bbbbbbbb-0000-4000-8000-000000000002", budi2: "bbbbbbbb-0000-4000-8000-000000000003" };

/** The `{message, field}` of the 400 a call throws. */
function refusal(fn: () => unknown): { message?: string; field?: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) return e.getResponse() as { message?: string; field?: string };
    throw e;
  }
  throw new Error("expected a 400");
}

// ═════════════════════════════════════════════════════════════════════════════════════════ names

describe("normalizeName", () => {
  it("lower-cases, removes accents, turns punctuation into spaces, collapses and trims", () => {
    expect(normalizeName("  Café  Ñandú — Bar & Grill!! ")).toBe("cafe nandu bar grill");
    expect(normalizeName("MOCK-BAKERY, Ltd.")).toBe("mock bakery ltd");
    expect(normalizeName("a_b/c")).toBe("a b c");
    expect(normalizeName("")).toBe("");
    expect(normalizeName("...")).toBe("");
  });
});

describe("suggestNames", () => {
  const list = [
    { id: "1", name: "Mock Bakery Bali" },
    { id: "2", name: "Mock Bakery" },
    { id: "3", name: "Demo Studio" },
    { id: "4", name: "Bakery of Demo Town" },
    { id: "5", name: "Unrelated Co" },
  ];
  it("offers the candidates sharing the most words first, the shorter name first among equals, at most three", () => {
    expect(suggestNames("mock bakery", list).map((x) => x.id)).toEqual(["2", "1", "4"]);
    expect(suggestNames("Demo", list).map((x) => x.id)).toEqual(["3", "4"]);
  });
  it("offers nothing that shares no word", () => {
    expect(suggestNames("Zebra Zone", list)).toEqual([]);
    expect(suggestNames("", list)).toEqual([]);
  });
  it("honours the limit", () => {
    expect(suggestNames("mock bakery demo", list, 2)).toHaveLength(2);
  });
});

describe("matchClient", () => {
  const eng = [
    { id: "e1", clientName: "Mock Bakery" },
    { id: "e2", clientName: "Demo Studio" },
    { id: "e3", clientName: "Demo  Studio!" },
  ];
  it("matches one engagement by normalized name", () => {
    expect(matchClient("MOCK bakery", eng, new Map())).toEqual({ kind: "matched", id: "e1" });
  });
  it("is none when no name matches, and ambiguous when two engagements share one", () => {
    expect(matchClient("Nobody", eng, new Map())).toEqual({ kind: "none" });
    expect(matchClient("demo studio", eng, new Map())).toEqual({ kind: "ambiguous", ids: ["e2", "e3"] });
  });
  it("the person's pick wins over the name rule", () => {
    expect(matchClient("demo studio", eng, new Map([["demo studio", "e3"]]))).toEqual({ kind: "matched", id: "e3" });
    expect(matchClient("Nobody", eng, new Map([["nobody", "e1"]]))).toEqual({ kind: "matched", id: "e1" });
  });
});

describe("matchOfficer", () => {
  const members: Member[] = [
    { id: "u1", name: "Ayu Mock", email: "ayu@mock.test" },
    { id: "u2", name: "Budi Demo", email: "budi@mock.test" },
    { id: "u3", name: "Budi  Demo", email: "budi2@mock.test" },
  ];
  it("matches by email (case ignored), then by name", () => {
    expect(matchOfficer("AYU@mock.test", members, new Map())).toEqual({ kind: "matched", id: "u1" });
    expect(matchOfficer("ayu mock", members, new Map())).toEqual({ kind: "matched", id: "u1" });
    expect(matchOfficer("budi2@mock.test", members, new Map())).toEqual({ kind: "matched", id: "u3" });
  });
  it("is none for nobody, ambiguous for a name two members share, and the pick wins", () => {
    expect(matchOfficer("Nobody", members, new Map())).toEqual({ kind: "none" });
    expect(matchOfficer("budi demo", members, new Map())).toEqual({ kind: "ambiguous" });
    expect(matchOfficer("budi demo", members, new Map([["budi demo", "u2"]]))).toEqual({ kind: "matched", id: "u2" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════ readers

describe("the whole-number reader", () => {
  it("takes the first whole number in the cell", () => {
    expect(readWholeNumber("12")).toBe(12);
    expect(readWholeNumber("12 posts")).toBe(12);
    expect(readWholeNumber("about 8-10")).toBe(8);
    expect(readWholeNumber("12.5")).toBe(12);
    expect(readWholeNumber("none")).toBeUndefined();
  });
});

describe("the creative source, batch and report format readers", () => {
  it("creatives from Creatives, Creative team, Creatives dept; in_team from the in-team forms", () => {
    for (const c of ["Creatives", "creative team", "CREATIVES DEPT", "Creatives Dept."]) expect(readCreativeSource(c), c).toBe("creatives");
    for (const c of ["In team", "In-team", "In house", "in-house", "Social designer", "Own designer"]) expect(readCreativeSource(c), c).toBe("in_team");
    expect(readCreativeSource("agency")).toBeUndefined();
  });
  it("batch A or B, case ignored, also as Batch A", () => {
    expect(readBatch("A")).toBe("A");
    expect(readBatch("b")).toBe("B");
    expect(readBatch("Batch A")).toBe("A");
    expect(readBatch("batch b")).toBe("B");
    expect(readBatch("C")).toBeUndefined();
    expect(readBatch("AB")).toBeUndefined();
  });
  it("email from Email and E-mail; meeting from Meeting, Call, Zoom, Meet", () => {
    for (const c of ["Email", "E-mail", "e mail"]) expect(readReportFormat(c), c).toBe("email");
    for (const c of ["Meeting", "Call", "Zoom", "Meet"]) expect(readReportFormat(c), c).toBe("meeting");
    expect(readReportFormat("Post")).toBeUndefined();
  });
});

describe("the network list reader", () => {
  it("splits on , / + & ; and new lines, and maps keys, names and the short forms", () => {
    expect(readNetworks("IG, FB / TikTok + LinkedIn & YT; Twitter\nthreads")).toEqual(["instagram", "facebook", "tiktok", "linkedin", "youtube", "x", "threads"]);
    expect(readNetworks("TT")).toEqual(["tiktok"]);
    expect(readNetworks("LI/x")).toEqual(["linkedin", "x"]);
    expect(readNetworks("pinterest, bluesky, mastodon")).toEqual(["pinterest", "bluesky", "mastodon"]);
  });
  it("keeps each network once, in the order written", () => {
    expect(readNetworks("Instagram, ig, IG")).toEqual(["instagram"]);
    expect(readNetworks("FB, IG")).toEqual(["facebook", "instagram"]);
  });
  it("an unknown item, or a list of nothing, is unreadable", () => {
    expect(readNetworks("IG, Snapchat")).toBeUndefined();
    expect(readNetworks(" , ; ")).toBeUndefined();
  });
});

describe("the format readers", () => {
  it("feed, carousel, reel and story from their words", () => {
    expect(readFormats("Feed, Post, Single, Image, Static")).toEqual(["feed"]);
    expect(readFormats("Carousel / Slide / Slides / Album")).toEqual(["carousel"]);
    expect(readFormats("Reel + Reels + Video")).toEqual(["reel"]);
    expect(readFormats("Story; Stories & IGS")).toEqual(["story"]);
    expect(readFormats("Reels, Stories, Post, Slides")).toEqual(["reel", "story", "feed", "carousel"]);
    expect(readFormats("poster")).toBeUndefined();
  });
  it("the plan's format is one value: a cell naming two is unreadable", () => {
    expect(readFormat("Carousel")).toBe("carousel");
    expect(readFormat("IGS")).toBe("story");
    expect(readFormat("feed, reel")).toBeUndefined();
  });
});

describe("the time reader", () => {
  it.each([
    ["09:30", "09:30"], ["9:30", "09:30"], ["9.30", "09:30"], ["17.30", "17:30"], ["23:59", "23:59"], ["0:00", "00:00"],
    ["9am", "09:00"], ["9 am", "09:00"], ["9AM", "09:00"], ["7:30 pm", "19:30"], ["7:30pm", "19:30"], ["12am", "00:00"], ["12pm", "12:00"],
    ["12:15 AM", "00:15"], ["9.30 pm", "21:30"], ["7 p.m.", "19:00"], ["09:00:00", "09:00"],
    ["2026-11-03 09:00", "09:00"], ["2026-11-03 14:45", "14:45"],
  ])("reads %s as %s", (cell, expected) => {
    expect(readTime(cell)).toBe(expected);
  });
  it.each(["9", "24:00", "7:60", "13pm", "0am", "noon", "9:3", "abc", "9.5"])("does not read %s", (cell) => {
    expect(readTime(cell)).toBeUndefined();
  });
});

describe("the date reader", () => {
  it("reads year-month-day always as that, whatever the order", () => {
    for (const order of ["dmy", "mdy", "ymd"] as const) {
      expect(readDate("2026-11-03", order, 2026), order).toBe("2026-11-03");
      expect(readDate("2026/11/03", order, 2026), order).toBe("2026-11-03");
      expect(readDate("2026-11-03 09:00", order, 2026), order).toBe("2026-11-03");
    }
  });
  it("reads a numeric date in the person's order", () => {
    expect(readDate("03/11/2026", "dmy", 2026)).toBe("2026-11-03");
    expect(readDate("03/11/2026", "mdy", 2026)).toBe("2026-03-11");
    expect(readDate("3.11.2026", "dmy", 2026)).toBe("2026-11-03");
    expect(readDate("11-3-26", "mdy", 2026)).toBe("2026-11-03");
    expect(readDate("26-11-03", "ymd", 2026)).toBe("2026-11-03");
    expect(readDate("26/11/2026", "mdy", 2026)).toBeUndefined(); // there is no month 26
  });
  it("a two-part numeric date takes the report year", () => {
    expect(readDate("3/11", "dmy", 2026)).toBe("2026-11-03");
    expect(readDate("3/11", "mdy", 2026)).toBe("2026-03-11");
    expect(readDate("11-03", "ymd", 2026)).toBe("2026-11-03");
  });
  it("reads English month names in any arrangement, with an optional year, suffix, weekday and time", () => {
    for (const c of ["3 Nov", "Nov 3", "3 November 2026", "Nov 3, 2026", "3rd Nov 2026", "Tue, 3 Nov 2026", "3-Nov-2026", "3 nov 26", "3 Nov 2026 9:30 am", "2026 Nov 3"]) {
      expect(readDate(c, "dmy", 2026), c).toBe("2026-11-03");
    }
  });
  it("reads every Indonesian month, in full and short", () => {
    const cases: Array<[string, string]> = [
      ["5 Januari 2027", "2027-01-05"], ["5 Jan", "2026-01-05"], ["6 Februari", "2026-02-06"], ["6 Feb", "2026-02-06"], ["7 Maret", "2026-03-07"],
      ["7 Mar", "2026-03-07"], ["8 April", "2026-04-08"], ["8 Apr", "2026-04-08"], ["9 Mei", "2026-05-09"], ["10 Juni", "2026-06-10"],
      ["10 Jun", "2026-06-10"], ["11 Juli", "2026-07-11"], ["11 Jul", "2026-07-11"], ["17 Agustus 2026", "2026-08-17"], ["17 Agu", "2026-08-17"],
      ["12 September", "2026-09-12"], ["12 Sep", "2026-09-12"], ["13 Oktober", "2026-10-13"], ["13 Okt", "2026-10-13"], ["14 November", "2026-11-14"],
      ["14 Nov", "2026-11-14"], ["25 Desember", "2026-12-25"], ["25 Des", "2026-12-25"], ["Selasa, 3 Nov 2026", "2026-11-03"], ["Jumat 6 Nov", "2026-11-06"],
    ];
    for (const [c, expected] of cases) expect(readDate(c, "dmy", 2026), c).toBe(expected);
  });
  it("is unreadable for a date that is not real, or text that is not a date", () => {
    for (const c of ["31/04/2026", "2026-02-30", "29 Feb 2027", "32 Nov", "abc", "3 Foo", "Nov", "13/13/2026", "3 Nov Dec", ""]) {
      expect(readDate(c, "dmy", 2026), c).toBeUndefined();
    }
    expect(readDate("29 Feb 2028", "dmy", 2026)).toBe("2028-02-29");
  });
});

describe("the yes/no and hashtag readers", () => {
  it("yes from yes, y, ya, true, 1, x, a tick or extra, in any case; no from the usual noes", () => {
    for (const c of ["yes", "Y", "YA", "true", "1", "x", "X", "✓", "✔", "Extra"]) expect(readYesNo(c), c).toBe(true);
    for (const c of ["no", "N", "tidak", "false", "0", "-"]) expect(readYesNo(c), c).toBe(false);
    expect(readYesNo("maybe")).toBeUndefined();
  });
  it("hashtags split on spaces, commas and new lines, each # dropped", () => {
    expect(readHashtags("#one #two,#three\n#four")).toEqual(["one", "two", "three", "four"]);
    expect(readHashtags("plain tag, other")).toEqual(["plain", "tag", "other"]);
    expect(readHashtags("#a#b")).toEqual(["a", "b"]);
    expect(readHashtags(" # , ")).toEqual([]);
  });
});

describe("the zoned instant", () => {
  it("answers the wall time of a zone as a UTC instant", () => {
    expect(instantInTz("2026-11-03", 9, 0, "Asia/Jakarta")).toBe("2026-11-03T02:00:00.000Z");
    expect(instantInTz("2026-11-03", 19, 30, "Asia/Makassar")).toBe("2026-11-03T11:30:00.000Z");
    expect(instantInTz("2026-07-05", 9, 0, "America/Los_Angeles")).toBe("2026-07-05T16:00:00.000Z"); // PDT
    expect(instantInTz("2026-12-05", 9, 0, "America/Los_Angeles")).toBe("2026-12-05T17:00:00.000Z"); // PST
    expect(instantInTz("2026-11-03", 9, 0, "UTC")).toBe("2026-11-03T09:00:00.000Z");
  });
  it("is null for a date or time that is not real", () => {
    expect(instantInTz("2026-02-30", 9, 0, "UTC")).toBeNull();
    expect(instantInTz("2026-11-03", 24, 0, "UTC")).toBeNull();
    expect(instantInTz("2026-11-03", 9, 60, "UTC")).toBeNull();
  });
  it("knows the zones Intl knows", () => {
    expect(isKnownTimeZone("Asia/Jakarta")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("Mars/Olympus")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
    expect(isKnownTimeZone(3)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════ the body

describe("parseImportBody", () => {
  const allocation = (o: Record<string, unknown> = {}) => ({
    dryRun: true, headerRow: true, columns: { client: 0, postsPerCycle: 1 }, rows: [["Client", "Posts"], ["Mock Bakery", "12"]], ...o,
  });
  const plan = (o: Record<string, unknown> = {}) => ({
    dryRun: true, headerRow: false, columns: { client: 0, date: 1 }, rows: [["Mock Bakery", "3 Nov"]], month: "2026-11", dateOrder: "dmy", timeZone: "Asia/Jakarta", ...o,
  });
  const field = (kind: "allocation" | "plan", body: unknown) => refusal(() => parseImportBody(kind, body, TODAY));

  it("accepts a well-formed body of each kind", () => {
    const a = parseImportBody("allocation", allocation({ skip: [1], clientMatches: { "Mock Bakery": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, officerMatches: { Ayu: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }), TODAY);
    expect(a.skip.has(1)).toBe(true);
    expect(a.clientMatches.get("mock bakery")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(a.officerMatches.get("ayu")).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const p = parseImportBody("plan", plan(), TODAY);
    expect(p.plan).toEqual({ month: "2026-11", dateOrder: "dmy", timeZone: "Asia/Jakarta" });
  });

  it("400 invalid_field names the field: the body, the two booleans, the columns", () => {
    expect(field("allocation", null)).toEqual({ message: "invalid_field", field: "body" });
    expect(field("allocation", [])).toEqual({ message: "invalid_field", field: "body" });
    expect(field("allocation", allocation({ dryRun: "yes" }))).toMatchObject({ field: "dryRun" });
    expect(field("allocation", allocation({ headerRow: undefined }))).toMatchObject({ field: "headerRow" });
    expect(field("allocation", allocation({ columns: [] }))).toMatchObject({ field: "columns" });
    expect(field("allocation", allocation({ columns: { client: 0, nope: 1 } }))).toMatchObject({ field: "columns.nope" });
    expect(field("allocation", allocation({ columns: { client: 0, postsPerCycle: 60 } }))).toMatchObject({ field: "columns.postsPerCycle" });
    expect(field("allocation", allocation({ columns: { client: 0, postsPerCycle: -1 } }))).toMatchObject({ field: "columns.postsPerCycle" });
    expect(field("allocation", allocation({ columns: { client: 0, postsPerCycle: 1.5 } }))).toMatchObject({ field: "columns.postsPerCycle" });
    expect(field("allocation", allocation({ columns: { client: 0, postsPerCycle: 0 } }))).toMatchObject({ field: "columns.postsPerCycle" }); // one column, two fields
  });

  it("the plan's fields are not the allocation's, and the other way round", () => {
    expect(field("allocation", allocation({ columns: { client: 0, date: 1 } }))).toMatchObject({ field: "columns.date" });
    expect(field("plan", plan({ columns: { client: 0, date: 1, postsPerCycle: 2 } }))).toMatchObject({ field: "columns.postsPerCycle" });
  });

  it("a required field missing from columns is refused (client; for the plan also date)", () => {
    expect(field("allocation", allocation({ columns: { postsPerCycle: 1 } }))).toMatchObject({ field: "columns.client" });
    expect(field("plan", plan({ columns: { client: 0 } }))).toMatchObject({ field: "columns.date" });
    expect(field("plan", plan({ columns: { date: 1 } }))).toMatchObject({ field: "columns.client" });
  });

  it("rows: too many, not a table, a cell that is not a string, a skip outside the rows", () => {
    expect(field("allocation", allocation({ rows: Array.from({ length: 301 }, () => ["x"]) }))).toMatchObject({ field: "rows" });
    expect(() => parseImportBody("allocation", allocation({ rows: Array.from({ length: 300 }, () => ["x"]) }), TODAY)).not.toThrow();
    expect(field("plan", plan({ rows: Array.from({ length: 1001 }, () => ["x"]) }))).toMatchObject({ field: "rows" });
    expect(() => parseImportBody("plan", plan({ rows: Array.from({ length: 1000 }, () => ["x", "y"]) }), TODAY)).not.toThrow();
    expect(field("allocation", allocation({ rows: "nope" }))).toMatchObject({ field: "rows" });
    expect(field("allocation", allocation({ rows: [["a"], 5] }))).toMatchObject({ field: "rows[1]" });
    expect(field("allocation", allocation({ rows: [["a", 5]] }))).toMatchObject({ field: "rows[0]" });
    expect(field("allocation", allocation({ skip: [2] }))).toMatchObject({ field: "skip" });
    expect(field("allocation", allocation({ skip: [-1] }))).toMatchObject({ field: "skip" });
    expect(field("allocation", allocation({ skip: ["1"] }))).toMatchObject({ field: "skip" });
  });

  it("the picks must be uuids, named by their sheet name", () => {
    expect(field("allocation", allocation({ clientMatches: { "Mock Bakery": "not-a-uuid" } }))).toMatchObject({ field: "clientMatches.Mock Bakery" });
    expect(field("allocation", allocation({ clientMatches: [] }))).toMatchObject({ field: "clientMatches" });
    expect(field("allocation", allocation({ officerMatches: { Ayu: 3 } }))).toMatchObject({ field: "officerMatches.Ayu" });
  });

  it("the plan: month, dateOrder and timeZone", () => {
    expect(field("plan", plan({ month: "2026-9" }))).toMatchObject({ field: "month" });
    expect(field("plan", plan({ month: "2026-13" }))).toMatchObject({ field: "month" });
    expect(field("plan", plan({ month: "2026-09" }))).toMatchObject({ field: "month" }); // before the report month
    expect(field("plan", plan({ month: undefined }))).toMatchObject({ field: "month" });
    expect(() => parseImportBody("plan", plan({ month: "2026-10" }), TODAY)).not.toThrow(); // the report month itself
    expect(field("plan", plan({ dateOrder: "ydm" }))).toMatchObject({ field: "dateOrder" });
    expect(field("plan", plan({ timeZone: "Mars/Olympus" }))).toMatchObject({ field: "timeZone" });
    expect(field("plan", plan({ timeZone: undefined }))).toMatchObject({ field: "timeZone" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════ allocation

const ENGAGEMENTS: AllocationEngagement[] = [
  { engagementId: E.bakery, clientName: "Mock Bakery", officer: null, postsPerCycle: null, creativeSource: "creatives", deliveryBatch: null, reportFormat: null, reportDueDay: null, platforms: [], formats: [], defaultPostTime: null },
  { engagementId: E.studio, clientName: "Demo Studio", officer: { id: U.ayu, name: "Ayu Mock" }, postsPerCycle: 12, creativeSource: "in_team", deliveryBatch: "A", reportFormat: "email", reportDueDay: 5, platforms: ["instagram", "facebook"], formats: ["feed", "reel"], defaultPostTime: "09:00" },
  { engagementId: E.garden, clientName: "Sample Garden Cafe", officer: null, postsPerCycle: 8, creativeSource: "creatives", deliveryBatch: "B", reportFormat: null, reportDueDay: null, platforms: [], formats: [], defaultPostTime: null },
];
const MEMBERS: Member[] = [
  { id: U.ayu, name: "Ayu Mock", email: "ayu@mock.test" },
  { id: U.budi, name: "Budi Demo", email: "budi@mock.test" },
];

function allocationBody(rows: string[][], o: Partial<{ headerRow: boolean; columns: Record<string, number>; skip: number[]; clientMatches: Record<string, string>; officerMatches: Record<string, string> }> = {}): ImportBody {
  return parseImportBody("allocation", {
    dryRun: true, headerRow: true, columns: { client: 0, officer: 1, postsPerCycle: 2, creativeSource: 3, deliveryBatch: 4, reportFormat: 5, reportDueDay: 6, platforms: 7, formats: 8, defaultPostTime: 9 },
    rows, ...o,
  }, TODAY);
}
const HEADER = ["Client", "Officer", "Posts", "Creative", "Batch", "Report", "Due day", "Platforms", "Formats", "Time"];

describe("previewAllocation", () => {
  it("reads every field of a row leniently, checks it by the PATCH's own rules, and shows what would change", () => {
    const { answer, writes } = previewAllocation(
      allocationBody([HEADER, ["mock BAKERY", "budi@mock.test", "10 posts", "In-house", "Batch A", "Zoom", "day 7", "IG / FB", "Reels, Post", "7:30 pm"]]),
      ENGAGEMENTS, MEMBERS,
    );
    expect(answer.summary).toEqual({ rows: 1, ready: 1, unchanged: 0, refused: 0, skipped: 0 });
    const row = answer.rows[0];
    expect(row).toMatchObject({ row: 1, outcome: "ready", engagementId: E.bakery, clientName: "Mock Bakery", refusals: [], warnings: [] });
    expect(row.changes).toEqual({
      postsPerCycle: { from: null, to: 10 }, creativeSource: { from: "creatives", to: "in_team" }, deliveryBatch: { from: null, to: "A" },
      reportFormat: { from: null, to: "meeting" }, reportDueDay: { from: null, to: 7 }, platforms: { from: [], to: ["instagram", "facebook"] },
      formats: { from: [], to: ["reel", "feed"] }, defaultPostTime: { from: null, to: "19:30" }, officer: { from: null, to: { id: U.budi, name: "Budi Demo" } },
    });
    expect(writes).toEqual([{
      row: 1, engagementId: E.bakery,
      patch: {
        postsPerCycle: 10, creativeSource: "in_team", deliveryBatch: "A", reportFormat: "meeting", reportDueDay: 7, platforms: ["instagram", "facebook"],
        formats: ["reel", "feed"], defaultPostTime: "19:30", officerId: U.budi,
      },
    }]);
  });

  it("the header row is never imported, and the row numbers are indexes into the rows sent", () => {
    const { answer } = previewAllocation(allocationBody([HEADER, ["Mock Bakery", "", "5"], ["Sample Garden Cafe", "", "9"]]), ENGAGEMENTS, MEMBERS);
    expect(answer.rows.map((r) => r.row)).toEqual([1, 2]);
    expect(answer.summary.rows).toBe(2);
  });

  it("works with no header row: the first row is imported", () => {
    const { answer } = previewAllocation(allocationBody([["Mock Bakery", "", "5"], ["Sample Garden Cafe", "", "9"]], { headerRow: false, columns: { client: 0, postsPerCycle: 2 } }), ENGAGEMENTS, MEMBERS);
    expect(answer.rows.map((r) => [r.row, r.outcome])).toEqual([[0, "ready"], [1, "ready"]]);
  });

  it("an empty cell leaves the field as it is: nothing is cleared", () => {
    const { answer, writes } = previewAllocation(allocationBody([HEADER, ["Demo Studio", "", "", "", "", "", "", "", "", ""]]), ENGAGEMENTS, MEMBERS);
    expect(answer.rows[0]).toMatchObject({ outcome: "unchanged", changes: {} });
    expect(writes).toEqual([]);
  });

  it("a row whose every value already equals the engagement's is unchanged (a replay)", () => {
    const { answer } = previewAllocation(
      allocationBody([HEADER, ["Demo Studio", "ayu@mock.test", "12", "in team", "a", "email", "5", "Instagram, Facebook", "Feed, Reel", "09:00"]]),
      ENGAGEMENTS, MEMBERS,
    );
    expect(answer.rows[0]).toMatchObject({ outcome: "unchanged", changes: {} });
  });

  it("only the fields that differ are written", () => {
    const { writes, answer } = previewAllocation(allocationBody([HEADER, ["Demo Studio", "", "13", "", "", "", "", "Facebook, Instagram", "", ""]]), ENGAGEMENTS, MEMBERS);
    expect(writes[0].patch).toEqual({ postsPerCycle: 13, platforms: ["facebook", "instagram"] }); // the order is part of the value
    expect(Object.keys(answer.rows[0].changes)).toEqual(["postsPerCycle", "platforms"]);
  });

  it("a value the PATCH refuses is refused under its field, every problem of the row at once", () => {
    const { answer, writes } = previewAllocation(
      allocationBody([HEADER, ["Mock Bakery", "", "999", "agency", "C", "post", "40", "Snapchat", "poster", "25:00"]]), ENGAGEMENTS, MEMBERS,
    );
    expect(answer.rows[0].outcome).toBe("refused");
    expect(answer.rows[0].refusals).toEqual([
      { field: "postsPerCycle", code: "invalid_field" }, { field: "creativeSource", code: "invalid_field" }, { field: "deliveryBatch", code: "invalid_field" },
      { field: "reportFormat", code: "invalid_field" }, { field: "reportDueDay", code: "invalid_field" }, { field: "platforms", code: "invalid_field" },
      { field: "formats", code: "invalid_field" }, { field: "defaultPostTime", code: "invalid_field" },
    ]);
    expect(writes).toEqual([]);
  });

  it("a missing client is missing_value; a client that matches nothing offers up to three suggestions and is listed once with all its rows", () => {
    const rows = [HEADER, ["", "", "5"], ["Mock Bakry Bali", "", "5"], ["mock  bakry bali", "", "6"], ["Sample Garden", "", "7"]];
    const { answer } = previewAllocation(allocationBody(rows), ENGAGEMENTS, MEMBERS);
    expect(answer.rows[0].refusals).toEqual([{ field: "client", code: "missing_value" }]);
    // The same unmatched name on two rows is also a duplicate: picking one client for it would write that client twice.
    expect(answer.rows[1].refusals).toEqual([{ field: "client", code: "client_not_found" }, { field: "client", code: "duplicate_client" }]);
    expect(answer.rows[1]).toMatchObject({ engagementId: null, clientName: null });
    expect(answer.unmatched.clients).toEqual([
      { sheetName: "Mock Bakry Bali", rows: [2, 3], suggestions: [{ engagementId: E.bakery, clientName: "Mock Bakery" }] },
      { sheetName: "Sample Garden", rows: [4], suggestions: [{ engagementId: E.garden, clientName: "Sample Garden Cafe" }] },
    ]);
  });

  it("two open engagements of one client name are client_ambiguous, and the person's pick resolves it", () => {
    const twin: AllocationEngagement = { ...ENGAGEMENTS[0], engagementId: E.bakery2 };
    const rows = [HEADER, ["Mock Bakery", "", "5"]];
    const refused = previewAllocation(allocationBody(rows), [...ENGAGEMENTS, twin], MEMBERS);
    expect(refused.answer.rows[0].refusals).toEqual([{ field: "client", code: "client_ambiguous" }]);
    expect(refused.answer.unmatched.clients[0].suggestions.map((s) => s.engagementId).sort()).toEqual([E.bakery, E.bakery2]);
    const picked = previewAllocation(allocationBody(rows, { clientMatches: { "Mock Bakery": "00000000-0000-4000-8000-00000000000a" } }), [...ENGAGEMENTS, { ...twin, engagementId: "00000000-0000-4000-8000-00000000000a" }], MEMBERS);
    expect(picked.answer.rows[0]).toMatchObject({ outcome: "ready", engagementId: "00000000-0000-4000-8000-00000000000a" });
  });

  it("a pick for a sheet name wins over the name rule", () => {
    const pick = "00000000-0000-4000-8000-00000000000b";
    const eng = [...ENGAGEMENTS, { ...ENGAGEMENTS[2], engagementId: pick, clientName: "Brand New Name" }];
    const { answer } = previewAllocation(allocationBody([HEADER, ["Totally Different", "", "5"]], { clientMatches: { "totally   different": pick } }), eng, MEMBERS);
    expect(answer.rows[0]).toMatchObject({ outcome: "ready", engagementId: pick, clientName: "Brand New Name" });
    expect(answer.unmatched.clients).toEqual([]);
  });

  it("officers: not found, ambiguous, and the pick", () => {
    const twinMembers: Member[] = [...MEMBERS, { id: U.budi2, name: "Budi  Demo", email: "budi2@mock.test" }];
    const rows = [HEADER, ["Mock Bakery", "Nobody Here", ""], ["Sample Garden Cafe", "budi demo", ""]];
    const { answer } = previewAllocation(allocationBody(rows), ENGAGEMENTS, twinMembers);
    expect(answer.rows[0].refusals).toEqual([{ field: "officer", code: "officer_not_found" }]);
    expect(answer.rows[1].refusals).toEqual([{ field: "officer", code: "officer_ambiguous" }]);
    expect(answer.unmatched.officers).toEqual([{ sheetName: "Nobody Here", rows: [1] }, { sheetName: "budi demo", rows: [2] }]);
    const picked = previewAllocation(allocationBody(rows, { officerMatches: { "Nobody Here": U.ayu, "budi demo": U.budi2 } }), ENGAGEMENTS, twinMembers);
    expect(picked.answer.rows.map((r) => r.outcome)).toEqual(["ready", "ready"]);
    expect(picked.writes.map((w) => w.patch.officerId)).toEqual([U.ayu, U.budi2]);
  });

  it("a client named on two rows refuses both with duplicate_client; unticking one lets the other through", () => {
    const rows = [HEADER, ["Mock Bakery", "", "5"], ["MOCK BAKERY", "", "6"]];
    const both = previewAllocation(allocationBody(rows), ENGAGEMENTS, MEMBERS);
    expect(both.answer.rows.map((r) => r.outcome)).toEqual(["refused", "refused"]);
    for (const r of both.answer.rows) expect(r.refusals).toContainEqual({ field: "client", code: "duplicate_client" });
    const ticked = previewAllocation(allocationBody(rows, { skip: [2] }), ENGAGEMENTS, MEMBERS);
    expect(ticked.answer.rows.map((r) => r.outcome)).toEqual(["ready", "skipped"]);
    expect(ticked.answer.summary).toEqual({ rows: 2, ready: 1, unchanged: 0, refused: 0, skipped: 1 });
  });

  it("two sheet names that resolve to one engagement (a pick) are a duplicate too", () => {
    const rows = [HEADER, ["Mock Bakery", "", "5"], ["The Bakery", "", "6"]];
    const { answer } = previewAllocation(allocationBody(rows, { clientMatches: { "The Bakery": E.bakery } }), ENGAGEMENTS, MEMBERS);
    expect(answer.rows.map((r) => r.outcome)).toEqual(["refused", "refused"]);
  });

  it("a skipped row is skipped even when it would be refused, and is not listed among the names to pick", () => {
    const { answer } = previewAllocation(allocationBody([HEADER, ["Unknown Co", "Nobody", "999"], ["Mock Bakery", "", "5"]], { skip: [1] }), ENGAGEMENTS, MEMBERS);
    expect(answer.rows.map((r) => r.outcome)).toEqual(["skipped", "ready"]);
    expect(answer.unmatched).toEqual({ clients: [], officers: [] });
  });

  it("a blank row (every mapped cell empty) is skipped, not refused", () => {
    const { answer } = previewAllocation(allocationBody([HEADER, ["", "", ""], ["Mock Bakery", "", "5"]]), ENGAGEMENTS, MEMBERS);
    expect(answer.rows.map((r) => r.outcome)).toEqual(["skipped", "ready"]);
  });

  it("a short row (fewer cells than columns) reads the missing cells as empty", () => {
    const { answer } = previewAllocation(allocationBody([HEADER, ["Mock Bakery"]]), ENGAGEMENTS, MEMBERS);
    expect(answer.rows[0].outcome).toBe("unchanged");
  });

  it("only the columns the person mapped are read", () => {
    const { writes } = previewAllocation(allocationBody([HEADER, ["Mock Bakery", "budi@mock.test", "5"]], { columns: { client: 0, postsPerCycle: 2 } }), ENGAGEMENTS, MEMBERS);
    expect(writes[0].patch).toEqual({ postsPerCycle: 5 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════ plan

const PLAN_ENGAGEMENTS: PlanEngagement[] = [
  { engagementId: E.bakery, clientName: "Mock Bakery", defaultPostTime: null, deliveryBatch: "A" },
  { engagementId: E.studio, clientName: "Demo Studio", defaultPostTime: "18:15", deliveryBatch: "B" },
  { engagementId: E.garden, clientName: "Sample Garden Cafe", defaultPostTime: null, deliveryBatch: null },
];
const PLAN_HEADER = ["Client", "Date", "Time", "Title", "Format", "Pillar", "Platforms", "Extra", "Angle", "Objective", "Key message", "Visual", "Caption", "On asset", "CTA", "Tags"];
const PLAN_COLUMNS = { client: 0, date: 1, time: 2, title: 3, format: 4, pillar: 5, placement: 6, isExtra: 7, angle: 8, objective: 9, keyMessage: 10, visualDirection: 11, caption: 12, onAssetText: 13, cta: 14, hashtags: 15 };

function planBody(rows: string[][], o: Partial<{ headerRow: boolean; columns: Record<string, number>; skip: number[]; clientMatches: Record<string, string>; month: string; dateOrder: string; timeZone: string }> = {}): ImportBody {
  return parseImportBody("plan", { dryRun: true, headerRow: true, columns: PLAN_COLUMNS, rows, month: "2026-11", dateOrder: "dmy", timeZone: "Asia/Jakarta", ...o }, TODAY);
}
const NO_LOOKUPS: PlanLookups = {
  cycles: new Map(), cyclePosts: new Map(), existing: new Map(),
  prefillFor: (batch) => (batch === "A" ? "2026-10-15" : batch === "B" ? "2026-10-30" : null),
};
const run = (body: ImportBody, lookups: Partial<PlanLookups> = {}, engagements = PLAN_ENGAGEMENTS) =>
  finishPlan(stagePlanRows(body, { tenantId: TENANT, today: TODAY, engagements }), { ...NO_LOOKUPS, ...lookups });
const full = (o: Partial<Record<keyof typeof PLAN_COLUMNS, string>> = {}): string[] => {
  const base: Record<keyof typeof PLAN_COLUMNS, string> = {
    client: "Mock Bakery", date: "3 Nov", time: "10:00", title: "Morning pastries", format: "Carousel", pillar: "Product", placement: "IG, FB", isExtra: "",
    angle: "Fresh daily", objective: "Awareness", keyMessage: "Baked at dawn", visualDirection: "Warm light", caption: "Start the day right.\nSecond line.",
    onAssetText: "Open daily", cta: "Visit us", hashtags: "#bakery #fresh",
  };
  return (Object.keys(PLAN_COLUMNS) as Array<keyof typeof PLAN_COLUMNS>).map((k) => o[k] ?? base[k]);
};

describe("importPostId and titleFromCaption", () => {
  it("is a stable uuid of tenant, engagement, month, date and the NORMALIZED title", () => {
    const id = importPostId(TENANT, "e1", "2026-11", "2026-11-03", "Morning Pastries!");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(importPostId(TENANT, "e1", "2026-11", "2026-11-03", "  morning   pastries ")).toBe(id);
    expect(importPostId(TENANT, "e1", "2026-11", "2026-11-04", "Morning Pastries")).not.toBe(id);
    expect(importPostId(TENANT, "e2", "2026-11", "2026-11-03", "Morning Pastries")).not.toBe(id);
    expect(importPostId("22222222-2222-4222-8222-222222222222", "e1", "2026-11", "2026-11-03", "Morning Pastries")).not.toBe(id);
  });
  it("the caption's first non-empty line, cut at 80 characters", () => {
    expect(titleFromCaption("\n  First line  \nSecond")).toBe("First line");
    expect(titleFromCaption("x".repeat(120))).toBe("x".repeat(80));
    expect(titleFromCaption("")).toBe("");
  });
});

describe("the plan preview", () => {
  it("a full row: the date in its order, the time in the zone, every field through the machine's rules, the cycle from the pre-fill", () => {
    const { answer, writes } = run(planBody([PLAN_HEADER, full()]));
    expect(answer.summary).toEqual({ rows: 1, ready: 1, unchanged: 0, refused: 0, skipped: 0 });
    const row = answer.rows[0];
    expect(row).toMatchObject({
      row: 1, outcome: "ready", refusals: [], warnings: [], engagementId: E.bakery, clientName: "Mock Bakery",
      cycle: { cycleId: null, deadline: "2026-10-15", created: true },
      post: { title: "Morning pastries", format: "carousel", scheduledAt: "2026-11-03T03:00:00.000Z", isExtra: false, placement: ["instagram", "facebook"] },
    });
    expect(row.post!.id).toBe(importPostId(TENANT, E.bakery, "2026-11", "2026-11-03", "Morning pastries"));
    expect(writes).toHaveLength(1);
    expect(writes[0].params).toEqual({
      id: row.post!.id, title: "Morning pastries", isExtra: false, format: "carousel", pillar: "Product", placement: ["instagram", "facebook"], scheduledAt: "2026-11-03T03:00:00.000Z",
    });
    expect(writes[0].extra).toEqual({
      angle: "Fresh daily", objective: "Awareness", key_message: "Baked at dawn", visual_direction: "Warm light", caption: "Start the day right.\nSecond line.",
      on_asset_text: "Open daily", cta: "Visit us", hashtags: ["bakery", "fresh"],
    });
    expect(writes[0].cycle).toEqual({ cycleId: null, deadline: "2026-10-15" });
    expect(cyclesToCreate(writes)).toEqual(new Map([[E.bakery, "2026-10-15"]]));
  });

  it("the three date orders and the month names", () => {
    const rows = (d: string) => [PLAN_HEADER, full({ date: d })];
    expect(run(planBody(rows("03/11/2026"))).answer.rows[0].post?.scheduledAt).toBe("2026-11-03T03:00:00.000Z");
    expect(run(planBody(rows("11/03/2026"), { dateOrder: "mdy" })).answer.rows[0].post?.scheduledAt).toBe("2026-11-03T03:00:00.000Z");
    expect(run(planBody(rows("2026/11/03"), { dateOrder: "ymd" })).answer.rows[0].post?.scheduledAt).toBe("2026-11-03T03:00:00.000Z");
    expect(run(planBody(rows("2026-11-03"))).answer.rows[0].post?.scheduledAt).toBe("2026-11-03T03:00:00.000Z");
    expect(run(planBody(rows("3 Nov"))).answer.rows[0].post?.scheduledAt).toBe("2026-11-03T03:00:00.000Z");
    expect(run(planBody(rows("Selasa, 3 November 2026"))).answer.rows[0].outcome).toBe("ready");
    expect(run(planBody(rows("25 Des"), { month: "2026-12" })).answer.rows[0].outcome).toBe("ready");
    expect(run(planBody(rows("17 Agu 2027"), { month: "2027-08" })).answer.rows[0].outcome).toBe("ready");
  });

  it("the date refusals: missing, unreadable, outside the month, in the past", () => {
    const at = (date: string, o: Record<string, string> = {}) => run(planBody([PLAN_HEADER, full({ date })], o)).answer.rows[0];
    expect(at("").refusals).toContainEqual({ field: "date", code: "missing_value" });
    expect(at("whenever").refusals).toEqual([{ field: "date", code: "invalid_field" }]);
    expect(at("31 Nov").refusals).toEqual([{ field: "date", code: "invalid_field" }]);
    expect(at("3 Dec").refusals).toEqual([{ field: "date", code: "date_outside_month" }]);
    expect(at("3 Nov 2027").refusals).toEqual([{ field: "date", code: "date_outside_month" }]);
    // The report month itself: a day before today is in the past, today is not.
    expect(at("28 Oct", { month: "2026-10" }).refusals).toEqual([{ field: "date", code: "date_in_past" }]);
    expect(at("29 Oct", { month: "2026-10" }).outcome).toBe("ready");
    // Outside the month AND in the past: both, at once.
    expect(at("5 Sep", { month: "2026-11" }).refusals).toEqual([{ field: "date", code: "date_outside_month" }]); // one reason: never also date_in_past
  });

  it("the time: every form, the engagement's default, then 09:00 with the warning", () => {
    const at = (time: string, client = "Mock Bakery") => run(planBody([PLAN_HEADER, full({ time, client })])).answer.rows[0];
    expect(at("9am").post?.scheduledAt).toBe("2026-11-03T02:00:00.000Z");
    expect(at("7:30 pm").post?.scheduledAt).toBe("2026-11-03T12:30:00.000Z");
    expect(at("17.30").post?.scheduledAt).toBe("2026-11-03T10:30:00.000Z");
    expect(at("").post?.scheduledAt).toBe("2026-11-03T02:00:00.000Z"); // 09:00 default
    expect(at("").warnings).toEqual([{ field: "time", code: "default_time_used" }]);
    expect(at("", "Demo Studio").post?.scheduledAt).toBe("2026-11-03T11:15:00.000Z"); // the engagement's 18:15
    expect(at("", "Demo Studio").warnings).toEqual([{ field: "time", code: "default_time_used" }]);
    expect(DEFAULT_POST_TIME).toBe("09:00");
    expect(at("soon").refusals).toEqual([{ field: "time", code: "invalid_field" }]);
  });

  it("with no time column, every row takes the default time", () => {
    const columns = { ...PLAN_COLUMNS } as Record<string, number>;
    delete columns.time;
    const { answer } = run(planBody([PLAN_HEADER, full()], { columns }));
    expect(answer.rows[0].warnings).toEqual([{ field: "time", code: "default_time_used" }]);
  });

  it("the title: the sheet's, else the caption's first line (cut at 80) with a warning, else missing_title", () => {
    const at = (title: string, caption: string) => run(planBody([PLAN_HEADER, full({ title, caption })])).answer.rows[0];
    expect(at("", "A great caption\nmore")).toMatchObject({ outcome: "ready", post: { title: "A great caption" }, warnings: [{ field: "title", code: "title_from_caption" }] });
    expect(at("", "y".repeat(150)).post?.title).toBe("y".repeat(80));
    expect(at("", "")).toMatchObject({ outcome: "refused", refusals: [{ field: "title", code: "missing_title" }] });
    expect(at("t".repeat(201), "")).toMatchObject({ outcome: "refused", refusals: [{ field: "title", code: "invalid_field" }] });
    expect(at("Plain", "caption").warnings.filter((w) => w.code === "title_from_caption")).toEqual([]);
  });

  it("every value passes the machine's own field rule: a too-long text, a bad format, a bad network, a bad yes/no", () => {
    const at = (o: Partial<Record<keyof typeof PLAN_COLUMNS, string>>) => run(planBody([PLAN_HEADER, full(o)])).answer.rows[0].refusals;
    expect(at({ pillar: "p".repeat(61) })).toEqual([{ field: "pillar", code: "invalid_field" }]);
    expect(at({ angle: "a".repeat(501) })).toEqual([{ field: "angle", code: "invalid_field" }]);
    expect(at({ objective: "o".repeat(201) })).toEqual([{ field: "objective", code: "invalid_field" }]);
    expect(at({ keyMessage: "k".repeat(501) })).toEqual([{ field: "keyMessage", code: "invalid_field" }]);
    expect(at({ visualDirection: "v".repeat(2001) })).toEqual([{ field: "visualDirection", code: "invalid_field" }]);
    expect(at({ caption: "c".repeat(5001) })).toEqual([{ field: "caption", code: "invalid_field" }]);
    expect(at({ onAssetText: "o".repeat(501) })).toEqual([{ field: "onAssetText", code: "invalid_field" }]);
    expect(at({ cta: "c".repeat(121) })).toEqual([{ field: "cta", code: "invalid_field" }]);
    expect(at({ hashtags: Array.from({ length: 61 }, (_, i) => `#t${i}`).join(" ") })).toEqual([{ field: "hashtags", code: "invalid_field" }]);
    expect(at({ format: "poster" })).toEqual([{ field: "format", code: "invalid_field" }]);
    expect(at({ format: "feed, reel" })).toEqual([{ field: "format", code: "invalid_field" }]);
    expect(at({ placement: "IG, Snapchat" })).toEqual([{ field: "placement", code: "invalid_field" }]);
    expect(at({ isExtra: "perhaps" })).toEqual([{ field: "isExtra", code: "invalid_field" }]);
  });

  it("isExtra from yes, y, ya, true, 1, x, a tick or extra; an empty cell is no", () => {
    for (const v of ["yes", "Y", "ya", "TRUE", "1", "x", "✓", "extra"]) expect(run(planBody([PLAN_HEADER, full({ isExtra: v })])).writes[0].params.isExtra, v).toBe(true);
    expect(run(planBody([PLAN_HEADER, full({ isExtra: "" })])).writes[0].params.isExtra).toBe(false);
  });

  it("an empty optional cell is left out of the post, not written as empty", () => {
    const { writes } = run(planBody([PLAN_HEADER, full({ format: "", pillar: "", placement: "", angle: "", caption: "", hashtags: "", cta: "" })]));
    expect(writes[0].params).not.toHaveProperty("format");
    expect(writes[0].params).not.toHaveProperty("pillar");
    expect(writes[0].params).not.toHaveProperty("placement");
    expect(Object.keys(writes[0].extra).sort()).toEqual(["key_message", "objective", "on_asset_text", "visual_direction"]);
  });

  it("client: unmatched rows are listed with suggestions; a pick resolves; ambiguity is its own code", () => {
    const rows = [PLAN_HEADER, full({ client: "Mock Bakry" }), full({ client: "" }), full({ client: "Mock Bakry", date: "4 Nov", title: "Second" })];
    const { answer } = run(planBody(rows));
    expect(answer.rows.map((r) => r.refusals[0])).toEqual([{ field: "client", code: "client_not_found" }, { field: "client", code: "missing_value" }, { field: "client", code: "client_not_found" }]);
    expect(answer.unmatched.clients).toEqual([{ sheetName: "Mock Bakry", rows: [1, 3], suggestions: [{ engagementId: E.bakery, clientName: "Mock Bakery" }] }]);
    const picked = run(planBody(rows, { clientMatches: { "Mock Bakry": E.bakery } }));
    expect(picked.answer.rows[0].outcome).toBe("ready");
    expect(picked.answer.rows[2].outcome).toBe("ready");
    const twin: PlanEngagement[] = [...PLAN_ENGAGEMENTS, { ...PLAN_ENGAGEMENTS[0], engagementId: E.bakery2 }];
    expect(run(planBody([PLAN_HEADER, full()]), {}, twin).answer.rows[0].refusals).toEqual([{ field: "client", code: "client_ambiguous" }]);
  });

  it("the cycle: an existing one is used as it is; none with no batch is no_cycle_deadline; the pre-fill names the deadline", () => {
    const rows = [PLAN_HEADER, full({ client: "Mock Bakery" }), full({ client: "Sample Garden Cafe", title: "Garden post" }), full({ client: "Demo Studio", title: "Studio post" })];
    const { answer } = run(planBody(rows), { cycles: new Map([[E.studio, { cycleId: "cy-studio", deadline: "2026-10-28" }]]) });
    expect(answer.rows[0].cycle).toEqual({ cycleId: null, deadline: "2026-10-15", created: true });
    expect(answer.rows[1]).toMatchObject({ outcome: "refused", refusals: [{ field: "cycle", code: "no_cycle_deadline" }], cycle: { cycleId: null, deadline: null, created: false } });
    expect(answer.rows[2]).toMatchObject({ outcome: "ready", cycle: { cycleId: "cy-studio", deadline: "2026-10-28", created: false } });
  });

  it("a cycle is made once per client: every ready row of it names the same deadline", () => {
    const rows = [PLAN_HEADER, full({ title: "One" }), full({ title: "Two", date: "4 Nov" })];
    const { writes } = run(planBody(rows));
    expect(writes.map((w) => w.cycle.cycleId)).toEqual([null, null]);
    expect([...cyclesToCreate(writes).entries()]).toEqual([[E.bakery, "2026-10-15"]]);
  });

  it("the same row twice in one sheet is one post: the second is unchanged with a same-title warning", () => {
    const rows = [PLAN_HEADER, full(), full({ title: "MORNING   pastries!" })];
    const { answer, writes } = run(planBody(rows));
    expect(answer.rows.map((r) => r.outcome)).toEqual(["ready", "unchanged"]);
    expect(answer.rows[1].warnings).toContainEqual({ field: "title", code: "same_title_in_cycle" });
    expect(writes).toHaveLength(1);
  });

  it("a replay finds the post by its id and answers unchanged; a discarded one is unchanged with discarded_since", () => {
    const first = run(planBody([PLAN_HEADER, full(), full({ title: "Other", date: "5 Nov" })]));
    const [a, b] = first.answer.rows.map((r) => r.post!.id!);
    const existing = new Map([[a, { deleted: false }], [b, { deleted: true }]]);
    const replay = run(planBody([PLAN_HEADER, full(), full({ title: "Other", date: "5 Nov" })]), {
      existing, cycles: new Map([[E.bakery, { cycleId: "cy-b", deadline: "2026-10-15" }]]),
    });
    expect(replay.answer.rows.map((r) => r.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(replay.answer.rows[0].warnings).toEqual([]);
    expect(replay.answer.rows[1].warnings).toEqual([{ field: "post", code: "discarded_since" }]);
    expect(replay.writes).toEqual([]);
    expect(replay.answer.summary).toEqual({ rows: 2, ready: 0, unchanged: 2, refused: 0, skipped: 0 });
  });

  it("a replay is unchanged even when the date has since passed (the post is already there)", () => {
    const rows = [PLAN_HEADER, full({ date: "28 Oct" })];
    const body = planBody(rows, { month: "2026-10" });
    expect(run(body).answer.rows[0].refusals).toEqual([{ field: "date", code: "date_in_past" }]);
    // The id of a row that is refused for its date is still derived, so a post written on an earlier day answers unchanged.
    const id = importPostId(TENANT, E.bakery, "2026-10", "2026-10-28", "Morning pastries");
    const replay = run(body, { existing: new Map([[id, { deleted: false }]]), cycles: new Map([[E.bakery, { cycleId: "cy", deadline: "2026-09-15" }]]) });
    expect(replay.answer.rows[0]).toMatchObject({ outcome: "unchanged", refusals: [] });
  });

  it("another post of the cycle with the same normalized title is a warning, not a refusal", () => {
    const { answer } = run(planBody([PLAN_HEADER, full()]), {
      cycles: new Map([[E.bakery, { cycleId: "cy-b", deadline: "2026-10-15" }]]),
      cyclePosts: new Map([["cy-b", [{ id: "other-post", title: "MORNING pastries" }]]]),
    });
    expect(answer.rows[0]).toMatchObject({ outcome: "ready", warnings: [{ field: "title", code: "same_title_in_cycle" }] });
  });

  it("an unticked row is skipped; a blank row is skipped; the header is never read", () => {
    const rows = [PLAN_HEADER, full(), full({ title: "Second", date: "4 Nov" }), PLAN_HEADER.map(() => "")];
    const { answer, writes } = run(planBody(rows, { skip: [1] }));
    expect(answer.rows.map((r) => r.outcome)).toEqual(["skipped", "ready", "skipped"]);
    expect(writes).toHaveLength(1);
    expect(answer.rows.map((r) => r.row)).toEqual([1, 2, 3]);
  });

  it("works with no header row", () => {
    const { answer } = run(planBody([full(), full({ title: "Second", date: "4 Nov" })], { headerRow: false }));
    expect(answer.rows.map((r) => [r.row, r.outcome])).toEqual([[0, "ready"], [1, "ready"]]);
  });

  it("only the mapped columns are read: a client and a date alone make a post whose title can only come from the caption", () => {
    const body = planBody([["Mock Bakery", "3 Nov"]], { headerRow: false, columns: { client: 0, date: 1 } });
    expect(run(body).answer.rows[0]).toMatchObject({ outcome: "refused", refusals: [{ field: "title", code: "missing_title" }] });
  });

  it("every problem of a row is listed at once", () => {
    const { answer } = run(planBody([PLAN_HEADER, full({ client: "", date: "", title: "", caption: "", time: "soon", format: "poster" })]));
    expect(answer.rows[0].refusals.map((r) => `${r.field}:${r.code}`).sort()).toEqual([
      "client:missing_value", "date:missing_value", "format:invalid_field", "time:invalid_field", "title:missing_title",
    ]);
  });
});

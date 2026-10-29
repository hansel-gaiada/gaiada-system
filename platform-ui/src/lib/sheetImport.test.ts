import { describe, it, expect } from "vitest";
import {
  ALLOCATION_FIELDS, HEADER_ALIASES, IMPORT_STEPS, PLAN_FIELDS, asImportAnswer, asParseAnswer, blankRowIndexes, buildImportBody, columnLetter, duplicateColumns,
  guessColumns, importRefusalText, normalizeHeader, rowCodeText, scheduledText, templateCsv, templateHeaders, valueText, type ImportDraft,
} from "./sheetImport";

// SCP-6a (BFF §63.23): the sheet import's pure half: the header aliases and the guess, the CSV template, the request body, the answers' parsers and the
// words for every row code. Invented names only.

describe("normalizeHeader", () => {
  it("lower-cases, drops accents and punctuation, and collapses spaces", () => {
    expect(normalizeHeader("  Posting   Date! ")).toBe("posting date");
    expect(normalizeHeader("Pilar Konten")).toBe("pilar konten");
    expect(normalizeHeader("Penanggung-Jawab")).toBe("penanggung jawab");
    expect(normalizeHeader("Référence")).toBe("reference");
    expect(normalizeHeader("Call-to-Action / CTA")).toBe("call to action cta");
  });
});

describe("guessColumns: allocation", () => {
  it("maps the template's own headers back to their fields, in order", () => {
    const g = guessColumns("allocation", templateHeaders("allocation"));
    ALLOCATION_FIELDS.forEach((f, i) => expect(g[f.key], f.key).toBe(i));
  });

  it("reads the English and Indonesian headers a team might use", () => {
    const g = guessColumns("allocation", ["Klien", "PIC", "Jumlah Post", "Designer", "Batch", "Format Laporan", "Tanggal Laporan", "Platform", "Jenis Konten", "Jam Posting"]);
    expect(g).toEqual({
      client: 0, officer: 1, postsPerCycle: 2, creativeSource: 3, deliveryBatch: 4, reportFormat: 5, reportDueDay: 6, platforms: 7, formats: 8, defaultPostTime: 9,
    });
  });

  it("tells 'Report format' (the report) from 'Formats' (the posts), whichever comes first", () => {
    expect(guessColumns("allocation", ["Account", "Report Format", "Formats"])).toEqual({ client: 0, reportFormat: 1, formats: 2 });
    expect(guessColumns("allocation", ["Account", "Formats", "Report Format"])).toEqual({ client: 0, reportFormat: 2, formats: 1 });
  });

  it("matches a header that holds an alias as whole words, and never one column twice", () => {
    const g = guessColumns("allocation", ["Client name (as in contract)", "Social Media Officer", "Quota / month"]);
    expect(g.client).toBe(0);
    expect(g.officer).toBe(1);
    expect(g.postsPerCycle).toBe(2);
    expect(new Set(Object.values(g)).size).toBe(Object.values(g).length);
  });

  it("leaves a field alone when no header names it, and ignores empty headers", () => {
    expect(guessColumns("allocation", ["", "Client", "Notes", ""])).toEqual({ client: 1 });
  });
});

describe("guessColumns: plan", () => {
  it("maps the template's own headers back to their fields, in order", () => {
    const g = guessColumns("plan", templateHeaders("plan"));
    PLAN_FIELDS.forEach((f, i) => expect(g[f.key], f.key).toBe(i));
  });

  it("reads the headers the sheet uses, in English and Indonesian", () => {
    const g = guessColumns("plan", [
      "Brand", "Tgl", "Jam", "Topik", "Tipe", "Pilar", "Channel", "Tambahan", "Angle", "Tujuan", "Pesan Utama", "Brief Visual", "Copywriting", "Teks Desain", "CTA", "Tagar",
    ]);
    expect(g).toEqual({
      client: 0, date: 1, time: 2, title: 3, format: 4, pillar: 5, placement: 6, isExtra: 7, angle: 8, objective: 9, keyMessage: 10, visualDirection: 11,
      caption: 12, onAssetText: 13, cta: 14, hashtags: 15,
    });
  });

  it("covers the spellings the brief names", () => {
    const g = guessColumns("plan", ["Client", "Posting Date", "Title", "Content Pillar", "Platform", "Key Message", "Visual Direction", "Text on Design", "Hashtags"]);
    expect(g).toEqual({ client: 0, date: 1, title: 2, pillar: 3, placement: 4, keyMessage: 5, visualDirection: 6, onAssetText: 7, hashtags: 8 });
    expect(guessColumns("plan", ["Client", "Ide", "Headline", "Visual Brief", "Referensi"])).toMatchObject({ title: 1, onAssetText: 2, visualDirection: 3 });
  });

  it("does not take 'Content Pillar' for the title, and takes a bare 'Content' for it", () => {
    expect(guessColumns("plan", ["Client", "Content Pillar", "Content"])).toEqual({ client: 0, pillar: 1, title: 2 });
  });

  it("has an entry for every field of both kinds, all of them already normalised-safe", () => {
    for (const [kind, fields] of [["allocation", ALLOCATION_FIELDS], ["plan", PLAN_FIELDS]] as const) {
      for (const f of fields) expect(HEADER_ALIASES[kind][f.key]?.length, `${kind}.${f.key}`).toBeGreaterThan(0);
      expect(Object.keys(HEADER_ALIASES[kind]).sort()).toEqual(fields.map((f) => f.key).sort());
    }
  });
});

describe("the template", () => {
  it("has the contract's headers in the contract's field order, one line", () => {
    expect(templateCsv("allocation")).toBe("Client,Officer,Posts per month,Creative source,Batch,Report format,Report due day,Platforms,Formats,Default post time\r\n");
    expect(templateCsv("plan")).toBe(
      "Client,Date,Time,Title,Format,Pillar,Platform,Extra,Angle,Objective,Key message,Visual direction,Caption,Text on design,CTA,Hashtags\r\n",
    );
  });
  it("carries the field order of 63.23.4 and 63.23.5", () => {
    expect(ALLOCATION_FIELDS.map((f) => f.key)).toEqual(["client", "officer", "postsPerCycle", "creativeSource", "deliveryBatch", "reportFormat", "reportDueDay", "platforms", "formats", "defaultPostTime"]);
    expect(PLAN_FIELDS.map((f) => f.key)).toEqual(["client", "date", "time", "title", "format", "pillar", "placement", "isExtra", "angle", "objective", "keyMessage", "visualDirection", "caption", "onAssetText", "cta", "hashtags"]);
  });
  it("marks client (and the plan's date) as the only required fields", () => {
    expect(ALLOCATION_FIELDS.filter((f) => f.required).map((f) => f.key)).toEqual(["client"]);
    expect(PLAN_FIELDS.filter((f) => f.required).map((f) => f.key)).toEqual(["client", "date"]);
  });
});

describe("small helpers", () => {
  it("names columns the way a spreadsheet does", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
  it("finds the rows with no cell holding anything", () => {
    expect(blankRowIndexes([["a", "b"], ["", "  "], [], ["", "x"]])).toEqual([1, 2]);
  });
  it("finds a column given to two fields, and ignores 'not in my sheet'", () => {
    expect(duplicateColumns({ client: "0", date: "0", title: "", time: "2" })).toEqual([{ column: 0, fields: ["client", "date"] }]);
    expect(duplicateColumns({ client: "0", date: "1" })).toEqual([]);
  });
  it("has six steps, in the contract's order", () => {
    expect(IMPORT_STEPS.map((s) => s.key)).toEqual(["what", "sheet", "columns", "names", "preview", "import"]);
  });
  it("words a value, a list and a missing one", () => {
    expect(valueText(null)).toBe("none");
    expect(valueText(["instagram", "tiktok"])).toBe("instagram, tiktok");
    expect(valueText({ id: "u-1", name: "Sam Officer" })).toBe("Sam Officer");
    expect(valueText(12)).toBe("12");
    expect(valueText(true)).toBe("yes");
  });
  it("words a scheduled instant in the zone it was read in", () => {
    expect(scheduledText("2026-11-03T02:00:00.000Z", "Asia/Makassar")).toBe("3 Nov, 10:00");
    expect(scheduledText(null, "UTC")).toBe("");
    expect(scheduledText("2026-11-03T02:00:00.000Z", "Not/AZone")).toBe("2026-11-03T02:00:00.000Z");
  });
});

const draft = (over: Partial<ImportDraft> = {}): ImportDraft => ({
  kind: "plan", rows: [["Client", "Date"], ["Brand Alpha", "3/11/2026"]], headerRow: true, mapping: { client: "0", date: "1", time: "" }, skip: new Set(),
  clientMatches: {}, officerMatches: {}, month: "2026-11", dateOrder: "dmy", timeZone: "Asia/Makassar", ...over,
});

describe("buildImportBody", () => {
  it("sends the plan's month, date order and zone, only the mapped columns, and no empty optional parts", () => {
    expect(buildImportBody(draft(), true)).toEqual({
      dryRun: true, headerRow: true, columns: { client: 0, date: 1 }, rows: [["Client", "Date"], ["Brand Alpha", "3/11/2026"]],
      month: "2026-11", dateOrder: "dmy", timeZone: "Asia/Makassar",
    });
  });
  it("sends skip sorted and the non-empty picks, and dryRun as asked", () => {
    const b = buildImportBody(draft({ skip: new Set([3, 1]), clientMatches: { "Alpha Co": "e-1", "Beta Co": "" } }), false);
    expect(b.dryRun).toBe(false);
    expect(b.skip).toEqual([1, 3]);
    expect(b.clientMatches).toEqual({ "Alpha Co": "e-1" });
  });
  it("leaves the plan's parts out of an allocation, and the officer picks in", () => {
    const b = buildImportBody(draft({ kind: "allocation", mapping: { client: "0", officer: "1" }, officerMatches: { Sam: "u-9" } }), true);
    expect(b).not.toHaveProperty("month");
    expect(b).not.toHaveProperty("dateOrder");
    expect(b).not.toHaveProperty("timeZone");
    expect(b.officerMatches).toEqual({ Sam: "u-9" });
  });
  it("never sends officer picks with a plan", () => {
    expect(buildImportBody(draft({ officerMatches: { Sam: "u-9" } }), true)).not.toHaveProperty("officerMatches");
  });
});

describe("the answers' parsers", () => {
  it("reads the parse answer, text for every cell, and names an unnamed tab", () => {
    const a = asParseAnswer({ tabs: [{ name: "Plan", rows: [["a", 2, null]] }, { rows: [] }, "junk"] });
    expect(a.tabs).toEqual([{ name: "Plan", rows: [["a", "2", ""]] }, { name: "Tab 2", rows: [] }]);
    expect(() => asParseAnswer({})).toThrow();
  });

  const answer = {
    dryRun: true, importId: null, summary: { rows: 3, ready: 1, unchanged: 0, refused: 1, skipped: 1 },
    unmatched: { clients: [{ sheetName: "Alfa Co", rows: [2], suggestions: [{ engagementId: "e-1", clientName: "Alpha Co" }, { nope: 1 }] }], officers: [{ sheetName: "Sam", rows: [2] }, 7] },
    rows: [
      { row: 1, outcome: "ready", refusals: [], warnings: [{ field: "time", code: "default_time_used" }], engagementId: "e-2", clientName: "Beta Co",
        cycle: { cycleId: null, deadline: "2026-10-31", created: true }, post: { id: "p-1", title: "Hello", format: "feed", scheduledAt: "2026-11-03T02:00:00Z", isExtra: false, placement: ["instagram"] } },
      { row: 2, outcome: "refused", refusals: [{ field: "client", code: "client_not_found" }, { code: 5 }], warnings: [] },
      { row: 3, outcome: "skipped" }, { row: 4, outcome: "weird" }, "junk",
    ],
  };

  it("reads a preview defensively: unknown outcomes and junk rows are dropped, suggestions and unmatched names kept", () => {
    const a = asImportAnswer(answer);
    expect(a.rows.map((r) => r.row)).toEqual([1, 2, 3]);
    expect(a.summary).toEqual({ rows: 3, ready: 1, unchanged: 0, refused: 1, skipped: 1 });
    expect(a.unmatched.clients).toEqual([{ sheetName: "Alfa Co", rows: [2], suggestions: [{ engagementId: "e-1", clientName: "Alpha Co" }] }]);
    expect(a.unmatched.officers).toEqual([{ sheetName: "Sam", rows: [2] }]);
    expect(a.rows[0].post).toMatchObject({ title: "Hello", placement: ["instagram"] });
    expect(a.rows[0].cycle).toEqual({ cycleId: null, deadline: "2026-10-31", created: true });
    expect(a.rows[0].warnings).toEqual([{ field: "time", code: "default_time_used" }]);
    expect(a.rows[1].refusals).toEqual([{ field: "client", code: "client_not_found" }]);
  });
  it("counts the summary from the rows when the server leaves it out, and throws on a body that is not an answer", () => {
    expect(asImportAnswer({ rows: [{ row: 0, outcome: "ready" }] }).summary).toMatchObject({ rows: 1, ready: 1 });
    expect(() => asImportAnswer({ summary: {} })).toThrow();
    expect(() => asImportAnswer(null)).toThrow();
  });
  it("reads an allocation row's changes", () => {
    const a = asImportAnswer({ rows: [{ row: 1, outcome: "ready", engagementId: "e-1", clientName: "Alpha Co", changes: { postsPerCycle: { from: null, to: 12 } } }] });
    expect(a.rows[0].changes).toEqual({ postsPerCycle: { from: null, to: 12 } });
  });
});

describe("the words", () => {
  const REFUSALS = ["missing_value", "invalid_field", "client_not_found", "client_ambiguous", "officer_not_found", "officer_ambiguous", "duplicate_client", "date_outside_month", "date_in_past", "missing_title", "no_cycle_deadline"];
  const WARNINGS = ["title_from_caption", "default_time_used", "same_title_in_cycle", "discarded_since"];

  it("words every row code of 63.23.3 as a sentence, never the bare token", () => {
    for (const c of [...REFUSALS, ...WARNINGS]) {
      const t = rowCodeText(c);
      expect(t, c).not.toBe(c);
      expect(t, c).toMatch(/[a-z]{3,}.*[.]$/);
      expect(t, c).not.toContain("_");
    }
  });
  it("names the field when the code carries one", () => {
    expect(rowCodeText("missing_value", "Posting date")).toBe("Posting date is empty, and this row needs it.");
    expect(rowCodeText("invalid_field", "Posting time")).toContain("Posting time");
  });
  it("points a missing deadline at the Allocation's batch or Settings", () => {
    expect(rowCodeText("no_cycle_deadline")).toMatch(/batch.*Allocation.*Settings/);
  });
  it("keeps an unknown code readable", () => {
    expect(rowCodeText("brand_new_code")).toBe("brand_new_code");
  });
  it("words the three routes' refusals", () => {
    expect(importRefusalText("not_a_social_approver")).toMatch(/Social Media head, the GM, the owner and the superadmin/);
    expect(importRefusalText("sheet_too_large", "rows")).toMatch(/2,000 rows/);
    expect(importRefusalText("sheet_too_large", "tabs")).toMatch(/20 tabs/);
    expect(importRefusalText("sheet_too_large", "file")).toMatch(/32 MB/);
    expect(importRefusalText("unreadable_sheet")).toMatch(/\.xlsx or \.csv/);
    expect(importRefusalText("invalid_field", "contentBase64")).toMatch(/2 MB/);
    expect(importRefusalText("invalid_field", "filename")).toMatch(/\.xlsx or \.csv/);
    expect(importRefusalText("invalid_field", "clientMatches.Alpha")).toMatch(/engagement/);
    expect(importRefusalText("import_rows_refused")).toMatch(/nothing was written/i);
    expect(importRefusalText("something_else")).toBe("something_else");
  });
});

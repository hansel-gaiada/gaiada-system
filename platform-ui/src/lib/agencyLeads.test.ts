import { describe, it, expect } from "vitest";
import {
  ALL_QUESTIONNAIRE_FIELDS,
  CANONICAL_DELEGATION_ROLES,
  QUESTIONNAIRE_REQUIRED_TOTAL,
  QUESTIONNAIRE_SECTIONS,
  buildInviteLink,
  formatAge,
  formatAnswerValue,
  needsInvite,
  queueRank,
  sectionEntries,
  type QSection,
} from "./agencyLeads";

describe("queueRank — contract rule 1's ordering, pinned", () => {
  it("ranks submitted above new above invited above everything else", () => {
    expect(queueRank("submitted")).toBe(0);
    expect(queueRank("new")).toBe(1);
    expect(queueRank("invited")).toBe(2);
    expect(queueRank("in_review")).toBe(3);
    expect(queueRank("nurturing")).toBe(3);
    expect(queueRank("declined")).toBe(3);
    expect(queueRank("converted")).toBe(3);
  });

  it("new outranks invited — the one signal the queue exists to carry", () => {
    expect(queueRank("new")).toBeLessThan(queueRank("invited"));
  });
});

describe("needsInvite", () => {
  it("is true only for 'new' — the actionable 'we never sent the form' state", () => {
    expect(needsInvite("new")).toBe(true);
    expect(needsInvite("invited")).toBe(false);
    expect(needsInvite("submitted")).toBe(false);
    expect(needsInvite("in_review")).toBe(false);
  });
});

describe("buildInviteLink — fragment, never query (contract)", () => {
  it("puts the token after a # fragment", () => {
    const link = buildInviteLink("https://discovery.example/intake", "abc123");
    expect(link).toBe("https://discovery.example/intake#t=abc123");
  });

  it("never produces a ?t= query parameter", () => {
    const link = buildInviteLink("https://discovery.example/intake", "abc123");
    expect(link).not.toMatch(/\?t=/);
    expect(link.split("#").length).toBe(2);
  });

  it("URL-encodes the token and strips any pre-existing fragment on the form URL", () => {
    const link = buildInviteLink("https://discovery.example/intake#old", "a/b c");
    expect(link).toBe(`https://discovery.example/intake#t=${encodeURIComponent("a/b c")}`);
  });
});

describe("formatAge", () => {
  it("renders days/hours, hours/minutes, minutes, or 'just now'", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(59)).toBe("just now");
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(3600)).toBe("1h 0m");
    expect(formatAge(3900)).toBe("1h 5m");
    expect(formatAge(90000)).toBe("1d 1h");
  });

  it("degrades to an em-dash on a bad value rather than throwing or printing NaN", () => {
    expect(formatAge(Number.NaN)).toBe("—");
    expect(formatAge(-5)).toBe("—");
  });
});

describe("the questionnaire mirror — must match the backend's transcription exactly", () => {
  it("has 13 sections", () => {
    expect(QUESTIONNAIRE_SECTIONS.length).toBe(13);
  });

  it("has 127 answerable fields total (backend's own AD-3 count, not the design doc's stale 122)", () => {
    expect(ALL_QUESTIONNAIRE_FIELDS.length).toBe(127);
  });

  it("every field id is unique across the whole questionnaire", () => {
    const ids = ALL_QUESTIONNAIRE_FIELDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("QUESTIONNAIRE_REQUIRED_TOTAL matches the actual count of required fields", () => {
    const required = ALL_QUESTIONNAIRE_FIELDS.filter((f) => f.required).length;
    expect(QUESTIONNAIRE_REQUIRED_TOTAL).toBe(required);
    expect(QUESTIONNAIRE_REQUIRED_TOTAL).toBeGreaterThan(0);
  });

  it("group headings never carry an id and are never counted as fields", () => {
    for (const section of QUESTIONNAIRE_SECTIONS) {
      for (const f of section.fields) {
        if (f.type === "group") expect(f.id).toBeUndefined();
      }
    }
  });
});

describe("sectionEntries — contract rule 4: 'key absent' is never 'answered empty'", () => {
  const section: QSection = {
    id: "s", title: "S", blurb: "",
    fields: [
      { type: "group", label: "A heading", required: false },
      { id: "answered_field", type: "text", label: "Answered", required: true },
      { id: "absent_field", type: "text", label: "Never present", required: false },
      { id: "empty_string_field", type: "text", label: "Present but blank", required: false },
      { id: "empty_array_field", type: "checkbox", label: "Present but empty array", required: false },
    ],
  };

  it("renders a heading entry for a group field", () => {
    const entries = sectionEntries(section, {});
    expect(entries[0]).toEqual({ kind: "heading", label: "A heading" });
  });

  it("distinguishes present-and-answered from absent from present-but-empty — never conflates them", () => {
    const answers = { answered_field: "hello", empty_string_field: "", empty_array_field: [] };
    const entries = sectionEntries(section, answers);

    const answered = entries.find((e) => e.kind === "field" && e.field.id === "answered_field");
    expect(answered).toMatchObject({ kind: "field", present: true, answered: true, value: "hello" });

    const absent = entries.find((e) => e.kind === "field" && e.field.id === "absent_field");
    // The key this test exists to pin: an absent key is NOT silently treated as an empty string —
    // it is its own distinguishable state (`present: false`), never coerced into the same shape a
    // present-but-blank answer produces.
    expect(absent).toMatchObject({ kind: "field", present: false, answered: false, value: undefined });

    const emptyString = entries.find((e) => e.kind === "field" && e.field.id === "empty_string_field");
    expect(emptyString).toMatchObject({ kind: "field", present: true, answered: false, value: "" });

    const emptyArray = entries.find((e) => e.kind === "field" && e.field.id === "empty_array_field");
    expect(emptyArray).toMatchObject({ kind: "field", present: true, answered: false, value: [] });

    // present vs absent must never collapse to the same tuple — that IS the bug this file exists to
    // prevent (a reviewer being unable to tell "they left it blank" from "this key was never there").
    expect(absent && absent.kind === "field" && absent.present).not.toBe(emptyString && emptyString.kind === "field" && emptyString.present);
  });

  it("never omits a field from the output, answered or not — nothing is silently skipped", () => {
    const entries = sectionEntries(section, {});
    const fieldEntries = entries.filter((e) => e.kind === "field");
    expect(fieldEntries.length).toBe(section.fields.filter((f) => f.type !== "group").length);
  });

  it("a grid only counts as answered once every row has a non-empty entry", () => {
    const gridSection: QSection = {
      id: "g", title: "G", blurb: "",
      fields: [{ id: "grid_field", type: "grid", label: "Grid", required: true, rows: ["r1", "r2"], cols: ["c1", "c2"] }],
    };
    const partial = sectionEntries(gridSection, { grid_field: { r1: "c1" } });
    expect(partial[0]).toMatchObject({ kind: "field", present: true, answered: false });

    const complete = sectionEntries(gridSection, { grid_field: { r1: "c1", r2: "c2" } });
    expect(complete[0]).toMatchObject({ kind: "field", present: true, answered: true });
  });
});

describe("formatAnswerValue", () => {
  it("joins array answers (checkbox) with commas", () => {
    expect(formatAnswerValue({ id: "x", type: "checkbox", label: "", required: false }, ["A", "B"])).toBe("A, B");
  });

  it("renders a scale value with its left/right anchors", () => {
    const field = { id: "x", type: "scale" as const, label: "", required: true, left: "Minimal", right: "Expressive" };
    expect(formatAnswerValue(field, 4)).toBe("4 (Minimal ←→ Expressive)");
  });

  it("renders a grid as a row/value list, filling a missing row with an em-dash rather than dropping it", () => {
    const field = { id: "x", type: "grid" as const, label: "", required: true, rows: ["Logo", "Video"], cols: ["Ready", "Missing"] };
    const rendered = formatAnswerValue(field, { Logo: "Ready" });
    expect(rendered).toEqual([{ row: "Logo", value: "Ready" }, { row: "Video", value: "—" }]);
  });

  it("stringifies a plain text answer", () => {
    expect(formatAnswerValue({ id: "x", type: "text", label: "", required: true }, "hello")).toBe("hello");
  });
});

describe("CANONICAL_DELEGATION_ROLES — mirrors agency-lead-convert.service.ts's §4.3 table", () => {
  it("has exactly the five roles the design table names, in order", () => {
    expect(CANONICAL_DELEGATION_ROLES.map((r) => r.role)).toEqual([
      "discovery_review", "sitemap", "integrations", "content_owners", "dns",
    ]);
  });

  it("discovery_review/content_owners default to the owner; sitemap/integrations/dns try a seat first", () => {
    const byRole = Object.fromEntries(CANONICAL_DELEGATION_ROLES.map((r) => [r.role, r.resolution]));
    expect(byRole.discovery_review).toBe("owner");
    expect(byRole.content_owners).toBe("owner");
    expect(byRole.sitemap).toBe("position");
    expect(byRole.integrations).toBe("position");
    expect(byRole.dns).toBe("position");
  });
});

// ─────────────────────────────────────────────────────────────────── M5-P1: the lead pipeline helpers
import {
  PIPELINE_REFUSAL_TEXT,
  allowedMoves,
  checkDealInput,
  dealInputValue,
  filterQueue,
  formatDeal,
  historyNewestFirst,
  isClosedStage,
  mostRecentCurrency,
  pipelineRefusalMessage,
  precisionHint,
  stageCounts,
  stageLabel,
  type LeadQueueRow,
  type PipelineCurrency,
  type PipelineStage,
  type StageEvent,
} from "./agencyLeads";

const STAGES: PipelineStage[] = [
  { key: "enquiry", position: 10, kind: "open", label: "Enquiry" },
  { key: "contacted", position: 20, kind: "open", label: "Contacted" },
  { key: "qualified", position: 30, kind: "open", label: "Qualified" },
  { key: "proposal", position: 40, kind: "open", label: "Proposal sent" },
  { key: "won", position: 90, kind: "won", label: "Won" },
  { key: "lost", position: 99, kind: "lost", label: "Lost" },
];
const CURRENCIES: PipelineCurrency[] = [
  { code: "IDR", symbol: "Rp", minorUnit: 0 },
  { code: "USD", symbol: "$", minorUnit: 2 },
];

function row(id: string, status: LeadQueueRow["status"], stage: string, extra: Partial<LeadQueueRow> = {}): LeadQueueRow {
  return {
    id, orgName: id, contactName: null, contactEmail: null, contactPhone: null, source: "staff", status,
    ownerId: null, ownerName: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    ageSeconds: 0, hasSubmission: false, stage, dealValue: null, dealCurrency: null, stageEnteredAt: "2026-09-01T00:00:00Z", ...extra,
  };
}

describe("allowedMoves: open stages only, never won or lost", () => {
  it("offers the other open stages in position order", () => {
    expect(allowedMoves(STAGES, "contacted", "in_review").map((s) => s.key)).toEqual(["enquiry", "qualified", "proposal"]);
  });
  it("never offers won or lost", () => {
    const keys = allowedMoves(STAGES, "enquiry", "new").map((s) => s.key);
    expect(keys).not.toContain("won");
    expect(keys).not.toContain("lost");
  });
  it("offers nothing for a converted or declined lead", () => {
    expect(allowedMoves(STAGES, "won", "converted")).toEqual([]);
    expect(allowedMoves(STAGES, "lost", "declined")).toEqual([]);
  });
});

describe("stageLabel / isClosedStage", () => {
  it("uses the reference label, and falls back to a humanised key", () => {
    expect(stageLabel(STAGES, "proposal")).toBe("Proposal sent");
    expect(stageLabel(null, "on_hold")).toBe("On hold");
  });
  it("closes on kind, with the two structural keys as the no-reference fallback", () => {
    expect(isClosedStage(STAGES, "won")).toBe(true);
    expect(isClosedStage(STAGES, "qualified")).toBe(false);
    expect(isClosedStage(null, "lost")).toBe(true);
    expect(isClosedStage(null, "qualified")).toBe(false);
  });
});

describe("formatDeal: exact decimal strings at the currency's minor unit", () => {
  it("IDR has no decimals", () => {
    expect(formatDeal("15000000.0000", "IDR", CURRENCIES)).toBe("IDR 15,000,000");
    expect(formatDeal("0.0000", "IDR", CURRENCIES)).toBe("IDR 0");
  });
  it("USD keeps two", () => {
    expect(formatDeal("10.2500", "USD", CURRENCIES)).toBe("USD 10.25");
    expect(formatDeal("1234567.5000", "USD", CURRENCIES)).toBe("USD 1,234,567.50");
  });
  it("never rounds away a non-zero digit beyond the minor unit", () => {
    expect(formatDeal("10.2550", "USD", CURRENCIES)).toBe("USD 10.255");
  });
  it("does no float arithmetic: a 16-digit value survives intact", () => {
    expect(formatDeal("9999999999999999.0000", "IDR", CURRENCIES)).toBe("IDR 9,999,999,999,999,999");
  });
  it("an unknown currency trims the padding; an absent value is an em-dash", () => {
    expect(formatDeal("5.5000", "SGD", CURRENCIES)).toBe("SGD 5.5");
    expect(formatDeal(null, null, CURRENCIES)).toBe("—");
  });
  it("dealInputValue gives an editable plain number", () => {
    expect(dealInputValue("15000000.0000")).toBe("15000000");
    expect(dealInputValue("10.2500")).toBe("10.25");
    expect(dealInputValue(null)).toBe("");
  });
});

describe("checkDealInput: the API's shape rule plus the minor unit", () => {
  it("accepts what the contract accepts", () => {
    expect(checkDealInput("10.25", 2)).toBeNull();
    expect(checkDealInput("1500", 0)).toBeNull();
    expect(checkDealInput("0", 2)).toBeNull();
  });
  it("IDR (0) refuses 1500.5 and USD (2) refuses 10.255, as precision", () => {
    expect(checkDealInput("1500.5", 0)).toBe("deal_value_precision");
    expect(checkDealInput("10.255", 2)).toBe("deal_value_precision");
  });
  it("refuses anything that is not a plain decimal, as invalid", () => {
    for (const bad of ["", "abc", "-5", "1,000", "1e3", "10.", ".5", "1.23456", "12345678901234567"]) {
      expect(checkDealInput(bad, 2), bad).toBe("deal_value_invalid");
    }
  });
  it("without a picked currency only the shape is checked", () => {
    expect(checkDealInput("10.255", null)).toBeNull();
  });
  it("precisionHint names the currency's own limit", () => {
    expect(precisionHint(CURRENCIES[0])).toMatch(/IDR has no decimals/);
    expect(precisionHint(CURRENCIES[1])).toMatch(/USD allows up to 2 decimals/);
    expect(precisionHint(null)).toBe("");
  });
});

describe("mostRecentCurrency: pre-select only, no default", () => {
  it("picks the currency of the most recently updated row that has one", () => {
    const rows = [
      row("a", "new", "enquiry", { dealCurrency: "IDR", updatedAt: "2026-09-01T00:00:00Z" }),
      row("b", "new", "enquiry", { dealCurrency: "USD", updatedAt: "2026-09-05T00:00:00Z" }),
      row("c", "new", "enquiry", { updatedAt: "2026-09-09T00:00:00Z" }),
    ];
    expect(mostRecentCurrency(rows)).toBe("USD");
  });
  it("is null when no lead has a value yet", () => {
    expect(mostRecentCurrency([row("a", "new", "enquiry")])).toBeNull();
  });
});

describe("filterQueue: it FILTERS, it never re-sorts (contract rule 1)", () => {
  // Deliberately in the BFF's whose-move-it-is order, which is NOT stage order, NOT age order, NOT id order.
  const rows = [
    row("s1", "submitted", "proposal"),
    row("n1", "new", "enquiry"),
    row("i1", "invited", "contacted"),
    row("s2", "in_review", "proposal"),
    row("w1", "converted", "won"),
    row("l1", "declined", "lost"),
    row("n2", "nurturing", "enquiry"),
  ];
  it("no filter returns the rows in the order received", () => {
    expect(filterQueue(rows, { stage: null, hideClosed: false }, STAGES).map((r) => r.id)).toEqual(["s1", "n1", "i1", "s2", "w1", "l1", "n2"]);
  });
  it("a stage filter keeps the received order within the stage", () => {
    expect(filterQueue(rows, { stage: "proposal", hideClosed: false }, STAGES).map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(filterQueue(rows, { stage: "enquiry", hideClosed: false }, STAGES).map((r) => r.id)).toEqual(["n1", "n2"]);
  });
  it("hide closed drops won and lost only", () => {
    expect(filterQueue(rows, { stage: null, hideClosed: true }, STAGES).map((r) => r.id)).toEqual(["s1", "n1", "i1", "s2", "n2"]);
  });
  it("counts are over all rows", () => {
    expect(stageCounts(rows)).toEqual({ proposal: 2, enquiry: 2, contacted: 1, won: 1, lost: 1 });
  });
});

describe("historyNewestFirst", () => {
  const ev = (id: string, at: string): StageEvent => ({
    id, fromStage: "enquiry", toStage: "contacted", dealValue: null, dealCurrency: null, actorId: null, actorName: null, viaAgent: null, occurredAt: at,
  });
  it("orders newest first and is stable for equal times", () => {
    const out = historyNewestFirst([ev("old", "2026-09-01T00:00:00Z"), ev("tie-a", "2026-09-03T00:00:00Z"), ev("new", "2026-09-04T00:00:00Z"), ev("tie-b", "2026-09-03T00:00:00Z")]);
    expect(out.map((e) => e.id)).toEqual(["new", "tie-a", "tie-b", "old"]);
  });
  it("does not mutate its input", () => {
    const input = [ev("a", "2026-09-01T00:00:00Z"), ev("b", "2026-09-02T00:00:00Z")];
    historyNewestFirst(input);
    expect(input.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("pipelineRefusalMessage: every typed reason in plain words", () => {
  const REASONS = ["stage_unknown", "stage_terminal", "lead_closed", "deal_incomplete", "deal_value_invalid", "deal_currency_unknown", "deal_value_precision"];
  it("has a sentence for each of the seven codes, and never leaks the code itself", () => {
    for (const r of REASONS) {
      const msg = pipelineRefusalMessage(r, 400, "raw backend text");
      expect(msg, r).toBe(PIPELINE_REFUSAL_TEXT[r]);
      expect(msg, r).not.toContain("_");
      expect(msg, r).not.toBe("raw backend text");
    }
  });
  it("a 403 without a known reason is a plain permission message", () => {
    expect(pipelineRefusalMessage(undefined, 403, "forbidden")).toBe("You don't have permission to do that.");
  });
  it("otherwise the backend's own words", () => {
    expect(pipelineRefusalMessage("something_new", 500, "boom")).toBe("boom");
  });
});

describe("lead source labels (M5-L4 adds web)", () => {
  it("web is Website form; every source has a label; an unknown one falls back to its key", async () => {
    const { sourceLabel, SOURCE_LABEL } = await import("./agencyLeads");
    expect(sourceLabel("web")).toBe("Website form");
    expect(Object.keys(SOURCE_LABEL).sort()).toEqual(["invite", "open", "staff", "web"]);
    expect(sourceLabel("partner")).toBe("partner");
  });
});

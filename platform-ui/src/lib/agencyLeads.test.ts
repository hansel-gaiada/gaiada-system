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

// SCP-5 W5-B2 — the pure part of "Ideas for next month" (BFF §63.25): the bodies' validation, the company's metric rule, what "Add to next
// plan" gives the post, the closed-cycle rule, and the fixture's `release_idea` on discard (and not on archive). No services needed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { ScpRouteError } from "./pipeline-effects";
import { SCP, scpAction } from "./fixture";
import { IO_EFFECTS } from "./machine";
import { EFFECT_RUNNERS } from "./pipeline-effects";
import {
  ANGLE_PREFIX, cutChars, cycleIsClosed, monthOfDay, parseIdeaCreate, parseIdeaFilter, parseIdeaPatch, parsePlanBody, planPostFields,
} from "./ideas";
import { DEFAULT_RULES } from "./rules";

const required = { metricRequired: true, sharedInMonthlyReport: false };
const optional = { metricRequired: false, sharedInMonthlyReport: false };
const ID = "3f2b8a52-6c1d-4a47-9d10-0a1b2c3d4e5f";

/** The refusal a call throws, as `{status, code, field}`. */
function refusal(fn: () => unknown): { status: number; code: string; field?: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ScpRouteError) {
      const r = e.getResponse() as { message: string; field?: string };
      return { status: e.getStatus(), code: r.message, field: r.field };
    }
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("SCP-5 W5-B2 · the defaults the code reads", () => {
  it("the seed requires the metric and keeps shared ideas out of the report (SCP-Q27)", () => {
    expect(DEFAULT_RULES.ideas).toEqual({ metricRequired: true, sharedInMonthlyReport: false });
  });
});

describe("SCP-5 W5-B2 · parseIdeaCreate (BFF §63.25.3)", () => {
  const good = { saw: "Reels got twice the saves", metric: "saves per reel", suggestion: "Make four reels next month" };

  it("takes a whole body, trims it, and lower-cases the ids", () => {
    const r = parseIdeaCreate({ ...good, saw: "  padded  ", id: ID.toUpperCase(), reportId: ID }, required);
    expect(r).toEqual({ id: ID, saw: "padded", metric: "saves per reel", suggestion: good.suggestion, reportId: ID });
  });

  it("the metric follows the company's setting: required, a missing or blank one is 400 {field: 'metric'}; optional, it is null", () => {
    for (const metric of [undefined, null, "", "   "]) {
      expect(refusal(() => parseIdeaCreate({ ...good, metric }, required))).toEqual({ status: 400, code: "missing_field", field: "metric" });
      expect(parseIdeaCreate({ ...good, metric }, optional).metric).toBeNull();
    }
    expect(parseIdeaCreate(good, optional).metric).toBe("saves per reel");
  });

  it("every field's refusal is typed and names the field, in the order saw, metric, suggestion", () => {
    expect(refusal(() => parseIdeaCreate({}, required))).toMatchObject({ status: 400, code: "missing_field", field: "saw" });
    expect(refusal(() => parseIdeaCreate({ saw: "x" }, required))).toMatchObject({ code: "missing_field", field: "metric" });
    expect(refusal(() => parseIdeaCreate({ saw: "x", metric: "y" }, required))).toMatchObject({ code: "missing_field", field: "suggestion" });
    expect(refusal(() => parseIdeaCreate({ ...good, saw: 5 }, required))).toMatchObject({ code: "invalid_field", field: "saw" });
    expect(refusal(() => parseIdeaCreate({ ...good, saw: "x".repeat(501) }, required))).toMatchObject({ code: "invalid_field", field: "saw" });
    expect(refusal(() => parseIdeaCreate({ ...good, metric: "y".repeat(301) }, optional))).toMatchObject({ code: "invalid_field", field: "metric" });
    expect(refusal(() => parseIdeaCreate({ ...good, suggestion: "z".repeat(501) }, required))).toMatchObject({ code: "invalid_field", field: "suggestion" });
    expect(refusal(() => parseIdeaCreate({ ...good, id: "nope" }, required))).toMatchObject({ code: "invalid_field", field: "id" });
    expect(refusal(() => parseIdeaCreate({ ...good, reportId: "nope" }, required))).toMatchObject({ code: "invalid_field", field: "reportId" });
    expect(refusal(() => parseIdeaCreate({ ...good, status: "planned" }, required))).toMatchObject({ code: "invalid_field", field: "status" });
    expect(refusal(() => parseIdeaCreate(["x"], required))).toMatchObject({ code: "invalid_field", field: "body" });
  });

  it("the limits are the table's CHECK limits, counted in characters (500, 300, 500)", () => {
    expect(parseIdeaCreate({ saw: "s".repeat(500), metric: "m".repeat(300), suggestion: "g".repeat(500) }, required).saw).toHaveLength(500);
    // an emoji is one character to the database, two UTF-16 units to JS
    expect(parseIdeaCreate({ saw: "🙂".repeat(500), metric: "m", suggestion: "g" }, required).saw).toHaveLength(1000);
    expect(refusal(() => parseIdeaCreate({ saw: "🙂".repeat(501), metric: "m", suggestion: "g" }, required))).toMatchObject({ field: "saw" });
  });
});

describe("SCP-5 W5-B2 · parseIdeaPatch", () => {
  it("takes some of the three fields, and a body with none is 400", () => {
    expect(parseIdeaPatch({ saw: " new " }, required)).toEqual({ saw: "new" });
    expect(refusal(() => parseIdeaPatch({}, required))).toMatchObject({ status: 400, field: "body" });
    expect(refusal(() => parseIdeaPatch({ id: ID }, required))).toMatchObject({ code: "invalid_field", field: "id" });
  });

  it("a metric the patch touches is held to the company's rule; a patch that leaves it alone is never judged on it", () => {
    expect(refusal(() => parseIdeaPatch({ metric: null }, required))).toEqual({ status: 400, code: "missing_field", field: "metric" });
    expect(parseIdeaPatch({ metric: null }, optional)).toEqual({ metric: null });
    expect(parseIdeaPatch({ suggestion: "again" }, required)).toEqual({ suggestion: "again" });
  });
});

describe("SCP-5 W5-B2 · the plan body, the list filter and the closed-cycle rule", () => {
  it("cycleId is required and a uuid: 400 {field: 'cycleId'}", () => {
    expect(parsePlanBody({ cycleId: ID.toUpperCase() })).toEqual({ cycleId: ID });
    for (const body of [undefined, null, {}, { cycleId: 3 }, { cycleId: "x" }]) {
      expect(refusal(() => parsePlanBody(body))).toEqual({ status: 400, code: "invalid_field", field: "cycleId" });
    }
  });

  it("the filter takes the three statuses and a uuid", () => {
    expect(parseIdeaFilter({})).toEqual({ status: null, reportId: null });
    expect(parseIdeaFilter({ status: "shared", reportId: ID })).toEqual({ status: "shared", reportId: ID });
    expect(refusal(() => parseIdeaFilter({ status: "done" }))).toMatchObject({ field: "status" });
    expect(refusal(() => parseIdeaFilter({ reportId: "x" }))).toMatchObject({ field: "reportId" });
  });

  it("a cycle is closed when its month is BEFORE the report month; this month and later are open", () => {
    expect(monthOfDay("2026-11-17")).toBe("2026-11");
    expect(cycleIsClosed("2026-10", "2026-11")).toBe(true);
    expect(cycleIsClosed("2025-12", "2026-01")).toBe(true);
    expect(cycleIsClosed("2026-11", "2026-11")).toBe(false);
    expect(cycleIsClosed("2027-01", "2026-12")).toBe(false);
  });
});

describe("SCP-5 W5-B2 · what \"Add to next plan\" gives the post (BFF §63.25.3)", () => {
  it("the title is the suggestion; the angle is 'From an idea: <saw> (<metric>)'", () => {
    expect(planPostFields({ saw: "Reels led", metric: "saves", suggestion: "Make reels" })).toEqual({ title: "Make reels", angle: `${ANGLE_PREFIX}Reels led (saves)` });
  });

  it("without a metric the angle has no empty parentheses", () => {
    expect(planPostFields({ saw: "Reels led", metric: null, suggestion: "Make reels" }).angle).toBe("From an idea: Reels led");
  });

  it("the title is cut at 200 characters and the angle at 500, never through a surrogate pair", () => {
    const f = planPostFields({ saw: "s".repeat(500), metric: "m".repeat(300), suggestion: "🙂".repeat(300) });
    expect([...f.title]).toHaveLength(200);
    expect(f.title).toBe("🙂".repeat(200));
    expect([...f.angle]).toHaveLength(500);
    expect(cutChars("abc", 5)).toBe("abc");
    expect(cutChars("abcdef", 3)).toBe("abc");
  });
});

describe("SCP-5 W5-B2 · the fixture's release_idea (BFF §63.25.1)", () => {
  const effectsOf = (action: string): string[] => (scpAction(action)?.effects ?? []).map(String);

  it("discard names release_idea, after the soft delete and before the content month's progress", () => {
    const e = effectsOf("discard");
    expect(e).toEqual(["soft_delete", "release_idea", "content_month_progress"]);
  });

  it("archive does not: an archived post keeps its idea planned", () => {
    expect(effectsOf("archive")).not.toContain("release_idea");
  });

  it("no other action names it, and the effect is an I/O effect with a runner (so the fixture and the code are in step)", () => {
    expect(SCP.actions.filter((a) => a.effects.some((x) => String(x).includes("release_idea"))).map((a) => a.action)).toEqual(["discard"]);
    expect(IO_EFFECTS.has("release_idea")).toBe(true);
    expect(typeof EFFECT_RUNNERS.release_idea).toBe("function");
  });
});

describe("SCP-5 W5-B2 · the fixture twins", () => {
  it("the server's stage-machine fixture and the UI's twin are byte-identical (a new effect needs both)", () => {
    const server = readFileSync(resolve(__dirname, "../scp-stage-machine.json"));
    const ui = readFileSync(resolve(__dirname, "../../../../../platform-ui/src/lib/scpStageMachine.json"));
    expect(Buffer.compare(server, ui)).toBe(0);
  });
});

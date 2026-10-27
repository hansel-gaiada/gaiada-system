// SCP-1h — the pure parts of the Creative step, no database: the design queue's paging and its two facts, and the Asset Library save's source
// and AI note. The routes themselves are proved against live Postgres and Cerbos in design-queue.http.test.ts and core/creative-source.test.ts.
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { DESIGN_QUEUE_DEFAULT_LIMIT, holdsSocialDesigner, parsePaging } from "./design-queue.controller";
import { AI_NOTE_MAX, CreativeRuleError, parseSourceAndNote } from "../../../core/creative-reviews";

const grant = (role: string, scopeType: "global" | "company" | "org_unit", scopeId: string | null) => ({ role, scopeType, scopeId });
/** What `fn` throws (the test fails if it does not throw). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("SCP-1h · holdsSocialDesigner (the in-team fact: the derived role's own condition)", () => {
  it("is a global grant, or a company grant at this company", () => {
    expect(holdsSocialDesigner({ roles: [grant("social_designer", "global", null)] }, TENANT)).toBe(true);
    expect(holdsSocialDesigner({ roles: [grant("social_designer", "company", TENANT)] }, TENANT)).toBe(true);
  });
  it("is not another company's grant, another scope's, or another role", () => {
    expect(holdsSocialDesigner({ roles: [grant("social_designer", "company", OTHER)] }, TENANT)).toBe(false);
    expect(holdsSocialDesigner({ roles: [grant("social_designer", "org_unit", TENANT)] }, TENANT)).toBe(false);
    expect(holdsSocialDesigner({ roles: [grant("social_copywriter", "company", TENANT), grant("member", "company", TENANT)] }, TENANT)).toBe(false);
    expect(holdsSocialDesigner({ roles: [] }, TENANT)).toBe(false);
  });
});

describe("SCP-1h · the design queue's paging (BFF §63.0: limit 1 to 100, default 30, an opaque cursor)", () => {
  it("defaults to 30 and takes 1 to 100", () => {
    expect(parsePaging({})).toEqual({ limit: DESIGN_QUEUE_DEFAULT_LIMIT, after: null });
    expect(DESIGN_QUEUE_DEFAULT_LIMIT).toBe(30);
    expect(parsePaging({ limit: "1" }).limit).toBe(1);
    expect(parsePaging({ limit: "100" }).limit).toBe(100);
    expect(parsePaging({ limit: "" }).limit).toBe(30);
  });
  it("refuses anything else with 400 and the field", () => {
    for (const limit of ["0", "101", "-1", "1.5", "abc", "1e2", 30 as unknown as string]) {
      try {
        parsePaging({ limit });
        throw new Error(`limit ${String(limit)} was accepted`);
      } catch (e) {
        expect(e, String(limit)).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toMatchObject({ message: "invalid_field", field: "limit" });
      }
    }
  });
  it("reads back a cursor it wrote, and refuses one it did not", () => {
    const key = ["2040-02-24", "2040-02-10T09:00:00.000Z", "33333333-3333-4333-8333-333333333333"];
    const cursor = Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
    expect(parsePaging({ cursor }).after).toEqual(key);
    for (const bad of ["garbage", Buffer.from("[1,2,3]").toString("base64url"), Buffer.from(JSON.stringify(["x", "y", "z"])).toString("base64url"), 5 as unknown as string]) {
      try {
        parsePaging({ cursor: bad });
        throw new Error("a bad cursor was accepted");
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({ message: "invalid_field", field: "cursor" });
      }
    }
  });
});

describe("SCP-1h · the Asset Library save's source and AI note (BFF §63.6.6, §35.2)", () => {
  it("defaults to unknown with no note, and takes each of the five sources", () => {
    expect(parseSourceAndNote(undefined, undefined)).toEqual({ source: "unknown", aiNote: null });
    expect(parseSourceAndNote(null, null)).toEqual({ source: "unknown", aiNote: null });
    for (const source of ["own", "client", "stock", "unknown"] as const) expect(parseSourceAndNote(source, undefined)).toEqual({ source, aiNote: null });
    expect(parseSourceAndNote("ai", "  Made with an image model.  ")).toEqual({ source: "ai", aiNote: "Made with an image model." });
  });
  it("an AI asset needs its note: 400 ai_note_required on aiNote", () => {
    for (const note of [undefined, null, "", "   "]) {
      try {
        parseSourceAndNote("ai", note);
        throw new Error("an AI asset with no note was accepted");
      } catch (e) {
        expect(e).toBeInstanceOf(CreativeRuleError);
        expect(e).toMatchObject({ httpStatus: 400, token: "ai_note_required", field: "aiNote" });
      }
    }
  });
  it("refuses a source that is not one of the five and a note that is not text or is too long, each with its field", () => {
    expect(thrown(() => parseSourceAndNote("AI", undefined))).toMatchObject({ token: "source_invalid", field: "source" });
    expect(thrown(() => parseSourceAndNote("", undefined))).toMatchObject({ token: "source_invalid", field: "source" });
    expect(thrown(() => parseSourceAndNote(5, undefined))).toMatchObject({ token: "source_invalid", field: "source" });
    expect(thrown(() => parseSourceAndNote("own", 5))).toMatchObject({ token: "ai_note_invalid", field: "aiNote" });
    expect(thrown(() => parseSourceAndNote("ai", "x".repeat(AI_NOTE_MAX + 1)))).toMatchObject({ token: "ai_note_invalid", field: "aiNote" });
    expect(parseSourceAndNote("ai", "x".repeat(AI_NOTE_MAX)).aiNote).toHaveLength(AI_NOTE_MAX);
  });
  it("counts the bound in characters, as the database does (a pair of emoji is two, not four)", () => {
    expect(parseSourceAndNote("ai", "\u{1F600}".repeat(AI_NOTE_MAX)).aiNote).toHaveLength(AI_NOTE_MAX * 2);
    expect(thrown(() => parseSourceAndNote("ai", "\u{1F600}".repeat(AI_NOTE_MAX + 1)))).toMatchObject({ token: "ai_note_invalid" });
  });
  it("a note may ride on a non-AI source; a blank one is no note", () => {
    expect(parseSourceAndNote("stock", "Licensed from a stock library.")).toEqual({ source: "stock", aiNote: "Licensed from a stock library." });
    expect(parseSourceAndNote("own", "   ")).toEqual({ source: "own", aiNote: null });
  });
});

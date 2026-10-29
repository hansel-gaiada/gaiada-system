import { describe, it, expect } from "vitest";
import {
  GUIDANCE_FORBIDDEN, GUIDANCE_NOT_FOUND, PREAMBLE_MAX, asPreambleView, assistantGuidanceHref, changedLine, countLabel, cpLength,
  guidanceDay, guidanceErrorText, lengthState, mayEditPreamble, measuredText, startingText, type PreambleView,
} from "./assistantGuidance";
import { lead, me, member } from "./workspaceFixtures";

// AIP-13b (BFF section 65): the client-safe rules the guidance page, its editor and its server action share.

const view = (over: Partial<PreambleView> = {}): PreambleView => ({
  unitNodeId: "d-web", department: { name: "Web Dev", key: "web-dev" }, custom: null, defaultText: "Default text.", effective: "Default text.",
  updatedAt: null, updatedBy: null, preview: "You are helping someone in the Web Dev department.\n\nDepartment guidance:\nDefault text.", contextEnabled: true, ...over,
});

describe("the length, counted as the server counts it", () => {
  it("counts code points, not UTF-16 units: 1,000 emoji are within the limit and 1,001 are not", () => {
    expect(cpLength("\u{1F600}")).toBe(1);
    expect("\u{1F600}".length).toBe(2);
    expect(lengthState("\u{1F600}".repeat(PREAMBLE_MAX))).toEqual({ count: 1000, over: 0, ok: true });
    expect(lengthState("\u{1F600}".repeat(PREAMBLE_MAX + 1))).toEqual({ count: 1001, over: 1, ok: false });
  });
  it("measures the text after the trim and CRLF to LF, as the server does", () => {
    expect(measuredText("  a\r\nb\r  ")).toBe("a\nb");
    expect(lengthState(`  ${"a".repeat(PREAMBLE_MAX)}  \r\n`).ok).toBe(true);
    expect(lengthState("a\r\nb").count).toBe(3);
  });
  it("words the count against 1,000, and the overflow when there is one", () => {
    expect(countLabel("")).toBe("0 of 1,000 characters");
    expect(countLabel("a".repeat(412))).toBe("412 of 1,000 characters");
    expect(countLabel("a".repeat(1037))).toBe("1,037 of 1,000 characters: 37 over the limit");
  });
  it("starts from the custom text, else the default, else nothing", () => {
    expect(startingText({ custom: "Own", defaultText: "Default" })).toBe("Own");
    expect(startingText({ custom: null, defaultText: "Default" })).toBe("Default");
    expect(startingText({ custom: null, defaultText: null })).toBe("");
  });
});

describe("the server's refusals, in words", () => {
  it("403 says who can change it, 404 says the department was not found, and a 400 is the server's own sentence", () => {
    expect(guidanceErrorText({ status: 403, message: "forbidden" })).toBe(GUIDANCE_FORBIDDEN);
    expect(GUIDANCE_FORBIDDEN).toBe("Only this department's head or a company admin can change this.");
    expect(guidanceErrorText({ status: 404, message: "department_not_found" })).toBe(GUIDANCE_NOT_FOUND);
    expect(guidanceErrorText({ status: 400, message: "body must be at most 1000 characters" })).toBe("body must be at most 1000 characters");
    expect(guidanceErrorText({ status: 500, message: "" })).toMatch(/could not be saved/);
  });
});

describe("who changed it, and when", () => {
  it("names nobody while the default stands", () => {
    expect(changedLine(view())).toBe("Nobody has changed it: the assistant uses the default.");
  });
  it("names the editor and the UTC day, and degrades when either is unknown", () => {
    const custom = { custom: "Own", updatedAt: "2026-10-29T10:00:00.000Z", updatedBy: { id: "u1", name: "Ketut Arta" } };
    expect(changedLine(custom)).toBe("Last changed by Ketut Arta on 29 Oct 2026.");
    expect(changedLine({ ...custom, updatedBy: null })).toBe("Last changed on 29 Oct 2026.");
    expect(changedLine({ ...custom, updatedAt: null })).toBe("Last changed by Ketut Arta.");
    expect(changedLine({ ...custom, updatedAt: null, updatedBy: null })).toMatch(/no longer/);
    expect(guidanceDay("nope")).toBe("");
  });
});

describe("the answer is checked, never trusted", () => {
  it("reads the section 65.1 view", () => {
    const raw = { ...view({ custom: "Own", updatedAt: "2026-10-29T10:00:00.000Z", updatedBy: { id: "u1", name: "Ketut" } }) };
    expect(asPreambleView(raw)).toEqual(raw);
  });
  it("treats a missing contextEnabled as off, so the screen never claims a text is in use on a platform that cannot say", () => {
    const { contextEnabled: _drop, ...old } = view();
    expect(asPreambleView(old).contextEnabled).toBe(false);
  });
  it("refuses anything that is not a view (a failed read is never an empty text)", () => {
    for (const bad of [null, undefined, "x", 5, {}, { unitNodeId: 5 }]) expect(() => asPreambleView(bad)).toThrow();
  });
});

describe("mayEditPreamble (a mirror of the server)", () => {
  const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
  const owner = me([{ role: "owner", scopeType: "company", scopeId: "co-a" }]);
  it("offers it to the admin, the owner, and the head of the unit or an enclosing one; not to a member or a sibling's head", () => {
    expect(mayEditPreamble(admin, "co-a", [])).toBe(true);
    expect(mayEditPreamble(owner, "co-a", ["d-seo", "root"])).toBe(true);
    expect(mayEditPreamble(me([member(), lead("d-web")]), "co-a", ["d-web", "root"])).toBe(true);
    expect(mayEditPreamble(me([member(), lead("d-web")]), "co-a", ["d-web-fe", "d-web", "root"])).toBe(true);
    expect(mayEditPreamble(me([member(), lead("d-seo")]), "co-a", ["d-web", "root"])).toBe(false);
    expect(mayEditPreamble(me([member()]), "co-a", ["d-web", "root"])).toBe(false);
  });
  it("addresses the page", () => {
    expect(assistantGuidanceHref("d-web")).toBe("/departments/d-web/assistant-guidance");
  });
});

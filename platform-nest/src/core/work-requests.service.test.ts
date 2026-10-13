// DW-5c (FRONTEND-BFF-CONTRACT §32.3 to §32.6) — the PURE rules of work-requests.service.ts: the request form validator,
// the body parsers, the lifecycle rules, the change-request sync plan, the org walk and the plain-text summaries. No
// database, no Cerbos: runs everywhere. The HTTP/DB proof of the same rules is work-requests.test.ts, which runs on the
// Linux gate.
import { describe, it, expect } from "vitest";
import {
  WorkRequestRuleError, buildTaskDescription, departmentOf, desiredStatusFromChangeRequest, indexOrgTree, parseAssetsForm,
  parseCreate, parseDateOnly, parseDecline, parseDeliver, parseEngineeringForm, parseHttpUrl, parseListQuery, plain, planDeliver,
  planSync, requireAssets, requireChangeRequestNew, requireFilterDepartment, requireOpen, requireToDepartment, summarizeAssetsForm,
  unitView,
} from "./work-requests.service";
import type { OrgNode } from "../admin/org-structure.service";

function refusal(fn: () => unknown): WorkRequestRuleError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WorkRequestRuleError);
    return e as WorkRequestRuleError;
  }
  throw new Error("expected a WorkRequestRuleError, but nothing was thrown");
}
const formField = (fn: () => unknown): string | undefined => {
  const e = refusal(fn);
  expect([e.httpStatus, e.reason]).toEqual([400, "form_invalid"]);
  return e.field;
};

const PART = "0190a000-0000-7000-8000-0000000000aa";
const deliverable = { format: "image" as const, size: "1080×1350", quantity: 3 };
const assetsBody = (over: Record<string, unknown> = {}) => ({
  kind: "assets", toUnitId: "d-creative", title: "Launch banners", form: { deliverables: [deliverable] }, ...over,
});
const engBody = (over: Record<string, unknown> = {}) => ({
  kind: "engineering", toUnitId: "d-web", title: "Fix the form", form: { kind: "bug" }, ...over,
});

describe("DW-5c §32.4 the assets form", () => {
  it("accepts the full shape and returns only what was sent, trimmed", () => {
    const f = parseAssetsForm({
      deliverables: [{ format: "video", size: " 1920×1080 ", quantity: 2 }, deliverable],
      channel: " Instagram ", references: ["https://a.test/x", "http://b.test/y"], notes: "Keep it light",
    });
    expect(f).toEqual({
      deliverables: [{ format: "video", size: "1920×1080", quantity: 2 }, deliverable],
      channel: "Instagram", references: ["https://a.test/x", "http://b.test/y"], notes: "Keep it light",
    });
    expect(parseAssetsForm({ deliverables: [deliverable] })).toEqual({ deliverables: [deliverable] });
  });

  it("takes every deliverable format and refuses any other", () => {
    for (const format of ["image", "video", "copy", "document", "other"]) {
      expect(() => parseAssetsForm({ deliverables: [{ format, size: "x", quantity: 1 }] })).not.toThrow();
    }
    expect(formField(() => parseAssetsForm({ deliverables: [{ format: "gif", size: "x", quantity: 1 }] }))).toBe("form.deliverables[0].format");
  });

  it("deliverables: 1 to 10 items", () => {
    expect(formField(() => parseAssetsForm({ deliverables: [] }))).toBe("form.deliverables");
    expect(formField(() => parseAssetsForm({}))).toBe("form.deliverables");
    expect(formField(() => parseAssetsForm({ deliverables: "image" }))).toBe("form.deliverables");
    expect(() => parseAssetsForm({ deliverables: Array.from({ length: 10 }, () => deliverable) })).not.toThrow();
    expect(formField(() => parseAssetsForm({ deliverables: Array.from({ length: 11 }, () => deliverable) }))).toBe("form.deliverables");
  });

  it("quantity: a whole number from 1 to 50", () => {
    for (const quantity of [1, 50]) expect(() => parseAssetsForm({ deliverables: [{ ...deliverable, quantity }] })).not.toThrow();
    for (const quantity of [0, 51, 1.5, "3", null, -1]) {
      expect(formField(() => parseAssetsForm({ deliverables: [{ ...deliverable, quantity }] })), String(quantity)).toBe("form.deliverables[0].quantity");
    }
  });

  it("size: a string of at most 60 characters", () => {
    expect(() => parseAssetsForm({ deliverables: [{ ...deliverable, size: "x".repeat(60) }] })).not.toThrow();
    expect(formField(() => parseAssetsForm({ deliverables: [{ ...deliverable, size: "x".repeat(61) }] }))).toBe("form.deliverables[0].size");
    expect(formField(() => parseAssetsForm({ deliverables: [{ format: "image", quantity: 1 }] }))).toBe("form.deliverables[0].size");
  });

  it("channel at most 60, notes at most 2,000, references 0 to 10 http(s) URLs of at most 500", () => {
    expect(() => parseAssetsForm({ deliverables: [deliverable], channel: "c".repeat(60) })).not.toThrow();
    expect(formField(() => parseAssetsForm({ deliverables: [deliverable], channel: "c".repeat(61) }))).toBe("form.channel");
    expect(() => parseAssetsForm({ deliverables: [deliverable], notes: "n".repeat(2000) })).not.toThrow();
    expect(formField(() => parseAssetsForm({ deliverables: [deliverable], notes: "n".repeat(2001) }))).toBe("form.notes");
    expect(() => parseAssetsForm({ deliverables: [deliverable], references: [] })).not.toThrow();
    expect(() => parseAssetsForm({ deliverables: [deliverable], references: Array.from({ length: 10 }, () => "https://a.test") })).not.toThrow();
    expect(formField(() => parseAssetsForm({ deliverables: [deliverable], references: Array.from({ length: 11 }, () => "https://a.test") }))).toBe("form.references");
    expect(formField(() => parseAssetsForm({ deliverables: [deliverable], references: ["ftp://a.test/x"] }))).toBe("form.references[0]");
    expect(formField(() => parseAssetsForm({ deliverables: [deliverable], references: ["https://a.test", "javascript:alert(1)"] }))).toBe("form.references[1]");
    expect(formField(() => parseAssetsForm({ deliverables: [deliverable], references: ["https://a.test/" + "p".repeat(500)] }))).toBe("form.references[0]");
  });

  it("refuses unknown keys, at the top and inside a deliverable (the form is data, never interpreted)", () => {
    expect(formField(() => parseAssetsForm({ deliverables: [deliverable], priority: "urgent" }))).toBe("form.priority");
    expect(formField(() => parseAssetsForm({ deliverables: [{ ...deliverable, color: "red" }] }))).toBe("form.deliverables[0].color");
    expect(formField(() => parseAssetsForm("nope"))).toBe("form");
    expect(formField(() => parseAssetsForm(null))).toBe("form");
    expect(formField(() => parseAssetsForm([]))).toBe("form");
  });

  it("scrubs a PAN out of the notes", () => {
    const f = parseAssetsForm({ deliverables: [deliverable], notes: "card 4111 1111 1111 1111 ok" });
    expect(f.notes).toContain("[REDACTED-PAN]");
    expect(f.notes).not.toContain("4111");
  });
});

describe("DW-5c §32.4 the engineering form", () => {
  it("takes the four change-request kinds and an optional http(s) affectedUrl", () => {
    for (const kind of ["content", "design", "feature", "bug"]) expect(parseEngineeringForm({ kind })).toEqual({ kind });
    expect(parseEngineeringForm({ kind: "bug", affectedUrl: "https://site.test/page" })).toEqual({ kind: "bug", affectedUrl: "https://site.test/page" });
  });
  it("refuses a missing or unknown kind, a bad URL and unknown keys", () => {
    expect(formField(() => parseEngineeringForm({}))).toBe("form.kind");
    expect(formField(() => parseEngineeringForm({ kind: "chore" }))).toBe("form.kind");
    expect(formField(() => parseEngineeringForm({ kind: "bug", affectedUrl: "not a url" }))).toBe("form.affectedUrl");
    expect(formField(() => parseEngineeringForm({ kind: "bug", affectedUrl: "file:///etc/passwd" }))).toBe("form.affectedUrl");
    expect(formField(() => parseEngineeringForm({ kind: "bug", affectedUrl: "https://s.test/" + "p".repeat(500) }))).toBe("form.affectedUrl");
    expect(formField(() => parseEngineeringForm({ kind: "bug", severity: "critical" }))).toBe("form.severity");
    expect(formField(() => parseEngineeringForm(undefined))).toBe("form");
  });
  it("an assets form is not an engineering form and the other way round", () => {
    expect(formField(() => parseEngineeringForm({ deliverables: [deliverable] }))).toBe("form.deliverables");
    expect(formField(() => parseAssetsForm({ kind: "bug" }))).toBe("form.kind");
  });
});

describe("DW-5c §32.5 POST requests: parseCreate", () => {
  it("parses an assets and an engineering request, reading only the documented fields", () => {
    const a = parseCreate(assetsBody({ brief: "Need them Friday", neededBy: "2026-11-02", campaignPartId: PART }));
    expect(a).toEqual({
      kind: "assets", toUnitId: "d-creative", title: "Launch banners", brief: "Need them Friday", neededBy: "2026-11-02",
      campaignPartId: PART, form: { deliverables: [deliverable] },
    });
    const e = parseCreate(engBody());
    expect(e).toEqual({ kind: "engineering", toUnitId: "d-web", title: "Fix the form", brief: "", neededBy: null, campaignPartId: null, form: { kind: "bug" } });
  });

  it("never reads server-derived fields from the body", () => {
    const a = parseCreate(assetsBody({
      requestedBy: "u-other", fromUnitId: "d-x", status: "delivered", tenantId: "t-x", pmTaskId: "p", changeRequestId: "c", closedBy: "u",
    }));
    expect(Object.keys(a).sort()).toEqual(["brief", "campaignPartId", "form", "kind", "neededBy", "title", "toUnitId"]);
  });

  it("kind, toUnitId and title are required", () => {
    expect(refusal(() => parseCreate(null)).reason).toBe("body_invalid");
    expect(refusal(() => parseCreate(assetsBody({ kind: "money" }))).reason).toBe("kind_invalid");
    expect(refusal(() => parseCreate(assetsBody({ kind: undefined }))).reason).toBe("kind_invalid");
    expect(refusal(() => parseCreate(assetsBody({ toUnitId: "" }))).reason).toBe("to_unit_invalid");
    expect(refusal(() => parseCreate(assetsBody({ toUnitId: 7 }))).reason).toBe("to_unit_invalid");
    expect(refusal(() => parseCreate(assetsBody({ title: "   " }))).reason).toBe("title_invalid");
    expect(refusal(() => parseCreate(assetsBody({ title: undefined }))).reason).toBe("title_invalid");
  });

  it("title is 1 to 200 characters; brief at most 10,000", () => {
    expect(parseCreate(assetsBody({ title: "t".repeat(200) })).title).toHaveLength(200);
    expect(refusal(() => parseCreate(assetsBody({ title: "t".repeat(201) }))).reason).toBe("title_invalid");
    expect(parseCreate(assetsBody({ brief: "b".repeat(10_000) })).brief).toHaveLength(10_000);
    expect(refusal(() => parseCreate(assetsBody({ brief: "b".repeat(10_001) }))).reason).toBe("brief_too_long");
    expect(refusal(() => parseCreate(assetsBody({ brief: 5 }))).reason).toBe("brief_invalid");
  });

  it("neededBy is a real YYYY-MM-DD date or null; campaignPartId is uuid-shaped", () => {
    expect(parseCreate(assetsBody({ neededBy: null })).neededBy).toBeNull();
    for (const bad of ["2026-02-30", "11/02/2026", "2026-1-2", 20261102]) {
      expect(refusal(() => parseCreate(assetsBody({ neededBy: bad }))).reason, String(bad)).toBe("date_invalid");
    }
    expect(refusal(() => parseCreate(assetsBody({ campaignPartId: "nope" }))).reason).toBe("campaign_part_invalid");
    expect(parseCreate(assetsBody({ campaignPartId: null })).campaignPartId).toBeNull();
  });

  it("the form is validated per kind, and is required", () => {
    expect(formField(() => parseCreate(assetsBody({ form: undefined })))).toBe("form");
    expect(formField(() => parseCreate(assetsBody({ form: { kind: "bug" } })))).toBe("form.kind");
    expect(formField(() => parseCreate(engBody({ form: { deliverables: [deliverable] } })))).toBe("form.deliverables");
  });

  it("scrubs PAN, national ids and e-mail from the title and brief, and strips NULs (plain text)", () => {
    const p = parseCreate(assetsBody({ title: "Cards 4111111111111111", brief: "mail a@b.co and\u0000 NIK 3174012345678901" }));
    expect(p.title).toContain("[REDACTED-PAN]");
    expect(p.brief).toContain("[REDACTED-EMAIL]");
    expect(p.brief).not.toContain("\u0000");
    expect(plain("ok\u0000text")).toBe("oktext");
  });
});

describe("DW-5c deliver, decline and list parsers", () => {
  const A = "0190a000-0000-7000-8000-0000000000b1";
  const B = "0190a000-0000-7000-8000-0000000000b2";
  it("deliver takes 1 to 20 uuids, de-duplicated, order kept", () => {
    expect(parseDeliver({ assetIds: [A, B, A] }).assetIds).toEqual([A, B]);
    expect(parseDeliver({ assetIds: Array.from({ length: 20 }, (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, "0")}`) }).assetIds).toHaveLength(20);
    for (const bad of [[], "x", ["nope"], [1], Array.from({ length: 21 }, (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, "0")}`), undefined]) {
      const e = refusal(() => parseDeliver({ assetIds: bad }));
      expect([e.httpStatus, e.reason, e.field]).toEqual([400, "asset_invalid", "assetIds"]);
    }
    expect(refusal(() => parseDeliver(null)).reason).toBe("body_invalid");
  });
  it("decline needs a reason of 1 to 2,000 characters", () => {
    expect(parseDecline({ reason: " no capacity this week " }).reason).toBe("no capacity this week");
    expect(parseDecline({ reason: "r".repeat(2000) }).reason).toHaveLength(2000);
    for (const bad of ["", "   ", "r".repeat(2001), 5, undefined]) {
      expect(refusal(() => parseDecline({ reason: bad })).reason, String(bad)).toBe("reason_invalid");
    }
  });
  it("the list query: box is required, incoming/sent need a unit, the default status is open", () => {
    expect(parseListQuery({ box: "incoming", unitId: "d-creative" })).toEqual({ box: "incoming", unitId: "d-creative", status: "open", kind: null });
    expect(parseListQuery({ box: "sent", unitId: "d-seo", status: "closed", kind: "assets" })).toEqual({ box: "sent", unitId: "d-seo", status: "closed", kind: "assets" });
    expect(parseListQuery({ box: "mine", unitId: "ignored", status: "all" })).toEqual({ box: "mine", unitId: null, status: "all", kind: null });
    expect(refusal(() => parseListQuery({})).reason).toBe("box_invalid");
    expect(refusal(() => parseListQuery({ box: "all" })).reason).toBe("box_invalid");
    expect(refusal(() => parseListQuery({ box: "incoming" })).reason).toBe("unit_invalid");
    expect(refusal(() => parseListQuery({ box: "sent", unitId: " " })).reason).toBe("unit_invalid");
    expect(refusal(() => parseListQuery({ box: "mine", status: "pending" })).reason).toBe("status_invalid");
    expect(refusal(() => parseListQuery({ box: "mine", kind: "money" })).reason).toBe("kind_invalid");
  });
  it("dates and URLs", () => {
    expect(parseDateOnly("2026-02-28", "d")).toBe("2026-02-28");
    expect(parseHttpUrl(" https://a.test/x ", "u")).toBe("https://a.test/x");
  });
});

describe("DW-5c §32.5 the lifecycle rules", () => {
  it("deliver: open closes the ask, delivered only takes more assets, everything else is 409 request_not_open", () => {
    expect(planDeliver("open")).toEqual({ closes: true });
    expect(planDeliver("delivered")).toEqual({ closes: false });
    for (const s of ["declined", "cancelled"]) {
      const e = refusal(() => planDeliver(s));
      expect([e.httpStatus, e.reason, e.detail]).toEqual([409, "request_not_open", { status: s }]);
    }
  });
  it("decline and cancel act on an open request only", () => {
    expect(() => requireOpen("open")).not.toThrow();
    for (const s of ["delivered", "declined", "cancelled"]) expect(refusal(() => requireOpen(s)).reason).toBe("request_not_open");
  });
  it("deliver and decline are for asset requests only: 409 wrong_kind_for_action", () => {
    expect(() => requireAssets("assets")).not.toThrow();
    const e = refusal(() => requireAssets("engineering"));
    expect([e.httpStatus, e.reason]).toEqual([409, "wrong_kind_for_action"]);
  });
  it("an engineering cancel is allowed only while the change request is new: 409 already_in_progress", () => {
    expect(() => requireChangeRequestNew("new")).not.toThrow();
    for (const s of ["triaged", "in_progress", "done", "verified", "declined"]) {
      const e = refusal(() => requireChangeRequestNew(s));
      expect([e.httpStatus, e.reason, e.detail]).toEqual([409, "already_in_progress", { changeRequestStatus: s }]);
    }
  });
});

describe("DW-5c §32.6 keeping the ask in step with its change request", () => {
  it("declined declines, verified delivers, everything else is open", () => {
    expect(desiredStatusFromChangeRequest("declined")).toBe("declined");
    expect(desiredStatusFromChangeRequest("verified")).toBe("delivered");
    for (const s of ["new", "triaged", "in_progress", "done"]) expect(desiredStatusFromChangeRequest(s), s).toBe("open");
  });
  it("planSync moves an open ask on triage decline and on verify", () => {
    expect(planSync("open", "declined")).toBe("declined");
    expect(planSync("open", "verified")).toBe("delivered");
  });
  it("planSync reopens a delivered ask when the change request is no longer verified (unverify)", () => {
    expect(planSync("delivered", "in_progress")).toBe("open");
    expect(planSync("delivered", "verified")).toBeNull();
  });
  it("every other change-request status leaves an open ask open, and a settled ask alone", () => {
    for (const s of ["new", "triaged", "in_progress", "done"]) expect(planSync("open", s), s).toBeNull();
    expect(planSync("declined", "declined")).toBeNull();
  });
  it("a cancelled ask never moves (the declined change request is the echo of the cancel)", () => {
    for (const s of ["new", "declined", "verified", "in_progress"]) expect(planSync("cancelled", s), s).toBeNull();
  });
});

describe("DW-5c §32.3 the org walk", () => {
  const node = (id: string, kind: string, children: OrgNode[] = [], name = id): OrgNode => ({ id, name, kind, assigneeId: null, assigneeName: null, children });
  const ROOT = node("root", "company", [
    node("d-seo", "department", [node("dv-tech", "division", [node("dv-deep", "division", [node("r-lead", "role")])])], "SEO"),
    node("d-social", "department", [], "Social"),
    node("dv-orphan", "division", [], "Orphan division"),
  ], "Gaia");
  const index = indexOrgTree(ROOT);

  it("indexes every node with its kind, name and parent", () => {
    expect(index.get("d-seo")).toEqual({ name: "SEO", kind: "department", parentId: "root" });
    expect(index.get("dv-tech")).toEqual({ name: "dv-tech", kind: "division", parentId: "d-seo" });
    expect(index.get("root")).toEqual({ name: "Gaia", kind: "company", parentId: null });
    expect(indexOrgTree(null).size).toBe(0);
  });

  it("a person in a division counts for that division's department (one or several levels up)", () => {
    expect(departmentOf(index, "d-seo")).toBe("d-seo");
    expect(departmentOf(index, "dv-tech")).toBe("d-seo");
    expect(departmentOf(index, "dv-deep")).toBe("d-seo");
    expect(departmentOf(index, "r-lead")).toBe("d-seo");
  });

  it("is null when no department sits above the node, or the node is unknown (an unplaced owner)", () => {
    expect(departmentOf(index, "dv-orphan")).toBeNull();
    expect(departmentOf(index, "root")).toBeNull();
    expect(departmentOf(index, "gone")).toBeNull();
  });

  it("to_unit_invalid: only a department node of this tree is a valid receiver", () => {
    expect(requireToDepartment(index, "d-social").name).toBe("Social");
    for (const id of ["dv-tech", "root", "gone", "r-lead"]) {
      const e = refusal(() => requireToDepartment(index, id));
      expect([e.httpStatus, e.reason], id).toEqual([400, "to_unit_invalid"]);
    }
  });
  it("unit_invalid for a box filter that is not a department", () => {
    expect(requireFilterDepartment(index, "d-seo").name).toBe("SEO");
    expect(refusal(() => requireFilterDepartment(index, "dv-tech")).reason).toBe("unit_invalid");
  });

  it("a unit gone from the tree reads name null with unitMissing true, never a stale name", () => {
    expect(unitView(index, "d-seo")).toEqual({ id: "d-seo", name: "SEO", unitMissing: false });
    expect(unitView(index, "d-removed")).toEqual({ id: "d-removed", name: null, unitMissing: true });
  });
});

describe("DW-5c §32.5 the asset task description", () => {
  const form = parseAssetsForm({
    deliverables: [{ format: "image", size: "1080×1350", quantity: 3 }, { format: "copy", size: "", quantity: 1 }],
    channel: "Instagram", references: ["https://a.test/ref"], notes: "Warm tones",
  });
  it("summarizes the form as plain text", () => {
    expect(summarizeAssetsForm(form)).toBe(
      ["Deliverables:", "- 3 x image (1080×1350)", "- 1 x copy", "Channel: Instagram", "References:", "- https://a.test/ref", "Notes: Warm tones"].join("\n"),
    );
  });
  it("is the brief, the form summary and a Requested by line, with the department when there is one", () => {
    const d = buildTaskDescription({ brief: "Need them Friday", form, requesterName: "Ana", fromUnitName: "SEO" });
    expect(d.startsWith("Need them Friday\n\nDeliverables:")).toBe(true);
    expect(d.endsWith("Requested by Ana (SEO)")).toBe(true);
    const owner = buildTaskDescription({ brief: "", form: { deliverables: [deliverable] }, requesterName: "Owner", fromUnitName: null });
    expect(owner.startsWith("Deliverables:")).toBe(true);
    expect(owner.endsWith("Requested by Owner")).toBe(true);
  });
});

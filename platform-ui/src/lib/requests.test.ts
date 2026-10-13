import { describe, it, expect } from "vitest";
import {
  LIMITS, REQUEST_STATUSES, assetDownloadHref, assigneeIdsOf, checkDeclineReason, checkDeliverIds, detailOf, emptyDeliverable,
  formFieldText, formLinks, formSummary, humanize, isHttpUrl, isRealDate, neededByText, normalizeRequestDetail, normalizeRequestRow,
  normalizeSummary, parseStatusFilter, parseTarget, partOptions, referenceLines, requestActions, requestErrorText,
  requestStatusLabel, routeText, safeHttpHref, unitText, validateRequestDraft, workLink, workText,
  type RequestDraft, type RequestRow, type WorkState,
} from "./requests";

// ── the form validator: every bound of §32.4 (and the title, brief and date rules of §32.1 / §32.5) ──────────────

const assetsDraft = (over: Partial<RequestDraft["assets"]> = {}, top: Partial<RequestDraft> = {}): RequestDraft => ({
  kind: "assets", toUnitId: "d-cre", title: "Launch banners", brief: "", neededBy: "", campaignPartId: "",
  assets: { deliverables: [{ format: "image", size: "1080x1350", quantity: "3" }], channel: "", references: "", notes: "", ...over },
  engineering: { kind: "", affectedUrl: "" },
  ...top,
});
const engDraft = (over: Partial<RequestDraft["engineering"]> = {}, top: Partial<RequestDraft> = {}): RequestDraft => ({
  kind: "engineering", toUnitId: "d-web", title: "Fix the footer", brief: "", neededBy: "", campaignPartId: "",
  assets: { deliverables: [], channel: "", references: "", notes: "" },
  engineering: { kind: "bug", affectedUrl: "", ...over },
  ...top,
});
const errorsOf = (d: RequestDraft) => {
  const c = validateRequestDraft(d);
  return c.ok ? null : c.errors;
};
const items = (n: number) => Array.from({ length: n }, () => ({ format: "image", size: "", quantity: "1" }));

describe("validateRequestDraft: the whole request", () => {
  it("accepts a minimal asset request and builds the exact body the server takes", () => {
    const c = validateRequestDraft(assetsDraft());
    expect(c).toEqual({
      ok: true,
      body: { kind: "assets", toUnitId: "d-cre", title: "Launch banners", form: { deliverables: [{ format: "image", size: "1080x1350", quantity: 3 }] } },
    });
  });

  it("sends the optional fields only when they are filled, trimmed where the server trims", () => {
    const c = validateRequestDraft(assetsDraft(
      { channel: "  Instagram ", references: "https://a.example/x\n\n  http://b.example/y  ", notes: "  keep it warm  " },
      { title: "  Banners  ", brief: "For the launch", neededBy: "2026-11-30", campaignPartId: " part-1 " },
    ));
    expect(c).toEqual({
      ok: true,
      body: {
        kind: "assets", toUnitId: "d-cre", title: "Banners", brief: "For the launch", neededBy: "2026-11-30", campaignPartId: "part-1",
        form: {
          deliverables: [{ format: "image", size: "1080x1350", quantity: 3 }],
          channel: "Instagram",
          references: ["https://a.example/x", "http://b.example/y"],
          notes: "  keep it warm  ",
        },
      },
    });
  });

  it("builds an engineering request from the kind and the optional page", () => {
    expect(validateRequestDraft(engDraft())).toEqual({ ok: true, body: { kind: "engineering", toUnitId: "d-web", title: "Fix the footer", form: { kind: "bug" } } });
    const c = validateRequestDraft(engDraft({ kind: "content", affectedUrl: " https://x.example/about " }));
    expect(c.ok && c.body.form).toEqual({ kind: "content", affectedUrl: "https://x.example/about" });
  });

  it("collects every mistake at once, keyed by the server's field names", () => {
    const e = errorsOf(assetsDraft({ deliverables: [{ format: "", size: "x".repeat(61), quantity: "0" }], channel: "c".repeat(61) }, { title: "", toUnitId: "" }))!;
    expect(Object.keys(e).sort()).toEqual([
      "form.channel", "form.deliverables[0].format", "form.deliverables[0].quantity", "form.deliverables[0].size", "title", "toUnitId",
    ]);
  });
});

describe("validateRequestDraft: title, brief, date", () => {
  it("needs a title of 1 to 200 characters after trimming", () => {
    expect(errorsOf(assetsDraft({}, { title: "   " }))?.title).toBeTruthy();
    expect(errorsOf(assetsDraft({}, { title: "a".repeat(200) }))).toBeNull();
    expect(errorsOf(assetsDraft({}, { title: "a".repeat(201) }))?.title).toMatch(/200/);
    expect(errorsOf(assetsDraft({}, { title: ` ${"a".repeat(200)} ` }))).toBeNull();
  });

  it("allows a brief of at most 10,000 characters", () => {
    expect(errorsOf(assetsDraft({}, { brief: "b".repeat(10_000) }))).toBeNull();
    expect(errorsOf(assetsDraft({}, { brief: "b".repeat(10_001) }))?.brief).toMatch(/10,000/);
  });

  it("takes a needed-by date only as a real calendar date", () => {
    expect(errorsOf(assetsDraft({}, { neededBy: "2026-02-28" }))).toBeNull();
    expect(errorsOf(assetsDraft({}, { neededBy: "2026-02-30" }))?.neededBy).toBeTruthy();
    expect(errorsOf(assetsDraft({}, { neededBy: "30/11/2026" }))?.neededBy).toBeTruthy();
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate("2027-02-29")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
  });
});

describe("validateRequestDraft: the assets form (§32.4)", () => {
  it("needs 1 to 10 deliverables", () => {
    expect(errorsOf(assetsDraft({ deliverables: [] }))?.["form.deliverables"]).toBeTruthy();
    expect(errorsOf(assetsDraft({ deliverables: items(1) }))).toBeNull();
    expect(errorsOf(assetsDraft({ deliverables: items(10) }))).toBeNull();
    expect(errorsOf(assetsDraft({ deliverables: items(11) }))?.["form.deliverables"]).toMatch(/10/);
  });

  it("takes only the five formats", () => {
    for (const f of ["image", "video", "copy", "document", "other"]) {
      expect(errorsOf(assetsDraft({ deliverables: [{ format: f, size: "", quantity: "1" }] })), f).toBeNull();
    }
    expect(errorsOf(assetsDraft({ deliverables: [{ format: "gif", size: "", quantity: "1" }] }))?.["form.deliverables[0].format"]).toBeTruthy();
    expect(errorsOf(assetsDraft({ deliverables: [{ format: "", size: "", quantity: "1" }] }))?.["form.deliverables[0].format"]).toBeTruthy();
  });

  it("allows a size of at most 60 characters (blank is fine)", () => {
    const at = (size: string) => errorsOf(assetsDraft({ deliverables: [{ format: "image", size, quantity: "1" }] }));
    expect(at("")).toBeNull();
    expect(at("s".repeat(60))).toBeNull();
    expect(at("s".repeat(61))?.["form.deliverables[0].size"]).toMatch(/60/);
  });

  it("takes a whole quantity from 1 to 50", () => {
    const at = (quantity: string) => errorsOf(assetsDraft({ deliverables: [{ format: "image", size: "", quantity }] }));
    expect(at("1")).toBeNull();
    expect(at("50")).toBeNull();
    for (const bad of ["0", "51", "-1", "1.5", "", "abc", "1e1"]) expect(at(bad)?.["form.deliverables[0].quantity"], bad).toMatch(/1 to 50/);
  });

  it("names the failing deliverable by its position", () => {
    const e = errorsOf(assetsDraft({ deliverables: [{ format: "image", size: "", quantity: "1" }, { format: "video", size: "", quantity: "99" }] }))!;
    expect(Object.keys(e)).toEqual(["form.deliverables[1].quantity"]);
  });

  it("allows a channel of at most 60 characters", () => {
    expect(errorsOf(assetsDraft({ channel: "c".repeat(60) }))).toBeNull();
    expect(errorsOf(assetsDraft({ channel: "c".repeat(61) }))?.["form.channel"]).toMatch(/60/);
  });

  it("allows 0 to 10 references, each an http(s) link of at most 500 characters", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `https://x.example/${i}`).join("\n");
    expect(errorsOf(assetsDraft({ references: lines(10) }))).toBeNull();
    expect(errorsOf(assetsDraft({ references: lines(11) }))?.["form.references"]).toMatch(/10/);
    expect(errorsOf(assetsDraft({ references: "ftp://x.example/a" }))?.["form.references"]).toMatch(/Reference 1/);
    expect(errorsOf(assetsDraft({ references: "https://ok.example\njavascript:alert(1)" }))?.["form.references"]).toMatch(/Reference 2/);
    expect(errorsOf(assetsDraft({ references: "not a url" }))?.["form.references"]).toBeTruthy();
    expect(errorsOf(assetsDraft({ references: `https://x.example/${"a".repeat(483)}` }))?.["form.references"]).toBeTruthy();
    expect(errorsOf(assetsDraft({ references: `https://x.example/${"a".repeat(482)}` }))).toBeNull();
  });

  it("allows notes of at most 2,000 characters", () => {
    expect(errorsOf(assetsDraft({ notes: "n".repeat(2_000) }))).toBeNull();
    expect(errorsOf(assetsDraft({ notes: "n".repeat(2_001) }))?.["form.notes"]).toMatch(/2,000/);
  });

  it("does not look at the engineering fields of an asset request, nor the reverse", () => {
    expect(errorsOf({ ...assetsDraft(), engineering: { kind: "nonsense", affectedUrl: "nope" } })).toBeNull();
    expect(errorsOf({ ...engDraft(), assets: { deliverables: [], channel: "x".repeat(99), references: "bad", notes: "" } })).toBeNull();
  });
});

describe("validateRequestDraft: the engineering form (§32.4)", () => {
  it("needs one of the four kinds", () => {
    for (const k of ["content", "design", "feature", "bug"]) expect(errorsOf(engDraft({ kind: k })), k).toBeNull();
    expect(errorsOf(engDraft({ kind: "" }))?.["form.kind"]).toBeTruthy();
    expect(errorsOf(engDraft({ kind: "chore" }))?.["form.kind"]).toBeTruthy();
  });

  it("takes the affected page only as an http(s) link of at most 500 characters", () => {
    expect(errorsOf(engDraft({ affectedUrl: "" }))).toBeNull();
    expect(errorsOf(engDraft({ affectedUrl: "https://x.example/p" }))).toBeNull();
    expect(errorsOf(engDraft({ affectedUrl: "/relative" }))?.["form.affectedUrl"]).toBeTruthy();
    expect(errorsOf(engDraft({ affectedUrl: "mailto:a@b.example" }))?.["form.affectedUrl"]).toBeTruthy();
    expect(errorsOf(engDraft({ affectedUrl: `https://x.example/${"a".repeat(500)}` }))?.["form.affectedUrl"]).toBeTruthy();
  });
});

describe("the small checks", () => {
  it("accepts a decline reason of 1 to 2,000 characters after trimming", () => {
    expect(checkDeclineReason("  ")).toMatch(/why/);
    expect(checkDeclineReason("No capacity")).toBeNull();
    expect(checkDeclineReason("r".repeat(2_000))).toBeNull();
    expect(checkDeclineReason("r".repeat(2_001))).toMatch(/2,000/);
  });

  it("accepts 1 to 20 distinct asset ids", () => {
    expect(checkDeliverIds([])).toBeTruthy();
    expect(checkDeliverIds(["a"])).toBeNull();
    expect(checkDeliverIds(Array.from({ length: 20 }, (_, i) => `a${i}`))).toBeNull();
    expect(checkDeliverIds(Array.from({ length: 21 }, (_, i) => `a${i}`))).toMatch(/20/);
    // The server de-duplicates, so duplicates are not extra assets.
    expect(checkDeliverIds(Array.from({ length: 30 }, () => "same"))).toBeNull();
  });

  it("splits references one per line and ignores blanks", () => {
    expect(referenceLines("a\r\n\r\n b \n")).toEqual(["a", "b"]);
  });

  it("knows an http(s) link from anything else", () => {
    expect(isHttpUrl("https://x.example")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(safeHttpHref("data:text/html,x")).toBeNull();
    expect(safeHttpHref(42)).toBeNull();
    expect(emptyDeliverable()).toEqual({ format: "", size: "", quantity: "1" });
    expect(LIMITS.deliverables).toBe(10);
  });
});

// ── every typed refusal, in words ───────────────────────────────────────────────────────────────

describe("requestErrorText", () => {
  const text = (reason: string, extra: Partial<Parameters<typeof requestErrorText>[0]> = {}) =>
    requestErrorText({ status: 400, reason, message: "raw message", ...extra });

  it("has a sentence for every code of §32.5 and §32.10, none of them the raw message", () => {
    const codes = [
      "body_invalid", "kind_invalid", "to_unit_invalid", "unit_invalid", "title_invalid", "brief_invalid", "brief_too_long",
      "date_invalid", "campaign_part_invalid", "form_invalid", "asset_invalid", "reason_invalid", "box_invalid", "status_invalid",
      "request_not_found", "request_kind_unavailable", "wrong_kind_for_action", "request_not_open", "already_in_progress",
      "intake_project_unavailable",
    ];
    for (const c of codes) {
      const t = text(c);
      expect(t, c).not.toBe("raw message");
      expect(t.length, c).toBeGreaterThan(20);
      expect(t, c).toMatch(/[.]$/);
    }
  });

  it("explains a refused form field by its position", () => {
    expect(text("form_invalid", { field: "form.deliverables[2].quantity" })).toBe("Deliverable 3: a quantity is a whole number from 1 to 50.");
    expect(text("form_invalid", { field: "form.deliverables[0].size" })).toMatch(/Deliverable 1: a size is at most 60/);
    expect(text("form_invalid", { field: "form.deliverables[0].format" })).toMatch(/choose a format/);
    expect(text("form_invalid", { field: "form.references[3]" })).toMatch(/http or https/);
    expect(text("form_invalid", { field: "form.kind" })).toMatch(/kind of change/);
    expect(text("form_invalid", { field: "form.affectedUrl" })).toMatch(/affected page/);
    expect(text("form_invalid", { field: "form.surprise" })).toMatch(/not valid/);
    expect(formFieldText(undefined)).toBeNull();
  });

  it("says how many chosen assets are gone", () => {
    expect(text("asset_invalid", { detail: { invalid: ["a", "b"] } })).toMatch(/^2 of the chosen assets are no longer/);
    expect(text("asset_invalid", { detail: { invalid: ["a"] } })).toMatch(/^1 of the chosen assets is no longer/);
    expect(text("asset_invalid")).toMatch(/1 to 20 assets/);
  });

  it("names the status a request is in when it is not open", () => {
    expect(text("request_not_open", { status: 409, detail: { status: "delivered" } })).toMatch(/This request is delivered/);
    expect(text("request_not_open", { status: 409 })).toMatch(/no longer open/);
  });

  it("falls back by status, then to the server's words", () => {
    expect(requestErrorText({ status: 403, message: "forbidden" })).toBe("You do not have permission to do that.");
    expect(requestErrorText({ status: 404, message: "nope" })).toMatch(/no longer exists/);
    expect(requestErrorText({ status: 500, message: "database down" })).toBe("database down");
    expect(requestErrorText({ status: null, message: "" })).toBe("That did not work. Try again.");
  });

  it("reads figures from a platform error body", () => {
    expect(detailOf({ error: "x", detail: { status: "open" } })).toEqual({ status: "open" });
    expect(detailOf({ detail: [1] })).toBeUndefined();
    expect(detailOf(null)).toBeUndefined();
  });
});

// ── what the wire sends ─────────────────────────────────────────────────────────────────────────

const wireRow = (over: Record<string, unknown> = {}) => ({
  id: "r1", kind: "assets", title: "Banners", status: "open", neededBy: "2026-11-30", createdAt: "2026-10-14T01:00:00Z", closedAt: null,
  fromUnit: { id: "d-seo", name: "SEO", unitMissing: false }, toUnit: { id: "d-cre", name: "Creatives", unitMissing: false },
  requestedBy: { id: "u1", name: "Ayu" }, campaign: { id: "c1", name: "Launch", partId: "p1" },
  work: { type: "pm_task", id: "t1", projectId: "pr1", status: "in_progress", isDone: false, responsibleName: "Budi" }, assetCount: 0, ...over,
});

describe("normalising requests", () => {
  it("reads a row", () => {
    const r = normalizeRequestRow(wireRow())!;
    expect(r.title).toBe("Banners");
    expect(r.toUnit).toEqual({ id: "d-cre", name: "Creatives", unitMissing: false });
    expect(r.campaign).toEqual({ id: "c1", name: "Launch", partId: "p1" });
    expect(r.work).toEqual({ state: "live", work: { type: "pm_task", id: "t1", projectId: "pr1", status: "in_progress", isDone: false, responsibleName: "Budi" } });
  });

  it("drops what is not a request instead of guessing", () => {
    expect(normalizeRequestRow(null)).toBeNull();
    expect(normalizeRequestRow({ id: "x" })).toBeNull();
    expect(normalizeRequestRow(wireRow({ kind: "other" }))).toBeNull();
    expect(normalizeRequestRow(wireRow({ id: 5 }))).toBeNull();
  });

  it("reads `work: null` as a removed work item, and anything unreadable as unknown, never as removed", () => {
    expect(normalizeRequestRow(wireRow({ work: null }))!.work).toEqual({ state: "removed" });
    expect(normalizeRequestRow(wireRow({ work: undefined }))!.work).toEqual({ state: "unknown" });
    expect(normalizeRequestRow(wireRow({ work: { type: "mystery", id: "z" } }))!.work).toEqual({ state: "unknown" });
    expect(normalizeRequestRow(wireRow({ work: { type: "pm_task" } }))!.work).toEqual({ state: "unknown" });
  });

  it("reads a change request's work item", () => {
    const r = normalizeRequestRow(wireRow({ kind: "engineering", work: { type: "change_request", id: "cr1", status: "new", route: null } }))!;
    expect(r.work).toEqual({ state: "live", work: { type: "change_request", id: "cr1", status: "new", route: null } });
  });

  it("treats a unit that left the tree as missing, with no name", () => {
    const r = normalizeRequestRow(wireRow({ fromUnit: { id: "d-old", name: null, unitMissing: true }, toUnit: { id: "d-x", name: null, unitMissing: true } }))!;
    expect(r.fromUnit).toEqual({ id: "d-old", name: null, unitMissing: true });
    expect(unitText(r.fromUnit)).toBe("A department that is no longer in the org chart");
    expect(unitText(null)).toBe("No department");
    expect(routeText({ fromUnit: null, toUnit: { id: "a", name: "Creatives", unitMissing: false } })).toBe("No department to Creatives");
  });

  it("reads the detail's brief, form, decline reason and assets", () => {
    const d = normalizeRequestDetail({
      ...wireRow({ status: "declined" }), brief: "Need <b>banners</b>", form: { deliverables: [] }, declineReason: "No capacity",
      assets: [{ id: "a1", name: "banner.png", contentType: "image/png", href: "/api/t/creative/assets/a1/content" }, { name: "no id" }],
    })!;
    expect(d.brief).toBe("Need <b>banners</b>");
    expect(d.declineReason).toBe("No capacity");
    expect(d.assets).toEqual([{ id: "a1", name: "banner.png", contentType: "image/png", href: "/api/t/creative/assets/a1/content" }]);
    expect(normalizeRequestDetail("nope")).toBeNull();
    expect(assetDownloadHref("a 1")).toBe("/api/creative-assets/a%201");
  });

  it("reads the summary only when it carries both numbers", () => {
    expect(normalizeSummary({ incoming: { open: 3, oldestOpenAt: "2026-10-01T00:00:00Z" }, sent: { open: 1 } })).toEqual({
      incoming: { open: 3, oldestOpenAt: "2026-10-01T00:00:00Z" }, sent: { open: 1 },
    });
    expect(normalizeSummary({ incoming: { open: 3 } })).toBeNull();
    expect(normalizeSummary([])).toBeNull();
  });
});

describe("words", () => {
  const live = (work: object): WorkState => ({ state: "live", work: work as never });
  it("says the work was removed, and that an unreadable item cannot be read", () => {
    expect(workText({ state: "removed" })).toBe("The work item was removed");
    expect(workText({ state: "unknown" })).toBe("The work item cannot be read");
  });

  it("says a task's status and who is responsible", () => {
    expect(workText(live({ type: "pm_task", id: "t", projectId: null, status: "in_progress", isDone: false, responsibleName: "Budi" }))).toBe("In progress. Responsible: Budi");
    expect(workText(live({ type: "pm_task", id: "t", projectId: null, status: "todo", isDone: false, responsibleName: null }))).toBe("Todo. Nobody is responsible yet");
    expect(workText(live({ type: "pm_task", id: "t", projectId: null, status: "review", isDone: true, responsibleName: "Budi" }))).toBe("Done. Responsible: Budi");
  });

  it("says a change request's status and route", () => {
    expect(workText(live({ type: "change_request", id: "c", status: "in_progress", route: "pm_task" }))).toBe("Change request in progress (Pm task)");
    expect(workText(live({ type: "change_request", id: "c", status: "new", route: null }))).toBe("Change request new");
  });

  it("links a task, links a change request to the receiver's Requests, and links nothing for a removed item", () => {
    const to = { id: "d-web", name: "Web Dev", unitMissing: false };
    expect(workLink({ toUnit: to }, live({ type: "pm_task", id: "t 1", projectId: null, status: "", isDone: false, responsibleName: null }))).toEqual({ href: "/tasks/t%201", label: "Open the task" });
    expect(workLink({ toUnit: to }, live({ type: "change_request", id: "c", status: "new", route: null }))?.href).toBe("/departments/d-web/requests");
    expect(workLink({ toUnit: { id: "d-web", name: null, unitMissing: true } }, live({ type: "change_request", id: "c", status: "new", route: null }))).toBeNull();
    expect(workLink({ toUnit: to }, { state: "removed" })).toBeNull();
  });

  it("labels every status and humanises an unknown one", () => {
    for (const s of REQUEST_STATUSES) expect(requestStatusLabel(s)).toMatch(/^[A-Z][a-z]+$/);
    expect(requestStatusLabel("on_hold")).toBe("On hold");
    expect(humanize("")).toBe("");
    expect(neededByText(null)).toBe("No date");
  });

  it("shows the form as plain lines and only draws http(s) references as links", () => {
    const form = {
      deliverables: [{ format: "image", size: "1080x1350", quantity: 3 }, { format: "copy", size: "", quantity: 1 }],
      channel: "Instagram", notes: "<script>x</script>", references: ["https://a.example", "javascript:alert(1)"],
    };
    expect(formSummary("assets", form)).toEqual([
      { label: "Deliverable 1", value: "3 x Image, 1080x1350" },
      { label: "Deliverable 2", value: "1 x Copy" },
      { label: "Channel", value: "Instagram" },
      { label: "Notes", value: "<script>x</script>" },
    ]);
    expect(formLinks(form)).toEqual([
      { label: "Reference 1", href: "https://a.example", text: "https://a.example" },
      { label: "Reference 2", href: null, text: "javascript:alert(1)" },
    ]);
    expect(formSummary("engineering", { kind: "bug" })).toEqual([{ label: "Kind", value: "Bug" }]);
    expect(formLinks({ affectedUrl: "https://x.example/p" })).toEqual([{ label: "Affected page", href: "https://x.example/p", text: "https://x.example/p" }]);
    expect(formSummary("assets", { deliverables: "nope" })).toEqual([]);
  });

  it("reads the target and the status filter, anything else being the default", () => {
    expect(parseTarget("creatives")).toBe("creatives");
    expect(parseTarget(["web-dev", "creatives"])).toBe("web-dev");
    expect(parseTarget("seo")).toBeNull();
    expect(parseTarget(undefined)).toBeNull();
    expect(parseStatusFilter("closed")).toBe("closed");
    expect(parseStatusFilter("all")).toBe("all");
    expect(parseStatusFilter("OPEN")).toBe("open");
    expect(parseStatusFilter(undefined)).toBe("open");
    expect(parseStatusFilter(["all", "closed"])).toBe("all");
  });
});

// ── who is offered what ─────────────────────────────────────────────────────────────────────────

describe("requestActions", () => {
  const crWork = (status: string): WorkState => ({ state: "live", work: { type: "change_request", id: "c", status, route: null } });
  const taskWork: WorkState = { state: "live", work: { type: "pm_task", id: "t", projectId: null, status: "todo", isDone: false, responsibleName: null } };
  const req = (over: Partial<Pick<RequestRow, "kind" | "status" | "work">> = {}): Pick<RequestRow, "kind" | "status" | "work"> =>
    ({ kind: "assets", status: "open", work: taskWork, ...over });
  const nobody = { isRequester: false, canDecide: false, isAssignee: false };
  const off = { cancel: false, deliver: false, deliverMore: false, decline: false };

  it("offers a stranger nothing", () => {
    expect(requestActions(req(), nobody)).toEqual(off);
  });

  it("offers the requester Cancel while open, and nothing once the request is closed", () => {
    const who = { ...nobody, isRequester: true };
    expect(requestActions(req(), who)).toEqual({ ...off, cancel: true });
    for (const status of ["delivered", "declined", "cancelled"]) expect(requestActions(req({ status }), who).cancel, status).toBe(false);
  });

  it("offers the requester of an engineering request Cancel only while its change request is new", () => {
    const who = { ...nobody, isRequester: true };
    expect(requestActions(req({ kind: "engineering", work: crWork("new") }), who).cancel).toBe(true);
    for (const s of ["triaged", "in_progress", "verified", "declined"]) expect(requestActions(req({ kind: "engineering", work: crWork(s) }), who).cancel, s).toBe(false);
    // If the change request cannot be seen, it is not assumed to be new.
    expect(requestActions(req({ kind: "engineering", work: { state: "removed" } }), who).cancel).toBe(false);
    expect(requestActions(req({ kind: "engineering", work: { state: "unknown" } }), who).cancel).toBe(false);
  });

  it("offers Deliver to an assignee, to a manager or head, and to nobody else", () => {
    expect(requestActions(req(), { ...nobody, isAssignee: true })).toEqual({ ...off, deliver: true });
    expect(requestActions(req(), { ...nobody, canDecide: true })).toEqual({ ...off, deliver: true, decline: true });
    // An unreadable task leaves "assignee" unknown, which is not assumed.
    expect(requestActions(req(), { ...nobody, isAssignee: null }).deliver).toBe(false);
  });

  it("offers Deliver more, not Deliver, on a delivered request, and no Decline", () => {
    const a = requestActions(req({ status: "delivered" }), { ...nobody, canDecide: true });
    expect(a).toEqual({ ...off, deliverMore: true });
    expect(requestActions(req({ status: "delivered" }), { ...nobody, isAssignee: true })).toEqual({ ...off, deliverMore: true });
    expect(requestActions(req({ status: "delivered" }), nobody)).toEqual(off);
  });

  it("offers neither Deliver nor Decline on a declined or cancelled request", () => {
    for (const status of ["declined", "cancelled"]) {
      expect(requestActions(req({ status }), { isRequester: false, canDecide: true, isAssignee: true }), status).toEqual(off);
    }
  });

  it("never offers Deliver or Decline on an engineering request: Web Dev triage handles it", () => {
    const e = req({ kind: "engineering", work: crWork("new") });
    expect(requestActions(e, { isRequester: false, canDecide: true, isAssignee: true })).toEqual(off);
  });

  it("lets a manager who also asked cancel their own request", () => {
    expect(requestActions(req(), { isRequester: true, canDecide: true, isAssignee: false })).toEqual({ cancel: true, deliver: true, deliverMore: false, decline: true });
  });
});

describe("assigneeIdsOf", () => {
  it("collects the responsible person, a person assignee and the contributors, once each", () => {
    expect(assigneeIdsOf({ assignee: { kind: "person", refId: "u1", responsibleId: "u2" }, contributors: [{ userId: "u3" }, { userId: "u1" }] }).sort()).toEqual(["u1", "u2", "u3"]);
  });
  it("does not count a department as a person, and copes with a task nobody holds", () => {
    expect(assigneeIdsOf({ assignee: { kind: "department", refId: "d-cre", responsibleId: null } })).toEqual([]);
    expect(assigneeIdsOf({ assignee: null })).toEqual([]);
    expect(assigneeIdsOf({})).toEqual([]);
  });
});

describe("partOptions", () => {
  it("offers the campaigns where the department has a live part, never a cancelled one or a campaign it only leads", () => {
    expect(partOptions([
      { id: "c1", name: "Launch", part: { id: "p1", status: "active" } },
      { id: "c2", name: "Old", part: { id: "p2", status: "cancelled" } },
      { id: "c3", name: "Led only", part: null },
    ])).toEqual([{ partId: "p1", label: "Launch" }]);
  });
});

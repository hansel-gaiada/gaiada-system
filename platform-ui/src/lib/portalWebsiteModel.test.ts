import { describe, expect, it } from "vitest";
import service from "../../e2e/webdesk-stub/compositions/service.json";
import type { CollectionComposition } from "./webdeskContentModel";
import type { ClientEditable } from "./webdeskEditorDriver";
import {
  canOfferPublishNow, collectionEditability, createBlockedCopy, hasUnpublishedChanges, itemListState, itemTitle, portalWebsiteHref, PORTAL_COPY,
  PUBLISHED_COPY, requesterLabel, requestState, showApprove, showWithdraw, splitRequests, type PortalPublishRequest,
} from "./portalWebsiteModel";

const ce = (over: Partial<ClientEditable> = {}): ClientEditable => ({ fields: { h1: true, url: false }, blocks: false, seo: false, create: { allowed: true, reason: null, blockedBy: [] }, ...over });
const defs = (service as unknown as CollectionComposition).fields;

describe("create is offered only where clientEditable.create.allowed, and otherwise says why", () => {
  it("allowed: nothing to say", () => {
    expect(createBlockedCopy(ce(), defs)).toBeNull();
  });
  it("required fields only Gaiada can fill: the owner's sentence, naming the fields by their labels (blockedBy)", () => {
    const copy = createBlockedCopy(ce({ create: { allowed: false, reason: "required-fields-not-editable", blockedBy: ["template", "url"] } }), defs);
    expect(copy).toBe("This collection has required fields only Gaiada can fill: Template, Url.");
    expect(copy!.startsWith("This collection has required fields only Gaiada can fill")).toBe(true);
  });
  it("an unknown blocker name falls back to the raw name; no names still reads as a sentence", () => {
    expect(createBlockedCopy(ce({ create: { allowed: false, reason: "required-fields-not-editable", blockedBy: ["ghost"] } }), defs)).toContain("ghost");
    expect(createBlockedCopy(ce({ create: { allowed: false, reason: "required-fields-not-editable", blockedBy: [] } }), defs)).toBe("This collection has required fields only Gaiada can fill.");
  });
  it("a system collection, and one where nothing is editable", () => {
    expect(createBlockedCopy(ce({ create: { allowed: false, reason: "system-collection", blockedBy: [] } }), defs)).toMatch(/managed by Gaiada/);
    expect(createBlockedCopy(ce({ create: { allowed: false, reason: "nothing-editable", blockedBy: [] } }), defs)).toBe(PORTAL_COPY.nothingEditable);
    expect(createBlockedCopy(ce({ create: { allowed: false, reason: null, blockedBy: [] } }), defs)).toMatch(/can't add pages/);
  });
});

describe("collectionEditability: per collection, whether anything in it is the client's", () => {
  it("some fields / all fields / nothing", () => {
    expect(collectionEditability(ce())).toEqual({ any: true, label: "You can edit some fields" });
    expect(collectionEditability(ce({ fields: { a: true, b: true } }))).toEqual({ any: true, label: "You can edit this" });
    expect(collectionEditability(ce({ fields: { a: false }, blocks: false }))).toEqual({ any: false, label: "Managed by Gaiada" });
    expect(collectionEditability(ce({ fields: {}, blocks: true })).any).toBe(true);
  });
});

describe("an item's state in a list", () => {
  const base = { deletedAt: null, headVersion: 3, publishedVersion: 3, publishState: "published" };
  it("live · live with changes not published · draft · not live · scheduled", () => {
    expect(itemListState(base, null, "i").key).toBe("live");
    expect(itemListState({ ...base, headVersion: 4 }, null, "i")).toMatchObject({ key: "draft-changes", label: "Live, with changes not published" });
    expect(itemListState({ ...base, publishedVersion: null, publishState: "draft" }, null, "i")).toMatchObject({ key: "never-published", label: "Draft, not live yet" });
    expect(itemListState({ ...base, publishState: "unpublished" }, null, "i").key).toBe("offline");
    expect(itemListState({ ...base, publishState: "scheduled" }, null, "i")).toMatchObject({ key: "scheduled", label: "Scheduled by Gaiada" });
  });
  it("a pending request is a second, independent fact", () => {
    expect(itemListState(base, new Set(["i"]), "i").pendingRequest).toBe(true);
    expect(itemListState(base, new Set(["other"]), "i").pendingRequest).toBe(false);
    expect(itemListState(base, null, "i").pendingRequest).toBe(false);
  });
  it("nothing to publish on a live item at its head; something on a draft", () => {
    expect(hasUnpublishedChanges(base)).toBe(false);
    expect(hasUnpublishedChanges({ ...base, headVersion: 4 })).toBe(true);
    expect(hasUnpublishedChanges({ ...base, publishedVersion: null })).toBe(true);
  });
});

describe("Publish now is for a change the VIEWER made (WSK-D58)", () => {
  const it0 = { deletedAt: null, headVersion: 4, publishedVersion: 3, headCreatedBy: "me" };
  it("offered for the viewer's own head with changes", () => { expect(canOfferPublishNow(it0, "me")).toBe(true); });
  it("not for a colleague's, an unknown author, or nothing new", () => {
    expect(canOfferPublishNow({ ...it0, headCreatedBy: "other" }, "me")).toBe(false);
    expect(canOfferPublishNow({ ...it0, headCreatedBy: null }, "me")).toBe(false);
    expect(canOfferPublishNow({ ...it0, headVersion: 3 }, "me")).toBe(false);
  });
});

const req = (over: Partial<PortalPublishRequest> = {}): PortalPublishRequest => ({
  approvalId: "a1", status: "pending", createdAt: "2026-10-11T08:00:00Z", tenantSlug: "gaiada", siteId: "s1", itemCount: 2, itemIds: ["i1", "i2"],
  requestedBy: { userId: "u2", name: "Dewi" }, requestedByMe: false, canApprove: true, executionStatus: null, ...over,
});

describe("requests: Approve and Withdraw", () => {
  it("Approve is shown on a colleague's pending request", () => { expect(showApprove(req())).toBe(true); });
  it("Approve is HIDDEN on the viewer's own request, even when the server's hint would allow it (a single-item request)", () => {
    expect(showApprove(req({ requestedByMe: true, canApprove: false }))).toBe(false);
    expect(showApprove(req({ requestedByMe: true, canApprove: true, itemCount: 1 }))).toBe(false);
  });
  it("Approve follows the server's hint, and only for a pending request", () => {
    expect(showApprove(req({ canApprove: false }))).toBe(false);
    expect(showApprove(req({ status: "approved" }))).toBe(false);
    expect(showApprove(req({ status: "rejected" }))).toBe(false);
  });
  it("Withdraw is shown on the viewer's OWN pending request only", () => {
    expect(showWithdraw(req({ requestedByMe: true }))).toBe(true);
    expect(showWithdraw(req())).toBe(false);
    expect(showWithdraw(req({ requestedByMe: true, status: "cancelled" }))).toBe(false);
    expect(showWithdraw(req({ requestedByMe: true, status: "approved" }))).toBe(false);
  });
});

describe("request states, in words", () => {
  it("an executed request reads 'Approved and sent', never 'Published' (the list cannot say it was confirmed live)", () => {
    expect(requestState({ status: "approved", executionStatus: "executed" }).label).toBe("Approved and sent");
    expect(requestState({ status: "approved", executionStatus: null }).label).toBe("Approved, publishing");
    expect(requestState({ status: "approved", executionStatus: "pending" }).label).toBe("Approved, publishing");
    expect(requestState({ status: "approved", executionStatus: "failed" })).toEqual({ label: "Approved, but publishing failed", tone: "bad" });
  });
  it("pending / rejected / withdrawn", () => {
    expect(requestState({ status: "pending", executionStatus: null }).label).toBe("Waiting for approval");
    expect(requestState({ status: "rejected", executionStatus: null }).label).toBe("Not approved");
    expect(requestState({ status: "cancelled", executionStatus: null }).label).toBe("Withdrawn");
  });
  it("who filed it: 'You', a name, or a plain fallback, never an id", () => {
    expect(requesterLabel(req({ requestedByMe: true }))).toBe("You");
    expect(requesterLabel(req())).toBe("Dewi");
    expect(requesterLabel(req({ requestedBy: { userId: "u9", name: null } }))).toBe("A colleague from your company");
    expect(requesterLabel(req({ requestedBy: { userId: "u9", name: "  " } }))).not.toMatch(/u9/);
  });
  it("splits waiting from decided, newest first, and caps the decided ones", () => {
    const rows = [
      req({ approvalId: "old", createdAt: "2026-10-01T00:00:00Z" }), req({ approvalId: "new", createdAt: "2026-10-09T00:00:00Z" }),
      ...Array.from({ length: 10 }, (_, n) => req({ approvalId: `d${n}`, status: "approved", createdAt: `2026-10-0${(n % 9) + 1}T00:00:00Z` })),
    ];
    const { pending, decided } = splitRequests(rows);
    expect(pending.map((r) => r.approvalId)).toEqual(["new", "old"]);
    expect(decided).toHaveLength(8);
  });
});

describe("words and links", () => {
  it("the publish confirmation is the owner's, exactly", () => { expect(PUBLISHED_COPY).toBe("Published. Your site updates in a few minutes."); });
  it("a request is filed with a plain promise of what happens next", () => {
    expect(PORTAL_COPY.requestFiled(2)).toBe("Request filed for 2 pages. Another person from your company needs to approve it before anything goes live.");
    expect(PORTAL_COPY.requestFiled(1)).toContain("1 page.");
  });
  it("links encode every segment once", () => {
    expect(portalWebsiteHref()).toBe("/portal/website");
    expect(portalWebsiteHref("gaiada", "site 1", "~media")).toBe("/portal/website/gaiada/site%201/~media".replace("~", encodeURIComponent("~")));
    expect(portalWebsiteHref("a/b")).toBe("/portal/website/a%2Fb");
  });
  it("an item's title: the title field, else the seo title, else the slug", () => {
    expect(itemTitle({ h1: "  Home  " }, {}, "h1", "s")).toBe("Home");
    expect(itemTitle({}, { title: "SEO T" }, "h1", "s")).toBe("SEO T");
    expect(itemTitle({ h1: "" }, {}, "h1", "the-slug")).toBe("the-slug");
  });
});

import { describe, it, expect } from "vitest";
import type { ItemEditorial, WdResult } from "./webdeskContentModel";
import {
  anchorLabel, doneWords, editorialActionsFor, editorialRefusalCopy, eventWords, grantRefusalCopy, groupBoard, lastEvent, leadingToken,
  reviewStateInfo, REVIEW_STATES, roleLabel, scopeWords, stripToken, validAnchor, type BoardItem, type EditorialCommand,
} from "./webdeskEditorialModel";

const ed = (over: Partial<ItemEditorial> = {}): ItemEditorial => ({ reviewRequired: true, state: "draft", approvedVersion: null, submittedVersion: null, ...over });
type Refusal = Exclude<WdResult<unknown>, { kind: "ok" }>;
const conflict = (slug: string, message = "server words"): Refusal => ({ kind: "conflict", slug, message, currentHeadVersion: null, currentContentHash: null, updatedAt: null });

describe("review state vocabulary", () => {
  it("every state has its own label, sentence and glyph (words and shape, not colour alone)", () => {
    const infos = REVIEW_STATES.map(reviewStateInfo);
    expect(new Set(infos.map((i) => i.label)).size).toBe(4);
    expect(new Set(infos.map((i) => i.sentence)).size).toBe(4);
    expect(new Set(infos.map((i) => i.glyph)).size).toBe(4);
    expect(infos.map((i) => i.label)).toEqual(["Draft", "In review", "Changes requested", "Approved"]);
    expect(infos.every((i) => i.known)).toBe(true);
  });

  it("an unknown state is shown as its own words on a neutral chip, never mapped onto one of the four", () => {
    const i = reviewStateInfo("on_hold");
    expect(i).toMatchObject({ label: "on hold", tone: "neutral", known: false });
    expect(REVIEW_STATES.map((s) => reviewStateInfo(s).label)).not.toContain(i.label);
  });
});

describe("editorialActionsFor: the item's `allowed` decides, the state only narrows", () => {
  const ALL = { submit: true, request_changes: true, seo_signoff: true, approve: true, assign: true, comment: true };
  const NONE = { submit: false, request_changes: false, seo_signoff: false, approve: false, assign: false, comment: false };
  const offered = (s: ReturnType<typeof editorialActionsFor>) => Object.entries(s).filter(([k, v]) => v === true && k !== "why").map(([k]) => k).sort();

  it("absent `allowed` offers NOTHING and says why (never read as denied, never as allowed)", () => {
    const s = editorialActionsFor(ed({ state: "in_review", submittedVersion: 2 }), undefined);
    expect(offered(s)).toEqual([]);
    expect(s.why).toMatch(/permission check .* did not answer/);
  });

  it("absent `editorial` offers nothing and says WebDesk did not report the review state", () => {
    const s = editorialActionsFor(undefined, ALL);
    expect(offered(s)).toEqual([]);
    expect(s.why).toMatch(/did not report/);
  });

  it("review off: nothing is offered even with every key allowed", () => {
    const s = editorialActionsFor(ed({ reviewRequired: false }), ALL);
    expect(offered(s)).toEqual([]);
    expect(s.why).toMatch(/not turned on/);
  });

  it.each([
    ["draft", ["assign", "comment", "submit"]],
    ["changes_requested", ["assign", "comment", "submit"]],
    ["in_review", ["approve", "assign", "comment", "requestChanges", "seoSignoff", "withdraw"]],
    ["approved", ["assign", "comment"]],
  ])("with everything allowed, state %s offers exactly %j", (state, want) => {
    expect(offered(editorialActionsFor(ed({ state }), ALL))).toEqual(want);
  });

  it("a key that is false is never offered, whatever the state", () => {
    for (const state of REVIEW_STATES) expect(offered(editorialActionsFor(ed({ state }), NONE))).toEqual([]);
    expect(editorialActionsFor(ed({ state: "in_review" }), NONE).why).toMatch(/no review action available/);
  });

  it("each key gates only its own action", () => {
    const inReview = ed({ state: "in_review", submittedVersion: 4 });
    expect(offered(editorialActionsFor(inReview, { ...NONE, approve: true }))).toEqual(["approve"]);
    expect(offered(editorialActionsFor(inReview, { ...NONE, request_changes: true }))).toEqual(["requestChanges"]);
    expect(offered(editorialActionsFor(inReview, { ...NONE, seo_signoff: true }))).toEqual(["seoSignoff"]);
    expect(offered(editorialActionsFor(inReview, { ...NONE, submit: true }))).toEqual(["withdraw"]);
    expect(offered(editorialActionsFor(ed(), { ...NONE, submit: true }))).toEqual(["submit"]);
    expect(offered(editorialActionsFor(ed(), { ...NONE, assign: true }))).toEqual(["assign"]);
    expect(offered(editorialActionsFor(ed(), { ...NONE, comment: true }))).toEqual(["comment"]);
  });

  it("an `allowed` key the UI does not know changes nothing (additive keys are ignored)", () => {
    expect(offered(editorialActionsFor(ed(), { ...NONE, brand_new_action: true }))).toEqual([]);
  });

  it("a current SEO sign-off hides the sign-off button; a required, missing one blocks approve with the reason", () => {
    const needs = editorialActionsFor(ed({ state: "in_review", submittedVersion: 4, seoSignoffRequired: true, seoSignedCurrent: false }), ALL);
    expect(needs.seoSignoff).toBe(true);
    expect(needs.approve).toBe(true);
    expect(needs.approveBlockedWhy).toMatch(/sign-off of v4 before it can be approved/);
    const done = editorialActionsFor(ed({ state: "in_review", submittedVersion: 4, seoSignoffRequired: true, seoSignedCurrent: true }), ALL);
    expect(done.seoSignoff).toBe(false);
    expect(done.approveBlockedWhy).toBeNull();
  });
});

describe("editorialRefusalCopy: every typed refusal in plain words", () => {
  const commands: EditorialCommand[] = ["submit", "withdraw", "requestChanges", "seoSignoff", "approve", "assign", "comment", "resolve"];

  it.each([
    ["review-not-enabled", /not turned on for this collection/],
    ["review-state-conflict", /current review state/],
    ["review-version-mismatch", /no longer the one in review/],
    ["seo-signoff-required", /SEO and AEO sign-off/],
    ["review-not-approved", /has not been approved/],
    ["review-principal-not-allowed", /human decisions/],
    ["review-self-approval", /different person/],
    ["item-deleted", /deleted/],
  ])("409/403 slug %s is words, with no slug and no status code in them", (slug, re) => {
    const text = editorialRefusalCopy("approve", conflict(slug));
    expect(text).toMatch(re);
    expect(text).not.toContain(slug);
    expect(text).not.toMatch(/\b(409|403|422)\b/);
  });

  it("a conflict nobody mapped still shows the server's own sentence, and says nothing was changed", () => {
    expect(editorialRefusalCopy("submit", conflict("brand-new-problem", "The thing is odd."))).toBe("The thing is odd. Nothing was changed.");
  });

  it("forbidden is about the command: approve mentions maker and checker", () => {
    expect(editorialRefusalCopy("approve", { kind: "forbidden", reason: "x" })).toMatch(/wrote the version being approved/);
    expect(editorialRefusalCopy("seoSignoff", { kind: "forbidden", reason: "x" })).toMatch(/SEO and AEO/);
    expect(editorialRefusalCopy("comment", { kind: "forbidden", reason: "x" })).toMatch(/permission/);
  });

  it("invalid keeps the BFF sentence minus its machine prefix; not-found names the comment", () => {
    expect(editorialRefusalCopy("requestChanges", { kind: "invalid", issues: [], message: "invalid_request: note must be 1..2000 characters" })).toBe("note must be 1..2000 characters Nothing was changed.");
    expect(editorialRefusalCopy("resolve", { kind: "not_found", slug: "comment-not-found" })).toMatch(/comment no longer exists/);
    expect(editorialRefusalCopy("submit", { kind: "not_found", slug: "item-not-found" })).toMatch(/no longer exists/);
  });

  it("an outcome-unknown 502 says it could not confirm and to refresh, never failed or saved", () => {
    const text = editorialRefusalCopy("approve", { kind: "unavailable", code: "upstream_error", reason: "not_observed" });
    expect(text).toMatch(/couldn't confirm approving it/);
    expect(text).toMatch(/Refresh/);
  });

  it("unavailable, refused-by-WebDesk, expired session, drift and not-enabled each have their own words", () => {
    expect(editorialRefusalCopy("submit", { kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" })).toMatch(/can't be reached/);
    expect(editorialRefusalCopy("submit", { kind: "unavailable", code: "upstream_error", reason: "webdesk_refused" })).toMatch(/WebDesk refused/);
    expect(editorialRefusalCopy("submit", { kind: "unavailable", code: "upstream_error", reason: "session_expired" })).toMatch(/session has expired/);
    expect(editorialRefusalCopy("submit", { kind: "unavailable", code: "contract_drift", reason: "x.y: expected number" })).toMatch(/unexpected \(x\.y: expected number\)/);
    expect(editorialRefusalCopy("submit", { kind: "not_enabled", reason: "not_served" })).toMatch(/isn't available on this deployment/);
  });

  it("no command, kind or slug yields an empty or raw-token answer", () => {
    const refusals: Refusal[] = [
      { kind: "forbidden", reason: "r" }, { kind: "not_found", slug: "s" }, { kind: "not_enabled", reason: "module_disabled" }, conflict("zzz"),
      { kind: "invalid", issues: [], message: "" }, { kind: "unavailable", code: "network", reason: "x" },
    ];
    for (const c of commands) for (const r of refusals) {
      const t = editorialRefusalCopy(c, r);
      expect(t.length).toBeGreaterThan(10);
      expect(t).not.toMatch(/^[a-z]+(-[a-z]+)+$/);
    }
  });

  it("every command has its own done sentence", () => {
    expect(new Set(commands.map(doneWords)).size).toBe(commands.length);
  });
});

describe("history helpers", () => {
  it("anchorLabel reads a pointer in words", () => {
    expect(anchorLabel(null)).toBeNull();
    expect(anchorLabel("")).toBe("the whole item");
    expect(anchorLabel("/blocks/0/props/h1")).toBe("h1");
    expect(anchorLabel("/blocks/0/props/faq/2/answer")).toBe("faq > 2 > answer");
    expect(anchorLabel("/seo/title")).toBe("seo > title");
    expect(anchorLabel("/blocks/0/props/a~1b")).toBe("a/b");
  });
  it("validAnchor takes '' or a pointer of at most 512 characters", () => {
    expect(validAnchor("")).toBe(true);
    expect(validAnchor("/seo/title")).toBe(true);
    expect(validAnchor("seo/title")).toBe(false);
    expect(validAnchor(`/${"a".repeat(512)}`)).toBe(false);
  });
  it("eventWords and lastEvent", () => {
    expect(eventWords("review.approved")).toBe("approved it");
    expect(eventWords("review.future_kind")).toBe("future kind");
    const evs = [
      { id: "1", version: 1, kind: "review.submitted", actorSub: "a", note: null, createdAt: "t1" },
      { id: "2", version: 1, kind: "review.changes_requested", actorSub: "b", note: "n", createdAt: "t2" },
      { id: "3", version: 2, kind: "review.submitted", actorSub: "c", note: null, createdAt: "t3" },
    ];
    expect(lastEvent(evs, "review.submitted")?.actorSub).toBe("c");
    expect(lastEvent(evs, "review.approved")).toBeNull();
  });
});

describe("board grouping", () => {
  const item = (id: string, state: string): BoardItem => ({ itemId: id, collectionKey: "service", locale: "en", slug: id, title: null, headVersion: 1, publishState: "draft", editorial: ed({ state }) });
  it("groups by state in flow order and keeps unknown states in a trailing column", () => {
    const cols = groupBoard([item("a", "approved"), item("b", "draft"), item("c", "draft"), item("d", "weird")]);
    expect(cols.map((c) => [c.state, c.items.length])).toEqual([["draft", 2], ["in_review", 0], ["changes_requested", 0], ["approved", 1], ["other", 1]]);
  });
  it("no unknown state, no 'other' column", () => {
    expect(groupBoard([item("a", "draft")]).map((c) => c.state)).toEqual(["draft", "in_review", "changes_requested", "approved"]);
  });
});

describe("grants words", () => {
  it("roles and scopes in words", () => {
    expect(roleLabel("webdesk_seo_reviewer")).toBe("SEO reviewer");
    expect(roleLabel("webdesk_odd_thing")).toBe("odd thing");
    expect(scopeWords(true, [], "collection")).toBe("every collection");
    expect(scopeWords(false, ["service", "page"], "collection")).toBe("service, page");
    expect(scopeWords(false, [], "language")).toBe("no language");
  });
  it("tokens", () => {
    expect(leadingToken("self_grant_forbidden: a principal may not")).toBe("self_grant_forbidden");
    expect(leadingToken("editorial_grant_expiry_mismatch")).toBe("editorial_grant_expiry_mismatch");
    expect(leadingToken("Some sentence with spaces")).toBeNull();
    expect(stripToken("invalid_request: userId must be a uuid")).toBe("userId must be a uuid");
  });
  it.each([
    ["self_grant_forbidden: a principal may not grant a role to themselves", /yourself/],
    ["editorial_target_not_eligible: the target is not an active user", /active employee/],
    ["unknown_collection: the site has no collection \"x\"", /collections you picked doesn't exist/],
    ["unknown_locale: nope", /languages you picked isn't one of this site's languages/],
  ])("400 %s is words", (message, re) => {
    expect(grantRefusalCopy({ kind: "invalid", issues: [], message })).toMatch(re);
  });
  it("409 expiry mismatch, 403, 404 and 503 are words", () => {
    expect(grantRefusalCopy(conflict("editorial_grant_expiry_mismatch"))).toMatch(/different expiry date/);
    expect(grantRefusalCopy({ kind: "forbidden", reason: "x" })).toMatch(/can't manage writers on this site/);
    expect(grantRefusalCopy({ kind: "not_found", slug: "site-not-found" })).toMatch(/doesn't exist or isn't one of your company's/);
    expect(grantRefusalCopy({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" })).toMatch(/can't be reached/);
    expect(grantRefusalCopy({ kind: "unavailable", code: "upstream_error", reason: "not_observed" })).toMatch(/couldn't confirm/);
  });
});

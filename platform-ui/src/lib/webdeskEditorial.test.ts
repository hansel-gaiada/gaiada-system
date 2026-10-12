import { describe, it, expect, vi, beforeEach } from "vitest";

// The writers' room's wire validation and readers (webdeskEditorial.ts) and its writes (webdeskEditorialActions.ts): every 2xx body is
// validated, a refusal is a typed result and never an empty list, and every write sends exactly the body the BFF documents.

vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ id: "u1", companies: [], roles: [] })) };
});
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./entities", () => ({ listMembers: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { getSessionUserId } from "./session-server";
import { WireDrift } from "./webdeskContent";
import {
  getEditorialBoard, getEditorialHistory, listEditorialGrants, loadEditorialInitial, loadEditorialState, parseEditorialBoard, parseEditorialHistory, parseGrants,
} from "./webdeskEditorial";
import {
  addCommentAction, approveAction, assignAction, grantRoleAction, listGrantsAction, loadEditorialStateAction, requestChangesAction, resolveCommentAction,
  revokeRoleAction, seoSignoffAction, submitForReviewAction, withdrawFromReviewAction,
} from "./webdeskEditorialActions";
import type { ItemDetail } from "./webdeskContentModel";

const fetchMock = vi.mocked(platformFetch);
const session = vi.mocked(getSessionUserId);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const BASE = "/api/co-1/modules/webdev/content/sites/gaiada/site-1";
const ITEM = "11111111-1111-4111-8111-111111111111";

const view = (over: Record<string, unknown> = {}) => ({
  reviewRequired: true, seoSignoffRequired: false, state: "in_review", authorSub: "u2", submittedVersion: 3, seoSignedVersion: null, seoSignedBy: null,
  seoSignedCurrent: false, approvedVersion: null, approvedBy: null, approvedAt: null, approvedIsHead: false, dueAt: null, plannedPublishAt: null, briefRef: null,
  openComments: 1, updatedAt: "2026-10-12T08:00:00.000Z", ...over,
});
const history = (over: Record<string, unknown> = {}) => ({
  itemId: ITEM, collectionKey: "service", headVersion: 3, deleted: false, editorial: view(), seoSnapshot: null,
  events: [{ id: "e1", version: 3, kind: "review.submitted", actorSub: "u2", note: null, createdAt: "2026-10-12T08:00:00.000Z" }], eventsTruncated: false,
  comments: [{ id: "c1", version: 3, anchor: "/blocks/0/props/h1", body: "Shorter?", authorSub: "u3", createdAt: "2026-10-12T08:05:00.000Z", resolvedAt: null, resolvedBy: null }],
  commentsTruncated: false, ...over,
});
const board = (over: Record<string, unknown> = {}) => ({
  items: [{ itemId: ITEM, collectionKey: "service", locale: "en", slug: "service.seo", title: "SEO", headVersion: 3, publishState: "draft", editorial: view() }],
  counts: { draft: 1, in_review: 2, changes_requested: 0, approved: 4 },
  policies: [{ collectionKey: "service", reviewRequired: true, seoSignoffRequired: false, updatedBy: "u9", updatedAt: "2026-10-12T00:00:00.000Z" }],
  page: { cursor: null, hasMore: false, limit: 100 }, ...over,
});
const grant = (over: Record<string, unknown> = {}) => ({
  grantId: "g1", userId: "u5", name: "Dewi", email: "dewi@example.com", role: "webdesk_writer", tenantSlug: "gaiada", siteId: "site-1",
  allCollections: false, collections: ["service"], allLocales: true, locales: [], expiresAt: null, grantedBy: "u9", updatedAt: "2026-10-12T00:00:00.000Z", ...over,
});

function problem(status: number, slug: string, extra: Record<string, unknown> = {}) {
  return new PlatformError(status, slug, undefined, undefined, undefined, { type: `https://webdesk.gaiada.online/errors/${slug}`, title: slug, status, ...extra });
}

beforeEach(() => { fetchMock.mockReset(); session.mockResolvedValue("u1"); });

describe("parseEditorialHistory", () => {
  it("reads the review record: state, events (oldest first), comments with their anchors", () => {
    const h = parseEditorialHistory(history());
    expect(h.editorial.state).toBe("in_review");
    expect(h.events.map((e) => e.kind)).toEqual(["review.submitted"]);
    expect(h.comments[0]).toMatchObject({ id: "c1", anchor: "/blocks/0/props/h1", resolvedAt: null });
  });
  it("a comment with no anchor is null, a resolved one carries who and when", () => {
    const h = parseEditorialHistory(history({ comments: [{ id: "c2", version: 3, anchor: null, body: "b", authorSub: "u3", createdAt: "t", resolvedAt: "t2", resolvedBy: "u4" }] }));
    expect(h.comments[0]).toMatchObject({ anchor: null, resolvedBy: "u4" });
  });
  it.each([
    ["a missing editorial", () => { const h = history() as Record<string, unknown>; delete h.editorial; return h; }, /editorial.history.editorial/],
    ["a comment whose version is a string", () => history({ comments: [{ id: "c", version: "3", anchor: null, body: "b", authorSub: "a", createdAt: "t", resolvedAt: null, resolvedBy: null }] }), /comments\[0\]\.version: expected integer/],
    ["events that are not an array", () => history({ events: {} }), /events: expected array/],
    ["no truncation flag", () => { const h = history() as Record<string, unknown>; delete h.commentsTruncated; return h; }, /commentsTruncated/],
  ])("drift: %s", (_n, mk, re) => {
    expect(() => parseEditorialHistory(mk())).toThrow(WireDrift);
    expect(() => parseEditorialHistory(mk())).toThrow(re);
  });
});

describe("parseEditorialBoard: counts and countsWithheld are one fact", () => {
  it("full counts: kept per state, countsWithheld false", () => {
    const b = parseEditorialBoard(board());
    expect(b.counts).toEqual({ draft: 1, in_review: 2, changes_requested: 0, approved: 4 });
    expect(b.countsWithheld).toBe(false);
    expect(b.items[0].editorial.state).toBe("in_review");
  });
  it("withheld: counts is NULL (never zeros) and countsWithheld is true", () => {
    const withheld = board() as Record<string, unknown>; delete withheld.counts; withheld.countsWithheld = true;
    const b = parseEditorialBoard(withheld);
    expect(b.counts).toBeNull();
    expect(b.countsWithheld).toBe(true);
  });
  it("drift: neither counts nor the flag, both at once, a state missing from counts, or a bad item", () => {
    const neither = board() as Record<string, unknown>; delete neither.counts;
    expect(() => parseEditorialBoard(neither)).toThrow(/board\.counts/);
    expect(() => parseEditorialBoard(board({ countsWithheld: true }))).toThrow(WireDrift);
    expect(() => parseEditorialBoard(board({ counts: { draft: 1, in_review: 1, changes_requested: 1 } }))).toThrow(/board\.counts\.approved/);
    expect(() => parseEditorialBoard(board({ items: [{ itemId: ITEM }] }))).toThrow(WireDrift);
  });
});

describe("parseGrants", () => {
  it("reads every member of a grant", () => {
    const g = parseGrants({ tenantSlug: "gaiada", siteId: "site-1", grants: [grant(), grant({ grantId: "g2", allCollections: true, collections: [], allLocales: false, locales: ["en"], expiresAt: "2027-01-01T00:00:00.000Z" })] });
    expect(g.grants).toHaveLength(2);
    expect(g.grants[1]).toMatchObject({ allCollections: true, locales: ["en"], expiresAt: "2027-01-01T00:00:00.000Z" });
  });
  it("an empty list is a real answer (none), a missing `grants` is drift", () => {
    expect(parseGrants({ tenantSlug: "t", siteId: "s", grants: [] }).grants).toEqual([]);
    expect(() => parseGrants({ tenantSlug: "t", siteId: "s" })).toThrow(/grants\.grants/);
    expect(() => parseGrants({ tenantSlug: "t", siteId: "s", grants: [grant({ allLocales: "yes" })] })).toThrow(WireDrift);
  });
});

describe("readers", () => {
  it("history, board and grants call the documented routes", async () => {
    fetchMock.mockResolvedValueOnce(history()).mockResolvedValueOnce(board()).mockResolvedValueOnce({ tenantSlug: "gaiada", siteId: "site-1", grants: [] });
    expect((await getEditorialHistory("u1", "co-1", "gaiada", "site-1", ITEM)).kind).toBe("ok");
    expect((await getEditorialBoard("u1", "co-1", "gaiada", "site-1", { state: "in_review", collection: "service", authorSub: "u2", cursor: "c" })).kind).toBe("ok");
    expect((await listEditorialGrants("u1", "co-1", "gaiada", "site-1")).kind).toBe("ok");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${BASE}/items/${ITEM}/editorial`,
      `${BASE}/editorial/board?state=in_review&collection=service&authorSub=u2&cursor=c&limit=100`,
      `${BASE}/editorial/grants`,
    ]);
  });
  it("a state the BFF would 400 on is not sent", async () => {
    fetchMock.mockResolvedValueOnce(board());
    await getEditorialBoard("u1", "co-1", "gaiada", "site-1", { state: "not-a-state" });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/editorial/board?limit=100`);
  });
  it("a 403 on the grants read is `forbidden`, never an empty list", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await listEditorialGrants("u1", "co-1", "gaiada", "site-1")).kind).toBe("forbidden");
  });
  it("a 403 on the board and a 503 are refusals too", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await getEditorialBoard("u1", "co-1", "gaiada", "site-1")).kind).toBe("forbidden");
    fetchMock.mockRejectedValueOnce(new PlatformError(503, "editorial_unavailable", undefined, undefined, "circuit_open", { error: "editorial_unavailable", reason: "circuit_open" }));
    expect(await getEditorialBoard("u1", "co-1", "gaiada", "site-1")).toMatchObject({ kind: "unavailable", code: "editorial_unavailable" });
  });
  it("a 2xx body of the wrong shape is contract drift", async () => {
    fetchMock.mockResolvedValueOnce({ items: [] });
    expect(await getEditorialBoard("u1", "co-1", "gaiada", "site-1")).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });
});

describe("loadEditorialState / loadEditorialInitial", () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    item: { itemId: ITEM, collectionKey: "service", locale: "en", slug: "service.seo", localizationGroupId: "g", headVersion: 3, publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "t" },
    version: { n: 3, contentHash: "h", createdAt: "t", createdBy: "u2", note: null, blocks: [], seo: {} },
    group: [], lint: { placeholders: { unresolvedTokens: [], markers: {} } },
    editorial: { reviewRequired: true, state: "in_review", approvedVersion: null, submittedVersion: 3 },
    allowed: { read: true, approve: true },
    ...over,
  });
  const route = (map: Record<string, unknown>) => fetchMock.mockImplementation(async (path: string) => {
    const hit = Object.entries(map).find(([k]) => (path as string).includes(k));
    if (!hit) throw new Error(`unexpected ${path}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  });

  it("one state from the item head and the history, with `allowed` carried as read", async () => {
    route({ [`/items/${ITEM}/editorial`]: history(), [`/items/${ITEM}?version=head`]: detail() });
    const r = await loadEditorialState("u1", "co-1", "gaiada", "site-1", ITEM);
    expect(r.kind === "ok" && r.data).toMatchObject({ headVersion: 3, allowed: { read: true, approve: true }, historyProblem: null });
    expect(r.kind === "ok" && r.data.history?.comments).toHaveLength(1);
  });
  it("a failed history keeps the state ok with `history: null` and the reason in words (never 'no comments')", async () => {
    route({ [`/items/${ITEM}/editorial`]: new PlatformError(503, "x", undefined, undefined, "circuit_open", { error: "editorial_unavailable", reason: "circuit_open" }), [`/items/${ITEM}?version=head`]: detail() });
    const r = await loadEditorialState("u1", "co-1", "gaiada", "site-1", ITEM);
    expect(r.kind === "ok" && r.data.history).toBeNull();
    expect(r.kind === "ok" && r.data.historyProblem).toMatch(/can't be reached/);
  });
  it("a failed item read fails the whole state", async () => {
    route({ [`/items/${ITEM}/editorial`]: history(), [`/items/${ITEM}?version=head`]: problem(404, "item-not-found") });
    expect(await loadEditorialState("u1", "co-1", "gaiada", "site-1", ITEM)).toEqual({ kind: "not_found", slug: "item-not-found" });
  });
  it("absent `allowed` stays undefined: unknown, not denied", async () => {
    route({ [`/items/${ITEM}/editorial`]: history(), [`/items/${ITEM}?version=head`]: detail({ allowed: undefined }) });
    const r = await loadEditorialState("u1", "co-1", "gaiada", "site-1", ITEM);
    expect(r.kind === "ok" && r.data.allowed).toBeUndefined();
  });
  it("loadEditorialInitial skips the history read when WebDesk sent no `editorial` (an older WebDesk)", async () => {
    const d = detail({ editorial: undefined }) as unknown as ItemDetail;
    const i = await loadEditorialInitial("u1", "co-1", "gaiada", "site-1", d);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(i).toMatchObject({ editorial: undefined, history: null, historyProblem: null });
  });
  it("loadEditorialInitial reads the history otherwise, and turns a failure into a sentence", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    const i = await loadEditorialInitial("u1", "co-1", "gaiada", "site-1", detail() as unknown as ItemDetail);
    expect(i.history).toBeNull();
    expect(i.historyProblem).toMatch(/can't read this item's review history/);
  });
});

describe("item command actions: route, body, idempotency key", () => {
  const ack = { itemId: ITEM, editorial: view(), replayed: false };
  const call = () => fetchMock.mock.calls[0] as [string, string, RequestInit];

  it("submit posts {version} and carries the Idempotency-Key header", async () => {
    fetchMock.mockResolvedValue(ack);
    const r = await submitForReviewAction(SCOPE, ITEM, 3, "idem-key-0001");
    expect(r).toEqual({ kind: "ok", data: { replayed: false, commentId: null } });
    const [path, user, init] = call();
    expect(path).toBe(`${BASE}/items/${ITEM}/editorial/submit`);
    expect(user).toBe("u1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ version: 3 });
    expect(init.headers).toEqual({ "Idempotency-Key": "idem-key-0001" });
  });
  it("a key the BFF would reject (too short) is not sent; the BFF generates one", async () => {
    fetchMock.mockResolvedValue(ack);
    await submitForReviewAction(SCOPE, ITEM, 3, "short");
    expect(call()[2].headers).toBeUndefined();
  });
  it("withdraw posts an empty object", async () => {
    fetchMock.mockResolvedValue(ack);
    await withdrawFromReviewAction(SCOPE, ITEM);
    expect(call()[0]).toBe(`${BASE}/items/${ITEM}/editorial/withdraw`);
    expect(JSON.parse(call()[2].body as string)).toEqual({});
  });
  it("request-changes sends {version, note} with the note trimmed; a blank or over-long note never reaches the BFF", async () => {
    fetchMock.mockResolvedValue(ack);
    await requestChangesAction(SCOPE, ITEM, 3, "  Tighten the intro.  ");
    expect(call()[0]).toBe(`${BASE}/items/${ITEM}/editorial/request-changes`);
    expect(JSON.parse(call()[2].body as string)).toEqual({ version: 3, note: "Tighten the intro." });
    fetchMock.mockClear();
    expect(await requestChangesAction(SCOPE, ITEM, 3, "   ")).toMatchObject({ kind: "invalid" });
    expect(await requestChangesAction(SCOPE, ITEM, 3, "x".repeat(2001))).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("seo-signoff and approve send {version}", async () => {
    fetchMock.mockResolvedValue(ack);
    await seoSignoffAction(SCOPE, ITEM, 3);
    await approveAction(SCOPE, ITEM, 3);
    expect(fetchMock.mock.calls.map((c) => [c[0], JSON.parse((c[2] as RequestInit).body as string)])).toEqual([
      [`${BASE}/items/${ITEM}/editorial/seo-signoff`, { version: 3 }],
      [`${BASE}/items/${ITEM}/editorial/approve`, { version: 3 }],
    ]);
  });
  it("a missing or non-integer version is refused before any call", async () => {
    expect(await approveAction(SCOPE, ITEM, 0)).toMatchObject({ kind: "invalid" });
    expect(await submitForReviewAction(SCOPE, ITEM, 1.5)).toMatchObject({ kind: "invalid" });
    expect(await approveAction({ tenantSlug: "", siteId: "s" }, ITEM, 1)).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("assign sends only what was given (null clears), and refuses an empty change", async () => {
    fetchMock.mockResolvedValue(ack);
    await assignAction(SCOPE, ITEM, { authorSub: "u7", dueAt: "2026-10-20T00:00:00.000Z", plannedPublishAt: null, briefRef: "  " });
    expect(JSON.parse(call()[2].body as string)).toEqual({ authorSub: "u7", dueAt: "2026-10-20T00:00:00.000Z", plannedPublishAt: null });
    fetchMock.mockClear();
    expect(await assignAction(SCOPE, ITEM, {})).toMatchObject({ kind: "invalid" });
    expect(await assignAction(SCOPE, ITEM, { dueAt: "not-a-date" })).toMatchObject({ kind: "invalid", message: "That date isn't valid." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("assign can clear the brief with null", async () => {
    fetchMock.mockResolvedValue(ack);
    await assignAction(SCOPE, ITEM, { briefRef: null });
    expect(JSON.parse(call()[2].body as string)).toEqual({ briefRef: null });
  });
  it("comment sends {version, body, anchor?}, validates the anchor and the body, and reads back the new comment id", async () => {
    fetchMock.mockResolvedValue({ itemId: ITEM, commentId: "c9", version: 3 });
    const r = await addCommentAction(SCOPE, ITEM, 3, " Shorter? ", "/blocks/0/props/h1", "idem-key-0002");
    expect(r).toEqual({ kind: "ok", data: { replayed: false, commentId: "c9" } });
    expect(call()[0]).toBe(`${BASE}/items/${ITEM}/editorial/comments`);
    expect(JSON.parse(call()[2].body as string)).toEqual({ version: 3, body: "Shorter?", anchor: "/blocks/0/props/h1" });
    fetchMock.mockClear();
    await addCommentAction(SCOPE, ITEM, 3, "No anchor");
    expect(JSON.parse((fetchMock.mock.calls[0][2] as RequestInit).body as string)).toEqual({ version: 3, body: "No anchor" });
    fetchMock.mockClear();
    expect(await addCommentAction(SCOPE, ITEM, 3, "  ")).toMatchObject({ kind: "invalid" });
    expect(await addCommentAction(SCOPE, ITEM, 3, "x".repeat(4001))).toMatchObject({ kind: "invalid" });
    expect(await addCommentAction(SCOPE, ITEM, 3, "ok", "no-slash")).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("resolve posts to the comment's route with an encoded id", async () => {
    fetchMock.mockResolvedValue({ itemId: ITEM, commentId: "c/1", alreadyResolved: false });
    await resolveCommentAction(SCOPE, ITEM, "c/1");
    expect(call()[0]).toBe(`${BASE}/items/${ITEM}/editorial/comments/c%2F1/resolve`);
  });
  it("a typed 409 comes back as data, with the slug the panel maps to words", async () => {
    fetchMock.mockRejectedValue(problem(409, "review-version-mismatch", { detail: "Version 2 is not the submitted version (3).", expectedVersion: 3 }));
    expect(await approveAction(SCOPE, ITEM, 2)).toMatchObject({ kind: "conflict", slug: "review-version-mismatch" });
  });
  it("a 403 is `forbidden`; a 404 comment is not_found (not 'not served'); a 502 ambiguous is unavailable/upstream_error", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await approveAction(SCOPE, ITEM, 3)).kind).toBe("forbidden");
    fetchMock.mockRejectedValueOnce(problem(404, "comment-not-found"));
    expect(await resolveCommentAction(SCOPE, ITEM, "c1")).toEqual({ kind: "not_found", slug: "comment-not-found" });
    fetchMock.mockRejectedValueOnce(new PlatformError(502, "webdesk_ambiguous", undefined, undefined, "not_observed", { error: "webdesk_ambiguous", reason: "not_observed" }));
    expect(await approveAction(SCOPE, ITEM, 3)).toMatchObject({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
  });
  it("a 2xx that is not an object is drift", async () => {
    fetchMock.mockResolvedValue("ok");
    expect(await approveAction(SCOPE, ITEM, 3)).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });
  it("no session: nothing is sent", async () => {
    session.mockResolvedValue(null as never);
    expect(await approveAction(SCOPE, ITEM, 3)).toMatchObject({ kind: "unavailable", reason: "session_expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("the re-read action returns the state", async () => {
    fetchMock.mockImplementation(async (path: string) => ((path as string).endsWith("/editorial") ? history() : {
      item: { itemId: ITEM, collectionKey: "service", locale: "en", slug: "s", localizationGroupId: "g", headVersion: 3, publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "t" },
      version: { n: 3, contentHash: "h", createdAt: "t", createdBy: null, note: null, blocks: [], seo: {} }, group: [], lint: { placeholders: { unresolvedTokens: [], markers: {} } },
    }));
    const r = await loadEditorialStateAction(SCOPE, ITEM);
    expect(r.kind).toBe("ok");
  });
});

describe("grant actions", () => {
  const PERSON = "22222222-2222-4222-8222-222222222222";
  const written = { userId: PERSON, role: "webdesk_writer", tenantSlug: "gaiada", siteId: "site-1", grantId: "g1", allCollections: false, collections: ["service"], allLocales: true, locales: [], expiresAt: null, changed: true, createdGrant: true };

  it("grant sends EXACTLY ONE of allCollections / collections and of allLocales / locales (an empty list never means all)", async () => {
    fetchMock.mockResolvedValue(written);
    const r = await grantRoleAction(SCOPE, { userId: PERSON, role: "webdesk_writer", allCollections: false, collections: ["service"], allLocales: true, locales: [], expiresAt: null });
    expect(r).toEqual({ kind: "ok", data: { userId: PERSON, role: "webdesk_writer", changed: true, createdGrant: true } });
    const [path, , init] = fetchMock.mock.calls[0] as [string, string, RequestInit];
    expect(path).toBe(`${BASE}/editorial/grants`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ userId: PERSON, role: "webdesk_writer", collections: ["service"], allLocales: true, expiresAt: null });
    fetchMock.mockClear();
    await grantRoleAction(SCOPE, { userId: PERSON, role: "webdesk_editor", allCollections: true, collections: ["ignored"], allLocales: false, locales: ["en", "id"], expiresAt: "2027-01-01T23:59:59.000Z" });
    expect(JSON.parse((fetchMock.mock.calls[0][2] as RequestInit).body as string)).toEqual({ userId: PERSON, role: "webdesk_editor", allCollections: true, locales: ["en", "id"], expiresAt: "2027-01-01T23:59:59.000Z" });
  });
  it("refuses before any call: no person, an unknown role, no collections, no languages, a bad date", async () => {
    const base = { userId: PERSON, role: "webdesk_writer" as const, allCollections: true, collections: [], allLocales: true, locales: [], expiresAt: null };
    expect(await grantRoleAction(SCOPE, { ...base, userId: "" })).toMatchObject({ kind: "invalid" });
    expect(await grantRoleAction(SCOPE, { ...base, role: "webdesk_admin" as never })).toMatchObject({ kind: "invalid" });
    expect(await grantRoleAction(SCOPE, { ...base, allCollections: false })).toMatchObject({ kind: "invalid", message: expect.stringMatching(/collection/) });
    expect(await grantRoleAction(SCOPE, { ...base, allLocales: false })).toMatchObject({ kind: "invalid", message: expect.stringMatching(/language/) });
    expect(await grantRoleAction(SCOPE, { ...base, expiresAt: "soon" })).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("revoke is a DELETE on the person and role, and reads removedGrant", async () => {
    fetchMock.mockResolvedValue({ userId: PERSON, role: "webdesk_writer", siteId: "site-1", changed: true, removedGrant: false });
    const r = await revokeRoleAction(SCOPE, PERSON, "webdesk_writer");
    expect(r).toEqual({ kind: "ok", data: { userId: PERSON, role: "webdesk_writer", changed: true, removedGrant: false } });
    const [path, , init] = fetchMock.mock.calls[0] as [string, string, RequestInit];
    expect(path).toBe(`${BASE}/editorial/grants/${PERSON}/webdesk_writer`);
    expect(init.method).toBe("DELETE");
    expect(await revokeRoleAction(SCOPE, PERSON, "webdesk_boss")).toMatchObject({ kind: "invalid" });
  });
  it("a 403 on grant is `forbidden`; a 400 token and a 409 expiry mismatch come back typed", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await grantRoleAction(SCOPE, { userId: PERSON, role: "webdesk_writer", allCollections: true, collections: [], allLocales: true, locales: [], expiresAt: null })).kind).toBe("forbidden");
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "self_grant_forbidden: a principal may not grant a role to themselves", undefined, undefined, undefined, { error: "self_grant_forbidden: a principal may not grant a role to themselves" }));
    expect(await grantRoleAction(SCOPE, { userId: PERSON, role: "webdesk_writer", allCollections: true, collections: [], allLocales: true, locales: [], expiresAt: null })).toMatchObject({ kind: "invalid", message: expect.stringMatching(/^self_grant_forbidden/) });
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "editorial_grant_expiry_mismatch", undefined, undefined, undefined, { error: "editorial_grant_expiry_mismatch" }));
    expect(await grantRoleAction(SCOPE, { userId: PERSON, role: "webdesk_writer", allCollections: true, collections: [], allLocales: true, locales: [], expiresAt: null })).toMatchObject({ kind: "conflict", slug: "editorial_grant_expiry_mismatch" });
  });
  it("the list action re-reads the grants", async () => {
    fetchMock.mockResolvedValue({ tenantSlug: "gaiada", siteId: "site-1", grants: [grant()] });
    const r = await listGrantsAction(SCOPE);
    expect(r.kind === "ok" && r.data.grants).toHaveLength(1);
  });
});

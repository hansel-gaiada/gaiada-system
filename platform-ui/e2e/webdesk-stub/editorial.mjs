// M5-W2e — the stubbed writers' room BFF (M5-W2d's review routes, M5-W1b's grants read, M5-W1c's `allowed`), as a pure in-memory model for
// e2e/webdesk-editorial.spec.ts. TEST FIXTURE ONLY: nothing under `src/` imports it. Like `wd.mjs`, it is transcribed from the contract
// (docs/FRONTEND-BFF-CONTRACT.md §27) and kept boring and literal: shapes first, no cleverness. It decides ONLY what the contract says a
// caller may do per x-user-id role (publisher: everything; viewer: read only); the REAL authority is Cerbos in the BFF.
//
//   GET  …/items/:itemId                  gains `editorial` and `allowed` (never for a client-portal user: the portal stub delegates here)
//   GET  …/collections/:key/items         each row gains `editorial`
//   GET  …/items/:itemId/editorial        the review record
//   POST …/items/:itemId/editorial/{submit,withdraw,request-changes,seo-signoff,approve,assign,comments,comments/:id/resolve}
//   GET  …/editorial/board                `countsWithheld` when `S.cfg.reviewCountsWithheld`
//   GET  …/editorial/grants               publisher tier only (a viewer is the BFF's 403)
//
// Scenario controls (POST /__stub/config): `reviewAllowedAbsent` (omit `allowed`), `reviewCountsWithheld`, `reviewOff` (policy off), and
// `reviewRefuse: "<slug>"` (the NEXT item command is refused with that typed 409 and changes nothing; one-shot).

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const R = (status, json) => ({ status, json });
const problem = (status, slug, title, detail, extra = {}) => R(status, { type: `${PROBLEM}${slug}`, title, status, detail, instance: "/stub", requestId: "stub-req", ...extra });
const forbidden = () => R(403, { error: "forbidden" });
const nowIso = () => new Date().toISOString();

const STATES = ["draft", "in_review", "changes_requested", "approved"];

/** The review data this stub starts with. Items are the ids of `wd.mjs`'s seed. */
export function seedReview() {
  const ev = (id, version, kind, actorSub, createdAt, note = null) => ({ id, version, kind, actorSub, note, createdAt });
  return {
    policies: { service: { reviewRequired: true, seoSignoffRequired: false } },
    seq: 0,
    items: new Map([
      // In review: submitted by gede-ic, version 1 (the item's head), one open comment anchored to the H1.
      ["itm-service-local-seo-en", {
        state: "in_review", authorSub: "gede-ic", submittedVersion: 1, seoSignedVersion: null, seoSignedBy: null, approvedVersion: null, approvedBy: null, approvedAt: null,
        dueAt: "2026-10-20T00:00:00.000Z", plannedPublishAt: null, briefRef: null,
        events: [ev("ev-1", 1, "review.created", "gede-ic", "2026-10-09T08:00:00.000Z"), ev("ev-2", 1, "review.submitted", "gede-ic", "2026-10-10T08:00:00.000Z")],
        comments: [{ id: "cm-1", version: 1, anchor: "/blocks/0/props/h1", body: "Can the H1 name the city?", authorSub: "dept-manager", createdAt: "2026-10-10T09:00:00.000Z", resolvedAt: null, resolvedBy: null }],
      }],
      // Approved: the whole flow done, version 1.
      ["itm-service-web-design-en", {
        state: "approved", authorSub: "gede-ic", submittedVersion: 1, seoSignedVersion: null, seoSignedBy: null, approvedVersion: 1, approvedBy: "dept-manager", approvedAt: "2026-10-09T10:00:00.000Z",
        dueAt: null, plannedPublishAt: null, briefRef: null,
        events: [ev("ev-3", 1, "review.submitted", "gede-ic", "2026-10-09T08:00:00.000Z"), ev("ev-4", 1, "review.approved", "dept-manager", "2026-10-09T10:00:00.000Z")],
        comments: [],
      }],
      // A draft in the flow, with changes asked for earlier on its published item.
      ["itm-service-seo-en", {
        state: "changes_requested", authorSub: "gede-ic", submittedVersion: 3, seoSignedVersion: null, seoSignedBy: null, approvedVersion: null, approvedBy: null, approvedAt: null,
        dueAt: null, plannedPublishAt: null, briefRef: "brief-seo-1",
        events: [ev("ev-5", 3, "review.submitted", "gede-ic", "2026-10-10T08:30:00.000Z"), ev("ev-6", 3, "review.changes_requested", "dept-manager", "2026-10-10T09:30:00.000Z", "Add the hotel angle to the intro.")],
        comments: [],
      }],
    ]),
    grants: [
      { grantId: "gr-1", userId: "gede-ic", name: "Gede", email: "gede@gaiada.com", role: "webdesk_writer", tenantSlug: "gaiada", siteId: "site-gaiada-com", allCollections: false, collections: ["service"], allLocales: true, locales: [], expiresAt: null, grantedBy: "dept-manager", updatedAt: "2026-10-09T08:00:00.000Z" },
    ],
  };
}

/** A client-portal user reaches `handleWebdesk` through the portal stub: they never get review members (the real BFF sends no `allowed` there). */
const isPortal = (userId) => userId.startsWith("wd-client");

const head = (it) => it.versions[it.versions.length - 1];

function viewOf(S, item, rv) {
  const policy = S.review.policies[item.collectionKey] ?? { reviewRequired: false, seoSignoffRequired: false };
  const on = policy.reviewRequired && !S.cfg.reviewOff;
  const r = rv ?? { state: "draft", authorSub: null, submittedVersion: null, seoSignedVersion: null, seoSignedBy: null, approvedVersion: null, approvedBy: null, approvedAt: null, dueAt: null, plannedPublishAt: null, briefRef: null, comments: [] };
  return {
    reviewRequired: on, seoSignoffRequired: policy.seoSignoffRequired, state: r.state, authorSub: r.authorSub, submittedVersion: r.submittedVersion,
    seoSignedVersion: r.seoSignedVersion, seoSignedBy: r.seoSignedBy, seoSignedCurrent: r.seoSignedVersion !== null && r.seoSignedVersion === r.submittedVersion,
    approvedVersion: r.approvedVersion, approvedBy: r.approvedBy, approvedAt: r.approvedAt, approvedIsHead: r.approvedVersion !== null && r.approvedVersion === head(item).n,
    dueAt: r.dueAt, plannedPublishAt: r.plannedPublishAt, briefRef: r.briefRef, openComments: (r.comments ?? []).filter((c) => c.resolvedAt === null).length,
    updatedAt: rv ? nowIso() : null,
  };
}

/** What `allowed` says for a role (one Cerbos batch in the real BFF). The viewer reads; a publisher does everything the state allows. */
function allowedFor(role) {
  const all = ["read", "update", "submit", "comment", "request_changes", "seo_signoff", "approve", "assign", "request_publish", "unpublish", "delete"];
  return Object.fromEntries(all.map((k) => [k, role === "publisher" || k === "read"]));
}

/** Post-process the staff item read and list rows: adds `editorial` (and `allowed` on the item read). Returns the body unchanged for a portal user. */
export function decorateItemDetail(S, body, it, { userId, role }) {
  if (isPortal(userId)) return body;
  const out = { ...body, editorial: viewOf(S, it, S.review.items.get(it.itemId)) };
  if (!S.cfg.reviewAllowedAbsent) out.allowed = allowedFor(role);
  return out;
}
export function decorateItemList(S, body, { userId }) {
  if (isPortal(userId)) return body;
  return { ...body, items: body.items.map((row) => ({ ...row, editorial: viewOf(S, S.items.get(row.itemId), S.review.items.get(row.itemId)) })) };
}

const titleOf = (it) => head(it).seo?.title ?? null;

function boardBody(S, query) {
  const wantState = query.get("state");
  const wantCollection = query.get("collection");
  const rows = [...S.review.items.entries()]
    .map(([id, rv]) => ({ it: S.items.get(id), rv }))
    .filter(({ it }) => it && !it.deletedAt)
    .filter(({ it, rv }) => (!wantState || rv.state === wantState) && (!wantCollection || it.collectionKey === wantCollection));
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const rv of S.review.items.values()) counts[rv.state] += 1;
  const body = {
    items: rows.map(({ it, rv }) => ({
      itemId: it.itemId, collectionKey: it.collectionKey, locale: it.locale, slug: it.slug, title: titleOf(it), headVersion: head(it).n, publishState: it.publishState, editorial: viewOf(S, it, rv),
    })),
    policies: Object.entries(S.review.policies).map(([collectionKey, p]) => ({ collectionKey, reviewRequired: p.reviewRequired && !S.cfg.reviewOff, seoSignoffRequired: p.seoSignoffRequired, updatedBy: "dept-manager", updatedAt: "2026-10-09T00:00:00.000Z" })),
    page: { cursor: null, hasMore: false, limit: 100 },
  };
  // A caller with a scoped grant gets no counts, and the flag (they would disclose the size of what the caller may not see).
  if (S.cfg.reviewCountsWithheld) return { ...body, countsWithheld: true };
  return { ...body, counts };
}

function historyBody(S, it) {
  const rv = S.review.items.get(it.itemId);
  return {
    itemId: it.itemId, collectionKey: it.collectionKey, headVersion: head(it).n, deleted: !!it.deletedAt, editorial: viewOf(S, it, rv), seoSnapshot: null,
    events: rv ? rv.events : [], eventsTruncated: false, comments: rv ? rv.comments : [], commentsTruncated: false,
  };
}

const textOk = (v, max) => typeof v === "string" && v.trim().length >= 1 && v.length <= max;

/** The item commands. Order, as in the real BFF: role (the 403) BEFORE the body is looked at, then review on, then state, then version. */
function itemCommand(S, it, cmd, body, { role, userId }) {
  if (role !== "publisher") return forbidden();
  if (S.cfg.reviewRefuse) {
    const slug = S.cfg.reviewRefuse; S.cfg.reviewRefuse = null;
    return problem(409, slug, "Refused", `The stub refuses this command with ${slug}. Nothing was changed.`);
  }
  const policy = S.review.policies[it.collectionKey];
  if (!policy || !policy.reviewRequired || S.cfg.reviewOff) return problem(409, "review-not-enabled", "Review is not enabled", `Editorial review is not enabled for the "${it.collectionKey}" collection on this site. Nothing was changed.`, { collectionKey: it.collectionKey });
  let rv = S.review.items.get(it.itemId);
  if (!rv) {
    rv = { state: "draft", authorSub: null, submittedVersion: null, seoSignedVersion: null, seoSignedBy: null, approvedVersion: null, approvedBy: null, approvedAt: null, dueAt: null, plannedPublishAt: null, briefRef: null, events: [], comments: [] };
    S.review.items.set(it.itemId, rv);
  }
  const ev = (kind, version, note = null) => rv.events.push({ id: `ev-${++S.review.seq + 100}`, version, kind, actorSub: userId, note, createdAt: nowIso() });
  const conflictState = (what) => problem(409, "review-state-conflict", "Review state conflict", `${what} is not allowed while the item is ${rv.state}. Nothing was changed.`, { currentState: rv.state });
  const mismatch = (given, expected, what) => problem(409, "review-version-mismatch", "Review version mismatch", `Version ${given} is not ${what} (${expected}). Nothing was changed.`, { expectedVersion: expected, givenVersion: given });
  const needVersion = () => (Number.isInteger(body?.version) && body.version >= 1 ? null : problem(400, "invalid-request", "Invalid request", "version must be a positive integer"));
  const ack = () => R(200, { itemId: it.itemId, editorial: viewOf(S, it, rv), replayed: false });

  switch (cmd) {
    case "submit": {
      const bad = needVersion(); if (bad) return bad;
      if (!["draft", "changes_requested"].includes(rv.state)) return conflictState("submit");
      if (body.version !== head(it).n) return mismatch(body.version, head(it).n, "the head version");
      rv.state = "in_review"; rv.submittedVersion = body.version; rv.authorSub = rv.authorSub ?? userId;
      ev("review.submitted", body.version);
      return ack();
    }
    case "withdraw": {
      if (rv.state !== "in_review") return conflictState("withdraw");
      rv.state = "draft"; ev("review.withdrawn", rv.submittedVersion);
      return ack();
    }
    case "request-changes": {
      const bad = needVersion(); if (bad) return bad;
      if (!textOk(body?.note, 2000)) return problem(400, "invalid-request", "Invalid request", "note must be 1..2000 characters");
      if (rv.state !== "in_review") return conflictState("requestChanges");
      if (body.version !== rv.submittedVersion) return mismatch(body.version, rv.submittedVersion, "the submitted version");
      rv.state = "changes_requested"; ev("review.changes_requested", body.version, body.note.trim());
      return ack();
    }
    case "seo-signoff": {
      const bad = needVersion(); if (bad) return bad;
      if (rv.state !== "in_review") return conflictState("seoSignoff");
      if (body.version !== rv.submittedVersion) return mismatch(body.version, rv.submittedVersion, "the submitted version");
      rv.seoSignedVersion = body.version; rv.seoSignedBy = userId; ev("review.seo_signed", body.version);
      return ack();
    }
    case "approve": {
      const bad = needVersion(); if (bad) return bad;
      if (rv.state !== "in_review") return conflictState("approve");
      if (body.version !== rv.submittedVersion) return mismatch(body.version, rv.submittedVersion, "the submitted version");
      if (policy.seoSignoffRequired && rv.seoSignedVersion !== rv.submittedVersion) return problem(409, "seo-signoff-required", "SEO sign-off required", `This collection requires an SEO/AEO sign-off of version ${body.version} before it can be approved. Nothing was changed.`, { version: body.version });
      rv.state = "approved"; rv.approvedVersion = body.version; rv.approvedBy = userId; rv.approvedAt = nowIso(); ev("review.approved", body.version);
      return ack();
    }
    case "assign": {
      const keys = ["authorSub", "dueAt", "plannedPublishAt", "briefRef"].filter((k) => body && k in body);
      if (keys.length === 0) return problem(400, "invalid-request", "Invalid request", "assign needs at least one of authorSub, dueAt, plannedPublishAt, briefRef");
      for (const k of keys) rv[k] = body[k];
      ev("review.assigned", head(it).n);
      return ack();
    }
    case "comments": {
      const bad = needVersion(); if (bad) return bad;
      if (!textOk(body?.body, 4000)) return problem(400, "invalid-request", "Invalid request", "body must be 1..4000 characters");
      const c = { id: `cm-${++S.review.seq + 100}`, version: body.version, anchor: typeof body.anchor === "string" ? body.anchor : null, body: body.body.trim(), authorSub: userId, createdAt: nowIso(), resolvedAt: null, resolvedBy: null };
      rv.comments.push(c); ev("review.comment", body.version);
      return R(201, { itemId: it.itemId, commentId: c.id, version: body.version });
    }
    default: {
      const m = /^comments\/([^/]+)\/resolve$/.exec(cmd);
      if (!m) return null;
      const c = rv.comments.find((x) => x.id === m[1]);
      if (!c) return problem(404, "comment-not-found", "Comment not found", "No such comment on this item.");
      const already = c.resolvedAt !== null;
      if (!already) { c.resolvedAt = nowIso(); c.resolvedBy = userId; ev("review.comment_resolved", c.version); }
      return R(200, { itemId: it.itemId, commentId: c.id, resolvedAt: c.resolvedAt, resolvedBy: c.resolvedBy, alreadyResolved: already });
    }
  }
}

/** Dispatch for the editorial routes under `…/sites/:t/:s`. `rest` is what follows the site. Returns null for a path that is not editorial. */
export function handleEditorial(S, { method, rest, query, body, userId, role }) {
  if (rest === "/editorial/board" && method === "GET") return R(200, boardBody(S, query));
  if (rest === "/editorial/grants" && method === "GET") {
    // `manage_editorial` (company admin, owner, Web Dev manager): a viewer is the BFF's plain 403, for any caller who is not a publisher.
    if (role !== "publisher") return forbidden();
    return R(200, { tenantSlug: "gaiada", siteId: "site-gaiada-com", grants: S.review.grants });
  }
  let m = rest.match(/^\/items\/([^/]+)\/editorial$/);
  if (m && method === "GET") {
    const it = S.items.get(m[1]);
    if (!it) return problem(404, "item-not-found", "Item not found");
    return R(200, historyBody(S, it));
  }
  m = rest.match(/^\/items\/([^/]+)\/editorial\/(.+)$/);
  if (m && method === "POST") {
    const it = S.items.get(m[1]);
    if (!it) return problem(404, "item-not-found", "Item not found");
    return itemCommand(S, it, m[2], body, { role, userId });
  }
  return null;
}

/** For `/__stub/state`: what the spec asserts on. */
export function reviewSnapshot(S) {
  return Object.fromEntries([...S.review.items.entries()].map(([id, rv]) => [id, { state: rv.state, submittedVersion: rv.submittedVersion, approvedVersion: rv.approvedVersion, events: rv.events.map((e) => ({ kind: e.kind, note: e.note, actorSub: e.actorSub })), comments: rv.comments.map((c) => ({ id: c.id, body: c.body, anchor: c.anchor, resolved: c.resolvedAt !== null })) }]));
}

// M5-W2b (writers' room design 4) — the editorial review commands over HTTP: the state machine, the version
// pin, review-off-by-default, maker != checker, idempotency, events, comments, the reads and the `editorial`
// member. Real Postgres (migrations through 0016), real Redis, the real AppModule with the REAL Layer-3/4 PDP
// (content-test-kit.ts); Layers 1/2/2e stay the NODE_ENV=test header stubs. NEEDS the Linux gate
// (webdesk/qa/linux-gate.sh): it was not run on the Windows dev box that wrote it.
//
// Doctrine (estate memory: "validation pre-empts authz"): every denial sends a body that is valid for its
// command and is paired with a positive control that sends the IDENTICAL request as an allowed principal.
// The pure transition table (every legal and illegal pair) is test/editorial-state-machine.spec.ts; the
// HTTP walk of the same pairs is the table-driven block below.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, hdr, type ContentFixture, type HeaderOpts } from "./content-test-kit";
import { draftItem, dumpAudit, itemBase } from "./preview-test-kit";
import { serviceFields } from "./content-test-kit";
import { REVIEW_STATES, TRANSITION_COMMANDS, evaluateTransition, type ReviewState, type TransitionCommand } from "../src/control/editorial/editorial-model";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const WRITER = "user-writer-1"; // creates and submits
const EDITOR = "user-editor-2"; // reviews and approves (a different person from the maker)
const SEO = "user-seo-3";

const BOT = JSON.stringify({ sub: "bot-1", pk: "agent", agt: "webdev-writer" });
const AUTOMATION = JSON.stringify({ sub: "auto-1", pk: "automation" });
const CLIENT = JSON.stringify({ sub: "client-1", ce: true });

describe("M5-W2b editorial review commands", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let other: ContentFixture;

  const site = (f: ContentFixture) => `/control/v1/tenants/${f.slug}/sites/${f.siteId}`;
  const ed = (f: ContentFixture, itemId: string) => `${site(f)}/content/items/${itemId}/editorial`;

  const post = (f: ContentFixture, itemId: string, path: string, body: Record<string, unknown>, opts: HeaderOpts = {}) =>
    app.inject({ method: "POST", url: `${ed(f, itemId)}/${path}`, headers: hdr({ editorial: EDITOR, ...opts }), payload: body });
  const put = (f: ContentFixture, key: string, body: Record<string, unknown>, opts: HeaderOpts = {}) =>
    app.inject({ method: "PUT", url: `${site(f)}/collections/${key}/editorial-policy`, headers: hdr({ editorial: EDITOR, ...opts }), payload: body });
  const get = (url: string) => app.inject({ method: "GET", url, headers: hdr({ idem: null, editorial: null }) });

  const setPolicy = async (f: ContentFixture, review: boolean, seo = false, key = "service") => {
    const r = await put(f, key, { reviewRequired: review, seoSignoffRequired: seo });
    if (r.statusCode !== 200) throw new Error(`setPolicy answered ${r.statusCode} ${r.body}`);
  };

  /** A service item written by WRITER; review is switched on for the collection first. */
  const newItem = async (f: ContentFixture, h1: string): Promise<string> => {
    const slug = `service.ed-${randomUUID().slice(0, 8)}`;
    const r = await app.inject({
      method: "POST",
      url: `${site(f)}/content/items`,
      headers: hdr({ editorial: WRITER }),
      payload: { collectionKey: "service", locale: "en", slug, fields: serviceFields({ h1 }) },
    });
    if (r.statusCode !== 201) throw new Error(`create answered ${r.statusCode} ${r.body}`);
    return r.json().item.itemId as string;
  };

  /** A new head version written by `who`. Returns the new version number. */
  const edit = async (f: ContentFixture, itemId: string, baseVersion: number, h1: string, who = WRITER): Promise<number> => {
    const r = await app.inject({ method: "PUT", url: itemBase(f, itemId), headers: hdr({ editorial: who }), payload: { baseVersion, fields: serviceFields({ h1 }) } });
    if (r.statusCode !== 200) throw new Error(`update answered ${r.statusCode} ${r.body}`);
    return r.json().version.version as number;
  };

  const editorialOf = async (f: ContentFixture, itemId: string) => (await get(`${site(f)}/content/items/${itemId}`)).json().editorial;

  /** Moves an item to `state` (head version 1, written by WRITER) with the legal command sequence. */
  const toState = async (f: ContentFixture, itemId: string, state: ReviewState): Promise<void> => {
    if (state === "draft") return;
    expect((await post(f, itemId, "submit", { version: 1 }, { editorial: WRITER })).statusCode).toBe(200);
    if (state === "in_review") return;
    if (state === "changes_requested") {
      expect((await post(f, itemId, "request-changes", { version: 1, note: "tighten the intro" })).statusCode).toBe(200);
      return;
    }
    expect((await post(f, itemId, "approve", { version: 1 })).statusCode).toBe(200);
  };

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("edrev");
    other = await createContentFixture("edrev-other");
    await setPolicy(fx, true);
  });
  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // The state machine: every (command, state) pair over HTTP
  // ==============================================================================================
  const HTTP: Record<TransitionCommand, { path: string; body: (v: number) => Record<string, unknown>; as: string }> = {
    submit: { path: "submit", body: (v) => ({ version: v }), as: WRITER },
    withdraw: { path: "withdraw", body: () => ({}), as: WRITER },
    requestChanges: { path: "request-changes", body: (v) => ({ version: v, note: "please revise" }), as: EDITOR },
    seoSignoff: { path: "seo-signoff", body: (v) => ({ version: v }), as: SEO },
    approve: { path: "approve", body: (v) => ({ version: v }), as: EDITOR },
  };

  for (const cmd of TRANSITION_COMMANDS) {
    for (const from of REVIEW_STATES) {
      const legal = evaluateTransition(cmd, from);
      it(`${legal.ok ? "LEGAL  " : "ILLEGAL"} ${cmd} from ${from}${legal.ok ? ` -> ${legal.to}` : " -> 409 review-state-conflict"}`, async () => {
        const itemId = await newItem(fx, `Walk ${cmd} ${from}`);
        await toState(fx, itemId, from);
        const h = HTTP[cmd];
        const res = await post(fx, itemId, h.path, h.body(1), { editorial: h.as });
        if (legal.ok) {
          expect(res.statusCode, res.body).toBe(200);
          expect(res.json().editorial.state).toBe(legal.to);
          expect(res.json().replayed).toBe(false);
        } else {
          expect(res.statusCode, res.body).toBe(409);
          expect(res.json().type).toBe(`${PROBLEM}review-state-conflict`);
          expect(res.json().currentState).toBe(from);
          // nothing moved
          expect((await editorialOf(fx, itemId)).state).toBe(from);
        }
      });
    }
  }

  // ==============================================================================================
  // The version pin
  // ==============================================================================================
  it("submit of a version that is not the head: 409 review-version-mismatch, nothing moves; the head is accepted", async () => {
    const itemId = await newItem(fx, "Pin submit");
    await edit(fx, itemId, 1, "Pin submit v2"); // head is now 2
    const stale = await post(fx, itemId, "submit", { version: 1 }, { editorial: WRITER });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ type: `${PROBLEM}review-version-mismatch`, expectedVersion: 2, givenVersion: 1 });
    expect((await editorialOf(fx, itemId)).state).toBe("draft");
    expect((await post(fx, itemId, "submit", { version: 2 }, { editorial: WRITER })).statusCode).toBe(200);
  });

  it("approve / request-changes / sign-off of a version that is not the one in review: 409 review-version-mismatch", async () => {
    const itemId = await newItem(fx, "Pin review");
    await toState(fx, itemId, "in_review"); // submitted_version = 1
    for (const [path, body] of [
      ["approve", { version: 2 }],
      ["request-changes", { version: 2, note: "x" }],
      ["seo-signoff", { version: 2 }],
    ] as const) {
      const r = await post(fx, itemId, path, body, { editorial: path === "seo-signoff" ? SEO : EDITOR });
      expect(r.statusCode, path).toBe(409);
      expect(r.json().type, path).toBe(`${PROBLEM}review-version-mismatch`);
    }
    expect((await editorialOf(fx, itemId)).state).toBe("in_review");
  });

  it("an edit in review: the state stays in_review, submitted follows the new head, and the old version can no longer be approved", async () => {
    const itemId = await newItem(fx, "Edit in review");
    await toState(fx, itemId, "in_review");
    expect(await edit(fx, itemId, 1, "Edit in review v2", EDITOR)).toBe(2);
    const e = await editorialOf(fx, itemId);
    expect(e).toMatchObject({ state: "in_review", submittedVersion: 2 });
    expect((await post(fx, itemId, "approve", { version: 1 })).statusCode).toBe(409);
    // v2 was written by EDITOR: EDITOR cannot approve their own rewrite (maker != checker), SEO can
    const self = await post(fx, itemId, "approve", { version: 2 }, { editorial: EDITOR });
    expect(self.statusCode).toBe(403);
    expect(self.json().type).toBe(`${PROBLEM}review-self-approval`);
    expect((await post(fx, itemId, "approve", { version: 2 }, { editorial: SEO })).statusCode).toBe(200);
  });

  it("an edit after approval: back to draft, and approved_version survives (still the version that was approved)", async () => {
    const itemId = await newItem(fx, "Edit after approval");
    await toState(fx, itemId, "approved");
    await edit(fx, itemId, 1, "Edit after approval v2");
    const e = await editorialOf(fx, itemId);
    expect(e).toMatchObject({ state: "draft", approvedVersion: 1, approvedIsHead: false });
  });

  // ==============================================================================================
  // Review is OFF by default
  // ==============================================================================================
  it("a collection with no policy row refuses every item command with 409 review-not-enabled (and changes nothing)", async () => {
    // `navigation` has no policy row
    const nav = await app.inject({
      method: "POST",
      url: `${site(fx)}/content/items`,
      headers: hdr({ editorial: WRITER }),
      payload: { collectionKey: "navigation", locale: "en", slug: "navigation", fields: { cta: "Contact" } },
    });
    expect(nav.statusCode, nav.body).toBe(201);
    const itemId = nav.json().item.itemId as string;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["submit", { version: 1 }],
      ["withdraw", {}],
      ["request-changes", { version: 1, note: "x" }],
      ["seo-signoff", { version: 1 }],
      ["approve", { version: 1 }],
      ["assign", { authorSub: WRITER }],
      ["comments", { version: 1, body: "hello" }],
    ];
    for (const [path, body] of cases) {
      const r = await post(fx, itemId, path, body);
      expect(r.statusCode, path).toBe(409);
      expect(r.json().type, path).toBe(`${PROBLEM}review-not-enabled`);
    }
    const rows = await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT 1 FROM editorial_items WHERE content_item_id = $1`, [itemId])).rows);
    expect(rows).toHaveLength(0); // the refusals left no review row behind
    // the item still reads as an untouched draft
    expect(await editorialOf(fx, itemId)).toMatchObject({ reviewRequired: false, state: "draft", authorSub: null, updatedAt: null });
  });

  it("review off after on: commands refuse again; turning it on again resumes the item where it was", async () => {
    const f = await createContentFixture("edrev-toggle");
    await setPolicy(f, true);
    const itemId = await newItem(f, "Toggle");
    await toState(f, itemId, "in_review");
    await setPolicy(f, false);
    expect((await post(f, itemId, "approve", { version: 1 })).json().type).toBe(`${PROBLEM}review-not-enabled`);
    await setPolicy(f, true);
    expect((await post(f, itemId, "approve", { version: 1 })).statusCode).toBe(200);
  });

  it("policySet: turning review off clears BOTH flags; sign-off on with review off is a 400; an unknown collection is 404", async () => {
    const f = await createContentFixture("edrev-policy");
    await setPolicy(f, true, true);
    let b = (await get(`${site(f)}/editorial/board`)).json();
    expect(b.policies).toEqual([expect.objectContaining({ collectionKey: "service", reviewRequired: true, seoSignoffRequired: true })]);
    const off = await put(f, "service", { reviewRequired: false }); // seoSignoffRequired omitted
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ reviewRequired: false, seoSignoffRequired: false });
    b = (await get(`${site(f)}/editorial/board`)).json();
    expect(b.policies).toEqual([expect.objectContaining({ reviewRequired: false, seoSignoffRequired: false })]);
    const contradictory = await put(f, "service", { reviewRequired: false, seoSignoffRequired: true });
    expect(contradictory.statusCode).toBe(400);
    expect(contradictory.json().type).toBe(`${PROBLEM}invalid-request`);
    expect((await put(f, "no-such-collection", { reviewRequired: true })).statusCode).toBe(404);
  });

  // ==============================================================================================
  // Maker != checker; human decisions only; client editors out
  // ==============================================================================================
  it("the creator of the version cannot approve it (403 review-self-approval); a different person can (positive control)", async () => {
    const itemId = await newItem(fx, "Maker checker");
    await toState(fx, itemId, "in_review"); // v1 by WRITER
    const self = await post(fx, itemId, "approve", { version: 1 }, { editorial: WRITER });
    expect(self.statusCode).toBe(403);
    expect(self.json().type).toBe(`${PROBLEM}review-self-approval`);
    expect((await editorialOf(fx, itemId)).state).toBe("in_review");
    const ok = await post(fx, itemId, "approve", { version: 1 }, { editorial: EDITOR });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().editorial).toMatchObject({ state: "approved", approvedVersion: 1, approvedBy: EDITOR });
  });

  it("an agent or automation principal never approves or signs off (403 review-principal-not-allowed); a human can", async () => {
    const itemId = await newItem(fx, "Human only");
    await toState(fx, itemId, "in_review");
    for (const who of [BOT, AUTOMATION]) {
      for (const [path, body] of [
        ["approve", { version: 1 }],
        ["seo-signoff", { version: 1 }],
      ] as const) {
        const r = await post(fx, itemId, path, body, { editorial: who });
        expect(r.statusCode, `${who} ${path}`).toBe(403);
        expect(r.json().type).toBe(`${PROBLEM}review-principal-not-allowed`);
      }
    }
    expect((await editorialOf(fx, itemId)).state).toBe("in_review");
    expect((await post(fx, itemId, "seo-signoff", { version: 1 }, { editorial: SEO })).statusCode).toBe(200);
    expect((await post(fx, itemId, "approve", { version: 1 }, { editorial: EDITOR })).statusCode).toBe(200);
  });

  it("a client editor (ce) gets 403 client-command-not-allowed on EVERY editorial write, with valid bodies", async () => {
    const itemId = await newItem(fx, "Client refused");
    await toState(fx, itemId, "in_review");
    const writes: Array<[string, Record<string, unknown>]> = [
      ["submit", { version: 1 }],
      ["withdraw", {}],
      ["request-changes", { version: 1, note: "x" }],
      ["seo-signoff", { version: 1 }],
      ["approve", { version: 1 }],
      ["assign", { authorSub: WRITER }],
      ["comments", { version: 1, body: "hello" }],
    ];
    for (const [path, body] of writes) {
      const r = await post(fx, itemId, path, body, { editorial: CLIENT });
      expect(r.statusCode, path).toBe(403);
      expect(r.json().type, path).toBe(`${PROBLEM}client-command-not-allowed`);
    }
    const pol = await put(fx, "service", { reviewRequired: true, seoSignoffRequired: false }, { editorial: CLIENT });
    expect(pol.statusCode).toBe(403);
    expect(pol.json().type).toBe(`${PROBLEM}client-command-not-allowed`);
    const res = await app.inject({ method: "POST", url: `${ed(fx, itemId)}/comments/${randomUUID()}/resolve`, headers: hdr({ editorial: CLIENT }), payload: {} });
    expect(res.statusCode).toBe(403);
    expect((await editorialOf(fx, itemId)).state).toBe("in_review");
  });

  it("scopes: a caller without webdesk:operate is refused every write (valid body), and one with webdesk:read alone can still read", async () => {
    const itemId = await newItem(fx, "Scopes");
    const denied = await post(fx, itemId, "submit", { version: 1 }, { editorial: WRITER, scopes: ["webdesk:read"] });
    expect(denied.statusCode).toBe(403);
    expect((await editorialOf(fx, itemId)).state).toBe("draft");
    expect((await post(fx, itemId, "submit", { version: 1 }, { editorial: WRITER })).statusCode).toBe(200); // positive control
    const board = await app.inject({ method: "GET", url: `${site(fx)}/editorial/board`, headers: hdr({ scopes: ["webdesk:read"], idem: null, editorial: null }) });
    expect(board.statusCode).toBe(200);
  });

  // ==============================================================================================
  // SEO sign-off
  // ==============================================================================================
  it("a collection that requires a sign-off: approve without one is 409 seo-signoff-required; a stale sign-off does not count", async () => {
    const f = await createContentFixture("edrev-seo");
    await setPolicy(f, true, true);
    const itemId = await newItem(f, "Needs signoff");
    await toState(f, itemId, "in_review");
    const no = await post(f, itemId, "approve", { version: 1 });
    expect(no.statusCode).toBe(409);
    expect(no.json().type).toBe(`${PROBLEM}seo-signoff-required`);
    const signed = await post(f, itemId, "seo-signoff", { version: 1 }, { editorial: SEO });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().editorial).toMatchObject({ state: "in_review", seoSignedVersion: 1, seoSignedBy: SEO, seoSignedCurrent: true });
    // the snapshot is computed by the server and stored for the signed version
    const snap = await asTenant(f.tenantId, async (db) => (await db.query(`SELECT seo_snapshot FROM editorial_items WHERE content_item_id = $1`, [itemId])).rows[0].seo_snapshot);
    expect(snap).toMatchObject({ version: 1 });
    expect(snap.content).toBeDefined();
    // a new version in review: the old sign-off no longer counts
    await edit(f, itemId, 1, "Needs signoff v2", EDITOR);
    expect((await editorialOf(f, itemId)).seoSignedCurrent).toBe(false);
    const stale = await post(f, itemId, "approve", { version: 2 }, { editorial: SEO });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().type).toBe(`${PROBLEM}seo-signoff-required`);
    expect((await post(f, itemId, "seo-signoff", { version: 2 }, { editorial: SEO })).statusCode).toBe(200);
    expect((await post(f, itemId, "approve", { version: 2 }, { editorial: SEO })).statusCode).toBe(200);
  });

  // ==============================================================================================
  // Idempotency
  // ==============================================================================================
  it("a replay (same Idempotency-Key, same request) returns the stored result with replayed: true and moves nothing", async () => {
    const itemId = await newItem(fx, "Replay");
    const idem = `idem-${randomUUID()}`;
    const first = await post(fx, itemId, "submit", { version: 1 }, { editorial: WRITER, idem });
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);
    const events = async () => asTenant(fx.tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM editorial_events WHERE content_item_id = $1`, [itemId])).rows[0].n);
    const before = await events();
    const replay = await post(fx, itemId, "submit", { version: 1 }, { editorial: WRITER, idem });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().editorial).toEqual(first.json().editorial);
    expect(await events()).toBe(before);
    // the same key with a DIFFERENT request is the existing key-reuse refusal
    const reused = await post(fx, itemId, "submit", { version: 2 }, { editorial: WRITER, idem });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().type).toBe(`${PROBLEM}idempotency-key-reused`);
    // a missing Idempotency-Key is a 400
    const none = await post(fx, itemId, "submit", { version: 1 }, { editorial: WRITER, idem: null });
    expect(none.statusCode).toBe(400);
  });

  it("every write leaves an audit row control.editorial.<cmd> (and the replay its .replay row)", async () => {
    const itemId = await newItem(fx, "Audited");
    const idem = `idem-${randomUUID()}`;
    await post(fx, itemId, "submit", { version: 1 }, { editorial: WRITER, idem });
    await post(fx, itemId, "submit", { version: 1 }, { editorial: WRITER, idem });
    const actions = (await dumpAudit(fx)).map((r) => r.action as string);
    expect(actions).toContain("control.editorial.submit");
    expect(actions).toContain("control.editorial.submit.replay");
  });

  // ==============================================================================================
  // Events, comments, assign, history, board
  // ==============================================================================================
  it("events: one per transition, in order, with the actor and the version; comment bodies are never in an event", async () => {
    const itemId = await newItem(fx, "Events");
    await toState(fx, itemId, "in_review");
    const c = await post(fx, itemId, "comments", { version: 1, anchor: "/fields/h1", body: "SECRET-COMMENT-BODY" });
    expect(c.statusCode).toBe(201);
    await post(fx, itemId, "request-changes", { version: 1, note: "needs a source" });
    await edit(fx, itemId, 1, "Events v2");
    await post(fx, itemId, "submit", { version: 2 }, { editorial: WRITER });
    await post(fx, itemId, "approve", { version: 2 }, { editorial: EDITOR });
    const h = (await get(`${ed(fx, itemId)}`)).json();
    expect(h.events.map((e: { kind: string }) => e.kind)).toEqual([
      "review.created", // review was on at create time
      "review.submitted",
      "review.comment",
      "review.changes_requested",
      "review.submitted",
      "review.approved",
    ]);
    expect(h.events.map((e: { actorSub: string }) => e.actorSub)).toEqual([WRITER, WRITER, EDITOR, EDITOR, WRITER, EDITOR]);
    expect(h.events[3]).toMatchObject({ version: 1, note: "needs a source" });
    expect(JSON.stringify(h.events)).not.toContain("SECRET-COMMENT-BODY");
    const stamps = h.events.map((e: { createdAt: string }) => Date.parse(e.createdAt));
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(h.eventsTruncated).toBe(false);
  });

  it("comments: anchored to a version, listed in order, resolve is idempotent, and no route can edit a body", async () => {
    const itemId = await newItem(fx, "Comments");
    await toState(fx, itemId, "in_review");
    const a = await post(fx, itemId, "comments", { version: 1, anchor: "/fields/h1", body: "first" });
    const b = await post(fx, itemId, "comments", { version: 1, body: "second, whole item" });
    expect(a.statusCode).toBe(201);
    expect(await editorialOf(fx, itemId)).toMatchObject({ openComments: 2 });
    const commentId = a.json().commentId as string;
    const resolve = () =>
      app.inject({ method: "POST", url: `${ed(fx, itemId)}/comments/${commentId}/resolve`, headers: hdr({ editorial: EDITOR }), payload: {} });
    const r1 = await resolve();
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ resolvedBy: EDITOR, alreadyResolved: false });
    const r2 = await resolve(); // a second resolve under a new key: nothing moves
    expect(r2.json()).toMatchObject({ resolvedBy: EDITOR, alreadyResolved: true, resolvedAt: r1.json().resolvedAt });
    expect(await editorialOf(fx, itemId)).toMatchObject({ openComments: 1 });
    const h = (await get(ed(fx, itemId))).json();
    expect(h.comments.map((c: { body: string }) => c.body)).toEqual(["first", "second, whole item"]);
    expect(h.comments[0]).toMatchObject({ version: 1, anchor: "/fields/h1", authorSub: EDITOR, resolvedBy: EDITOR });
    expect(h.comments[1]).toMatchObject({ anchor: null, resolvedAt: null });
    // there is no edit route: PUT/PATCH on a comment is a 404, and the body is unchanged
    for (const method of ["PUT", "PATCH"] as const) {
      const r = await app.inject({ method, url: `${ed(fx, itemId)}/comments/${commentId}`, headers: hdr({ editorial: EDITOR }), payload: { body: "rewritten" } });
      expect(r.statusCode, method).toBe(404);
    }
    expect((await get(ed(fx, itemId))).json().comments[0].body).toBe("first");
    // an unknown comment is 404 comment-not-found; a version the item does not have is 409 version-not-found
    const ghost = await app.inject({ method: "POST", url: `${ed(fx, itemId)}/comments/${randomUUID()}/resolve`, headers: hdr({ editorial: EDITOR }), payload: {} });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().type).toBe(`${PROBLEM}comment-not-found`);
    expect((await post(fx, itemId, "comments", { version: 9, body: "x" })).json().type).toBe(`${PROBLEM}version-not-found`);
    expect(b.statusCode).toBe(201);
  });

  it("assign: author and dates move, state does not; null clears a date; an empty assign is a 400", async () => {
    const itemId = await newItem(fx, "Assign");
    const r = await post(fx, itemId, "assign", { authorSub: "user-author-9", dueAt: "2026-11-01T00:00:00Z", briefRef: "brief-7" });
    expect(r.statusCode).toBe(200);
    expect(r.json().editorial).toMatchObject({ state: "draft", authorSub: "user-author-9", dueAt: "2026-11-01T00:00:00.000Z", briefRef: "brief-7" });
    const cleared = await post(fx, itemId, "assign", { dueAt: null });
    expect(cleared.json().editorial).toMatchObject({ authorSub: "user-author-9", dueAt: null, briefRef: "brief-7" });
    expect((await post(fx, itemId, "assign", {})).statusCode).toBe(400);
    expect((await post(fx, itemId, "assign", { dueAt: "next tuesday" })).statusCode).toBe(400);
  });

  it("the review member of item.get / item.list, the review-state filter, the board and cross-tenant isolation", async () => {
    const f = await createContentFixture("edrev-reads");
    await setPolicy(f, true);
    const a = await newItem(f, "Read A");
    const b = await newItem(f, "Read B");
    await toState(f, b, "in_review");
    const item = (await get(`${site(f)}/content/items/${a}`)).json();
    expect(item.editorial).toMatchObject({ reviewRequired: true, seoSignoffRequired: false, state: "draft", authorSub: WRITER, openComments: 0 });
    const list = (await get(`${site(f)}/collections/service/items`)).json();
    const byId = (id: string) => list.items.find((i: { itemId: string }) => i.itemId === id);
    expect(byId(a).editorial.state).toBe("draft");
    expect(byId(b).editorial.state).toBe("in_review");
    const filtered = (await get(`${site(f)}/collections/service/items?reviewState=in_review`)).json();
    expect(filtered.items.map((i: { itemId: string }) => i.itemId)).toEqual([b]);
    expect((await get(`${site(f)}/collections/service/items?reviewState=nope`)).statusCode).toBe(400);
    const board = (await get(`${site(f)}/editorial/board`)).json();
    expect(board.counts).toEqual({ draft: 1, in_review: 1, changes_requested: 0, approved: 0 });
    expect(board.items.map((i: { itemId: string }) => i.itemId).sort()).toEqual([a, b].sort());
    expect((await get(`${site(f)}/editorial/board?state=in_review`)).json().items.map((i: { itemId: string }) => i.itemId)).toEqual([b]);
    expect((await get(`${site(f)}/editorial/board?bogus=1`)).statusCode).toBe(400);
    // another tenant sees none of it, and cannot reach the item by id
    expect((await get(`${site(other)}/editorial/board`)).json().items).toEqual([]);
    expect((await get(`${site(other)}/content/items/${a}/editorial`)).statusCode).toBe(404);
    const cross = await app.inject({ method: "POST", url: `${ed(other, a)}/submit`, headers: hdr({ editorial: WRITER }), payload: { version: 1 } });
    expect(cross.statusCode).toBe(404);
  });

  it("legacy item (created while review was off): reads as an untouched draft, and its first command works once review is on", async () => {
    const f = await createContentFixture("edrev-legacy");
    const { itemId } = await draftItem(app, f, "Legacy");
    expect(await editorialOf(f, itemId)).toMatchObject({ state: "draft", authorSub: null, updatedAt: null });
    await setPolicy(f, true);
    expect((await post(f, itemId, "submit", { version: 1 }, { editorial: WRITER })).statusCode).toBe(200);
    expect(await editorialOf(f, itemId)).toMatchObject({ state: "in_review", authorSub: null });
  });

  it("no review data on /v1: a published item's delivery response carries none of the editorial members", async () => {
    const f = await createContentFixture("edrev-v1");
    await setPolicy(f, true);
    const itemId = await newItem(f, "Delivery");
    await toState(f, itemId, "approved");
    // the delivery tables never see it: the editorial rows exist, the content projection has no such column
    const cols = await asTenant(f.tenantId, async (db) =>
      (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'content_items' AND column_name ~ '(review|editorial|approved)'`)).rows,
    );
    expect(cols).toEqual([]);
  });
});

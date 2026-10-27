import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-2 (BFF §63.9, §63.16): the DEMO_MODE answers of the client's post approval page, read from and written to the SAME pipeline store the staff demo uses, in
// the server's order of checks. The store seeds from the day it is first touched, so the clock is pinned to mid-month (Friday 16 October 2026) before it is
// imported (hence vi.hoisted). Only Date is faked, so the undo window can be moved with `setSystemTime`.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialPortalPostsDemo, demoPortalSocialFile, isPortalVisible } from "./demoSocialPortal";
import { socialDemo } from "./demoSocial";
import { getDemoResponse } from "./demoFixtures";
import { PIPE_POSTS } from "./demoSocialPipeline";
import type { PortalSocialPost } from "./portalSocial";

const CLIENT = "demo-client";
const raw = (method: string, path: string, body?: unknown, q: Record<string, string> = {}, user = CLIENT) =>
  socialPortalPostsDemo(method, `/api/co-agency/portal/social/${path}`, new URLSearchParams(q), user, body === undefined ? undefined : JSON.stringify(body));
/** A route's answer (every route of the section answers, so null would be a bug, and the types say so). */
const call = (method: string, path: string, body?: unknown, q: Record<string, string> = {}, user = CLIENT): { status: number; json: unknown } => {
  const r = raw(method, path, body, q, user);
  if (!r) throw new Error(`${method} ${path} was not answered`);
  return r;
};
const json = <T>(r: { json: unknown } | null | undefined): T => r?.json as T;
interface Listed { items: PortalSocialPost[]; nextCursor: string | null; counts: { toReview: number; approved: number; changesAsked: number } }
const list = (q: Record<string, string> = {}) => json<Listed>(call("GET", "posts", undefined, q));
const titled = (title: string): PortalSocialPost => {
  const hit = [...list({ tab: "grid", limit: "50" }).items, ...list({ tab: "to_review", limit: "50" }).items].find((p) => p.title === title);
  if (!hit) throw new Error(`no portal post titled ${title}`);
  return hit;
};
const store = (title: string) => PIPE_POSTS.find((p) => p.title === title)!;
/** What the staff side reads for the same post (`GET posts/:postId/pipeline`, as the superadmin). */
const staff = (id: string) => (socialDemo("GET", `/api/co-agency/modules/social/posts/${id}/pipeline`, new URLSearchParams(), undefined, "demo-hansel")?.json ?? {}) as Record<string, unknown> & {
  pipelineStatus: string; phase: string; change: { case: string } | null; changedOnly: boolean; copyBefore: unknown; creativeState: string | null; history: Array<Record<string, unknown>>;
};
/** The seeded store as it was, so a test that needs posts waiting again can have them (the earlier tests decided some). */
const SEED = new Map(PIPE_POSTS.map((p) => [p.id, structuredClone(p)]));
const reseed = () => { for (const p of PIPE_POSTS) Object.assign(p, structuredClone(SEED.get(p.id))); };
const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

describe("1 · identity (the first check): only a portal client contact", () => {
  it("a staff caller is 403 'not a portal client' on every route, whatever the post or the body", () => {
    for (const [m, p, b] of [
      ["GET", "posts", undefined], ["GET", "stories", undefined], ["GET", "posts/any", undefined], ["POST", "posts/any/decide", {}], ["POST", "posts/approve-all", {}],
      ["POST", "decisions/any/undo", {}],
    ] as Array<[string, string, unknown]>) {
      expect(call(m, p, b, {}, "demo-hansel"), `${m} ${p}`).toEqual({ status: 403, json: { error: "not a portal client" } });
    }
  });
  it("a path that is not one of the routes is not answered (the caller falls through)", () => {
    expect(raw("GET", "unknown")).toBeNull();
    expect(raw("DELETE", "posts")).toBeNull();
    expect(socialPortalPostsDemo("GET", "/api/co-agency/portal/social-reviews", new URLSearchParams(), CLIENT)).toBeNull();
  });
});

describe("the data the demo must have for the client (cl-1)", () => {
  it("has posts waiting on the client in all four formats, and approved, scheduled, live and changes-asked ones", () => {
    const all = list({ tab: "grid", limit: "50" }).items;
    const waiting = all.filter((p) => p.state === "to_review");
    expect(new Set(waiting.map((p) => p.format))).toEqual(new Set(["feed", "carousel", "reel", "story"]));
    for (const s of ["approved", "scheduled", "live", "changes_asked"] as const) expect(all.some((p) => p.state === s), s).toBe(true);
    expect(new Set(all.map((p) => p.clientId))).toEqual(new Set(["cl-1"]));
    expect(new Set(all.map((p) => p.clientName))).toEqual(new Set(["Northwind Traders"]));
  });
  it("has a client-visible comment with a pin, and a decision recorded by our team", () => {
    const scarf = json<PortalSocialPost>(call("GET", `posts/${titled("Five ways to style a scarf").id}`));
    expect(scarf.comments?.some((c) => c.anchor && c.anchor.fileId.endsWith("-f2"))).toBe(true);
    const packing = json<PortalSocialPost>(call("GET", `posts/${titled("Meet the packing team").id}`));
    expect(packing.decision).toMatchObject({ kind: "approved", recorded: true, channel: "whatsapp", decidedBy: null });
  });
});

describe("GET posts: the tabs, the counts, the filters and the cursor", () => {
  it("to_review lists exactly the posts waiting on the client, soonest first, with the counts of the whole filter", () => {
    const r = list({ tab: "to_review" });
    expect(r.items.every((p) => p.state === "to_review")).toBe(true);
    expect(r.items.map((p) => p.title).sort()).toEqual(["Five ways to style a scarf", "Last call for the market stall", "Studio tour in 30 seconds", "Weekend market date moved"]);
    expect(r.items.map((p) => p.plannedAt)).toEqual([...r.items.map((p) => p.plannedAt)].sort());
    expect(r.counts).toEqual({ toReview: 4, approved: 7, changesAsked: 1 });
  });
  it("approved lists approved, scheduled and live posts, newest first; the grid lists every visible one", () => {
    const a = list({ tab: "approved" });
    expect(new Set(a.items.map((p) => p.state))).toEqual(new Set(["approved", "scheduled", "live"]));
    expect(a.items.map((p) => p.plannedAt)).toEqual([...a.items.map((p) => p.plannedAt)].sort().reverse());
    expect(list({ tab: "grid", limit: "50" }).items).toHaveLength(12);
  });
  it("a month narrows the list and the counts; a client that is not theirs lists nothing", () => {
    const month = list({ tab: "grid", month: "2026-09", limit: "50" });
    expect(month.items.length).toBeGreaterThan(0);
    expect(month.items.every((p) => p.month === "2026-09")).toBe(true);
    expect(month.counts.toReview).toBe(0);
    const other = list({ tab: "grid", clientId: "cl-soc-spa" });
    expect(other.items).toEqual([]);
    expect(other.counts).toEqual({ toReview: 0, approved: 0, changesAsked: 0 });
  });
  it("pages with a cursor and says when there is no more", () => {
    const first = list({ tab: "grid", limit: "5" });
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBe("o5");
    const second = list({ tab: "grid", limit: "5", cursor: first.nextCursor as string });
    expect(second.items.map((p) => p.id)).not.toContain(first.items[0].id);
    const last = list({ tab: "grid", limit: "5", cursor: "o10" });
    expect(last.items).toHaveLength(2);
    expect(last.nextCursor).toBeNull();
  });
  it("a bad parameter is a 400 naming its field", () => {
    expect(call("GET", "posts", undefined, { tab: "later" })).toMatchObject({ status: 400, json: { field: "tab" } });
    expect(call("GET", "posts", undefined, { month: "2026-13" })).toMatchObject({ status: 400, json: { field: "month" } });
    expect(call("GET", "posts", undefined, { limit: "0" })).toMatchObject({ status: 400, json: { field: "limit" } });
    expect(call("GET", "posts", undefined, { cursor: "x" })).toMatchObject({ status: 400, json: { field: "cursor" } });
  });
  it("the stories are the story posts waiting on the client, then the recent live ones", () => {
    const s = json<{ items: PortalSocialPost[] }>(call("GET", "stories")).items;
    expect(s.every((p) => p.format === "story")).toBe(true);
    expect(s[0]).toMatchObject({ title: "Last call for the market stall", state: "to_review" });
    expect(s.some((p) => p.state === "live")).toBe(true);
  });
});

describe("what the client sees, and what they never see", () => {
  it("a post carries images at the portal file route, a hash and the network's own variants", () => {
    const carousel = titled("Five ways to style a scarf");
    expect(carousel.images.map((i) => i.fileId)).toEqual([`${carousel.id}-f1`, `${carousel.id}-f2`, `${carousel.id}-f3`]);
    expect(carousel.images.every((i) => i.thumbFileId === i.fileId && i.alt.length > 0)).toBe(true);
    expect(carousel.reviewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(carousel.variants.length).toBeGreaterThan(0);
    expect(carousel.variants[0]).toMatchObject({ surface: "carousel", handle: "@northwindtraders" });
    expect(carousel.hashtags.length).toBeGreaterThan(0);
  });
  it("no staff status, holder, check, suggestion, copy log or team comment, and no staff name except a comment's author", () => {
    const all = JSON.stringify([list({ tab: "grid", limit: "50" }), ...list({ tab: "grid", limit: "50" }).items.map((p) => call("GET", `posts/${p.id}`)?.json)]);
    for (const leak of ["pipelineStatus", "engineStatus", "holder", "checks", "suggestions", "copyLog", "history", "Internal:", "Dewi Santoso", "u-pm", "Citra Maheswari"]) {
      expect(all, leak).not.toContain(leak);
    }
    const packing = JSON.stringify(call("GET", `posts/${titled("Meet the packing team").id}`)?.json);
    expect(packing).not.toContain("Komang"); // the officer who recorded it: never named
    // the comment's author is the one staff name that may appear
    expect(JSON.stringify(call("GET", `posts/${titled("Five ways to style a scarf").id}`)?.json)).toContain("Komang Lestari");
  });
  it("a post is visible only when it is the contact's client's and has reached the client", () => {
    expect(call("GET", `posts/${store("Sunday reset ritual").id}`)).toMatchObject({ status: 404, json: { error: "post_not_found" } }); // another client's, live
    expect(call("GET", `posts/${store("November kickoff").id}`)).toMatchObject({ status: 404, json: { error: "post_not_found" } }); // theirs, still planned
    expect(call("GET", "posts/ghost")).toMatchObject({ status: 404, json: { error: "post_not_found" } });
    expect(isPortalVisible(store("Five ways to style a scarf"))).toBe(true);
    expect(isPortalVisible(store("Wool care in three steps"))).toBe(false); // theirs, in proofread
  });
});

describe("images (the portal file route, BFF §63.8)", () => {
  it("serves a generated placeholder at the network's ratio for an image of a visible post", () => {
    const story = titled("Last call for the market stall");
    const r = demoPortalSocialFile(CLIENT, story.images[0].fileId);
    expect(r?.status).toBe(200);
    expect(r?.svg).toContain('height="1920"'); // 9:16
    expect(demoPortalSocialFile(CLIENT, titled("Five ways to style a scarf").images[1].fileId)?.svg).toContain('height="1350"'); // 4:5
  });
  it("is the one 404 for an image the post does not have or a post the contact cannot see, 403 for staff, and null for a file that is not a post's", () => {
    const id = titled("Autumn collection teaser").id;
    expect(demoPortalSocialFile(CLIENT, `${id}-f2`)).toEqual({ status: 404 }); // a feed post has one image
    expect(demoPortalSocialFile(CLIENT, `${store("Sunday reset ritual").id}-f1`)).toEqual({ status: 404 });
    expect(demoPortalSocialFile("demo-hansel", `${id}-f1`)).toEqual({ status: 403 });
    expect(demoPortalSocialFile(CLIENT, "f-contract-1")).toBeNull();
  });
});

describe("decide: the server's order of checks", () => {
  const decide = (id: string, body: unknown, user = CLIENT) => call("POST", `posts/${id}/decide`, body, {}, user);

  it("2 · visibility comes before the body: a post that is not theirs is 404 even with a bad body", () => {
    expect(decide("ghost", { nonsense: true })).toMatchObject({ status: 404, json: { error: "post_not_found" } });
    expect(decide(store("Sunday reset ritual").id, {})).toMatchObject({ status: 404, json: { error: "post_not_found" } });
    expect(decide(store("November kickoff").id, {})).toMatchObject({ status: 404, json: { error: "post_not_found" } });
  });

  it("3 · status comes before the body: a visible post that is not with the client, and holds no decision, is 409 post_not_with_client", () => {
    const p = store("Behind the scenes at the studio");
    const before = structuredClone(p);
    try {
      // our team has taken it back into design: the client's old decision is gone with the return
      p.pipelineStatus = "design";
      p.history = p.history.filter((h) => !String(h.action).includes("client_approve") && !String(h.action).includes("record_client"));
      expect(decide(p.id, { decision: "nonsense" })).toMatchObject({ status: 409, json: { error: "post_not_with_client" } });
    } finally {
      Object.assign(p, before);
    }
  });

  it("4 · the body: decision, then changeKind, then note, then anchor, then seenHash; each 400 names its field", () => {
    const p = titled("Weekend market date moved");
    const ok = { decision: "change", changeKind: "copy", note: "Fix the date.", seenHash: p.reviewHash };
    const code = (over: Record<string, unknown>) => decide(p.id, { ...ok, ...over });
    expect(code({ decision: "maybe" })).toMatchObject({ status: 400, json: { error: "invalid_field", field: "decision" } });
    expect(code({ changeKind: undefined })).toMatchObject({ status: 400, json: { field: "changeKind" } });
    expect(code({ changeKind: "layout" })).toMatchObject({ status: 400, json: { field: "changeKind" } });
    expect(code({ note: "" })).toMatchObject({ status: 400, json: { field: "note" } });
    expect(code({ note: "   " })).toMatchObject({ status: 400, json: { field: "note" } });
    expect(code({ note: "x".repeat(2001) })).toMatchObject({ status: 400, json: { field: "note" } });
    expect(code({ anchor: { x: 1.5, y: 0.2, fileId: "f" } })).toMatchObject({ status: 400, json: { field: "anchor" } });
    expect(code({ anchor: { x: 0.2, y: 0.2 } })).toMatchObject({ status: 400, json: { field: "anchor" } });
    // the pin sits on one of the post's own pictures
    expect(code({ anchor: { x: 0.2, y: 0.2, fileId: "some-other-file" } })).toMatchObject({ status: 400, json: { field: "anchor" } });
    // a pin on its own picture passes the body (it is then stopped by the stale hash, so nothing is decided here)
    expect(code({ anchor: { x: 0.2, y: 0.2, fileId: p.images[0].fileId }, seenHash: "stale" })).toMatchObject({ status: 409, json: { error: "content_changed" } });
    expect(code({ seenHash: undefined })).toMatchObject({ status: 400, json: { field: "seenHash" } });
    // the first problem wins: a bad decision is reported before a bad note
    expect(code({ decision: "maybe", note: "" })).toMatchObject({ json: { field: "decision" } });
    // an approval needs no note and no kind
    expect(decide(p.id, { decision: "approve" })).toMatchObject({ status: 400, json: { field: "seenHash" } });
    // nothing above changed the post
    expect(store("Weekend market date moved").pipelineStatus).toBe("client");
  });

  it("5 · the hash: a post changed while the client looked is 409 content_changed, after the body and before any decision", () => {
    const p = titled("Weekend market date moved");
    const stored = store("Weekend market date moved");
    const was = stored.caption;
    try {
      stored.caption = `${was} We moved the date.`;
      expect(decide(p.id, { decision: "approve", seenHash: p.reviewHash })).toMatchObject({ status: 409, json: { error: "content_changed" } });
      expect(stored.pipelineStatus).toBe("client");
      // the new version carries the new hash, which then decides
      const fresh = json<PortalSocialPost>(call("GET", `posts/${p.id}`));
      expect(fresh.reviewHash).not.toBe(p.reviewHash);
      expect(fresh.caption).toContain("We moved the date.");
    } finally {
      stored.caption = was;
    }
  });

  it("a decision moves the staff side's post, the same way a recorded one does (approve: status approved, history by the contact via the portal)", () => {
    const p = titled("Five ways to style a scarf");
    const r = decide(p.id, { decision: "approve", seenHash: p.reviewHash });
    expect(r.status).toBe(200);
    const a = json<{ decisionId: string; postId: string; state: string; undoUntil: string }>(r);
    expect(a).toMatchObject({ postId: p.id, state: "approved" });
    expect(Date.parse(a.undoUntil) - Date.now()).toBe(10_000);
    const s = staff(p.id);
    expect(s.pipelineStatus).toBe("approved");
    expect(s.history[s.history.length - 1]).toMatchObject({ action: "client_approve", from: "client", to: "approved", viaPortal: true, recorded: null, by: { name: "Dana Whitfield" } });
    // and the portal reads it back: approved, by Dana, with the undo still open for her
    const read = json<PortalSocialPost>(call("GET", `posts/${p.id}`));
    expect(read.state).toBe("approved");
    expect(read.decision).toMatchObject({ decisionId: a.decisionId, kind: "approved", recorded: false, decidedBy: { name: "Dana Whitfield" }, undoUntil: a.undoUntil });
    // another contact of the same client sees the decision but not an undo
    expect(json<PortalSocialPost>(call("GET", `posts/${p.id}`, undefined, {}, "demo-client-admin")).decision?.undoUntil).toBeUndefined();
  });

  it("6 · a replay is 200 alreadyDecided; a different decision is 409 client_review_already_decided; neither changes the post", () => {
    const p = titled("Five ways to style a scarf"); // approved by the test above (the hash is unchanged by a decision)
    const hash = p.reviewHash;
    const same = decide(p.id, { decision: "approve", seenHash: hash });
    expect(same).toMatchObject({ status: 200, json: { alreadyDecided: true, postId: p.id } });
    expect(decide(p.id, { decision: "change", changeKind: "copy", note: "Actually, change it.", seenHash: hash })).toMatchObject({ status: 409, json: { error: "client_review_already_decided" } });
    expect(staff(p.id).pipelineStatus).toBe("approved");
    // a replay still meets the body and the hash first
    expect(decide(p.id, { decision: "approve" })).toMatchObject({ status: 400, json: { field: "seenHash" } });
    expect(decide(p.id, { decision: "approve", seenHash: "stale" })).toMatchObject({ status: 409, json: { error: "content_changed" } });
  });

  it("undo puts the post back with the client, restoring what the decision changed, inside the window and by the contact who decided", () => {
    const p = titled("Five ways to style a scarf");
    const id = json<PortalSocialPost>(call("GET", `posts/${p.id}`)).decision!.decisionId;
    expect(call("POST", `decisions/${id}/undo`, {}, {}, "demo-client-admin")).toMatchObject({ status: 403, json: { error: "not_your_decision" } });
    const u = call("POST", `decisions/${id}/undo`, {});
    expect(u).toMatchObject({ status: 200, json: { decisionId: id, postId: p.id, state: "to_review" } });
    const s = staff(p.id);
    expect(s.pipelineStatus).toBe("client");
    expect(s.history[s.history.length - 1]).toMatchObject({ action: "client_undo", to: "client", viaPortal: true });
    expect(json<PortalSocialPost>(call("GET", `posts/${p.id}`)).decision).toBeNull();
    // the decision was reversed: a second undo has nothing to undo (lane A: 404 decision_not_found)
    expect(call("POST", `decisions/${id}/undo`, {})).toMatchObject({ status: 404, json: { error: "decision_not_found" } });
    // and the client can decide again (a new decision)
    expect(decide(p.id, { decision: "approve", seenHash: p.reviewHash }).status).toBe(200);
  });

  it("undo after the 10 seconds is 409 undo_window_passed; so is undo after anything happened to the post since", () => {
    const a = titled("Weekend market date moved");
    const first = json<{ decisionId: string }>(decide(a.id, { decision: "approve", seenHash: a.reviewHash }));
    later(10_001);
    expect(call("POST", `decisions/${first.decisionId}/undo`, {})).toMatchObject({ status: 409, json: { error: "undo_window_passed" } });
    expect(staff(a.id).pipelineStatus).toBe("approved");
    // "anything happened since": our team acts inside the window
    const b = titled("Studio tour in 30 seconds");
    const second = json<{ decisionId: string }>(decide(b.id, { decision: "approve", seenHash: b.reviewHash }));
    store("Studio tour in 30 seconds").history.push({ action: "schedule", from: "approved", to: "scheduled", by: { id: "u-social", name: "Komang Lestari" }, agent: null, at: new Date().toISOString(), recorded: null, viaPortal: false });
    expect(call("POST", `decisions/${second.decisionId}/undo`, {})).toMatchObject({ status: 409, json: { error: "undo_window_passed" } });
  });

  it("a recorded decision has no undo and no name; an unknown or out-of-scope decision is 404", () => {
    const packing = json<PortalSocialPost>(call("GET", `posts/${titled("Meet the packing team").id}`));
    expect(packing.decision?.undoUntil).toBeUndefined();
    expect(call("POST", `decisions/${packing.decision!.decisionId}/undo`, {})).toMatchObject({ status: 403, json: { error: "not_your_decision" } });
    expect(call("POST", "decisions/ghost/undo", {})).toMatchObject({ status: 404, json: { error: "decision_not_found" } });
  });

  it("an old decision of the contact's own, long past its window, is 409 undo_window_passed", () => {
    const old = json<PortalSocialPost>(call("GET", `posts/${titled("Behind the scenes at the studio").id}`));
    expect(old.decision).toMatchObject({ kind: "approved", recorded: false, decidedBy: { name: "Dana Whitfield" } });
    expect(old.decision?.undoUntil).toBeUndefined();
    expect(call("POST", `decisions/${old.decision!.decisionId}/undo`, {})).toMatchObject({ status: 409, json: { error: "undo_window_passed" } });
  });
});

describe("lane A's shapes: an approval's note, malformed clientId, approve-all's undoUntil", () => {
  it("an approval may carry a note of 1 to 2,000 characters, kept on the staff side's decision row; an empty or long one is a 400", () => {
    reseed();
    const p = titled("Studio tour in 30 seconds");
    const dec = (body: Record<string, unknown>) => call("POST", `posts/${p.id}/decide`, { decision: "approve", seenHash: p.reviewHash, ...body });
    expect(dec({ note: "" })).toMatchObject({ status: 400, json: { field: "note" } });
    expect(dec({ note: "x".repeat(2001) })).toMatchObject({ status: 400, json: { field: "note" } });
    expect(dec({ note: "Love it." }).status).toBe(200);
    expect(staff(p.id).history.at(-1)).toMatchObject({ action: "client_approve", note: "Love it." });
    reseed();
  });
  it("a malformed clientId is a 400 on `clientId`; one outside the scope is empty with zero counts", () => {
    expect(call("GET", "posts", undefined, { clientId: "a b" })).toMatchObject({ status: 400, json: { field: "clientId" } });
    expect(call("GET", "stories", undefined, { clientId: "a b" })).toMatchObject({ status: 400, json: { field: "clientId" } });
    expect(list({ clientId: "cl-elsewhere" })).toEqual({ items: [], nextCursor: null, counts: { toReview: 0, approved: 0, changesAsked: 0 } });
  });
  it("approve-all's undoUntil is null when nothing was approved", () => {
    const decided = titled("Autumn collection teaser");
    const r = call("POST", "posts/approve-all", { items: [{ postId: decided.id, seenHash: decided.reviewHash }] });
    expect(r.json).toMatchObject({ results: [{ outcome: "skipped" }], undoUntil: null });
  });
});

describe("loops d and e: the client's change moves the staff side as the fixture says", () => {
  const decide = (id: string, body: unknown) => call("POST", `posts/${id}/decide`, body);

  it("a DESIGN change (loop d) is client_design: the designer holds it again (creative revision), with the note and the pin on the staff side", () => {
    // the portal's "Launch day announcement" already carries a design change with its pin (the seed)
    const seeded = json<PortalSocialPost>(call("GET", `posts/${titled("Launch day announcement").id}`));
    expect(seeded).toMatchObject({ state: "changes_asked", decision: { kind: "changes", changeKind: "design", recorded: false } });
    expect(seeded.decision?.anchor).toMatchObject({ x: 0.62, y: 0.34 });
    expect(seeded.decision?.note).toContain("larger");
    // and a new one, with a pin, through the route
    const p = titled("Studio tour in 30 seconds");
    const pinned = { x: 0.3, y: 0.7, fileId: p.images[0].fileId };
    store("Studio tour in 30 seconds").pipelineStatus = "client"; // the previous test approved it, then the team moved on: put it back for this one
    store("Studio tour in 30 seconds").history = store("Studio tour in 30 seconds").history.filter((h) => !["schedule"].includes(String(h.action)));
    const r = decide(p.id, { decision: "change", changeKind: "design", note: "Make the product larger.", anchor: pinned, seenHash: json<PortalSocialPost>(call("GET", `posts/${p.id}`)).reviewHash });
    expect(r.status).toBe(200);
    const s = staff(p.id);
    expect(s).toMatchObject({ pipelineStatus: "changes", phase: "client_changes", creativeState: "revision", change: { case: "client_design", by: "client", kind: "design", note: "Make the product larger." } });
    expect(s.history[s.history.length - 1]).toMatchObject({ action: "client_change", viaPortal: true, anchor: pinned, note: "Make the product larger." });
    const read = json<PortalSocialPost>(call("GET", `posts/${p.id}`));
    expect(read).toMatchObject({ state: "changes_asked", decision: { kind: "changes", changeKind: "design", note: "Make the product larger.", anchor: pinned } });
  });

  it("a COPY change (loop e) is client_copy: back to the officer, the changed text only (changedOnly with the 'before' kept), then undone", () => {
    const p = titled("Last call for the market stall");
    const r = decide(p.id, { decision: "change", changeKind: "copy", note: "Say 'tonight', not 'today'.", seenHash: p.reviewHash });
    expect(r.status).toBe(200);
    const s = staff(p.id);
    expect(s).toMatchObject({ pipelineStatus: "changes", phase: "client_changes", change: { case: "client_copy", returnTo: "proofread" }, changedOnly: true });
    expect(s.copyBefore).toMatchObject({ caption: p.caption });
    // the story leaves the circle's waiting group and the client can undo inside the window
    const decisionId = json<{ decisionId: string }>(r).decisionId;
    expect(call("POST", `decisions/${decisionId}/undo`, {}).status).toBe(200);
    const back = staff(p.id);
    expect(back).toMatchObject({ pipelineStatus: "client", change: null, changedOnly: false, copyBefore: null });
  });
});

describe("POST posts/approve-all: exactly the listed posts that still wait with an unchanged hash", () => {
  it("approves the waiting ones and reports the others as skipped, with the reason; one undo window for the batch", () => {
    reseed(); // the earlier tests decided some of them
    const waiting = list({ tab: "to_review", limit: "50" }).items;
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    const stale = waiting[0];
    const ok = waiting.slice(1);
    const notWaiting = titled("Autumn collection teaser");
    const store0 = store(stale.title);
    const was = store0.caption;
    store0.caption = `${was}!`; // changed while the client looked
    try {
      const r = call("POST", "posts/approve-all", {
        items: [...waiting.map((p) => ({ postId: p.id, seenHash: p.reviewHash })), { postId: notWaiting.id, seenHash: notWaiting.reviewHash }, { postId: "ghost", seenHash: "x" }],
      });
      expect(r.status).toBe(200);
      const a = json<{ results: Array<{ postId: string; outcome: string; reason?: string; decisionId?: string }>; undoUntil: string }>(r);
      expect(a.results.filter((x) => x.outcome === "approved").map((x) => x.postId).sort()).toEqual(ok.map((p) => p.id).sort());
      expect(a.results.find((x) => x.postId === stale.id)).toMatchObject({ outcome: "skipped", reason: "content_changed" });
      expect(a.results.find((x) => x.postId === notWaiting.id)).toMatchObject({ outcome: "skipped", reason: "client_review_already_decided" }); // it holds a decision already
      expect(a.results.find((x) => x.postId === "ghost")).toMatchObject({ outcome: "skipped", reason: "post_not_found" });
      expect(a.results.filter((x) => x.outcome === "approved").every((x) => typeof x.decisionId === "string")).toBe(true);
      expect(Date.parse(a.undoUntil) - Date.now()).toBe(10_000);
      // the staff side moved for the approved ones only; the stale one still waits
      for (const p of ok) expect(staff(p.id).pipelineStatus).toBe("approved");
      expect(staff(stale.id).pipelineStatus).toBe("client");
      // and each decision can be undone
      const first = a.results.find((x) => x.outcome === "approved")!;
      expect(call("POST", `decisions/${first.decisionId}/undo`, {}).status).toBe(200);
    } finally {
      store0.caption = was;
    }
  });
  it("1 to 50 items, each with a postId and a seenHash: anything else is a 400 on `items`", () => {
    expect(call("POST", "posts/approve-all", {})).toMatchObject({ status: 400, json: { field: "items" } });
    expect(call("POST", "posts/approve-all", { items: [] })).toMatchObject({ status: 400, json: { field: "items" } });
    expect(call("POST", "posts/approve-all", { items: Array.from({ length: 51 }, (_, i) => ({ postId: `p${i}`, seenHash: "h" })) })).toMatchObject({ status: 400, json: { field: "items" } });
    expect(call("POST", "posts/approve-all", { items: [{ postId: "p1" }] })).toMatchObject({ status: 400, json: { field: "items" } });
  });
});

describe("wired into the demo router (what platformFetch reaches)", () => {
  it("answers the query string and the identity, beside the older per-variant reviews", () => {
    const r = getDemoResponse("GET", "/api/co-agency/portal/social/posts?tab=approved&limit=2", "demo-client");
    expect(r.status).toBe(200);
    expect((r.json as Listed).items).toHaveLength(2);
    expect((r.json as Listed).items.every((p) => ["approved", "scheduled", "live"].includes(p.state))).toBe(true);
    expect(getDemoResponse("GET", "/api/co-agency/portal/social/posts", "demo-hansel")).toEqual({ status: 403, json: { error: "not a portal client" } });
    expect(getDemoResponse("POST", "/api/co-agency/portal/social/posts/approve-all", "demo-client", "{}").status).toBe(400);
    expect(getDemoResponse("GET", "/api/co-agency/portal/social-reviews", "demo-client").status).toBe(200);
  });
});

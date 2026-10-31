import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

// SCP-5e (BFF §63.6.3, §63.26.3): DEMO_MODE's post edit with `savedItemIds`, in the server's order of checks: the gate first (the post, the person, the step, the body), then the list of ids (1 to 10 distinct
// ids, each a live item of the post's client: 400 `savedItemIds`), then the machine's own guards (409 `field_locked`); the use counts rise in the same step as the edit, and only when it applied.
// The store seeds from the day it is first touched, so the clock is pinned to mid-month before it is imported (hence vi.hoisted). Only Date is faked. The stores are shared, so every test names its own post.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { PIPE_POSTS } from "./demoSocialPipeline";
import { socialDemo } from "./demoSocial";
import { asSavedPage } from "./socialSaved";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const OFFICER = "u-social";
const call = (method: string, tail: string, user: string, body?: unknown, query = ""): { status: number; json: Body } =>
  socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), user) as { status: number; json: Body };
const edit = (postId: string, user: string, body: Record<string, unknown>) => call("PATCH", `posts/${postId}/pipeline`, user, body);
const post = (id: string) => PIPE_POSTS.find((p) => p.id === id)!;
const uses = (collection: string): Record<string, number> =>
  Object.fromEntries(asSavedPage(call("GET", "engagements/soc-eng-1/saved", OFFICER, undefined, `collection=${collection}`).json, collection).entries.items.map((i) => [(i as { title: string }).title, (i as { useCount: number }).useCount]));
const idOf = (collection: string, title: string): string => {
  const page = asSavedPage(call("GET", "engagements/soc-eng-1/saved", OFFICER, undefined, `collection=${collection}`).json, collection);
  const hit = (page.entries.items as Array<{ id: string; title: string }>).find((i) => i.title === title);
  if (!hit) throw new Error(`no saved item '${title}'`);
  return hit.id;
};
const refused = (r: { status: number; json: Body }, status: number, code: string, field?: string) => {
  expect([r.status, r.json.error]).toEqual([status, code]);
  if (field) expect(r.json.field).toBe(field);
};

const DRAFT = "soc-post-n-12"; // Northwind, drafting
const PLANNED = "soc-post-n-11"; // Northwind, planned: the copy is locked
const PROOF = "soc-post-n-13"; // Northwind, proofread
const OTHER_DRAFT = "soc-post-h-7"; // another client's, drafting

describe("the post edit with savedItemIds (demo)", () => {
  it("applies the fields and counts one use for each item in the same step, with the time", () => {
    const cap = idOf("captions", "Weekend reminder");
    const tpl = idOf("templates", "Behind the scenes");
    const before = { ...uses("captions"), ...uses("templates") };
    const r = edit(DRAFT, OFFICER, { expectedStatus: "drafting", fields: { caption: "A counted caption" }, savedItemIds: [cap, tpl] });
    expect(r.status).toBe(200);
    expect(r.json.applied).toMatchObject({ action: "edit" });
    expect(post(DRAFT).caption).toBe("A counted caption");
    const after = { ...uses("captions"), ...uses("templates") };
    expect(after["Weekend reminder"]).toBe(before["Weekend reminder"] + 1);
    expect(after["Behind the scenes"]).toBe(before["Behind the scenes"] + 1);
    expect(after["Thank you to the team"]).toBe(before["Thank you to the team"]); // an item not named is not counted
    const item = asSavedPage(call("GET", "engagements/soc-eng-1/saved", OFFICER, undefined, "collection=captions").json, "captions").entries.items as Array<{ id: string; lastUsedAt: string | null; used: boolean }>;
    expect(item.find((i) => i.id === cap)).toMatchObject({ used: true, lastUsedAt: "2026-10-16T04:00:00.000Z" });
  });

  it("an edit without savedItemIds counts nothing and works as before; a second edit counts again", () => {
    const tpl = idOf("templates", "Behind the scenes");
    const before = uses("templates")["Behind the scenes"];
    expect(edit(DRAFT, OFFICER, { expectedStatus: "drafting", fields: { cta: "Plain" } }).status).toBe(200);
    expect(uses("templates")["Behind the scenes"]).toBe(before);
    expect(edit(DRAFT, OFFICER, { expectedStatus: "drafting", fields: { cta: "Once" }, savedItemIds: [tpl] }).status).toBe(200);
    expect(edit(DRAFT, OFFICER, { expectedStatus: "drafting", fields: { cta: "Twice" }, savedItemIds: [tpl] }).status).toBe(200);
    expect(uses("templates")["Behind the scenes"]).toBe(before + 2);
  });

  it("a replayed edit (the same actionId) counts once and answers alreadyApplied", () => {
    const cap = idOf("captions", "Thank you to the team");
    const before = uses("captions")["Thank you to the team"];
    const actionId = randomUUID();
    const body = { expectedStatus: "drafting", fields: { cta: "Replay" }, savedItemIds: [cap], actionId };
    expect(edit(DRAFT, OFFICER, body).json.alreadyApplied).toBeUndefined();
    expect(uses("captions")["Thank you to the team"]).toBe(before + 1);
    expect(edit(DRAFT, OFFICER, body).json.alreadyApplied).toBe(true);
    expect(uses("captions")["Thank you to the team"]).toBe(before + 1);
    refused(edit(DRAFT, OFFICER, { ...body, actionId: "nope" }), 400, "invalid_field", "actionId");
  });

  it("is 400 on `savedItemIds` for another client's item, an unknown or deleted item, or a bad list; the edit is not applied and nothing is counted", () => {
    const cap = idOf("captions", "Weekend reminder");
    const gone = idOf("references", "Competitor-free mood board");
    expect(call("DELETE", `saved/${gone}`, OFFICER).status).toBe(200);
    const all = { ...uses("captions"), ...uses("templates"), ...uses("photos") };
    const caption = post(DRAFT).caption;
    const bad = (ids: unknown, label: string, postId = DRAFT) => {
      const r = edit(postId, OFFICER, { expectedStatus: "drafting", fields: { caption: "Must not land" }, savedItemIds: ids });
      refused(r, 400, "invalid_field", "savedItemIds");
      expect(post(postId).caption, `${label}: not applied`).not.toBe("Must not land");
    };
    bad(["not-an-item"], "an unknown item");
    bad([gone], "a deleted item");
    bad([cap, "not-an-item"], "one good and one unknown");
    bad([cap], "an item of another client", OTHER_DRAFT);
    bad([], "none");
    bad(Array.from({ length: 11 }, (_, i) => `x-${i}`), "eleven");
    bad([cap, cap], "a repeat");
    bad([7], "not an id");
    bad(cap, "not a list");
    bad(null, "null");
    expect(post(DRAFT).caption).toBe(caption);
    expect({ ...uses("captions"), ...uses("templates"), ...uses("photos") }).toEqual(all);
  });

  it("up to ten items are allowed", () => {
    const ids = [...asSavedPage(call("GET", "engagements/soc-eng-1/saved", OFFICER, undefined, "collection=captions").json, "captions").entries.items, ...asSavedPage(call("GET", "engagements/soc-eng-1/saved", OFFICER, undefined, "collection=templates").json, "templates").entries.items]
      .map((i) => (i as { id: string }).id);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    const before = uses("captions");
    expect(edit(DRAFT, OFFICER, { expectedStatus: "drafting", fields: { cta: "Many" }, savedItemIds: ids.slice(0, 10) }).status).toBe(200);
    expect(uses("captions")["Weekend reminder"]).toBe(before["Weekend reminder"] + 1);
  });

  it("answers in the server's order: the gate (404, 403, 409 status, 400 body) before the ids, the ids before the machine's field_locked; a refusal counts nothing", () => {
    const cap = idOf("captions", "Weekend reminder");
    const before = uses("captions");
    // the gate first: an unknown post, a person who may not edit, a stale step, a bad body: every one wins over a bad id list
    refused(edit("soc-post-none", OFFICER, { expectedStatus: "drafting", fields: { caption: "x" }, savedItemIds: ["bad"] }), 404, "post_not_found");
    refused(edit(DRAFT, "u-copy", { expectedStatus: "drafting", fields: { caption: "x" }, savedItemIds: ["bad"] }), 403, "not_the_officer");
    refused(edit(DRAFT, OFFICER, { expectedStatus: "planned", fields: { caption: "x" }, savedItemIds: ["bad"] }), 409, "status_changed");
    refused(edit(DRAFT, OFFICER, { expectedStatus: "drafting", fields: { caption: 7 }, savedItemIds: ["bad"] }), 400, "invalid_field", "caption");
    refused(edit(DRAFT, OFFICER, { expectedStatus: "drafting", savedItemIds: ["bad"] }), 400, "missing_field", "fields");
    // then the ids, before the machine's own guard
    refused(edit(PLANNED, OFFICER, { expectedStatus: "planned", fields: { caption: "Locked" }, savedItemIds: ["bad"] }), 400, "invalid_field", "savedItemIds");
    // and the machine's guard with good ids: field_locked, nothing applied or counted
    refused(edit(PLANNED, OFFICER, { expectedStatus: "planned", fields: { caption: "Locked" }, savedItemIds: [cap] }), 409, "field_locked");
    refused(edit(PROOF, OFFICER, { expectedStatus: "proofread", fields: { caption: "Locked" }, savedItemIds: [cap] }), 409, "invalid_transition");
    expect(post(PLANNED).caption).toBe("");
    expect(uses("captions")).toEqual(before);
  });

  it("the reference images ride the edit as the fixture allows (planned takes rawAssets) and count the link's use", () => {
    // a kept photo link (the mood board was deleted by an earlier test)
    const photo = (asSavedPage(call("GET", "engagements/soc-eng-1/saved", OFFICER, undefined, "collection=photos").json, "photos").entries.items as Array<{ savedItemId: string | null; holds: string; title: string; url: string | null }>)
      .find((p) => p.savedItemId && p.holds === "link")!;
    const r = edit(PLANNED, OFFICER, {
      expectedStatus: "planned", fields: { rawAssets: [{ url: photo.url, label: photo.title, source: "stock", aiNote: null }] }, savedItemIds: [photo.savedItemId],
    });
    expect(r.status).toBe(200);
    expect(post(PLANNED).rawAssets).toHaveLength(1);
  });
});

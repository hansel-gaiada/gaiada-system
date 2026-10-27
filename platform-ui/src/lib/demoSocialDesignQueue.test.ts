import { describe, it, expect, afterAll } from "vitest";

// SCP-1h (BFF §63.6.6, §63.16): DEMO_MODE answers the designer's queue and the request detail's `socialPosts` from the demo pipeline store, so the
// page and the request page work with no backend. The store seeds from the day it is first touched, so the clock is pinned to mid-month (Friday 16
// October 2026, midday in Singapore) before it is imported (hence vi.hoisted). Only Date is faked.
import { vi } from "vitest";
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { getDemoResponse } from "./demoFixtures";
import { demoDesignQueue, demoMonthRequests, demoRequestSocialPosts } from "./demoSocialDesignQueue";
import { asDesignQueue } from "./socialDesignQueue";

const queue = (userId: string, q: Record<string, string> = {}) => socialDemo("GET", "/api/co-agency/modules/social/design-queue", new URLSearchParams(q), undefined, userId);
const page = (userId: string, q: Record<string, string> = {}) => asDesignQueue(queue(userId, q)?.json);

describe("GET design-queue in the demo", () => {
  it("is routed by the social demo and parses as the contract's list", () => {
    const r = queue("u-creative");
    expect(r?.status).toBe(200);
    const p = asDesignQueue(r?.json);
    expect(p.nextCursor).toBeNull();
    expect(Object.keys((r?.json as { items: Array<Record<string, unknown>> }).items[0]).sort()).toEqual([
      "clientName", "creativeState", "format", "health", "postId", "readyBy", "revisionNote", "thumbFileId", "title",
    ]);
  });

  it("gives the Creatives designer the posts of the Creatives clients at the design step, and a revision its note", () => {
    const titles = page("u-creative").items.map((i) => i.title).sort();
    expect(titles).toEqual(["Banquet room open day", "Launch day announcement"]);
    const revision = page("u-creative").items.find((i) => i.title === "Launch day announcement")!;
    expect(revision).toMatchObject({
      clientName: "Northwind Traders", creativeState: "revision", revisionNote: "Please make the product larger and move the logo to the top corner.",
    });
    const plain = page("u-creative").items.find((i) => i.title === "Banquet room open day")!;
    expect(plain).toMatchObject({ clientName: "Harborlight Hotel", creativeState: "in_progress", revisionNote: null });
  });

  it("gives the in-team designer only the in-team client's posts", () => {
    const items = page("u-social-design").items;
    expect(items.map((i) => i.title).sort()).toEqual(["Candlelit couples room", "Hot stone, step by step", "Winter warmth menu"]);
    expect(items.every((i) => i.clientName === "Saltmarsh Day Spa")).toBe(true);
    expect(items.find((i) => i.title === "Candlelit couples room")).toMatchObject({ revisionNote: "The text sits on a bright patch; move it lower.", creativeState: "revision" });
    expect(items.find((i) => i.title === "Winter warmth menu")).toMatchObject({ creativeState: "not_started", revisionNote: null });
  });

  it("gives everyone else an honest empty list, the HoD and the superadmin included, and refuses a client contact at the gate", () => {
    for (const who of ["u-pm", "u-gm", "demo-hansel", "demo-owner", "u-social", "u-copy"]) expect(page(who).items, who).toEqual([]);
    expect(queue("demo-client")?.status).toBe(403);
  });

  it("carries each post's health with its ready-by, and orders by ready-by", () => {
    const items = page("u-social-design").items;
    expect(items.every((i) => i.health && i.health.readyBy === i.readyBy)).toBe(true);
    const readyBys = items.map((i) => i.readyBy);
    expect(readyBys).toEqual([...readyBys].sort());
  });

  it("pages with an opaque cursor and refuses a bad limit or cursor with the field", () => {
    const first = page("u-social-design", { limit: "2" });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = page("u-social-design", { limit: "2", cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((i) => i.postId);
    expect(new Set(all).size).toBe(3);
    for (const [q, field] of [[{ limit: "0" }, "limit"], [{ limit: "101" }, "limit"], [{ limit: "x" }, "limit"], [{ cursor: "garbage" }, "cursor"]] as const) {
      expect(queue("u-social-design", q)).toMatchObject({ status: 400, json: { error: "invalid_field", field } });
    }
  });

  it("is answered through the demo response router like every other route", () => {
    const r = getDemoResponse("GET", "/api/co-agency/modules/social/design-queue", "u-creative");
    expect(r.status).toBe(200);
    expect(asDesignQueue(r.json).items.length).toBe(2);
    expect(demoDesignQueue("u-creative", new URLSearchParams()).status).toBe(200);
  });
});

describe("the request detail's socialPosts in the demo", () => {
  it("names the month requests the demo posts join, one per Creatives client and month", () => {
    const requests = demoMonthRequests();
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.some((r) => r.title === "Northwind Traders · October 2026 social designs")).toBe(true);
    expect(new Set(requests.map((r) => r.id)).size).toBe(requests.length);
  });

  it("lists the posts that joined a month request, each with a link to its post page", () => {
    const r = demoMonthRequests().find((x) => x.title === "Northwind Traders · October 2026 social designs")!;
    const posts = demoRequestSocialPosts(r.id, "dept-4");
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) {
      expect(Object.keys(p).sort()).toEqual(["clientName", "creativeState", "href", "pipelineStatus", "postId", "title"]);
      expect(p).toMatchObject({ clientName: "Northwind Traders", href: `/departments/dept-4/posts/${String(p.postId)}` });
    }
    expect(demoRequestSocialPosts("no-such-request", "dept-4")).toEqual([]);
  });

  it("answers GET requests/:id for a month request (not listed), and [] for a hand-filed one", () => {
    const m = demoMonthRequests()[0];
    const detail = getDemoResponse("GET", `/api/co-agency/requests/${m.id}`, "demo-hansel");
    expect(detail.status).toBe(200);
    const body = detail.json as { id: string; title: string; kind: string; socialPosts: Array<{ postId: string }> };
    expect(body).toMatchObject({ id: m.id, title: m.title, kind: "assets" });
    expect(body.socialPosts.length).toBeGreaterThan(0);
    const hand = getDemoResponse("GET", "/api/co-agency/requests/wr-same-1", "demo-hansel");
    expect((hand.json as { socialPosts: unknown[] }).socialPosts).toEqual([]);
    const listed = getDemoResponse("GET", "/api/co-agency/requests?box=incoming&unitId=dept-2&status=all", "demo-hansel").json as Array<{ id: string }> | { rows?: Array<{ id: string }> };
    const ids = (Array.isArray(listed) ? listed : listed.rows ?? []).map((r) => r.id);
    expect(ids).not.toContain(m.id);
  });
});

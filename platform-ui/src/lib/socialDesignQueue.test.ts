import { describe, it, expect } from "vitest";
import {
  asDesignQueue, creativeStateLabel, designQueuePostHref, formatLabel, DESIGN_QUEUE_PAGE_SIZE,
} from "./socialDesignQueue";

// SCP-1h (BFF §63.6.6): the design queue's parsing and words. A 200 with the wrong shape reads as "cannot tell" (a throw the reader turns into
// `unavailable`), never as a plausible-looking empty queue.

const wireItem = (over: Record<string, unknown> = {}) => ({
  postId: "p-1", clientName: "Brand Alpha", title: "Morning pastries", format: "feed", creativeState: "in_progress", revisionNote: null,
  readyBy: "2026-11-04", health: { state: "on_track", spareDays: 3, lateDays: null, lateWith: null, latestSafeHandoff: "2026-11-02", readyBy: "2026-11-04" },
  thumbFileId: null, ...over,
});

describe("asDesignQueue", () => {
  it("reads the contract's list and cursor", () => {
    const p = asDesignQueue({ items: [wireItem(), wireItem({ postId: "p-2", revisionNote: "Move the logo.", thumbFileId: "f-1" })], nextCursor: "abc" });
    expect(p.nextCursor).toBe("abc");
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toEqual({
      postId: "p-1", clientName: "Brand Alpha", title: "Morning pastries", format: "feed", creativeState: "in_progress", revisionNote: null, readyBy: "2026-11-04",
      health: { state: "on_track", spareDays: 3, lateDays: null, lateWith: null, latestSafeHandoff: "2026-11-02", readyBy: "2026-11-04" }, thumbFileId: null,
    });
    expect(p.items[1]).toMatchObject({ revisionNote: "Move the logo.", thumbFileId: "f-1" });
  });

  it("reads an empty list and the end of the list (a null cursor)", () => {
    expect(asDesignQueue({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    expect(asDesignQueue({ items: [wireItem()] }).nextCursor).toBeNull();
  });

  it("keeps a post whose format, creative state or health the server did not give", () => {
    const [it1] = asDesignQueue({ items: [wireItem({ format: null, creativeState: null, health: null })] }).items;
    expect(it1).toMatchObject({ format: null, creativeState: null, health: null });
    const [bad] = asDesignQueue({ items: [wireItem({ health: { state: "nonsense" } })] }).items;
    expect(bad.health).toBeNull(); // an unknown state is no health, never a guessed one
  });

  it("falls back to a neutral client name rather than showing nothing", () => {
    expect(asDesignQueue({ items: [wireItem({ clientName: "" })] }).items[0].clientName).toBe("A client");
  });

  it("throws on a body that is not the list, so the reader says it cannot tell", () => {
    for (const bad of [null, "nope", [], {}, { items: "x" }, { items: [null] }, { items: [wireItem({ postId: "" })] }, { items: [wireItem({ readyBy: null })] }, { items: [wireItem({ title: 5 })] }]) {
      expect(() => asDesignQueue(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("the words and the link", () => {
  it("words the four creative states, and a post with none as not started", () => {
    expect(["not_started", "in_progress", "revision", "submitted"].map(creativeStateLabel)).toEqual(["Not started", "In progress", "Revision", "Submitted"]);
    expect(creativeStateLabel(null)).toBe("Not started");
    expect(creativeStateLabel("odd")).toBe("odd");
  });
  it("words the formats", () => {
    expect(["feed", "carousel", "reel", "story"].map(formatLabel)).toEqual(["Feed", "Carousel", "Reel", "Story"]);
    expect(formatLabel(null)).toBe("No format yet");
  });
  it("links to the post page of the department, with both ids escaped", () => {
    expect(designQueuePostHref("d-soc", "p-1")).toBe("/departments/d-soc/posts/p-1");
    expect(designQueuePostHref("d/x", "p 1")).toBe("/departments/d%2Fx/posts/p%201");
  });
  it("asks for a page of 30, the contract's default", () => {
    expect(DESIGN_QUEUE_PAGE_SIZE).toBe(30);
  });
});

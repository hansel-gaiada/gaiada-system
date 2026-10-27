import { describe, it, expect } from "vitest";
import { normalizeRequestDetail, socialPostStatusText } from "./requests";

// SCP-1h (BFF §63.6.6): the request detail's additive `socialPosts`, read defensively. An older backend that sends none reads as [], and a row that
// cannot be a post is dropped alone, never the whole list.
const wire = (over: Record<string, unknown> = {}) => ({
  id: "i1", kind: "assets", title: "Brand Alpha · November 2026 social designs", status: "open", neededBy: "2026-11-04", createdAt: "2026-10-12T03:00:00.000Z", closedAt: null,
  fromUnit: null, toUnit: { id: "dept-2", name: "Creatives", unitMissing: false }, requestedBy: { id: "u-1", name: "Dewi" }, campaign: null,
  work: { type: "pm_task", id: "t1", projectId: null, status: "in_progress", isDone: false, responsibleName: null }, assetCount: 0,
  brief: "", form: { deliverables: [] }, declineReason: null, assets: [], ...over,
});

describe("normalizeRequestDetail: socialPosts", () => {
  it("reads each post's fields", () => {
    const d = normalizeRequestDetail(wire({
      socialPosts: [{ postId: "p-1", title: "Morning pastries", clientName: "Brand Alpha", pipelineStatus: "design", creativeState: "not_started", href: "/departments/d-soc/posts/p-1" }],
    }))!;
    expect(d.socialPosts).toEqual([{
      postId: "p-1", title: "Morning pastries", clientName: "Brand Alpha", pipelineStatus: "design", creativeState: "not_started", href: "/departments/d-soc/posts/p-1",
    }]);
  });
  it("reads [] when the backend sends none, or sends something that is not a list", () => {
    expect(normalizeRequestDetail(wire())!.socialPosts).toEqual([]);
    expect(normalizeRequestDetail(wire({ socialPosts: null }))!.socialPosts).toEqual([]);
    expect(normalizeRequestDetail(wire({ socialPosts: "p-1" }))!.socialPosts).toEqual([]);
  });
  it("drops a row that cannot be a post and keeps the others; a missing link or state reads as null", () => {
    const d = normalizeRequestDetail(wire({ socialPosts: [null, { title: "no id" }, { postId: "p-2", pipelineStatus: "hod" }] }))!;
    expect(d.socialPosts).toEqual([{ postId: "p-2", title: "Untitled post", clientName: "", pipelineStatus: "hod", creativeState: null, href: null }]);
  });
  it("leaves every other field as it was", () => {
    const d = normalizeRequestDetail(wire({ socialPosts: [] }))!;
    expect(d).toMatchObject({ id: "i1", brief: "", declineReason: null, assets: [], kind: "assets" });
  });
});

describe("socialPostStatusText", () => {
  it("says where a post stands in plain words", () => {
    expect(socialPostStatusText({ pipelineStatus: "design", creativeState: "in_progress" })).toBe("To design · in progress");
    expect(socialPostStatusText({ pipelineStatus: "changes", creativeState: "revision" })).toBe("Changes asked for · revision");
    expect(socialPostStatusText({ pipelineStatus: "final", creativeState: "submitted" })).toBe("Final check · submitted");
    expect(socialPostStatusText({ pipelineStatus: "hod", creativeState: null })).toBe("With the head of department");
    expect(socialPostStatusText({ pipelineStatus: "odd", creativeState: null })).toBe("odd");
  });
});

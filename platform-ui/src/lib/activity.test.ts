import { describe, it, expect } from "vitest";
import { humanizeVerb, objectLabel, activityHref, actorLabel } from "./activity";

describe("humanizeVerb", () => {
  it("takes the segment after the last dot and de-underscores it", () => {
    expect(humanizeVerb("task.status_changed")).toBe("status changed");
    expect(humanizeVerb("created")).toBe("created");
    expect(humanizeVerb("brief_approved")).toBe("brief approved");
  });
});

describe("objectLabel", () => {
  it("capitalizes objectKind and prefers title over objectRef", () => {
    expect(objectLabel({ objectKind: "pm_task", title: "Fix login redirect", objectRef: "t-1" })).toBe(
      "Pm task: Fix login redirect",
    );
    expect(objectLabel({ objectKind: "task", title: "Fix login redirect", objectRef: "t-1" })).toBe(
      "Task: Fix login redirect",
    );
    expect(objectLabel({ objectKind: "doc", title: null, objectRef: "doc-9" })).toBe("Doc: doc-9");
  });
});

describe("activityHref", () => {
  it("links known object kinds and omits unknown ones", () => {
    expect(activityHref({ objectKind: "pm_task", objectRef: "t-1" })).toBe("/tasks/t-1");
    expect(activityHref({ objectKind: "task", objectRef: "t-2" })).toBe("/tasks/t-2");
    expect(activityHref({ objectKind: "project", objectRef: "p-1" })).toBe("/projects/p-1");
    expect(activityHref({ objectKind: "milestone", objectRef: "m-1" })).toBeUndefined();
  });
});

describe("actorLabel", () => {
  it("resolves a known user id, falls back to the raw id, then to actorExternal", () => {
    const names = { "u-1": "Made Putra" };
    expect(actorLabel({ actorUserId: "u-1", actorExternal: null }, names)).toBe("Made Putra");
    expect(actorLabel({ actorUserId: "u-unknown", actorExternal: null }, names)).toBe("u-unknown");
    expect(actorLabel({ actorUserId: null, actorExternal: "scheduler" }, names)).toBe("scheduler");
    expect(actorLabel({ actorUserId: null, actorExternal: null }, names)).toBeNull();
  });
});

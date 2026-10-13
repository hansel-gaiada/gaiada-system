import { describe, it, expect } from "vitest";
import { assistantDrawerHref, assistantFullPageHref, derivePageContextRef, pageContextPrefix, safeFromPath } from "./assistantContext";

describe("derivePageContextRef", () => {
  it("maps a project detail page to a project ref", () => {
    expect(derivePageContextRef("/projects/p-web-1", "co-agency")).toEqual({
      kind: "project", id: "p-web-1", ref: "erp:project:p-web-1",
    });
  });

  it("maps a task detail page to a task ref", () => {
    expect(derivePageContextRef("/tasks/t-4", "co-agency")).toEqual({
      kind: "task", id: "t-4", ref: "erp:task:t-4",
    });
  });

  it("maps a client detail page to a client ref", () => {
    expect(derivePageContextRef("/clients/cl-1", "co-agency")).toEqual({
      kind: "client", id: "cl-1", ref: "erp:client:cl-1",
    });
  });

  it("maps a meeting detail page to a meeting ref", () => {
    expect(derivePageContextRef("/meetings/rec-demo-1", "co-agency")).toEqual({
      kind: "meeting", id: "rec-demo-1", ref: "erp:meeting:rec-demo-1",
    });
  });

  it("embeds the tenant id in a person ref (erp-source.ts's own convention)", () => {
    expect(derivePageContextRef("/people/u-pm", "co-agency")).toEqual({
      kind: "person", id: "u-pm", ref: "erp:person:co-agency:u-pm",
    });
  });

  it("refuses a person ref with no active tenant — a person ref cannot be built without one", () => {
    expect(derivePageContextRef("/people/u-pm", null)).toBeNull();
  });

  it("prefers the department-nested task pattern over the department-nested project pattern", () => {
    expect(derivePageContextRef("/departments/dept-1/projects/p-web-1/tasks/t-4", "co-agency")).toEqual({
      kind: "task", id: "t-4", ref: "erp:task:t-4",
    });
  });

  it("maps a department-nested project page (no task segment) to a project ref", () => {
    expect(derivePageContextRef("/departments/dept-1/projects/p-web-1", "co-agency")).toEqual({
      kind: "project", id: "p-web-1", ref: "erp:project:p-web-1",
    });
  });

  it("treats a create-form route (.../new) as having no entity to pin", () => {
    expect(derivePageContextRef("/projects/new", "co-agency")).toBeNull();
    expect(derivePageContextRef("/tasks/new", "co-agency")).toBeNull();
  });

  it("returns null for a list/settings page with no resolvable entity", () => {
    expect(derivePageContextRef("/projects", "co-agency")).toBeNull();
    expect(derivePageContextRef("/reports/company", "co-agency")).toBeNull();
    expect(derivePageContextRef("/", "co-agency")).toBeNull();
  });

  it("returns null for a null/undefined pathname", () => {
    expect(derivePageContextRef(null, "co-agency")).toBeNull();
    expect(derivePageContextRef(undefined, "co-agency")).toBeNull();
  });

  it("decodes a URL-encoded id segment", () => {
    expect(derivePageContextRef("/tasks/t%2D4", "co-agency")).toEqual({
      kind: "task", id: "t-4", ref: "erp:task:t-4",
    });
  });
});

describe("assistantDrawerHref", () => {
  it("carries the derived ref as ?ctx= when the page resolves to an entity, and the page's path as &from=", () => {
    expect(assistantDrawerHref("/projects/p-web-1", "co-agency")).toBe(
      `/assistant?ctx=${encodeURIComponent("erp:project:p-web-1")}&from=${encodeURIComponent("/projects/p-web-1")}`,
    );
  });

  it("DW-2h: a page with no resolvable entity still carries where it was opened from", () => {
    expect(assistantDrawerHref("/departments/d-web/board", "co-agency")).toBe(
      `/assistant?from=${encodeURIComponent("/departments/d-web/board")}`,
    );
  });

  it("falls back to the bare /assistant href with no pathname, or on the assistant itself", () => {
    expect(assistantDrawerHref(null, "co-agency")).toBe("/assistant");
    expect(assistantDrawerHref("/assistant", "co-agency")).toBe("/assistant");
  });
});

describe("safeFromPath (DW-2h)", () => {
  it("keeps a same-origin absolute path", () => {
    expect(safeFromPath("/departments/d-web/board")).toBe("/departments/d-web/board");
    expect(safeFromPath("/")).toBe("/");
  });

  it("refuses anything that could leave the site or loop back into the assistant", () => {
    for (const bad of [null, undefined, "", "departments/x", "//evil.example", "https://evil.example/x", "/a\\b", "/a\nb", "/assistant", "/assistant?thread=1", "/assistant/x"]) {
      expect(safeFromPath(bad as string | null | undefined)).toBeNull();
    }
    expect(safeFromPath(`/${"a".repeat(600)}`)).toBeNull();
  });
});

describe("assistantFullPageHref (DW-2h)", () => {
  it("carries the SAME thread id, and the way back when there is one", () => {
    expect(assistantFullPageHref("th 1", "/departments/d-web/board")).toBe(
      `/assistant?thread=${encodeURIComponent("th 1")}&from=${encodeURIComponent("/departments/d-web/board")}`,
    );
  });

  it("is today's link when there is no origin", () => {
    expect(assistantFullPageHref("th-1", null)).toBe("/assistant?thread=th-1");
  });
});

describe("pageContextPrefix", () => {
  it("formats a labelled preamble carrying the exact ref", () => {
    expect(pageContextPrefix("Client site redesign", "erp:project:p-web-1")).toBe(
      "[Context: Client site redesign (erp:project:p-web-1)]\n\n",
    );
  });
});

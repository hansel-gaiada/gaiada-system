import { describe, it, expect } from "vitest";
import { assistantDrawerHref, derivePageContextRef, pageContextPrefix } from "./assistantContext";

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
  it("carries the derived ref as ?ctx= when the page resolves to an entity", () => {
    expect(assistantDrawerHref("/projects/p-web-1", "co-agency")).toBe(
      `/assistant?ctx=${encodeURIComponent("erp:project:p-web-1")}`,
    );
  });

  it("falls back to the bare /assistant href on a page with no resolvable entity", () => {
    expect(assistantDrawerHref("/reports/company", "co-agency")).toBe("/assistant");
    expect(assistantDrawerHref(null, "co-agency")).toBe("/assistant");
  });
});

describe("pageContextPrefix", () => {
  it("formats a labelled preamble carrying the exact ref", () => {
    expect(pageContextPrefix("Client site redesign", "erp:project:p-web-1")).toBe(
      "[Context: Client site redesign (erp:project:p-web-1)]\n\n",
    );
  });
});

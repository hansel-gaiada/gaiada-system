import { describe, it, expect, beforeEach } from "vitest";
import { assistantGuidanceDemo, resetAssistantGuidanceDemo } from "./demoAssistantGuidance";

// AIP-13b (BFF section 65): the demo store answers in the server's order of checks, so DEMO_MODE shows the real states of the page.
const path = (unit: string, tenant = "co-agency") => `/api/${tenant}/departments/${unit}/assistant-preamble`;
const get = (unit: string, who: string) => assistantGuidanceDemo("GET", path(unit), undefined, who);
const put = (unit: string, who: string, body: unknown) => assistantGuidanceDemo("PUT", path(unit), JSON.stringify(body), who);

beforeEach(() => resetAssistantGuidanceDemo());

describe("the demo guidance store", () => {
  it("ignores other paths", () => {
    expect(assistantGuidanceDemo("GET", "/api/co-agency/notices", undefined, "demo-hansel")).toBeNull();
  });
  it("answers the default for a department with one, with the preview the server builds and contextEnabled off", () => {
    const r = get("dept-1", "demo-hansel");
    expect(r?.status).toBe(200);
    expect(r?.json).toMatchObject({ custom: null, contextEnabled: false, department: { name: "Web Dev" } });
    expect((r?.json as { preview: string }).preview).toMatch(/^You are helping someone in the Web Dev department\.\n\nDepartment guidance:\nWeb Dev takes/);
  });
  it("a write is stored trimmed with editor and time, and an empty write deletes it", () => {
    const w = put("dept-1", "u-webhead", { body: "  Own text.  " });
    expect(w?.json).toMatchObject({ custom: "Own text.", effective: "Own text.", updatedBy: { id: "u-webhead", name: "Ketut Arta" } });
    expect((get("dept-1", "demo-hansel")?.json as { custom: string }).custom).toBe("Own text.");
    expect(put("dept-1", "u-webhead", { body: "" })?.json).toMatchObject({ custom: null, updatedAt: null, updatedBy: null });
  });
  it("1,001 code points is a 400 naming body; a missing body is a 400", () => {
    expect(put("dept-1", "demo-hansel", { body: "\u{1F600}".repeat(1001) })).toMatchObject({ status: 400, json: { field: "body" } });
    expect(put("dept-1", "demo-hansel", {})?.status).toBe(400);
  });
  it("a head of a sibling, a member and another company are 403 before anything says whether the unit exists; the admin gets 404 for an unknown unit", () => {
    expect(get("dept-1", "dept-manager")?.status).toBe(403);
    expect(get("dept-1", "u-dev")?.status).toBe(403);
    expect(get("nope", "u-dev")?.status).toBe(403);
    expect(assistantGuidanceDemo("GET", path("dept-1", "co-other"), undefined, "demo-hansel")?.status).toBe(403);
    expect(get("nope", "demo-hansel")).toMatchObject({ status: 404, json: { error: "department_not_found" } });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// AIP-13b (BFF section 65.3): the guidance write and read. The platform's refusals are put in words and shown as the form's error; nothing here decides
// who may do what (Cerbos does). An empty body is the reset, and it is sent as it is.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return {
    ...actual, platformFetch: vi.fn(),
    getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [{ role: "member", scopeType: "company", scopeId: "co-a" }], companies: [{ id: "co-a", name: "Agency", type: "agency" }] })),
  };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import { savePreambleAction } from "./assistantGuidanceActions";
import { getAssistantPreamble } from "./assistantGuidance-data";

const fetchMock = vi.mocked(platformFetch);
const refused = (status: number, message: string, field?: string) => new PlatformError(status, message, field);
const bodyOf = (i = 0) => JSON.parse(String(fetchMock.mock.calls[i][2]?.body));
const VIEW = {
  unitNodeId: "d-web", department: { name: "Web Dev", key: "web-dev" }, custom: "Own.", defaultText: "Default.", effective: "Own.",
  updatedAt: "2026-10-29T10:00:00.000Z", updatedBy: { id: "u1", name: "Ketut Arta" }, preview: "preview", contextEnabled: true,
};

beforeEach(() => { fetchMock.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("savePreambleAction", () => {
  it("PUTs the trimmed text to this company's unit, answers the server's new view, and refreshes the page", async () => {
    fetchMock.mockResolvedValue(VIEW);
    const r = await savePreambleAction("co-a", "d-web", "  Own.\r\n  ");
    expect(r).toEqual({ ok: true, view: VIEW });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/departments/d-web/assistant-preamble");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PUT");
    expect(bodyOf()).toEqual({ body: "Own." });
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/departments/[deptId]/assistant-guidance", "page");
  });
  it("sends an EMPTY body for the reset (the server deletes the company's row)", async () => {
    fetchMock.mockResolvedValue({ ...VIEW, custom: null, effective: "Default.", updatedAt: null, updatedBy: null });
    const r = await savePreambleAction("co-a", "d-web", "");
    expect(r.ok).toBe(true);
    expect(bodyOf()).toEqual({ body: "" });
  });
  it("puts the unit id in the path encoded", async () => {
    fetchMock.mockResolvedValue({ ...VIEW, unitNodeId: "d/web" });
    await savePreambleAction("co-a", "d/web", "x");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/departments/d%2Fweb/assistant-preamble");
  });
  it("403 is said plainly, 404 says the department was not found, a 400 is the server's own message with its field", async () => {
    fetchMock.mockRejectedValueOnce(refused(403, "Forbidden"));
    expect(await savePreambleAction("co-a", "d-web", "x")).toEqual({ ok: false, error: "Only this department's head or a company admin can change this." });
    fetchMock.mockRejectedValueOnce(refused(404, "department_not_found", "unitNodeId"));
    expect(await savePreambleAction("co-a", "d-gone", "x")).toMatchObject({ ok: false, error: expect.stringMatching(/department was not found/), field: "unitNodeId" });
    fetchMock.mockRejectedValueOnce(refused(400, "body must be at most 1000 characters", "body"));
    expect(await savePreambleAction("co-a", "d-web", "x")).toEqual({ ok: false, error: "body must be at most 1000 characters", field: "body" });
    expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
  });
  it("a company the person is not in never reaches the platform", async () => {
    expect(await savePreambleAction("co-zzz", "d-web", "x")).toEqual({ ok: false, error: "Select a company first." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("an answer that is not a view is a failure, never a saved empty text", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(savePreambleAction("co-a", "d-web", "x")).rejects.toThrow();
  });
});

describe("getAssistantPreamble", () => {
  it("GETs the unit's route and answers the checked view", async () => {
    fetchMock.mockResolvedValue(VIEW);
    expect(await getAssistantPreamble("u1", "co-a", "d-web")).toEqual({ kind: "ok", data: VIEW });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/departments/d-web/assistant-preamble");
  });
  it("keeps 403, 404 and everything else apart: forbidden, not_found, unavailable with the backend's words", async () => {
    fetchMock.mockRejectedValueOnce(refused(403, "Forbidden"));
    expect(await getAssistantPreamble("u1", "co-a", "d-web")).toEqual({ kind: "forbidden" });
    fetchMock.mockRejectedValueOnce(refused(404, "department_not_found"));
    expect(await getAssistantPreamble("u1", "co-a", "d-web")).toEqual({ kind: "not_found" });
    fetchMock.mockRejectedValueOnce(refused(500, "platform 500"));
    expect(await getAssistantPreamble("u1", "co-a", "d-web")).toEqual({ kind: "unavailable", reason: "platform 500" });
    fetchMock.mockResolvedValueOnce({ nope: 1 });
    expect((await getAssistantPreamble("u1", "co-a", "d-web")).kind).toBe("unavailable");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-5a (BFF §63.18): the report writes. Each action is one request to the contract's own route with the contract's own body; a refusal comes back as data with its words; "Draft with AI" makes
// the ai-draft request and NO write.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), getMe: vi.fn(async () => ({ userId: "u-1" })), platformFetch: vi.fn() }));

import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { platformFetch, PlatformError } from "./platform";
import { CHECK_SEND_REASON, WRITE_REASON } from "./socialReports";
import { approveReport, deliverReport, draftMonthlyReport, proposeReportDraft, saveReport, sendBackReport, submitReport } from "./socialReportsActions";

const B = "/api/co-a/modules/social";
const calls = () => vi.mocked(platformFetch).mock.calls.map((c) => [String((c[2] as { method?: string } | undefined)?.method ?? "GET"), c[0]]);
const body = (i = 0) => JSON.parse(String((vi.mocked(platformFetch).mock.calls[i][2] as { body: string }).body));

beforeEach(() => {
  vi.mocked(platformFetch).mockReset().mockResolvedValue({});
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-a");
});

describe("the report writes", () => {
  it("draft: POST engagements/:id/reports with a monthly kind, the month and the click's id", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "r1", status: "draft", simulated: true, draftedVia: "fallback" });
    const r = await draftMonthlyReport("e 1", "2026-09", "11111111-1111-4111-8111-111111111111");
    expect(calls()).toEqual([["POST", `${B}/engagements/e%201/reports`]]);
    expect(body()).toEqual({ id: "11111111-1111-4111-8111-111111111111", kind: "monthly", period: "2026-09" });
    expect(r).toEqual({ ok: true, report: { id: "r1", status: "draft", simulated: true, draftedVia: "fallback" } });
  });
  it("save: PATCH reports/:id with exactly the narrative, the notes and the plan, and nothing about the status", async () => {
    const r = await saveReport("r1", { narrativeMd: "N", notes: { followers: { insight: "i", suggestion: "s" } }, actionPlan: [{ action: "a", owner: "agency" }] });
    expect(calls()).toEqual([["PATCH", `${B}/reports/r1`]]);
    expect(Object.keys(body()).sort()).toEqual(["actionPlan", "narrativeMd", "notes"]);
    expect(r).toEqual({ ok: true });
  });
  it("submit and send back are the two status moves of the same PATCH", async () => {
    await submitReport("r1");
    await sendBackReport("r1");
    expect(calls()).toEqual([["PATCH", `${B}/reports/r1`], ["PATCH", `${B}/reports/r1`]]);
    expect([body(0), body(1)]).toEqual([{ status: "in_review" }, { status: "draft" }]);
  });
  it("approve and deliver are POSTs to their own routes, and deliver answers the file and the client's report", async () => {
    await approveReport("r1");
    vi.mocked(platformFetch).mockResolvedValue({ id: "r1", status: "delivered", filename: "social-report-2026-09.pdf", clientReportId: "cr-1", fileId: "f1", deliverableId: null });
    const r = await deliverReport("r1");
    expect(calls()).toEqual([["POST", `${B}/reports/r1/approve`], ["POST", `${B}/reports/r1/deliver`]]);
    expect(r).toEqual({ ok: true, filename: "social-report-2026-09.pdf", clientReportId: "cr-1" });
  });
  it("Draft with AI asks for a proposal and WRITES NOTHING: one POST to ai-draft, no PATCH", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ narrativeMd: "N", notes: { followers: { insight: "i", suggestion: "s" }, engagement: { insight: "i", suggestion: "s" }, audience: { insight: "i", suggestion: "s" } }, actionPlan: [{ action: "a", owner: "client" }], draftedVia: "template" });
    const r = await proposeReportDraft("r1");
    expect(calls()).toEqual([["POST", `${B}/reports/r1/ai-draft`]]);
    expect(r).toMatchObject({ ok: true, proposal: { draftedVia: "template", narrativeMd: "N" } });
  });
});

describe("refusals come back as data, in words", () => {
  it("a 403 says who may do what was asked", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "not authorized: cerbos denied approve on social_report"));
    const approve = await approveReport("r1");
    expect(approve).toMatchObject({ ok: false, refusal: { status: 403 }, message: `You cannot do this. ${CHECK_SEND_REASON}` });
    expect(await sendBackReport("r1")).toMatchObject({ ok: false, message: `You cannot do this. ${CHECK_SEND_REASON}` });
    expect(await deliverReport("r1")).toMatchObject({ ok: false, message: `You cannot do this. ${CHECK_SEND_REASON}` });
    expect(await saveReport("r1", { narrativeMd: "", notes: {}, actionPlan: [] })).toMatchObject({ ok: false, message: `You cannot do this. ${WRITE_REASON}` });
  });
  it("a 400 code gets its sentence, and a 400 with a field names it", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "notes_incomplete"));
    expect(await approveReport("r1")).toMatchObject({ ok: false, refusal: { status: 400, error: "notes_incomplete" }, message: expect.stringMatching(/missing its insight or its suggestion/) });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "invalid_field", "actionPlan"));
    expect(await saveReport("r1", { narrativeMd: "", notes: {}, actionPlan: [] })).toMatchObject({ ok: false, refusal: { field: "actionPlan" }, message: expect.stringMatching(/at most 10 actions/) });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(503, "pdf_render_not_configured"));
    expect(await deliverReport("r1")).toMatchObject({ ok: false, message: expect.stringMatching(/PDF maker is not set up/) });
  });
  it("a signed-out person or a person with no company gets a refusal, not a request", async () => {
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null as never);
    expect(await approveReport("r1")).toMatchObject({ ok: false, refusal: { error: "session_expired" } });
    vi.mocked(getActiveTenant).mockResolvedValueOnce(null as never);
    expect(await approveReport("r1")).toMatchObject({ ok: false, refusal: { error: "no_company" } });
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

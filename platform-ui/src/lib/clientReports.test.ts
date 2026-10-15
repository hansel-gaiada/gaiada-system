import { describe, it, expect, vi, beforeEach } from "vitest";

// PV7-04b — the staff side of client reports: the pure rules, and the two write actions' refusals in plain words.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import {
  WITHDRAW_REASON_MAX, publishErrorText, reportActions, staffReportDownloadLabel, withdrawErrorText, withdrawReasonState,
} from "./clientReports";
import { publishClientReportAction, withdrawClientReportAction } from "./clientReportsActions";

const fetchMock = vi.mocked(platformFetch);
const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
beforeEach(() => { fetchMock.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("reportActions", () => {
  const file = { id: "f", filename: "a.pdf", contentType: "application/pdf", byteSize: 1 };
  it("Publish is for drafts only, Withdraw for published only, and a withdrawn report is final", () => {
    expect(reportActions({ status: "draft", file })).toMatchObject({ canPublish: true, canWithdraw: false, publishBlockedReason: null });
    expect(reportActions({ status: "published", file })).toMatchObject({ canPublish: false, canWithdraw: true });
    expect(reportActions({ status: "withdrawn", file })).toMatchObject({ canPublish: false, canWithdraw: false });
  });
  it("a draft with no file says why it cannot go out", () => {
    expect(reportActions({ status: "draft", file: null }).publishBlockedReason).toMatch(/no file/);
  });
});

describe("withdrawReasonState", () => {
  it("needs a reason and bounds it at the backend's length", () => {
    expect(withdrawReasonState("   ").canSubmit).toBe(false);
    expect(withdrawReasonState("Wrong figures").canSubmit).toBe(true);
    expect(withdrawReasonState("x".repeat(WITHDRAW_REASON_MAX)).canSubmit).toBe(true);
    expect(withdrawReasonState("x".repeat(WITHDRAW_REASON_MAX + 1)).canSubmit).toBe(false);
  });
});

describe("staffReportDownloadLabel", () => {
  it("follows the file's content type", () => {
    expect(staffReportDownloadLabel("application/pdf")).toBe("PDF");
    expect(staffReportDownloadLabel("text/markdown")).toBe("Markdown");
    expect(staffReportDownloadLabel("image/png")).toBe("File");
  });
});

describe("the refusals in plain words", () => {
  it("publish: 409 codes, 403 and 404", () => {
    expect(publishErrorText(409, "not_a_draft")).toMatch(/no longer a draft/);
    expect(publishErrorText(409, "report_has_no_file")).toMatch(/no file yet/);
    expect(publishErrorText(403, "not authorized: cerbos denied")).toBe("You can't publish reports for this client.");
    expect(publishErrorText(404, "report not found")).toMatch(/no longer exists/);
  });
  it("withdraw: 400 and 409 codes and 403", () => {
    expect(withdrawErrorText(400, "reason_required")).toMatch(/Say why/);
    expect(withdrawErrorText(400, "reason_too_long")).toContain(String(WITHDRAW_REASON_MAX));
    expect(withdrawErrorText(409, "not_published")).toMatch(/not published/);
    expect(withdrawErrorText(403, "x")).toBe("You can't withdraw reports for this client.");
  });
});

describe("publishClientReportAction", () => {
  it("POSTs publish for the active company and revalidates the tab", async () => {
    fetchMock.mockResolvedValue({ id: "r1", status: "published", publishedAt: "2026-10-15T00:00:00Z" });
    const r = await publishClientReportAction(null, form({ clientId: "cl-1", reportId: "r1" }));
    expect(r).toMatchObject({ ok: true, id: "r1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/co-1/client-reports/r1/publish", "u1", { method: "POST" });
    expect(revalidatePath).toHaveBeenCalledWith("/clients/cl-1/reports");
  });
  it("says a 409 not_a_draft and a 409 report_has_no_file in plain words, never the machine code", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "not_a_draft"));
    const a = await publishClientReportAction(null, form({ clientId: "cl-1", reportId: "r1" }));
    expect(a).toMatchObject({ ok: false });
    expect(a.error).not.toContain("not_a_draft");
    expect(a.error).toMatch(/no longer a draft/);
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "report_has_no_file"));
    const b = await publishClientReportAction(null, form({ clientId: "cl-1", reportId: "r1" }));
    expect(b.error).toMatch(/no file yet/);
  });
  it("renders a 403 as a plain refusal", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized: cerbos denied publish on client_report"));
    expect((await publishClientReportAction(null, form({ clientId: "cl-1", reportId: "r1" }))).error).toBe("You can't publish reports for this client.");
  });
});

describe("withdrawClientReportAction", () => {
  it("needs a reason: a blank one is answered without calling the platform", async () => {
    const r = await withdrawClientReportAction(null, form({ clientId: "cl-1", reportId: "r1", reason: "   " }));
    expect(r).toMatchObject({ ok: false, field: "reason" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refuses a reason over the backend's length without calling it", async () => {
    const r = await withdrawClientReportAction(null, form({ clientId: "cl-1", reportId: "r1", reason: "x".repeat(WITHDRAW_REASON_MAX + 1) }));
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("POSTs the trimmed reason and revalidates", async () => {
    fetchMock.mockResolvedValue({ id: "r1", status: "withdrawn", withdrawnAt: "2026-10-15T00:00:00Z" });
    const r = await withdrawClientReportAction(null, form({ clientId: "cl-1", reportId: "r1", reason: "  Wrong ad spend  " }));
    expect(r).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/co-1/client-reports/r1/withdraw", "u1", { method: "POST", body: JSON.stringify({ reason: "Wrong ad spend" }) });
    expect(revalidatePath).toHaveBeenCalledWith("/clients/cl-1/reports");
  });
  it("says the server's 400 and 409 in plain words", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "reason_required"));
    expect((await withdrawClientReportAction(null, form({ clientId: "cl-1", reportId: "r1", reason: "x" }))).error).toMatch(/Say why/);
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "not_published"));
    expect((await withdrawClientReportAction(null, form({ clientId: "cl-1", reportId: "r1", reason: "x" }))).error).toMatch(/not published/);
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "denied"));
    expect((await withdrawClientReportAction(null, form({ clientId: "cl-1", reportId: "r1", reason: "x" }))).error).toBe("You can't withdraw reports for this client.");
  });
});

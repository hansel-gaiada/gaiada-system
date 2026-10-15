import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-7g-1 — the writes behind Finance > Tax > Returns. Cerbos decides who may prepare, file and amend; what is pinned here is
// the wire (route, body, revalidation), the words for a 403, the server's own 400 and 409 text passed through, and that a
// blank form never reaches the server.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import { fileTaxReturn, prepareTaxReturn } from "./financeTaxActions";

const fetchMock = vi.mocked(platformFetch);
const body = () => JSON.parse(String(fetchMock.mock.calls[0][2]?.body));
const prepared = { id: "r1", kind: "ppn", periodYear: 2026, periodMonth: 9, status: "draft", computed: { output: 1000, input: 400, net: 600 } };

beforeEach(() => { fetchMock.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("prepareTaxReturn", () => {
  it("POSTs kind, year and month, returns the server's figures and re-reads the Tax page", async () => {
    fetchMock.mockResolvedValue(prepared);
    const r = await prepareTaxReturn("ppn", 2026, 9);
    expect(r).toEqual({ ok: true, result: prepared });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/finance/tax/returns");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(body()).toEqual({ kind: "ppn", periodYear: 2026, periodMonth: 9 });
    expect(revalidatePath).toHaveBeenCalledWith("/finance/tax");
  });

  it("the annual return sends no month, even if one is passed", async () => {
    fetchMock.mockResolvedValue({ ...prepared, kind: "pph_badan", periodMonth: null });
    await prepareTaxReturn("pph_badan", 2025, 6);
    expect(body()).toEqual({ kind: "pph_badan", periodYear: 2025 });
  });

  it("says a 403 in words and does not revalidate", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "forbidden"));
    const r = await prepareTaxReturn("ppn", 2026, 9);
    expect(r).toEqual({ ok: false, error: "You don't have permission to prepare tax returns." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("passes the server's 409 (already filed) and 400 text through untouched", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "the ppn return for 2026-3 is already filed — Use finance_tax_amend_return to correct a lodged return."));
    expect((await prepareTaxReturn("ppn", 2026, 3)).error).toBe("the ppn return for 2026-3 is already filed — Use finance_tax_amend_return to correct a lodged return.");
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "periodYear must be between 2000 and 2100"));
    expect((await prepareTaxReturn("ppn", 2026, 3)).error).toBe("periodYear must be between 2000 and 2100");
  });

  it("refuses a bad kind, year or month before any request", async () => {
    expect(await prepareTaxReturn("vat", 2026, 3)).toMatchObject({ ok: false });
    expect((await prepareTaxReturn("ppn", 1999, 3)).error).toMatch(/between 2000 and 2100/);
    expect((await prepareTaxReturn("ppn", 2026.5, 3)).error).toMatch(/between 2000 and 2100/);
    expect((await prepareTaxReturn("ppn", 2026, 13)).error).toMatch(/month/);
    expect((await prepareTaxReturn("pph21", 2026, null)).error).toMatch(/month/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fileTaxReturn", () => {
  const filed = { id: "r1", status: "filed", period: "PPN 2026-09", filingReference: "NTPN-1", filed: { output: 1000, input: 400, net: 600 } };

  it("POSTs the trimmed reference and the typed period to the return's file route, with no amend flag for a first filing", async () => {
    fetchMock.mockResolvedValue(filed);
    const r = await fileTaxReturn("r1", { filingReference: "  NTPN-1 ", confirm: "PPN 2026-09" });
    expect(r).toEqual({ ok: true, result: filed });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/finance/tax/returns/r1/file");
    expect(body()).toEqual({ filingReference: "NTPN-1", confirm: "PPN 2026-09" });
    expect(revalidatePath).toHaveBeenCalledWith("/finance/tax");
  });

  it("an amendment sends amend:true", async () => {
    fetchMock.mockResolvedValue({ ...filed, status: "amended" });
    await fileTaxReturn("r1", { filingReference: "NTPN-2", confirm: "PPN 2026-09", amend: true });
    expect(body()).toEqual({ filingReference: "NTPN-2", confirm: "PPN 2026-09", amend: true });
  });

  it("says a 403 in words, naming the act; an assurance refusal keeps its machine reason", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await fileTaxReturn("r1", { filingReference: "N", confirm: "PPN 2026-09" })).error).toBe("You don't have permission to record a tax filing.");
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await fileTaxReturn("r1", { filingReference: "N", confirm: "PPN 2026-09", amend: true })).error).toBe("You don't have permission to amend a tax return.");
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden", undefined, undefined, "assurance_required"));
    expect(await fileTaxReturn("r1", { filingReference: "N", confirm: "PPN 2026-09" })).toEqual({
      ok: false, error: "You need a second factor before you can record a tax filing.", reason: "assurance_required",
    });
  });

  it("passes the 400 (confirmation, already filed) and 409 (period not ended) text through untouched", async () => {
    const sentences = [
      [400, 'confirmation does not match — type the period exactly as "PPN 2026-09" to proceed. This action cannot be undone by an ordinary correction.'],
      [400, "PPN 2026-09 is already filed. Re-filing replaces the figures of record — pass amend:true to file an AMENDMENT, which is a different statement to DJP and is recorded as such."],
      [409, "period ends 2026-10-31 — cannot file before it closes"],
    ] as const;
    for (const [status, message] of sentences) {
      fetchMock.mockRejectedValueOnce(new PlatformError(status, message));
      expect((await fileTaxReturn("r1", { filingReference: "N", confirm: "PPN 2026-09" })).error).toBe(message);
    }
  });

  it("never sends a blank reference, a missing period or a missing return", async () => {
    expect((await fileTaxReturn("r1", { filingReference: "   ", confirm: "PPN 2026-09" })).error).toMatch(/filing reference/);
    expect((await fileTaxReturn("r1", { filingReference: "N", confirm: " " })).error).toMatch(/period/);
    expect((await fileTaxReturn("", { filingReference: "N", confirm: "PPN 2026-09" })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows what is not a platform answer (a socket failure is not a refusal)", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    await expect(fileTaxReturn("r1", { filingReference: "N", confirm: "PPN 2026-09" })).rejects.toThrow("socket hang up");
  });
});

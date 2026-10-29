import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-6a (BFF §63.23): the sheet import's three server actions. Pinned: the route and the exact body each call sends (`dryRun` set by the action, never by
// the caller), the company in the path, that a refusal comes back as its code and as words, that a 409 `import_rows_refused` carries the preview the
// server returned as `detail`, that an apply (and only an apply) revalidates the pages it changed, and that a lost session says so.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});

import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { platformFetch, PlatformError } from "./platform";
import { applyImport, parseSheet, previewImport } from "./socialImportActions";
import type { ImportBody } from "./sheetImport";

const fetchMock = vi.mocked(platformFetch);
const bodyOfCall = (n = 0) => JSON.parse(String(fetchMock.mock.calls[n][2]?.body));
const body: ImportBody = { dryRun: false, headerRow: true, columns: { client: 0 }, rows: [["Client"], ["Brand Alpha"]] };
const previewJson = {
  dryRun: true, importId: null, summary: { rows: 2, ready: 1, unchanged: 0, refused: 1, skipped: 0 }, unmatched: { clients: [], officers: [] },
  rows: [{ row: 1, outcome: "ready" }, { row: 2, outcome: "refused", refusals: [{ field: "client", code: "client_not_found" }] }],
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(getSessionUserId).mockResolvedValue("u1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-1");
});

describe("parseSheet", () => {
  it("POSTs a file's name and base64 (or pasted text) to import/parse and answers the tabs", async () => {
    fetchMock.mockResolvedValue({ tabs: [{ name: "Pasted", rows: [["a", "b"]] }] });
    const r = await parseSheet({ text: "a\tb" });
    expect(r).toEqual({ ok: true, tabs: [{ name: "Pasted", rows: [["a", "b"]] }] });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/modules/social/import/parse");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(bodyOfCall()).toEqual({ text: "a\tb" });
    await parseSheet({ filename: "plan.xlsx", contentBase64: "AAA=" });
    expect(bodyOfCall(1)).toEqual({ filename: "plan.xlsx", contentBase64: "AAA=" });
    expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
  });

  it("answers a refusal as its code, its field and the words", async () => {
    fetchMock.mockRejectedValue(new PlatformError(400, "sheet_too_large", "rows"));
    expect(await parseSheet({ text: "x" })).toEqual({ ok: false, error: "sheet_too_large", field: "rows", message: expect.stringMatching(/more than 2,000 rows/) });
    fetchMock.mockRejectedValue(new PlatformError(403, "not_a_social_approver"));
    expect(await parseSheet({ text: "x" })).toMatchObject({ ok: false, error: "not_a_social_approver", message: expect.stringMatching(/Social Media head, the GM/) });
  });
});

describe("previewImport and applyImport", () => {
  it("POST to import/<kind> with dryRun true for a preview, and write nothing", async () => {
    fetchMock.mockResolvedValue(previewJson);
    const r = await previewImport("plan", { ...body, dryRun: false });
    expect(r.ok && r.answer.rows.map((x) => x.outcome)).toEqual(["ready", "refused"]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/modules/social/import/plan");
    expect(bodyOfCall()).toMatchObject({ dryRun: true, headerRow: true, columns: { client: 0 } });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("POST to import/allocation with dryRun false for an apply, and revalidate the department pages", async () => {
    fetchMock.mockResolvedValue({ ...previewJson, dryRun: false, importId: "imp-1" });
    const r = await applyImport("allocation", { ...body, dryRun: true });
    expect(r.ok && r.answer.importId).toBe("imp-1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/modules/social/import/allocation");
    expect(bodyOfCall().dryRun).toBe(false);
    expect(revalidatePath).toHaveBeenCalledWith("/departments", "layout");
  });

  it("carries the 409's preview in `detail`, and revalidates nothing", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "import_rows_refused", undefined, undefined, undefined, { error: "import_rows_refused", detail: previewJson }));
    const r = await applyImport("plan", body);
    expect(r).toMatchObject({ ok: false, error: "import_rows_refused", message: expect.stringMatching(/nothing was written/i) });
    expect(!r.ok && r.detail?.rows.map((x) => x.outcome)).toEqual(["ready", "refused"]);
    expect(!r.ok && r.detail?.rows[1].refusals).toEqual([{ field: "client", code: "client_not_found" }]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("answers a 409 with a missing or malformed detail as null, never a crash", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "import_rows_refused", undefined, undefined, undefined, { error: "import_rows_refused", detail: { nope: 1 } }));
    expect(await applyImport("plan", body)).toMatchObject({ ok: false, error: "import_rows_refused", detail: null });
    fetchMock.mockRejectedValue(new PlatformError(409, "import_rows_refused"));
    const r = await applyImport("plan", body);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.detail).toBeNull();
  });

  it("does not attach a detail to any other 409", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "something_else", undefined, undefined, undefined, { detail: previewJson }));
    expect(await applyImport("plan", body)).toEqual({ ok: false, error: "something_else", field: undefined, message: "something_else" });
  });

  it("words a field refusal of the body", async () => {
    fetchMock.mockRejectedValue(new PlatformError(400, "invalid_field", "clientMatches.Alfa"));
    expect(await previewImport("plan", body)).toMatchObject({ ok: false, field: "clientMatches.Alfa", message: expect.stringMatching(/engagement/) });
  });

  it("rethrows what is not a platform refusal", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    await expect(previewImport("plan", body)).rejects.toThrow("socket hang up");
  });
});

describe("the session and the company", () => {
  it("say so, and send nothing, when the session is gone or no company is active", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect(await parseSheet({ text: "x" })).toMatchObject({ ok: false, error: "session_expired" });
    vi.mocked(getSessionUserId).mockResolvedValue("u1");
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    expect(await previewImport("plan", body)).toMatchObject({ ok: false, error: "no_company" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

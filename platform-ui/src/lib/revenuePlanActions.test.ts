import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import { setRevenuePlanMonth, clearRevenuePlanMonth } from "./revenuePlanActions";
import { NO_BASE_CURRENCY_WORDS, REFUSED_WORDS } from "./revenuePlan";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  getMe: vi.fn(async () => ({ id: "u-1", roles: [] })),
  platformFetch: vi.fn(),
}));

// DW-7j-5 (BFF §40.6.4): the revenue plan's two write actions: the routes and bodies they send, the typed amount converted with the
// server's own decimals, and every refusal in words.

const read = (minorUnit: number | null) => ({ currency: minorUnit === null ? null : "IDR", minorUnit, months: [] });

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});

describe("setRevenuePlanMonth", () => {
  it("reads the currency's decimals from the server, then PUTs the amount in minor units with the trimmed note, and refreshes the page", async () => {
    vi.mocked(platformFetch).mockResolvedValueOnce(read(2)).mockResolvedValueOnce({ month: "2026-09", amountMinor: 123_456 });
    expect(await setRevenuePlanMonth("2026-09", "1,234.56", "  Q3  ")).toEqual({ ok: true });
    const [readPath, , readInit] = vi.mocked(platformFetch).mock.calls[0];
    expect(readPath).toBe("/api/co-1/revenue-plan?from=2026-09&to=2026-09");
    expect(readInit).toBeUndefined();
    const [path, user, init] = vi.mocked(platformFetch).mock.calls[1];
    expect(path).toBe("/api/co-1/revenue-plan/2026-09");
    expect(user).toBe("u-1");
    expect(init).toMatchObject({ method: "PUT" });
    // the client never sends a currency
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ amountMinor: 123_456, note: "Q3" });
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["/departments/[deptId]/revenue-plan"]));
  });

  it("a currency with no decimals takes the amount as it is, and sends no note when it is empty", async () => {
    vi.mocked(platformFetch).mockResolvedValueOnce(read(0)).mockResolvedValueOnce({});
    expect(await setRevenuePlanMonth("2026-09", "200000000", "   ")).toEqual({ ok: true });
    expect(JSON.parse(String((vi.mocked(platformFetch).mock.calls[1][2] as RequestInit).body))).toEqual({ amountMinor: 200_000_000 });
  });

  it("says in words that only an administrator may set the plan when the server refuses (403), and refreshes nothing", async () => {
    vi.mocked(platformFetch).mockResolvedValueOnce(read(0)).mockRejectedValueOnce(new PlatformError(403, "not authorized: cerbos denied approve on dept_kpi_target"));
    expect(await setRevenuePlanMonth("2026-09", "100", "")).toEqual({ ok: false, error: REFUSED_WORDS, field: undefined });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("words a refused read too (403 on the decimals read), and the missing base currency (a null minorUnit)", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized"));
    expect(await setRevenuePlanMonth("2026-09", "100", "")).toMatchObject({ ok: false, error: REFUSED_WORDS });
    expect(platformFetch).toHaveBeenCalledTimes(1);
    vi.mocked(platformFetch).mockResolvedValueOnce(read(null));
    expect(await setRevenuePlanMonth("2026-09", "100", "")).toEqual({ ok: false, error: NO_BASE_CURRENCY_WORDS });
  });

  it("passes the server's 400 sentence and field through as sent", async () => {
    vi.mocked(platformFetch).mockResolvedValueOnce(read(0)).mockRejectedValueOnce(new PlatformError(400, "amountMinor must be a whole number of at least 0", "amountMinor"));
    expect(await setRevenuePlanMonth("2026-09", "100", "")).toEqual({ ok: false, error: "amountMinor must be a whole number of at least 0", field: "amountMinor" });
  });

  it("refuses a typed amount the currency cannot hold without calling the server to write", async () => {
    vi.mocked(platformFetch).mockResolvedValue(read(0));
    expect(await setRevenuePlanMonth("2026-09", "100.5", "")).toMatchObject({ ok: false, field: "amount" });
    expect(await setRevenuePlanMonth("2026-09", "", "")).toMatchObject({ ok: false, field: "amount" });
    expect(vi.mocked(platformFetch).mock.calls.every((c) => !(c[2] as RequestInit | undefined)?.method)).toBe(true); // only reads
  });

  it("refuses a bad month and a note over 2000 characters before calling the server; a lost session says so", async () => {
    expect(await setRevenuePlanMonth("2026-9", "100")).toMatchObject({ ok: false, field: "month" });
    expect(await setRevenuePlanMonth("2026-09", "100", "x".repeat(2001))).toMatchObject({ ok: false, field: "note" });
    expect(platformFetch).not.toHaveBeenCalled();
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect(await setRevenuePlanMonth("2026-09", "100")).toEqual({ ok: false, error: "Session expired — sign in again." });
  });
});

describe("clearRevenuePlanMonth", () => {
  it("DELETEs the month and refreshes the page", async () => {
    vi.mocked(platformFetch).mockResolvedValue(undefined);
    expect(await clearRevenuePlanMonth("2026-09")).toEqual({ ok: true });
    const [path, user, init] = vi.mocked(platformFetch).mock.calls[0];
    expect(path).toBe("/api/co-1/revenue-plan/2026-09");
    expect(user).toBe("u-1");
    expect(init).toEqual({ method: "DELETE" });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("words a refusal (403) and passes any other sentence through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized"));
    expect(await clearRevenuePlanMonth("2026-09")).toMatchObject({ ok: false, error: REFUSED_WORDS });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "module finance not enabled for this company"));
    expect(await clearRevenuePlanMonth("2026-09")).toMatchObject({ ok: false, error: "module finance not enabled for this company" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a bad month before calling the server", async () => {
    expect(await clearRevenuePlanMonth("september")).toMatchObject({ ok: false, field: "month" });
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

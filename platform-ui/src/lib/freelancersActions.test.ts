import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-10f-4b — the writes behind Finance > Payables > Freelancers. Cerbos decides who may do what; what is pinned here is the wire (route,
// method, body), that the hourly rate is sent as the TEXT typed (never through a float), the words for a 403, the machine reasons turned
// into sentences, the blockers carried from a 409, and that "Draft all ready" asks the server again and survives one refusal.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import {
  addRateAction, discardBillAction, draftAllReadyAction, draftBillAction, endRateAction, linkVendorAction, withdrawRateAction,
} from "./freelancersActions";

const fetchMock = vi.mocked(platformFetch);
const call = (n = 0) => ({ path: fetchMock.mock.calls[n][0], init: fetchMock.mock.calls[n][2] });
const body = (n = 0) => JSON.parse(String(fetchMock.mock.calls[n][2]?.body));
const refuse = (status: number, message: string, reason?: string, extra?: unknown) =>
  new PlatformError(status, message, undefined, undefined, reason, extra);

beforeEach(() => { fetchMock.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("addRateAction", () => {
  const ok = { hourlyRate: "150000", validFrom: "2026-10-01", expenseAccountCode: "6100" };

  it("POSTs the rate as the text typed, trimmed, to the person's rates route, and re-reads the page", async () => {
    fetchMock.mockResolvedValue({ id: "r1", closedRate: null });
    const r = await addRateAction("u-dev", { ...ok, hourlyRate: " 150000.50 ", note: "  first  " });
    expect(r.ok).toBe(true);
    expect(call().path).toBe("/api/co-1/finance/freelancers/u-dev/rates");
    expect(call().init?.method).toBe("POST");
    const b = body();
    expect(b).toEqual({ hourlyRate: "150000.50", validFrom: "2026-10-01", expenseAccountCode: "6100", note: "first" });
    expect(typeof b.hourlyRate).toBe("string");
    expect(revalidatePath).toHaveBeenCalledWith("/finance/payables/freelancers");
  });

  it("omits an empty note", async () => {
    fetchMock.mockResolvedValue({ id: "r1" });
    await addRateAction("u-dev", { ...ok, note: "   " });
    expect(body()).not.toHaveProperty("note");
  });

  it("refuses a blank form before any request, naming the field", async () => {
    expect(await addRateAction("", ok)).toMatchObject({ ok: false, field: "userId" });
    expect(await addRateAction("u", { ...ok, hourlyRate: "" })).toMatchObject({ ok: false, field: "hourlyRate" });
    expect(await addRateAction("u", { ...ok, hourlyRate: "0" })).toMatchObject({ ok: false, field: "hourlyRate" });
    expect(await addRateAction("u", { ...ok, hourlyRate: "-5" })).toMatchObject({ ok: false, field: "hourlyRate" });
    expect(await addRateAction("u", { ...ok, hourlyRate: "1e3" })).toMatchObject({ ok: false, field: "hourlyRate" });
    expect(await addRateAction("u", { ...ok, validFrom: "2026-02-30" })).toMatchObject({ ok: false, field: "validFrom" });
    expect(await addRateAction("u", { ...ok, expenseAccountCode: " " })).toMatchObject({ ok: false, field: "expenseAccountCode" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads rate_overlap as a sentence, keeps the reason, and does not revalidate", async () => {
    fetchMock.mockRejectedValue(refuse(409, "this range overlaps another rate of the person: end that rate first", "rate_overlap"));
    const r = await addRateAction("u-dev", ok);
    expect(r).toMatchObject({ ok: false, reason: "rate_overlap" });
    expect(r.error).toMatch(/overlaps another rate for this person/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says a 403 in words, and names the second factor when only assurance stands in the way", async () => {
    fetchMock.mockRejectedValueOnce(refuse(403, "forbidden"));
    expect(await addRateAction("u-dev", ok)).toEqual({ ok: false, error: "You don't have permission to add a freelancer rate." });
    fetchMock.mockRejectedValueOnce(refuse(403, "not authorized: needs a second factor", "assurance_required"));
    expect(await addRateAction("u-dev", ok)).toEqual({
      ok: false, error: "You need a second factor before you can add a freelancer rate.", reason: "assurance_required",
    });
  });

  it("falls back to the server's words for a reason it does not know", async () => {
    fetchMock.mockRejectedValue(refuse(409, "something new and specific", "brand_new_reason"));
    expect((await addRateAction("u-dev", ok)).error).toBe("something new and specific");
  });
});

describe("endRateAction, withdrawRateAction, linkVendorAction", () => {
  it("ends a rate with PATCH {validTo}", async () => {
    fetchMock.mockResolvedValue({ id: "r1" });
    await endRateAction("u-dev", "r1", "2026-12-31");
    expect(call().path).toBe("/api/co-1/finance/freelancers/u-dev/rates/r1");
    expect(call().init?.method).toBe("PATCH");
    expect(body()).toEqual({ validTo: "2026-12-31" });
  });
  it("refuses a bad end date before any request", async () => {
    expect(await endRateAction("u", "r", "soon")).toMatchObject({ ok: false, field: "validTo" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("withdraws with a bodyless DELETE, and reads rate_used as a sentence", async () => {
    fetchMock.mockResolvedValueOnce({ deleted: true });
    expect((await withdrawRateAction("u-dev", "r1")).ok).toBe(true);
    expect(call().init?.method).toBe("DELETE");
    expect(call().init?.body).toBeUndefined();
    fetchMock.mockRejectedValueOnce(refuse(409, "this rate priced hours on a bill", "rate_used"));
    expect((await withdrawRateAction("u-dev", "r1")).error).toMatch(/already on a bill/);
  });
  it("links a vendor with PATCH {userId}, and says person_has_vendor in words", async () => {
    fetchMock.mockResolvedValueOnce({ vendorId: "v3", userId: "u-creative" });
    expect((await linkVendorAction("v3", "u-creative")).ok).toBe(true);
    expect(call().path).toBe("/api/co-1/finance/ap/vendors/v3/person");
    expect(call().init?.method).toBe("PATCH");
    expect(body()).toEqual({ userId: "u-creative" });
    fetchMock.mockRejectedValueOnce(refuse(409, "another live vendor already names this person", "person_has_vendor"));
    expect((await linkVendorAction("v3", "u-dev")).error).toMatch(/Another vendor already names this person/);
    expect(await linkVendorAction("", "u")).toMatchObject({ ok: false, field: "vendorId" });
    expect(await linkVendorAction("v", "")).toMatchObject({ ok: false, field: "userId" });
  });
});

describe("draftBillAction", () => {
  it("POSTs the person and the period", async () => {
    fetchMock.mockResolvedValue({ billId: "b1", billNo: "GA/FB/2026/0002" });
    const r = await draftBillAction("gede-ic", "2026-09-01", "2026-09-30");
    expect(r.result).toMatchObject({ billNo: "GA/FB/2026/0002" });
    expect(call().path).toBe("/api/co-1/finance/freelancer-bills");
    expect(body()).toEqual({ userId: "gede-ic", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  });
  it("carries every blocker of a 409 bill_blocked from the answer's body", async () => {
    const blockers = [{ code: "NO_VENDOR", message: "no live vendor names Putu" }, { code: "NO_RATE", message: "no rate covers 2026-09-30" }];
    fetchMock.mockRejectedValue(refuse(409, "this bill cannot be drafted yet", "bill_blocked", { error: "x", reason: "bill_blocked", blockers }));
    const r = await draftBillAction("u-creative", "2026-09-01", "2026-09-30");
    expect(r).toMatchObject({ ok: false, reason: "bill_blocked", blockers });
    expect(r.error).toBe("this bill cannot be drafted yet");
  });
  it("refuses a bad period before any request", async () => {
    expect((await draftBillAction("u", "2026-09-30", "2026-09-01")).error).toMatch(/ends before it starts/);
    expect((await draftBillAction("", "2026-09-01", "2026-09-30")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("draftAllReadyAction", () => {
  const f = (id: string, over: Record<string, unknown> = {}) => ({
    user: { id, name: `Name ${id}`, email: `${id}@x` }, vendor: null, lines: [{ minutes: 60 }], blockers: [], warnings: [], ...over,
  });
  const preview = (...freelancers: unknown[]) => ({ periodStart: "2026-09-01", periodEnd: "2026-09-30", freelancers });

  it("re-reads the preview on the server and drafts only the ready ones, one at a time", async () => {
    fetchMock
      .mockResolvedValueOnce(preview(f("a"), f("b", { blockers: [{ code: "NO_VENDOR", message: "m" }] }), f("c")))
      .mockResolvedValueOnce({ billNo: "GA/FB/2026/0002" })
      .mockResolvedValueOnce({ billNo: "GA/FB/2026/0003" });
    const r = await draftAllReadyAction("2026-09-01", "2026-09-30");
    expect(r.ok).toBe(true);
    expect(call(0).path).toBe("/api/co-1/finance/freelancer-bills/preview?periodStart=2026-09-01&periodEnd=2026-09-30");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(body(1).userId).toBe("a");
    expect(body(2).userId).toBe("c");
    expect(r.result?.map((o) => [o.userId, o.ok, o.billNo])).toEqual([["a", true, "GA/FB/2026/0002"], ["c", true, "GA/FB/2026/0003"]]);
  });

  it("one refusal does not stop the others, and is named", async () => {
    fetchMock
      .mockResolvedValueOnce(preview(f("a"), f("c")))
      .mockRejectedValueOnce(refuse(409, "nothing", "nothing_to_bill"))
      .mockResolvedValueOnce({ billNo: "GA/FB/2026/0003" });
    const r = await draftAllReadyAction("2026-09-01", "2026-09-30");
    expect(r.ok).toBe(true);
    expect(r.result?.[0]).toMatchObject({ userId: "a", ok: false });
    expect(r.result?.[0].error).toMatch(/nothing left to bill/);
    expect(r.result?.[1]).toMatchObject({ userId: "c", ok: true });
  });

  it("stops at a 403 instead of repeating it for everyone, and reports not ok", async () => {
    fetchMock
      .mockResolvedValueOnce(preview(f("a"), f("c")))
      .mockRejectedValueOnce(refuse(403, "forbidden"));
    const r = await draftAllReadyAction("2026-09-01", "2026-09-30");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission/);
  });

  it("says so when nobody is ready, and drafts nothing", async () => {
    fetchMock.mockResolvedValueOnce(preview(f("b", { lines: [] })));
    const r = await draftAllReadyAction("2026-09-01", "2026-09-30");
    expect(r).toEqual({ ok: false, error: "Nobody is ready to bill in this period." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not draft when the preview is unreadable", async () => {
    fetchMock.mockResolvedValueOnce([]);
    expect((await draftAllReadyAction("2026-09-01", "2026-09-30")).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset();
    expect((await draftAllReadyAction("2026-09-30", "2026-09-01")).error).toMatch(/ends before it starts/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("discardBillAction", () => {
  it("DELETEs the bill, and reads bill_not_draft as a sentence", async () => {
    fetchMock.mockResolvedValueOnce({ billId: "b1", discarded: true, releasedEntries: 4 });
    const r = await discardBillAction("b1");
    expect(r.result?.releasedEntries).toBe(4);
    expect(call().path).toBe("/api/co-1/finance/freelancer-bills/b1");
    expect(call().init?.method).toBe("DELETE");
    fetchMock.mockRejectedValueOnce(refuse(409, "bill X is approved; only a draft can be discarded", "bill_not_draft"));
    expect((await discardBillAction("b1")).error).toMatch(/Only a draft can be discarded/);
  });
});

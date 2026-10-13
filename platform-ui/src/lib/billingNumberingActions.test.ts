import { describe, it, expect, vi, beforeEach } from "vitest";

// PV5-04b (PV-D35) — the writes behind the service-line and number-code sections, and the picker on the staff invoice page.
// The platform's refusals are put in words; nothing here decides who may do what (Cerbos does).

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }) }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import { preassignCodeAction, saveServiceLineAction } from "./billingNumberingActions";
import { setServiceLineAction } from "./invoiceActions";

const fetchMock = vi.mocked(platformFetch);
const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const body = () => JSON.parse(String(fetchMock.mock.calls[0][2]?.body));
const refused = (status: number, reason?: string) => new PlatformError(status, "raw message", undefined, undefined, reason);

beforeEach(() => { fetchMock.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("saveServiceLineAction", () => {
  it("🔴 PUTs the line under its key; a rename sends the name and the department, and nothing it was not given", async () => {
    fetchMock.mockResolvedValue({});
    const r = await saveServiceLineAction(null, form({ key: "web", name: "Web development", departmentId: "dept-web" }));
    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/billing/service-lines/web");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PUT");
    expect(body()).toEqual({ name: "Web development", departmentId: "dept-web" });
    expect(revalidatePath).toHaveBeenCalledWith("/finance/settings/billing-profile");
  });

  it("🔴 a switch-off sends ONLY active (it must not rename the line or clear its department)", async () => {
    fetchMock.mockResolvedValue({});
    await saveServiceLineAction(null, form({ key: "web", active: "false" }));
    expect(body()).toEqual({ active: false });
  });

  it("an empty department unlinks (null); a bad key or a blank name never reaches the server", async () => {
    fetchMock.mockResolvedValue({});
    await saveServiceLineAction(null, form({ key: "web", name: "Web", departmentId: "" }));
    expect(body()).toEqual({ name: "Web", departmentId: null });
    fetchMock.mockClear();
    const badKey = await saveServiceLineAction(null, form({ key: "Web-Dev", name: "Web" }));
    expect(badKey).toMatchObject({ ok: false, field: "key" });
    const blank = await saveServiceLineAction(null, form({ key: "web", name: "  " }));
    expect(blank).toMatchObject({ ok: false, field: "name" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts a 403 in words", async () => {
    fetchMock.mockRejectedValue(refused(403));
    const r = await saveServiceLineAction(null, form({ key: "web", name: "Web" }));
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/finance managers and company administrators/);
  });
});

describe("preassignCodeAction", () => {
  it("POSTs the pair, and the code only when one is typed (upper-cased)", async () => {
    fetchMock.mockResolvedValue({ code: "7K3", alreadyAssigned: false });
    const r = await preassignCodeAction(null, form({ serviceLineKey: "web", businessType: "hotel", code: "" }));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/billing/number-codes");
    expect(body()).toEqual({ serviceLineKey: "web", businessType: "hotel" });
    expect(r).toMatchObject({ ok: true });
    expect(r.notice).toMatch(/Assigned the code 7K3/);
    fetchMock.mockClear();
    await preassignCodeAction(null, form({ serviceLineKey: "web", businessType: "hotel", code: "qx7" }));
    expect(body()).toEqual({ serviceLineKey: "web", businessType: "hotel", code: "QX7" });
  });

  it("says so when the pair already had a code (it is never changed)", async () => {
    fetchMock.mockResolvedValue({ code: "7K3", alreadyAssigned: true });
    const r = await preassignCodeAction(null, form({ serviceLineKey: "web", businessType: "hotel" }));
    expect(r.notice).toMatch(/already has the code 7K3/);
  });

  it("🔴 the 409 reasons are put in plain words, and a malformed code never reaches the server", async () => {
    fetchMock.mockRejectedValueOnce(refused(409, "code_already_assigned"));
    expect((await preassignCodeAction(null, form({ serviceLineKey: "web", businessType: "hotel", code: "ZZ9" }))).error).toMatch(/never changed/);
    fetchMock.mockRejectedValueOnce(refused(409, "code_taken"));
    expect((await preassignCodeAction(null, form({ serviceLineKey: "web", businessType: "retail", code: "ZZ9" }))).error).toMatch(/another pair/);
    fetchMock.mockClear();
    const bad = await preassignCodeAction(null, form({ serviceLineKey: "web", businessType: "hotel", code: "a-b" }));
    expect(bad).toMatchObject({ ok: false, field: "code" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("setServiceLineAction (the invoice picker)", () => {
  it("🔴 PATCHes the invoice's service line; an empty choice clears it (null)", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const r = await setServiceLineAction("inv-1", null, form({ serviceLineKey: "web" }));
    expect(r).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/invoices/inv-1/service-line");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PATCH");
    expect(body()).toEqual({ serviceLineKey: "web" });
    fetchMock.mockClear();
    await setServiceLineAction("inv-1", null, form({ serviceLineKey: "" }));
    expect(body()).toEqual({ serviceLineKey: null });
    expect(revalidatePath).toHaveBeenCalledWith("/invoices/inv-1");
  });

  it("says why when it is refused: not allowed, or already issued", async () => {
    fetchMock.mockRejectedValueOnce(refused(403));
    expect((await setServiceLineAction("inv-1", null, form({ serviceLineKey: "web" }))).error).toMatch(/limited to company administrators and managers/);
    fetchMock.mockRejectedValueOnce(refused(409, "issued"));
    expect((await setServiceLineAction("inv-1", null, form({ serviceLineKey: "web" }))).error).toMatch(/already issued/);
    fetchMock.mockRejectedValueOnce(refused(400));
    expect((await setServiceLineAction("inv-1", null, form({ serviceLineKey: "nope" }))).error).toBe("raw message");
  });
});

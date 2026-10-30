import { describe, it, expect, vi, beforeEach } from "vitest";

// AIP-17b and AIP-18 (BFF §66.9, §66.11): the owner's writes and the lift. The tenant is the session's own; a refusal is returned, never thrown, in words;
// every successful write revalidates the two screens; `changed: false` (nothing moved) is passed through.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { PlatformError, platformFetch } from "./platform";
import { liftStopAction, setAllowanceAction, setCompanyBudgetAction, setUnitBudgetAction } from "./aiBudgetActions";

const fetchMock = vi.mocked(platformFetch);
const call = () => fetchMock.mock.calls[0] as unknown as [string, string, { method: string; body?: string }];

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ changed: true });
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(getSessionUserId).mockResolvedValue("u1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-1");
});

describe("the company's alert figure", () => {
  it("PUTs the figure as the string typed, to the session's company", async () => {
    expect(await setCompanyBudgetAction("250.00")).toEqual({ ok: true, changed: true });
    const [path, user, init] = call();
    expect(path).toBe("/api/co-1/ai-usage/budgets/company");
    expect(user).toBe("u1");
    expect(init).toEqual({ method: "PUT", body: '{"monthlyUsd":"250.00"}' });
  });
  it("removes the figure with null", async () => {
    await setCompanyBudgetAction(null);
    expect(call()[2].body).toBe('{"monthlyUsd":null}');
  });
  it("revalidates both screens after a write", async () => {
    await setCompanyBudgetAction("1");
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(["/ai-usage", "/analytics/ai-usage/department"]);
  });
});

describe("a department's budget", () => {
  it("sends the figure and the mode", async () => {
    await setUnitBudgetAction("d-web", "40", "soft_stop");
    const [path, , init] = call();
    expect(path).toBe("/api/co-1/ai-usage/budgets/units/d-web");
    expect(init).toEqual({ method: "PUT", body: '{"monthlyUsd":"40","mode":"soft_stop"}' });
  });
  it("omits the mode when none is given (the server keeps the stored one, Report only for a new budget)", async () => {
    await setUnitBudgetAction("d-web", "40");
    expect(call()[2].body).toBe('{"monthlyUsd":"40"}');
  });
  it("removes with null and NO mode (the server refuses a mode with no figure)", async () => {
    await setUnitBudgetAction("d-web", null, "report");
    expect(call()[2].body).toBe('{"monthlyUsd":null}');
  });
  it("encodes the unit id and refuses an empty one without calling the server", async () => {
    await setUnitBudgetAction("a/b", "1");
    expect(call()[0]).toBe("/api/co-1/ai-usage/budgets/units/a%2Fb");
    fetchMock.mockClear();
    expect(await setUnitBudgetAction("", "1")).toMatchObject({ ok: false, field: "unitNodeId" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a person's allowance", () => {
  it("sets a number and clears with null", async () => {
    await setAllowanceAction("p-1", 350);
    expect(call()[0]).toBe("/api/co-1/ai-usage/allowances/p-1");
    expect(call()[2]).toEqual({ method: "PUT", body: '{"dailyReplies":350}' });
    fetchMock.mockClear();
    await setAllowanceAction("p-1", null);
    expect(call()[2].body).toBe('{"dailyReplies":null}');
  });
});

describe("the lift (AIP-18)", () => {
  it("POSTs with no body to the unit's lift route", async () => {
    expect(await liftStopAction("d-web")).toEqual({ ok: true, changed: true });
    const [path, , init] = call();
    expect(path).toBe("/api/co-1/ai-usage/budgets/units/d-web/lift");
    expect(init).toEqual({ method: "POST" });
  });
  it("passes `changed: false` through (lifting again in the same month)", async () => {
    fetchMock.mockResolvedValue({ month: "2026-10", changed: false });
    expect(await liftStopAction("d-web")).toEqual({ ok: true, changed: false });
  });
});

describe("refusals are returned in words, never thrown", () => {
  it("says the server's 400 sentence, with its field", async () => {
    fetchMock.mockRejectedValue(new PlatformError(400, "monthlyUsd must be greater than 0", "monthlyUsd"));
    expect(await setCompanyBudgetAction("0")).toEqual({ ok: false, error: "monthlyUsd must be greater than 0", field: "monthlyUsd" });
    expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
  });
  it("says a 403 for a write, and a different one for a lift", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "Forbidden"));
    expect(await setAllowanceAction("p", 1)).toMatchObject({ ok: false, error: expect.stringMatching(/Only the owner/) });
    expect(await liftStopAction("d")).toMatchObject({ ok: false, error: expect.stringMatching(/head of this department/) });
  });
  it("says the 404s: no soft stop, no such person, no such department", async () => {
    fetchMock.mockRejectedValue(new PlatformError(404, "no_soft_stop"));
    expect(await liftStopAction("d")).toMatchObject({ ok: false, error: expect.stringMatching(/no soft stop/) });
    fetchMock.mockRejectedValue(new PlatformError(404, "person_not_found"));
    expect(await setAllowanceAction("p", 1)).toMatchObject({ ok: false, error: expect.stringMatching(/not an active member/) });
    fetchMock.mockRejectedValue(new PlatformError(404, "unit_not_found"));
    expect(await setUnitBudgetAction("d", "1")).toMatchObject({ ok: false, error: expect.stringMatching(/department was not found/) });
  });
  it("says a signed-out session and a missing company without calling the server", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect(await setCompanyBudgetAction("1")).toMatchObject({ ok: false, error: expect.stringMatching(/session expired/) });
    vi.mocked(getSessionUserId).mockResolvedValue("u1");
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    expect(await setCompanyBudgetAction("1")).toMatchObject({ ok: false, error: "Select a company first." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("lets a failure that is not the platform's through", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    await expect(setCompanyBudgetAction("1")).rejects.toThrow("socket hang up");
  });
});

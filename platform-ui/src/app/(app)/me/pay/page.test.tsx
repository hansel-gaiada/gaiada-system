import { describe, it, expect, vi } from "vitest";

// /me/pay asks for the person's OWN leave ledger by name. The backend refuses 400 "subjectUserId required" for a staff
// reader (HR, admins) when the subject is left out, which broke the page for them (found live on 1.0.0-alpha.397).
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-self") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-self", roles: [], companies: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
const ledger = vi.fn(async () => null);
vi.mock("@/lib/hr-full", () => ({
  listPayslips: vi.fn(async () => []),
  getLeaveLedger: (...a: unknown[]) => ledger(...(a as [])),
  formatMoney: () => "-",
  minutesToDays: () => "0",
}));

import MyPayPage from "./page";

describe("/me/pay", () => {
  it("reads the person's own leave ledger by name", async () => {
    await MyPayPage();
    expect(ledger).toHaveBeenCalledWith("u-self", "co-a", "u-self", expect.any(Number));
  });
});

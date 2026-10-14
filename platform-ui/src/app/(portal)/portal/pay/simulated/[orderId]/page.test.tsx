import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PortalSimulatedPayment } from "@/lib/portal";

// PV-D41 — the SIMULATED hosted payment page: it says plainly that no real money moves, shows the invoice number and the
// amount, offers exactly the three outcomes while the payment is open, and nothing once it is final. 404 (notFound) when
// the BFF says there is no such page (simulation off, or not the caller's order).

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind" })) }));
vi.mock("@/lib/portal-data", () => ({ getSimulatedPayment: vi.fn() }));
vi.mock("@/lib/portalActions", () => ({ portalSimulatedPaymentAct: vi.fn() }));

import { getSimulatedPayment } from "@/lib/portal-data";
import SimulatedPaymentPage from "./page";

const mocked = vi.mocked(getSimulatedPayment);
const OPEN: PortalSimulatedPayment = {
  simulated: true, orderId: "ck-1", invoiceId: "inv-1", invoiceNo: "EX/2026/0021", amount: 150_000, currency: "IDR",
  transactionStatus: null, canAct: true, returnUrl: "/portal/invoices/inv-1?checkout=finished",
};
const mount = async (p: PortalSimulatedPayment | null) => {
  mocked.mockResolvedValue(p);
  return render(await SimulatedPaymentPage({ params: Promise.resolve({ orderId: "ck-1" }) }));
};

beforeEach(() => mocked.mockReset());

describe("simulated payment page (PV-D41)", () => {
  it("🔴 says it is simulated and no real money moves, with the invoice number, the amount and the three outcomes", async () => {
    await mount(OPEN);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Simulated payment");
    expect(screen.getByText("Simulated payment (review stage): no real money moves.")).toBeInTheDocument();
    expect(screen.getByText("EX/2026/0021")).toBeInTheDocument();
    expect(screen.getAllByText(/150,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button").filter((b) => b.getAttribute("name") === "action").map((b) => [b.textContent, (b as HTMLButtonElement).value]))
      .toEqual([["Pay (simulated)", "pay"], ["Leave pending", "pending"], ["Payment fails", "fail"]]);
  });

  it("a final simulated payment offers nothing more", async () => {
    await mount({ ...OPEN, transactionStatus: "settlement", canAct: false });
    expect(screen.queryByRole("button", { name: "Pay (simulated)" })).toBeNull();
    expect(screen.getByText(/Paid \(simulated\)\. No real money moved\./)).toBeInTheDocument();
  });

  it("🔴 no page when the BFF has none (simulation off, or not yours): notFound", async () => {
    await expect(mount(null)).rejects.toThrow("notFound");
  });
});

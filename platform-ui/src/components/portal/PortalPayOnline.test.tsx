import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// PV5-10 — the "Pay online" button: it asks the server action for the provider's hosted page and sends the browser
// there; a refusal is shown as the server wrote it; it never sends the browser anywhere unsafe.

const startCheckout = vi.fn();
vi.mock("@/lib/portalActions", () => ({ portalStartCheckout: (...a: unknown[]) => startCheckout(...a) }));

import { PortalPayOnline } from "./PortalPayOnline";
import { isCheckoutReturn, isCheckoutUrl } from "@/lib/portal";

const assign = vi.fn();
beforeEach(() => {
  startCheckout.mockReset();
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

describe("PortalPayOnline", () => {
  it("sends the browser to the hosted page the server answered", async () => {
    startCheckout.mockResolvedValue({ ok: true, url: "https://app.sandbox.midtrans.com/snap/v4/redirection/tok" });
    render(<PortalPayOnline invoiceId="inv-1" amountDue={150000} currency="IDR" />);
    fireEvent.click(screen.getByRole("button", { name: "Pay online" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://app.sandbox.midtrans.com/snap/v4/redirection/tok"));
    expect(screen.getByRole("status")).toHaveTextContent(/Taking you to the payment page/);
    expect((startCheckout.mock.calls[0][1] as FormData).get("invoiceId")).toBe("inv-1");
  });

  it("shows the server's refusal in an alert and goes nowhere", async () => {
    startCheckout.mockResolvedValue({ ok: false, error: "Nothing is left to pay on this invoice." });
    render(<PortalPayOnline invoiceId="inv-1" amountDue={150000} currency="IDR" />);
    fireEvent.click(screen.getByRole("button", { name: "Pay online" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing is left to pay on this invoice.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("never follows an unsafe URL even if one came back", async () => {
    startCheckout.mockResolvedValue({ ok: true, url: "javascript:alert(1)" });
    render(<PortalPayOnline invoiceId="inv-1" amountDue={1} currency="IDR" />);
    fireEvent.click(screen.getByRole("button", { name: "Pay online" }));
    await waitFor(() => expect(startCheckout).toHaveBeenCalled());
    expect(assign).not.toHaveBeenCalled();
  });

  it("names the amount in plain words and never says Card", () => {
    render(<PortalPayOnline invoiceId="inv-1" amountDue={150000} currency="IDR" />);
    expect(screen.getByText(/150,000/)).toBeInTheDocument();
    expect(screen.queryByText(/card/i)).toBeNull();
  });
});

describe("checkout URL and return guards", () => {
  it.each([
    ["https://app.midtrans.com/snap/x", true],
    ["/portal/invoices/inv-1?checkout=finished", true],
    ["//evil.example/x", false],
    ["/\\evil.example", false],
    ["http://app.midtrans.com/snap/x", false],
    ["javascript:alert(1)", false],
    ["", false],
    [undefined, false],
  ])("isCheckoutUrl(%s) = %s", (url, want) => expect(isCheckoutUrl(url)).toBe(want));

  it("recognises our own return and the provider's return parameters, and nothing else", () => {
    expect(isCheckoutReturn({ checkout: "finished" })).toBe(true);
    expect(isCheckoutReturn({ checkout: "finished?order_id=ck-1" })).toBe(true);
    expect(isCheckoutReturn({ order_id: "ck-1", status_code: "200" })).toBe(true);
    expect(isCheckoutReturn({ transaction_status: "pending" })).toBe(true);
    expect(isCheckoutReturn({})).toBe(false);
    expect(isCheckoutReturn(undefined)).toBe(false);
    expect(isCheckoutReturn({ checkout: "other" })).toBe(false);
  });
});

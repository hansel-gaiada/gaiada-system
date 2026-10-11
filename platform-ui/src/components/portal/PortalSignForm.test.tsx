import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// CP-14 — the sign form's OWN states. The durable "Signed — thank you" is the contract page's (see
// app/(portal)/portal/contracts/[contractId]/page.test.tsx); this pins the bridge the form shows between
// the action returning and the refreshed page arriving, and that it says the same thing the page says.
// The server action is mocked: the real one resolves the session via `next/headers`.
vi.mock("@/lib/portalActions", () => ({ portalSignContract: vi.fn() }));

import { portalSignContract } from "@/lib/portalActions";
import { PortalSignForm } from "./PortalSignForm";

const signMock = vi.mocked(portalSignContract);

const fillAndSubmit = () => {
  fireEvent.change(screen.getByLabelText(/your full name/i), { target: { value: "Dana Whitfield" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.submit(screen.getByRole("button", { name: /sign this agreement/i }).closest("form")!);
};

beforeEach(() => signMock.mockReset());

describe("PortalSignForm", () => {
  it("the name field is the signer's to type: never pre-filled", () => {
    render(<PortalSignForm contractId="k-1" title="Website retainer 2026" />);
    expect(screen.getByLabelText(/your full name/i)).toHaveValue("");
    expect(screen.getByRole("checkbox")).toBeRequired();
  });

  it("on success, shows the shared 'Signed — thank you' confirmation in place of the form", async () => {
    signMock.mockResolvedValue({ ok: true, id: "k-1" });
    render(<PortalSignForm contractId="k-1" title="Website retainer 2026" />);
    fillAndSubmit();
    const note = await screen.findByText(/signed — thank you/i);
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveTextContent(/recorded against Website retainer 2026/);
    expect(screen.queryByRole("button", { name: /sign this agreement/i })).toBeNull();
    const fd = signMock.mock.calls[0][1] as FormData;
    expect(fd.get("contractId")).toBe("k-1");
    expect(fd.get("signerName")).toBe("Dana Whitfield");
  });

  it("on a refusal, keeps the form and shows the server's reason", async () => {
    signMock.mockResolvedValue({ ok: false, error: "Your access to this portal is view-only." });
    render(<PortalSignForm contractId="k-1" title="Website retainer 2026" />);
    fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/view-only/);
    expect(screen.getByRole("button", { name: /sign this agreement/i })).toBeInTheDocument();
    expect(screen.queryByText(/signed — thank you/i)).toBeNull();
  });
});

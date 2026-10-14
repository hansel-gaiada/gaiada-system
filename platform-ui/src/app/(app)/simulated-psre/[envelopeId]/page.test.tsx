import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SimulatedEnvelopeView } from "@/lib/simulatedPsre";

// PV5-11 — our countersigner's page at the SIMULATED PSrE. Same banner and layout as the client's; whether THIS caller may
// sign is the backend's `canSign` (a company owner only), with the reason in words otherwise. Nothing reads a role here.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-owner") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-owner" })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "gaiada") }));
vi.mock("@/lib/simulatedPsre-data", () => ({ getStaffSimulatedEnvelope: vi.fn() }));
vi.mock("@/lib/contractsActions", () => ({ countersignSimulatedPsreAction: vi.fn() }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));

import { getStaffSimulatedEnvelope } from "@/lib/simulatedPsre-data";
import StaffSimulatedPsrePage from "./page";

const envMock = vi.mocked(getStaffSimulatedEnvelope);
const HASH = "e".repeat(64);
const VIEW: SimulatedEnvelopeView = {
  envelopeId: "simenv_1", provider: "simulated_psre", label: "Simulated PSrE (review stage)", simulated: true,
  notice: "Simulated certified signature: not a real PSrE signature", title: "Website retainer 2026", status: "pending",
  completedAt: null, contractId: "k-1", clientId: "cl-1", contractStatus: "sent", contentSha256: HASH,
  documentFilename: "retainer.txt", documentContentType: "text/plain", documentSha256: HASH, documentText: "Clause 1.",
  documentPath: "/api/gaiada/simulated-psre/envelopes/simenv_1/document",
  signers: [
    { role: "client", displayName: "Northwind (client)", state: "signed", signerName: "Dana Whitfield", signerTitle: null, signedAt: "2026-10-10T03:00:00Z" },
    { role: "countersigner", displayName: "Our company", state: "pending", signerName: null, signerTitle: null, signedAt: null },
  ],
  yourRole: "countersigner", canSign: true, reason: null,
};
const mount = async (v: SimulatedEnvelopeView | null) => {
  envMock.mockResolvedValue(v);
  return render(await StaffSimulatedPsrePage({ params: Promise.resolve({ envelopeId: "simenv_1" }) }));
};
beforeEach(() => envMock.mockReset());

describe("staff simulated PSrE page", () => {
  it("🔴 a 404 from the backend is notFound()", async () => {
    await expect(mount(null)).rejects.toThrow("notFound");
    expect(envMock).toHaveBeenCalledWith("u-owner", "gaiada", "simenv_1");
  });

  it("renders the banner, the document, who has signed, and the countersign form when canSign", async () => {
    await mount(VIEW);
    expect(screen.getByRole("note")).toHaveTextContent("Simulated certified signature: not a real PSrE signature");
    expect(screen.getByText("Clause 1.")).toBeInTheDocument();
    expect(screen.getByText(/Dana Whitfield/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Countersign at the simulated PSrE" })).toBeInTheDocument();
  });

  it("🔴 when the backend says the caller may not (not an owner), no form: the reason, and the link back to the billing tab", async () => {
    await mount({ ...VIEW, canSign: false, reason: "Only a company owner can countersign." });
    expect(screen.queryByRole("button", { name: /countersign at the simulated/i })).toBeNull();
    expect(screen.getByText("Only a company owner can countersign.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to contracts and billing" })).toHaveAttribute("href", "/clients/cl-1/billing");
  });
});

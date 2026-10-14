import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SimulatedEnvelopeView } from "@/lib/simulatedPsre";

// PV5-11 — the client's page at the SIMULATED PSrE, rendered as the server renders it. Pins: a 404 from the backend (flag off,
// or not this client's envelope) is a 404 here, the banner is always present, and the form appears only when the backend
// said canSign.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind" })) }));
vi.mock("@/lib/simulatedPsre-data", () => ({ getPortalSimulatedEnvelope: vi.fn() }));
vi.mock("@/lib/portalActions", () => ({ portalSignSimulatedPsre: vi.fn() }));

import { getPortalSimulatedEnvelope } from "@/lib/simulatedPsre-data";
import PortalSimulatedPsrePage from "./page";

const envMock = vi.mocked(getPortalSimulatedEnvelope);
const HASH = "f".repeat(64);
const VIEW: SimulatedEnvelopeView = {
  envelopeId: "simenv_1", provider: "simulated_psre", label: "Simulated PSrE (review stage)", simulated: true,
  notice: "Simulated certified signature: not a real PSrE signature", title: "Website retainer 2026", status: "pending",
  completedAt: null, contractId: "k-1", clientId: "cl-1", contractStatus: "sent", contentSha256: HASH,
  documentFilename: "retainer.txt", documentContentType: "text/plain", documentSha256: HASH, documentText: "Clause 1.",
  documentPath: "/api/northwind/portal/simulated-psre/envelopes/simenv_1/document",
  signers: [{ role: "client", displayName: "Northwind (client)", state: "pending", signerName: null, signerTitle: null, signedAt: null }],
  yourRole: "client", canSign: true, reason: null,
};
const mount = async (v: SimulatedEnvelopeView | null) => {
  envMock.mockResolvedValue(v);
  return render(await PortalSimulatedPsrePage({ params: Promise.resolve({ envelopeId: "simenv_1" }) }));
};
beforeEach(() => envMock.mockReset());

describe("portal simulated PSrE page", () => {
  it("🔴 a 404 from the backend is notFound()", async () => {
    await expect(mount(null)).rejects.toThrow("notFound");
    expect(envMock).toHaveBeenCalledWith("u-client", "northwind", "simenv_1");
  });

  it("renders the banner, the title as the one h1, the document and the form when canSign", async () => {
    await mount(VIEW);
    expect(screen.getByRole("note")).toHaveTextContent("Simulated certified signature: not a real PSrE signature");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Website retainer 2026");
    expect(screen.getByText("Clause 1.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign at the simulated PSrE" })).toBeInTheDocument();
  });

  it("without canSign: the backend's reason, no form, and the way back", async () => {
    await mount({ ...VIEW, canSign: false, reason: "Your access to this portal is view-only." });
    expect(screen.queryByRole("button", { name: /sign at the simulated/i })).toBeNull();
    expect(screen.getByText("Your access to this portal is view-only.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the agreement" })).toHaveAttribute("href", "/portal/contracts/k-1");
  });
});

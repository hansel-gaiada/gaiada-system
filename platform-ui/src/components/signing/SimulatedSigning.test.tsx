import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { SimulatedEnvelopeView } from "@/lib/simulatedPsre";

// PV5-11 — the simulated PSrE signing pages' shared pieces: the banner, the document and its hash, the signers, and the
// form that exists ONLY when the backend said canSign. Everything shown is the backend's field.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { SimulatedBanner } from "./SimulatedBanner";
import { SimulatedEnvelopeBody } from "./SimulatedEnvelopeBody";
import { SimulatedSigningPanel } from "./SimulatedSigningPanel";

const HASH = "0123456789abcdef".repeat(4);
const NOTICE = "Simulated certified signature: not a real PSrE signature";

const VIEW: SimulatedEnvelopeView = {
  envelopeId: "simenv_1", provider: "simulated_psre", label: "Simulated PSrE (review stage)", simulated: true, notice: NOTICE,
  title: "Website retainer 2026", status: "pending", completedAt: null, contractId: "k-1", clientId: "cl-1", contractStatus: "sent",
  contentSha256: HASH, documentFilename: "retainer.txt", documentContentType: "text/plain", documentSha256: HASH,
  documentText: "Clause 1. The work.\nClause 2. The fee.", documentPath: "/api/northwind/portal/simulated-psre/envelopes/simenv_1/document",
  signers: [
    { role: "client", displayName: "Northwind (client)", state: "pending", signerName: null, signerTitle: null, signedAt: null },
    { role: "countersigner", displayName: "Our company", state: "pending", signerName: null, signerTitle: null, signedAt: null },
  ],
  yourRole: "client", canSign: true, reason: null,
};

const action = vi.fn();
beforeEach(() => action.mockReset());

const page = (view: SimulatedEnvelopeView, variant: "portal" | "staff" = "portal") =>
  render(
    <SimulatedEnvelopeBody view={view} variant={variant}>
      <SimulatedSigningPanel
        view={view} variant={variant} action={action} submitLabel="Sign at the simulated PSrE"
        back={{ href: "/portal/contracts/k-1", label: "Back to the agreement" }} clientId="cl-1"
      />
    </SimulatedEnvelopeBody>,
  );

describe("SimulatedBanner", () => {
  it("is a note carrying the backend's notice and the provider label", () => {
    render(<SimulatedBanner label="Simulated PSrE (review stage)" notice={NOTICE} />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Simulated PSrE (review stage)");
    expect(note).toHaveTextContent(NOTICE);
  });
  it("falls back to the fixed sentence when the notice is missing: the page can never omit the statement", () => {
    render(<SimulatedBanner label={null} notice={undefined} />);
    expect(screen.getByRole("note")).toHaveTextContent(NOTICE);
  });
});

describe("simulated signing page body", () => {
  it("🔴 shows the banner, the document text, the short hash with a copy button, the signers, and the form when canSign", () => {
    page(VIEW);
    expect(screen.getByRole("note")).toHaveTextContent(NOTICE);
    expect(screen.getByRole("region", { name: "Text of the document" })).toHaveTextContent(/Clause 1\. The work\./);
    expect(screen.getByText("01234567…89abcdef")).toBeInTheDocument();
    expect(screen.getByText("SHA-256 of the document")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy the full sha-256 of the document/i })).toBeInTheDocument();
    const signers = screen.getByRole("list", { name: "Signers" });
    expect(within(signers).getAllByRole("listitem")).toHaveLength(2);
    expect(within(signers).getAllByText("Not signed yet")).toHaveLength(2);
    // The form.
    expect(screen.getByLabelText(/your full name/i)).toHaveValue("");
    expect(screen.getByRole("checkbox")).toBeRequired();
    expect(screen.getByRole("button", { name: "Sign at the simulated PSrE" })).toBeInTheDocument();
    const form = screen.getByRole("button", { name: "Sign at the simulated PSrE" }).closest("form")!;
    expect((form.querySelector("input[name=documentSha256]") as HTMLInputElement).value).toBe(HASH);
    expect((form.querySelector("input[name=envelopeId]") as HTMLInputElement).value).toBe("simenv_1");
    expect((form.querySelector("input[name=contractId]") as HTMLInputElement).value).toBe("k-1");
  });

  it("🔴 no form without canSign: it shows the backend's reason instead", () => {
    page({ ...VIEW, canSign: false, reason: "Only a company owner can countersign." });
    expect(screen.queryByRole("button", { name: /sign at the simulated psre/i })).toBeNull();
    expect(screen.queryByLabelText(/your full name/i)).toBeNull();
    expect(screen.getByText("Only a company owner can countersign.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the agreement" })).toHaveAttribute("href", "/portal/contracts/k-1");
  });

  it("when this caller's own signer row is signed, says so durably (not from the form's state), with the link back", () => {
    const signed: SimulatedEnvelopeView = {
      ...VIEW, canSign: false, reason: "You have already signed.",
      signers: [
        { ...VIEW.signers[0], state: "signed", signerName: "Dana Whitfield", signerTitle: "COO", signedAt: "2026-10-11T03:00:00Z" },
        VIEW.signers[1],
      ],
    };
    page(signed);
    // (The hash's copy button has its own, empty, live region: pick ours by its text.)
    const status = screen.getByText(/Signed at the simulated PSrE/);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent(/not a real PSrE signature/);
    expect(screen.getByText(/Dana Whitfield, COO, 11 Oct 2026/)).toBeInTheDocument();
    expect(screen.queryByText("You have already signed.")).toBeNull();
  });

  it("without inline text it links the simulator's copy through the backend's documentPath", () => {
    page({ ...VIEW, documentText: null, documentFilename: "retainer.pdf" });
    expect(screen.queryByRole("region", { name: "Text of the document" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download retainer.pdf" })).toHaveAttribute("href", VIEW.documentPath);
  });
});

describe("simulated sign form", () => {
  it("sends the typed name, title, agreement and the document hash; shows the status and the way back on success", async () => {
    action.mockResolvedValue({ ok: true, id: "k-1" });
    page(VIEW);
    fireEvent.change(screen.getByLabelText(/your full name/i), { target: { value: "Dana Whitfield" } });
    fireEvent.change(screen.getByLabelText(/your job title/i), { target: { value: "COO" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("button", { name: "Sign at the simulated PSrE" }).closest("form")!);
    const status = await screen.findByText(/Signed at the simulated PSrE/);
    expect(status).toHaveAttribute("role", "status");
    expect(screen.getByRole("link", { name: "Back to the agreement" })).toHaveAttribute("href", "/portal/contracts/k-1");
    const fd = action.mock.calls[0][1] as FormData;
    expect(fd.get("signerName")).toBe("Dana Whitfield");
    expect(fd.get("signerTitle")).toBe("COO");
    expect(fd.get("agree")).toBe("yes");
    expect(fd.get("documentSha256")).toBe(HASH);
    expect(fd.get("clientId")).toBe("cl-1");
  });

  it("a refusal stays in an alert and keeps the form", async () => {
    action.mockResolvedValue({ ok: false, error: "The document changed since you opened this page." });
    page(VIEW);
    fireEvent.change(screen.getByLabelText(/your full name/i), { target: { value: "Dana Whitfield" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("button", { name: "Sign at the simulated PSrE" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/document changed/);
    expect(screen.getByRole("button", { name: "Sign at the simulated PSrE" })).toBeInTheDocument();
  });
});

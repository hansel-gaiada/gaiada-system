import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PortalContractDetail } from "@/lib/portal";

// CP-14 — the contract page's signing card, rendered as the server renders it BEFORE and AFTER the sign
// action's refresh. Regression (release 1.0.0-alpha.352, Next 16.2 -> 16.3.8): the sign action
// revalidates this page and 16.3 now applies that refresh in the same response; the refreshed read has
// `canSign: false`, so the sign form — which was the only thing holding "Signed — thank you" — unmounted
// and the client saw no confirmation (e2e/portal.spec.ts "a client reads an agreement and signs it").
// The confirmation now comes from the recorded signature, which is what these tests pin.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind" })) }));
vi.mock("@/lib/portal-data", () => ({ getPortalContract: vi.fn() }));
vi.mock("@/lib/portalActions", () => ({ portalSignContract: vi.fn() }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: () => null }));
vi.mock("@/components/pipeline/ArtifactMarkdown", () => ({ ArtifactMarkdown: ({ text }: { text: string }) => <div>{text}</div> }));

import { getPortalContract } from "@/lib/portal-data";
import PortalContractPage from "./page";

const contractMock = vi.mocked(getPortalContract);

const SENT: PortalContractDetail = {
  id: "k-1", title: "Website retainer 2026", reference: "NW-2026-01", version: 1, status: "sent",
  value: 12_000_000, currency: "IDR", startsOn: "2026-10-01", endsOn: "2027-09-30",
  sentAt: "2026-10-05T00:00:00Z", signedAt: null, projectId: null,
  bodyMd: "## Scope\nThe work.", declineReason: null, termEnded: false,
  canSign: true, viewOnly: false, signatures: [], document: null,
};
const SIGNED_BY_CLIENT: PortalContractDetail = {
  ...SENT,
  canSign: false,
  signatures: [{ party: "client", signerName: "Dana Whitfield", signerTitle: null, signedAt: "2026-10-11T03:00:00Z" }],
};

const mount = async (k: PortalContractDetail) => {
  contractMock.mockResolvedValue(k);
  return render(await PortalContractPage({ params: Promise.resolve({ contractId: k.id }) }));
};

beforeEach(() => contractMock.mockReset());

describe("contract page: signing card", () => {
  it("before signing: the sign form, and no confirmation", async () => {
    await mount(SENT);
    expect(screen.getByRole("button", { name: /sign this agreement/i })).toBeInTheDocument();
    expect(screen.queryByText(/signed — thank you/i)).toBeNull();
  });

  it("after the sign action's refresh (canSign false, client signature recorded): exactly ONE 'Signed — thank you', from the server", async () => {
    await mount(SIGNED_BY_CLIENT);
    // Exactly one: Playwright's getByText is strict, so a second match would fail the e2e as surely as none.
    const notes = screen.getAllByText(/signed — thank you/i);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveAttribute("role", "status");
    expect(notes[0]).toHaveTextContent(/Dana Whitfield signed Website retainer 2026 for your organisation on 11 Oct 2026/);
    expect(screen.queryByRole("button", { name: /sign this agreement/i })).toBeNull();
    expect(screen.queryByLabelText(/your full name/i)).toBeNull();
  });

  it("a view-only colleague on a signed agreement sees it signed, not 'a colleague needs to sign this'", async () => {
    await mount({ ...SIGNED_BY_CLIENT, viewOnly: true });
    expect(screen.getByText(/signed — thank you/i)).toBeInTheDocument();
    expect(screen.queryByText(/view-only/i)).toBeNull();
  });

  it("a view-only contact on an UNSIGNED agreement is told why they cannot sign", async () => {
    await mount({ ...SENT, canSign: false, viewOnly: true });
    expect(screen.getByText(/view-only, so a colleague with signing rights needs to sign this/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign this agreement/i })).toBeNull();
  });

  it("never offers the form above no readable terms, even when the server says canSign", async () => {
    await mount({ ...SENT, bodyMd: null, document: null });
    expect(screen.queryByRole("button", { name: /sign this agreement/i })).toBeNull();
    expect(screen.getByText(/document needs to be attached before this can be signed/i)).toBeInTheDocument();
  });
});

// PV5-09 — the sealed signed copy. Once BOTH parties have signed, the client's copy is one sealed PDF (PV-D25), rendered after
// the commit (PV5-07): a signed contract with no file yet says "being prepared", never a dead link, and a contract that is
// not signed promises nothing. An older server omits the field, which reads the same as null.
describe("contract page: the signed copy (PV5-09)", () => {
  const FULLY_SIGNED: PortalContractDetail = {
    ...SENT,
    status: "signed", canSign: false, signedAt: "2026-10-11T03:00:00Z",
    signatures: [
      { party: "provider", signerName: "Olive Owner", signerTitle: "Owner", signedAt: "2026-10-10T03:00:00Z" },
      { party: "client", signerName: "Dana Whitfield", signerTitle: null, signedAt: "2026-10-11T03:00:00Z" },
    ],
  };
  const copyCard = () => screen.getByRole("heading", { name: /^Your signed copy/ }).closest("section") as HTMLElement;

  it("🔴 links the sealed copy through the portal's own file route once it exists", async () => {
    await mount({ ...FULLY_SIGNED, signedCopyFileId: "f-sealed" });
    const link = within(copyCard()).getByRole("link", { name: /Download your signed copy \(PDF\)/ });
    expect(link).toHaveAttribute("href", "/api/northwind/portal/files/f-sealed");
  });

  it("🔴 a signed contract with no copy yet says 'being prepared' and has no link: null and a missing field read alike", async () => {
    const first = await mount({ ...FULLY_SIGNED, signedCopyFileId: null });
    expect(within(copyCard()).getByText(/being prepared/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /signed copy/i })).toBeNull();
    first.unmount();
    const older: PortalContractDetail = { ...FULLY_SIGNED };
    delete older.signedCopyFileId;
    await mount(older);
    expect(within(copyCard()).getByText(/being prepared/i)).toBeInTheDocument();
  });

  it("🔴 a contract that is not signed yet (even one the client has signed) shows no signed-copy card at all", async () => {
    await mount(SIGNED_BY_CLIENT);
    expect(screen.queryByRole("heading", { name: /^Your signed copy/ })).toBeNull();
    expect(screen.queryByText(/being prepared/i)).toBeNull();
  });

  it("names the provider's signature row by role, never by a company name written into the page", async () => {
    await mount(FULLY_SIGNED);
    expect(screen.getByText("Our company")).toBeInTheDocument();
    expect(screen.queryByText(/Gaia Digital Agency/)).toBeNull();
  });
});

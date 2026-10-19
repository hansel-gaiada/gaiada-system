import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PortalContractDetail } from "@/lib/portal";

// DW-10f-2b (BFF §61.6, §61.9) — the portal contract page's "Payment schedule": a table after the agreement's terms (and so above the
// signature), nothing when the contract has none, and "Added by <company> on <date>, after the agreement was signed" for DW-D49's addition.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind", name: "Gaia Digital Agency" })) }));
vi.mock("@/lib/portal-data", () => ({ getPortalContract: vi.fn() }));
vi.mock("@/lib/portalActions", () => ({ portalSignContract: vi.fn(), portalStartCertifiedSigning: vi.fn() }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: () => null }));
vi.mock("@/components/pipeline/ArtifactMarkdown", () => ({ ArtifactMarkdown: ({ text }: { text: string }) => <div>{text}</div> }));

import { getPortalContract } from "@/lib/portal-data";
import PortalContractPage from "./page";

const contractMock = vi.mocked(getPortalContract);
const SIGNED: PortalContractDetail = {
  id: "k-1", title: "Master Services Agreement", reference: "GDA-2026-004", version: 1, status: "signed",
  value: 240_000_000, currency: "IDR", startsOn: "2026-07-21", endsOn: "2027-07-21",
  sentAt: "2026-07-16T00:00:00Z", signedAt: "2026-07-21T00:00:00Z", projectId: null,
  bodyMd: "## Scope\nThe work.", declineReason: null, termEnded: false,
  canSign: false, viewOnly: false, document: null,
  signatures: [
    { party: "provider", signerName: "D. Syrowatka", signerTitle: "Director", signedAt: "2026-07-20T03:00:00Z" },
    { party: "client", signerName: "Dana Whitfield", signerTitle: null, signedAt: "2026-07-21T03:00:00Z" },
  ],
  schedule: {
    currency: "IDR", total: 240_000_000, scheduleSha256: "ab".repeat(32), addedAfterSigning: null,
    instalments: [
      { position: 1, label: "Deposit", amount: 120_000_000, due: { kind: "on_signing", on: "2026-07-21" }, state: "invoiced", invoice: { id: "inv-2026-014", invoiceNo: "DEMO/2026/0014" } },
      { position: 2, label: "Balance", amount: 120_000_000, due: { kind: "date", on: "2026-12-18" }, state: "upcoming", invoice: null },
    ],
  },
};
const mount = async (k: PortalContractDetail) => {
  contractMock.mockResolvedValue(k);
  return render(await PortalContractPage({ params: Promise.resolve({ contractId: k.id }) }));
};
const card = () => screen.getByRole("heading", { name: /^Payment schedule/ }).closest("section") as HTMLElement;

beforeEach(() => contractMock.mockReset());

describe("portal contract page · Payment schedule", () => {
  it("🔴 draws the table, and links an issued invoice's number to /portal/invoices/:id", async () => {
    await mount(SIGNED);
    const table = within(card()).getByRole("table", { name: "Payment schedule instalments" });
    expect(within(table).getByText("Deposit")).toBeInTheDocument();
    expect(within(table).getByText("Balance")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Invoiced, DEMO/2026/0014" })).toHaveAttribute("href", "/portal/invoices/inv-2026-014");
    expect(within(table).getAllByText("Due 18 Dec 2026")).toHaveLength(2); // the Due column, and the status in the client's words
  });

  it("🔴 sits with the terms, ahead of the signatures", async () => {
    await mount(SIGNED);
    const order = screen.getAllByRole("heading").map((h) => h.textContent);
    const at = (t: string) => order.findIndex((h) => (h ?? "").startsWith(t));
    expect(at("The agreement")).toBeGreaterThanOrEqual(0);
    expect(at("The agreement")).toBeLessThan(at("Payment schedule"));
    expect(at("Payment schedule")).toBeLessThan(at("Signatures"));
  });

  it("🔴 shows nothing for a contract with no schedule: null and a missing field read alike", async () => {
    const first = await mount({ ...SIGNED, schedule: null });
    expect(screen.queryByRole("heading", { name: /^Payment schedule/ })).toBeNull();
    first.unmount();
    const older: PortalContractDetail = { ...SIGNED };
    delete older.schedule;
    await mount(older);
    expect(screen.queryByRole("heading", { name: /^Payment schedule/ })).toBeNull();
  });

  it("🔴 a schedule added after signing says by which company and when", async () => {
    await mount({ ...SIGNED, schedule: { ...(SIGNED.schedule as NonNullable<PortalContractDetail["schedule"]>), addedAfterSigning: { on: "2026-10-18" } } });
    expect(within(card()).getByText("Added by Gaia Digital Agency on 18 Oct 2026, after the agreement was signed.")).toBeInTheDocument();
  });

  it("an unsigned agreement with a fixed schedule shows it, with 'On signing' for the first instalment", async () => {
    await mount({
      ...SIGNED, status: "sent", canSign: true, signedAt: null, signatures: [],
      schedule: { ...(SIGNED.schedule as NonNullable<PortalContractDetail["schedule"]>), instalments: [
        { position: 1, label: "Deposit", amount: 120_000_000, due: { kind: "on_signing", on: null }, state: "scheduled", invoice: null },
        { position: 2, label: "Balance", amount: 120_000_000, due: { kind: "date", on: "2026-12-18" }, state: "scheduled", invoice: null },
      ] },
    });
    const table = within(card()).getByRole("table", { name: "Payment schedule instalments" });
    expect(within(table).getAllByText("On signing").length).toBeGreaterThan(0);
    expect(within(table).getByText("Due 18 Dec 2026", { selector: "td:last-child" })).toBeInTheDocument();
  });
});

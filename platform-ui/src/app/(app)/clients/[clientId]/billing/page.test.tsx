import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// PV5-08 fix — one failing read must never take the billing page down. The Documents read failing (a thrown
// error, or a reply with no list) renders its own refusal in its own section; the other sections still render.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ roles: [] })), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "t1") }));
vi.mock("@/lib/entities", () => ({ listProjects: vi.fn(async () => []) }));
vi.mock("@/lib/contracts-data", () => ({
  listContracts: vi.fn(async () => []),
  listClientPayments: vi.fn(async () => []),
  listClientInvoices: vi.fn(async () => ({ kind: "list", invoices: [] })),
  getContract: vi.fn(),
  listClientDocuments: vi.fn(),
}));
vi.mock("@/components/clients/billing/ContractForm", () => ({ ContractForm: () => null }));
vi.mock("@/components/clients/billing/ContractRow", () => ({ ContractRow: () => null }));
vi.mock("@/components/clients/billing/PaymentRow", () => ({ PaymentRow: () => null }));

import { listClientDocuments } from "@/lib/contracts-data";
import ClientBillingPage from "./page";

const mount = async () => render(await ClientBillingPage({ params: Promise.resolve({ clientId: "cl-1" }) }));

describe("billing page: the Documents read", () => {
  it("a thrown read is a refusal in the Documents section, and the other sections still render", async () => {
    vi.mocked(listClientDocuments).mockRejectedValue(new Error("boom"));
    await mount();
    expect(screen.getByRole("heading", { name: "Documents" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contracts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Invoices" })).toBeInTheDocument();
    expect(screen.queryByText(/No signed agreement, issued invoice or payment receipt/)).toBeNull();
  });

  it("a reply with no list is a refusal too, never an empty list", async () => {
    vi.mocked(listClientDocuments).mockRejectedValue(new Error("the documents list came back in an unexpected shape"));
    await mount();
    expect(screen.queryByText(/No signed agreement, issued invoice or payment receipt/)).toBeNull();
  });

  it("a good read renders the list", async () => {
    vi.mocked(listClientDocuments).mockResolvedValue([]);
    await mount();
    expect(screen.getByText(/No signed agreement, issued invoice or payment receipt/)).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { Contract, ContractDetail } from "@/lib/contracts";

// DW-10f-2b (BFF §61.9) — what the billing page hands each contract row about its payment schedule. The schedule is on the DETAIL read, so the
// page reads the detail of every sent contract (signatures) and every contract that has instalments; a failed detail read is passed on as a
// refusal (never "no schedule"); and "Add a payment schedule" is offered to `company.manage`, the gate the invoice screens use.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "t1") }));
vi.mock("@/lib/entities", () => ({ listProjects: vi.fn(async () => []) }));
vi.mock("@/lib/contracts-data", () => ({
  listContracts: vi.fn(),
  listClientPayments: vi.fn(async () => []),
  listClientInvoices: vi.fn(async () => ({ kind: "list", invoices: [] })),
  getContract: vi.fn(),
  listClientDocuments: vi.fn(async () => []),
}));
const rowProps: Array<Record<string, unknown>> = [];
vi.mock("@/components/clients/billing/ContractForm", () => ({ ContractForm: () => null }));
vi.mock("@/components/clients/billing/ContractRow", () => ({ ContractRow: (p: Record<string, unknown>) => { rowProps.push(p); return null; } }));
vi.mock("@/components/clients/billing/PaymentRow", () => ({ PaymentRow: () => null }));

import { getMe } from "@/lib/platform";
import { getContract, listContracts } from "@/lib/contracts-data";
import ClientBillingPage from "./page";

const k = (over: Partial<Contract>): Contract => ({
  id: "k", clientId: "cl-4", clientName: "Viceroy", projectId: null, projectName: null, title: "T", reference: null, version: 1, supersedesId: null,
  status: "draft", fileId: null, bodyMd: "x", value: 100, currency: "IDR", startsOn: null, endsOn: null, sentAt: null, signedAt: null,
  declineReason: null, createdBy: null, createdAt: "2026-10-01T00:00:00Z", clientSigned: false, providerSigned: false, termEnded: false,
  canCountersign: false, ...over,
});
const ADMIN = { userId: "u1", roles: [{ role: "company_admin", scopeType: "company", scopeId: "t1" }], companies: [] } as never;
const MEMBER = { userId: "u1", roles: [{ role: "member", scopeType: "company", scopeId: "t1" }], companies: [] } as never;
const mount = async () => render(await ClientBillingPage({ params: Promise.resolve({ clientId: "cl-4" }) }));
const propsOf = (id: string) => rowProps.find((p) => (p.contract as Contract).id === id) as Record<string, any>;
const detail = (c: Contract, schedule: ContractDetail["schedule"]): ContractDetail => ({ ...c, signatures: [], schedule });

beforeEach(() => { rowProps.length = 0; vi.mocked(getMe).mockReset(); vi.mocked(getMe).mockResolvedValue(ADMIN); vi.mocked(getContract).mockReset(); vi.mocked(listContracts).mockReset(); });

describe("billing page · the payment schedule's reads", () => {
  it("reads the detail of a sent contract and of every contract that has instalments, and nothing else", async () => {
    vi.mocked(listContracts).mockResolvedValue([
      k({ id: "draft-none", scheduleSummary: null }),
      k({ id: "draft-sched", scheduleSummary: { count: 2, total: 100, matchesValue: true } }),
      k({ id: "sent", status: "sent", scheduleSummary: null }),
      k({ id: "signed-addable", status: "signed", scheduleAddable: true, scheduleSummary: null }),
    ]);
    vi.mocked(getContract).mockImplementation(async (_u, _t, id) => detail(k({ id }), null));
    await mount();
    expect(vi.mocked(getContract).mock.calls.map((c) => c[2]).sort()).toEqual(["draft-sched", "sent"]);
    // the others are passed no schedule at all (not read), which a row reads as "nothing to say", never a failure
    expect(propsOf("draft-none").schedule).toBeUndefined();
    expect(propsOf("signed-addable").schedule).toBeUndefined();
    expect(propsOf("signed-addable").scheduleRefused).toBeUndefined();
  });

  it("passes the schedule from the detail read to its row", async () => {
    const schedule = { currency: "IDR", value: 100, total: 100, matchesValue: true, scheduleSha256: null, addedAfterSigning: null, instalments: [] };
    vi.mocked(listContracts).mockResolvedValue([k({ id: "draft-sched", scheduleSummary: { count: 1, total: 100, matchesValue: true } })]);
    vi.mocked(getContract).mockResolvedValue(detail(k({ id: "draft-sched" }), schedule));
    await mount();
    expect(propsOf("draft-sched").schedule).toEqual(schedule);
  });

  it("🔴 a failed detail read is passed on as a refusal for a row with instalments: never 'no schedule'", async () => {
    vi.mocked(listContracts).mockResolvedValue([k({ id: "draft-sched", scheduleSummary: { count: 1, total: 100, matchesValue: true } })]);
    vi.mocked(getContract).mockRejectedValue(new Error("platform 500"));
    await mount();
    expect(propsOf("draft-sched").schedule).toBeUndefined();
    expect(propsOf("draft-sched").scheduleRefused).toBe("platform 500");
  });

  it("a sent contract whose detail failed says so for its signatures, not for a schedule it never had", async () => {
    vi.mocked(listContracts).mockResolvedValue([k({ id: "sent", status: "sent", scheduleSummary: null })]);
    vi.mocked(getContract).mockRejectedValue(new Error("platform 500"));
    await mount();
    expect(propsOf("sent").signaturesRefused).toBe("platform 500");
    expect(propsOf("sent").scheduleRefused).toBeUndefined();
  });

  it("🔴 offers the after-signing control to company.manage and not to a plain member", async () => {
    vi.mocked(listContracts).mockResolvedValue([k({ id: "s", status: "signed", scheduleAddable: true })]);
    await mount();
    expect(propsOf("s").canBill).toBe(true);
    rowProps.length = 0;
    vi.mocked(getMe).mockResolvedValue(MEMBER);
    await mount();
    expect(propsOf("s").canBill).toBe(false);
  });
});

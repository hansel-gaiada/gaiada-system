import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// SCP-3g (PERMISSION §53.12): a pipeline post's publish approval on /approvals/[id]. The four social approvers decide it without
// `approvals.decide` (the HoD and GM seats, the owner), so the decide form follows the server's per-row `approverDecides`; a viewer
// the server does not mark keeps today's rule. Real page; only the network egress and next's request APIs are mocked. Same
// harness as siteArchiveApproval.test.tsx.

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-hod") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/approvals", () => ({ getApprovalDetailAcrossTenants: vi.fn() }));
vi.mock("@/components/mail/MailThreadPanel", () => ({ MailThreadPanel: () => null }));

import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getApprovalDetailAcrossTenants } from "@/lib/approvals";
import ApprovalDetailPage from "./page";

const getMeMock = vi.mocked(getMe);
const detailMock = vi.mocked(getApprovalDetailAcrossTenants);

/** A member of co-1 with no `approvals.decide` (the HoD seat holds no company_admin). */
const member = () => ({
  userId: "u-hod", name: "N", email: "n@x.com", title: null, assurance: "high",
  companies: [{ id: "co-1", name: "Gaia" }], roles: [{ role: "member", scopeType: "company", scopeId: "co-1" }],
}) as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: "ap-1", workflowId: "agent:social", toolName: "social.publishPost", toolArgs: { variantId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4" },
  impact: "high", reason: "Publish the March launch post", status: "pending", origin: "agent", agentName: "agent:social",
  requestedBy: "u-officer", requestedByName: "Dewi", decidedBy: null, decidedByName: null, decidedAt: null,
  createdAt: "2026-10-28T08:00:00.000Z", executionStatus: "not_applicable", executedAt: null, executedBy: null, executionError: null,
  executionResult: null, executionAttempts: null, approveRefusal: null,
  ...over,
});
const asDetail = (data: Record<string, unknown>) => ({ tenantId: "co-1", detail: { kind: "automation_approval", origin: "agent", data } }) as never;
const page = async () => ApprovalDetailPage({ params: Promise.resolve({ id: "ap-1" }) });

beforeEach(() => {
  getMeMock.mockReset(); detailMock.mockReset();
  getMeMock.mockResolvedValue(member());
  vi.mocked(getSessionUserId).mockResolvedValue("u-hod");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("/approvals/[id] for a pipeline post's publish approval (SCP-3g)", () => {
  it("offers Approve and Deny to a viewer the server marks approverDecides, though they hold no approvals.decide", async () => {
    detailMock.mockResolvedValue(asDetail(row({ approverDecides: true })));
    render(await page());
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("keeps Approve disabled with the reason when the server says this viewer filed it (self_approval)", async () => {
    detailMock.mockResolvedValue(asDetail(row({ approverDecides: true, approveRefusal: "self_approval" })));
    render(await page());
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers nothing when the server does not mark the row (false, or an older backend without the field)", async () => {
    for (const over of [{ approverDecides: false }, {}]) {
      detailMock.mockResolvedValue(asDetail(row(over)));
      render(await page());
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      cleanup();
    }
  });

  it("offers nothing on a decided row, marked or not", async () => {
    detailMock.mockResolvedValue(asDetail(row({ approverDecides: true, status: "approved", decidedBy: "u-gm", decidedAt: "2026-10-28T09:00:00.000Z" })));
    render(await page());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

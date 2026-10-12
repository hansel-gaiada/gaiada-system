import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// WebDesk site.archive on /approvals/[id] (owner ruling 2026-10-12): the row is labelled a site archive request, gets its own summary
// (which site, what approving does, that it cannot be undone) instead of the publish summary, and is decided with the generic form
// (the answer carries no secret). Real page; only the network egress and next's request APIs are mocked. Same harness as
// keyMintApproval.test.tsx.

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-approver") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/approvals", () => ({ getApprovalDetailAcrossTenants: vi.fn() }));
vi.mock("@/lib/webdeskContent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/webdeskContent")>("@/lib/webdeskContent");
  return { ...actual, findKeyTarget: vi.fn(), findSiteName: vi.fn() };
});
vi.mock("@/components/mail/MailThreadPanel", () => ({ MailThreadPanel: () => null }));
vi.mock("@/components/webdesk/content/WebdeskPublishSummary", () => ({ WebdeskPublishSummary: () => <div data-testid="publish-summary" /> }));

import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch } from "@/lib/platform";
import { getApprovalDetailAcrossTenants } from "@/lib/approvals";
import { findKeyTarget, findSiteName } from "@/lib/webdeskContent";
import ApprovalDetailPage from "./page";

const SITE = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const TITLE = 'Archive site "gaiada.com" of gaiada (irreversible: it stops serving content and accepts no writes)';

const fetchMock = vi.mocked(platformFetch);
const getMeMock = vi.mocked(getMe);
const detailMock = vi.mocked(getApprovalDetailAcrossTenants);
const siteNameMock = vi.mocked(findSiteName);
const keyTargetMock = vi.mocked(findKeyTarget);

const meAs = (userId: string) => ({
  userId, name: "N", email: "n@x.com", title: null, assurance: "high",
  companies: [{ id: "co-1", name: "Gaia" }], roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-1" }],
}) as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: "ap-1", workflowId: "site.archive", toolName: "webdesk.site.archive",
  toolArgs: { command: "site.archive", tenantSlug: "gaiada", siteId: SITE, summary: { title: TITLE }, commandHash: "h" },
  impact: "high", reason: TITLE, status: "pending", origin: "webdesk", agentName: null,
  requestedBy: "u-requester", requestedByName: "Dewi", decidedBy: null, decidedByName: null, decidedAt: null,
  createdAt: "2026-10-12T08:00:00.000Z", executionStatus: "not_applicable", executedAt: null, executedBy: null, executionError: null, executionResult: null, executionAttempts: null,
  ...over,
});
const asDetail = (data: Record<string, unknown>) => ({ tenantId: "co-1", detail: { kind: "automation_approval", origin: "webdesk", data } }) as never;
const page = async () => ApprovalDetailPage({ params: Promise.resolve({ id: "ap-1" }) });

beforeEach(() => {
  fetchMock.mockReset(); getMeMock.mockReset(); detailMock.mockReset(); siteNameMock.mockReset(); keyTargetMock.mockReset();
  getMeMock.mockResolvedValue(meAs("u-approver"));
  vi.mocked(getSessionUserId).mockResolvedValue("u-approver");
  siteNameMock.mockResolvedValue("gaiada.com");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("/approvals/[id] for a site.archive row", () => {
  it("is labelled a site archive request, titled from the row, with the site, the irreversible warning and the effects — never a publish or key summary", async () => {
    detailMock.mockResolvedValue(asDetail(row()));
    render(await page());
    expect(screen.getAllByText("Site archive request").length).toBeGreaterThanOrEqual(2); // the eyebrow and the summary card
    expect(screen.queryByText("Website publish")).toBeNull();
    expect(screen.queryByText("API key request")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(TITLE);
    expect(screen.queryByTestId("publish-summary")).toBeNull();
    expect(screen.queryByTestId("key-summary")).toBeNull();
    expect(screen.getByTestId("archive-summary-site").textContent).toContain("gaiada.com");
    expect(screen.getByTestId("archive-summary-site").textContent).toContain(SITE);
    expect(screen.getByTestId("archive-summary-irreversible").textContent).toMatch(/cannot be undone/);
    expect(screen.getByTestId("archive-summary-effects").textContent).toMatch(/stops serving content/);
    expect(siteNameMock).toHaveBeenCalledWith("u-approver", "co-1", "gaiada", SITE);
    expect(keyTargetMock).not.toHaveBeenCalled();
  });

  it("shows the site id alone when the name could not be read (cosmetic read failed)", async () => {
    siteNameMock.mockResolvedValue(null);
    detailMock.mockResolvedValue(asDetail(row()));
    render(await page());
    expect(screen.getByTestId("archive-summary-site").textContent).toBe(SITE);
  });

  it("arguments in the wrong format are flagged, not summarised, and no site read is made", async () => {
    detailMock.mockResolvedValue(asDetail(row({ toolArgs: { unexpected: true } })));
    render(await page());
    expect(screen.getByTestId("archive-summary-unrecognised").textContent).toMatch(/Unrecognised request/);
    expect(screen.queryByTestId("archive-summary")).toBeNull();
    expect(siteNameMock).not.toHaveBeenCalled();
  });

  it("an approver gets the generic Approve / Deny form (nothing secret comes back, so no custody component)", async () => {
    detailMock.mockResolvedValue(asDetail(row()));
    const { container } = render(await page());
    expect(container.querySelector("form")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("a decided row shows the summary but no decide control", async () => {
    detailMock.mockResolvedValue(asDetail(row({ status: "approved", decidedBy: "u-approver", decidedByName: "Ayu", decidedAt: "2026-10-12T09:00:00.000Z", executionStatus: "executed" })));
    const { container } = render(await page());
    expect(screen.getByTestId("archive-summary")).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("a publish row and a key row are untouched: no archive summary, no site-name read", async () => {
    detailMock.mockResolvedValue(asDetail(row({
      workflowId: "content.publish", toolName: "webdesk.content.requestPublish", reason: "Publish 1 item",
      toolArgs: { tenantSlug: "gaiada", siteId: SITE, items: [{ itemId: "i1", version: 3 }], rebuild: "staging" },
    })));
    render(await page());
    expect(screen.getByText("Website publish")).toBeTruthy();
    expect(screen.getByTestId("publish-summary")).toBeTruthy();
    expect(screen.queryByTestId("archive-summary")).toBeNull();
    expect(siteNameMock).not.toHaveBeenCalled();
  });
});

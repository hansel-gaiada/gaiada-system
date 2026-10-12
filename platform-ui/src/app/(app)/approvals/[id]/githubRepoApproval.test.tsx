import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// GH-12 on /approvals/[id] and the inbox: a repo-creation request (origin 'github') is labelled, summarised readably, decided through
// the façade as origin 'github', and has its own filter chip. Real page and server action; only egress and next's request APIs mocked.

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
vi.mock("@/components/mail/MailThreadPanel", () => ({ MailThreadPanel: () => null }));

import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getApprovalDetailAcrossTenants } from "@/lib/approvals";
import { decideApprovalItem } from "../../actions";
import { ORIGINS, ORIGIN_LABEL, isApprovalOrigin, originCounts } from "@/lib/approvalsShared";
import { OriginFilterBar } from "@/components/approvals/OriginFilterBar";
import { parseGithubRepoRequestArgs } from "@/lib/githubRepoApproval";
import ApprovalDetailPage from "./page";

const fetchMock = vi.mocked(platformFetch);
const detailMock = vi.mocked(getApprovalDetailAcrossTenants);
const REASON = "Web Dev: provision repo 'acme-site' (marketing, template gaiadabali/tpl-marketing)";

const row = (over: Record<string, unknown> = {}) => ({
  id: "ap-1", workflowId: "github:create_repo", toolName: "github.createRepo",
  toolArgs: { name: "acme-site", private: true, description: "Web Dev site", templateOwner: "gaiadabali", templateRepo: "tpl-marketing" },
  impact: "high", reason: REASON, status: "pending", origin: "github", agentName: null,
  requestedBy: "u-requester", requestedByName: "Dewi", decidedBy: null, decidedByName: null, decidedAt: null,
  createdAt: "2026-10-12T08:00:00.000Z", executionStatus: "not_applicable", executedAt: null, executedBy: null, executionError: null, executionResult: null, executionAttempts: null,
  ...over,
});
const asDetail = (data: Record<string, unknown>) => ({ tenantId: "co-1", detail: { kind: "automation_approval", origin: "github", data } }) as never;
const page = async () => ApprovalDetailPage({ params: Promise.resolve({ id: "ap-1" }) });

beforeEach(() => {
  fetchMock.mockReset(); detailMock.mockReset();
  vi.mocked(getMe).mockResolvedValue({
    userId: "u-approver", name: "N", email: "n@x.com", title: null, assurance: "high",
    companies: [{ id: "co-1", name: "Gaia" }], roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-1" }],
  } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("/approvals/[id] for a github repo-creation row", () => {
  it("is labelled, titled from the reason, and summarises repo, template, visibility and requester", async () => {
    detailMock.mockResolvedValue(asDetail(row()));
    render(await page());
    expect(screen.getAllByText("GitHub repository request").length).toBeGreaterThanOrEqual(2); // eyebrow + summary card
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(REASON);
    expect(screen.getByTestId("github-summary-name").textContent).toBe("acme-site");
    expect(screen.getByTestId("github-summary-template").textContent).toBe("gaiadabali/tpl-marketing");
    expect(screen.getByTestId("github-summary-visibility").textContent).toBe("Private");
    expect(screen.queryByTestId("github-summary-public-warning")).toBeNull();
    expect(screen.getByText("Dewi")).toBeTruthy(); // requested by, from the generic overview
  });

  it("a public repository is flagged; no template reads as an empty repository", async () => {
    detailMock.mockResolvedValue(asDetail(row({ toolArgs: { name: "open-repo", private: false } })));
    render(await page());
    expect(screen.getByTestId("github-summary-visibility").textContent).toBe("Public");
    expect(screen.getByTestId("github-summary-public-warning")).toBeTruthy();
    expect(screen.getByTestId("github-summary-template").textContent).toMatch(/None/);
  });

  it("arguments in the wrong format are flagged, not summarised", async () => {
    detailMock.mockResolvedValue(asDetail(row({ toolArgs: { unexpected: true } })));
    render(await page());
    expect(screen.getByTestId("github-summary-unrecognised").textContent).toMatch(/Unrecognised request/);
    expect(screen.queryByTestId("github-summary")).toBeNull();
  });

  it("the decide form posts origin 'github'", async () => {
    detailMock.mockResolvedValue(asDetail(row()));
    const { container } = render(await page());
    const origin = container.querySelector('form input[name="origin"]') as HTMLInputElement | null;
    expect(origin?.value).toBe("github");
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("a non-github automation row is untouched: no GitHub summary", async () => {
    detailMock.mockResolvedValue({ tenantId: "co-1", detail: { kind: "automation_approval", origin: "automation", data: row({ origin: "automation", workflowId: "wf", toolName: "x.y" }) } } as never);
    render(await page());
    expect(screen.queryByTestId("github-summary")).toBeNull();
    expect(screen.queryAllByText("GitHub repository request")).toHaveLength(0);
  });
});

describe("decideApprovalItem for origin github", () => {
  it("approve and reject post { origin: 'github', decision, note } to the façade", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await decideApprovalItem("co-1", "github", "ap-1", "approved", "ok")).toEqual({ ok: true });
    expect(await decideApprovalItem("co-1", "github", "ap-1", "rejected")).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/approvals/ap-1/decide");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ origin: "github", decision: "approved", note: "ok" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][2]?.body))).toEqual({ origin: "github", decision: "rejected" });
  });

  it("surfaces a refusal as { ok:false, error }", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized"));
    expect(await decideApprovalItem("co-1", "github", "ap-1", "approved")).toEqual({ ok: false, error: "not authorized" });
  });
});

describe("the inbox filter knows github", () => {
  it("is a recognised origin with a label and a count", () => {
    expect(ORIGINS).toContain("github");
    expect(isApprovalOrigin("github")).toBe(true);
    expect(ORIGIN_LABEL.github).toBe("GitHub");
    expect(originCounts([{ origin: "github" }, { origin: "github" }, { origin: "agency" }]).github).toBe(2);
  });

  it("renders a GitHub chip with its count that links to ?origin=github", () => {
    const counts = Object.fromEntries(ORIGINS.map((o) => [o, 0])) as Record<(typeof ORIGINS)[number], number>;
    counts.github = 3;
    render(<OriginFilterBar counts={counts} total={3} active={undefined} buildHref={(n) => (n ? `/approvals?origin=${n}` : "/approvals")} />);
    const chip = screen.getByText("GitHub").closest("a");
    expect(chip?.getAttribute("href")).toBe("/approvals?origin=github");
    expect(chip?.textContent).toContain("3");
  });
});

describe("parseGithubRepoRequestArgs mirrors the server's parser", () => {
  it("defaults private to true, requires a name, and the template is both-or-neither", () => {
    expect(parseGithubRepoRequestArgs({ name: "a" })).toEqual({ name: "a", private: true, description: null, template: null });
    expect(parseGithubRepoRequestArgs({ name: "a", private: false })?.private).toBe(false);
    expect(parseGithubRepoRequestArgs({})).toBeNull();
    expect(parseGithubRepoRequestArgs({ name: "a", templateOwner: "o" })).toBeNull();
    expect(parseGithubRepoRequestArgs(null)).toBeNull();
    expect(parseGithubRepoRequestArgs([])).toBeNull();
  });
});

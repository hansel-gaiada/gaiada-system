import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { GithubRepoRegistry, GithubOrgBanner } from "./GithubRepoRegistry";
import type { GithubRepoListResponse, GithubRepoView } from "@/lib/githubRepos";

function repo(over: Partial<GithubRepoView> & { id: string; fullName: string }): GithubRepoView {
  return {
    org: "gaiadabali", name: over.fullName.split("/")[1] ?? "repo", htmlUrl: `https://github.com/${over.fullName}`,
    visibility: "private", archived: false, topics: [],
    defaultBranch: "main", headSha: null, headCommittedAt: null, headAuthor: null,
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: null, projectName: null,
    repoCreatedAt: "2026-01-01T00:00:00Z", pushedAt: null, lastSyncedAt: "2026-09-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

const ORG = { login: "gaiadabali", tenantId: "co-agency", tenantName: "Gaia Digital Agency" };

function page(repos: GithubRepoView[]): GithubRepoListResponse {
  return { repos, total: repos.length, limit: 200, offset: 0, org: ORG };
}

const actions = { link: vi.fn(), unlink: vi.fn() };

// GHT-3 (ruling §3/§9) — the registry is an ORG surface, not a browsing-company one. These tests
// pin the two additions this ticket makes to an otherwise-unchanged presentational component: the
// org-meta banner, and the fact that a viewer's `mayLink` mirror is expected to already be computed
// against `org.tenantId` by the caller (page.tsx) rather than by this component.
describe("GithubRepoRegistry — org meta banner", () => {
  it("names the org login and the company it's registered to, not the browsing company", () => {
    render(
      <GithubRepoRegistry
        linked={page([repo({ id: "r1", fullName: "gaiadabali/r1", webdevSiteId: "s1", webdevSiteDomain: "r1.example.com" })])}
        unlinked={page([])}
        archivedTotal={0}
        includeArchived={false}
        basePath="/departments/dept-1/repositories"
        mayLink={false}
        siteCandidates={[]}
        projectCandidates={[]}
        appHealth={{ ok: false, reason: "unavailable" }}
        actions={actions}
      />,
    );
    expect(screen.getByText("gaiadabali")).toBeInTheDocument();
    expect(screen.getByText(/registered to Gaia Digital Agency/)).toBeInTheDocument();
  });

  it("GithubOrgBanner alone renders a fallback when the org has no name on file", () => {
    render(<GithubOrgBanner org={{ login: "gaiadabali", tenantId: "co-x", tenantName: null }} />);
    expect(screen.getByText(/an unnamed company/)).toBeInTheDocument();
  });
});

describe("GithubRepoRegistry — app health is wired through, not assumed", () => {
  it("renders the App-health failure state even when the registry itself has rows", () => {
    render(
      <GithubRepoRegistry
        linked={page([repo({ id: "r1", fullName: "gaiadabali/r1" })])}
        unlinked={page([])}
        archivedTotal={0}
        includeArchived={false}
        basePath="/departments/dept-1/repositories"
        mayLink={false}
        siteCandidates={[]}
        projectCandidates={[]}
        appHealth={{ ok: false, reason: "no_org" }}
        actions={actions}
      />,
    );
    // The registry's OWN rows still render (a repo row exists) ...
    expect(screen.getByText("gaiadabali/r1")).toBeInTheDocument();
    // ... but the App-health panel honestly reports its own, independent failure rather than being
    // silently skipped just because the registry read succeeded.
    expect(screen.getByText(/configuration gap, not an outage/i)).toBeInTheDocument();
  });
});

// Regression: production returned `login: ""` (GITHUB_ORG was forwarded to mcp-hub but not to
// platform). Unguarded, the banner rendered an empty <code> box, which reads as a broken page.
describe("GithubOrgBanner — an absent org login", () => {
  it("names the gap instead of rendering an empty code box, and keeps the tenant", () => {
    render(<GithubOrgBanner org={{ login: "", tenantId: "t1", tenantName: "Gaia Digital Agency" }} />);
    // The title carries the gap notice AND still names the tenant. `getAllByText` for the tenant:
    // the hint line names it too, so a single-match query is wrong here rather than the code being.
    expect(screen.getByText(/name not configured/i)).toBeInTheDocument();
    expect(screen.getByText(/GITHUB_ORG/)).toBeInTheDocument();
    expect(screen.getAllByText(/Gaia Digital Agency/).length).toBeGreaterThan(0);
    // The actual defect: an empty <code> element. There must be no empty code box at all.
    const codes = document.querySelectorAll("code");
    expect(Array.from(codes).filter((c) => !c.textContent?.trim())).toHaveLength(0);
  });

  it("renders the login normally when it is present", () => {
    render(<GithubOrgBanner org={{ login: "gaiadabali", tenantId: "t1", tenantName: "Gaia Digital Agency" }} />);
    expect(screen.getByText("gaiadabali")).toBeInTheDocument();
    expect(screen.queryByText(/name not configured/i)).not.toBeInTheDocument();
  });
});

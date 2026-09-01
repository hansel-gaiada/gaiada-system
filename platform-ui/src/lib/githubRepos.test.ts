import { describe, it, expect } from "vitest";
import {
  isUnlinked,
  syncFreshness, freshnessTone,
  deployedRefStatus,
  runLabel, runTone,
  formatCommitAuthor, linkDisplayName, repoSearchText,
  suggestLinkTargets, type LinkCandidate,
  type GithubRepoView,
} from "./githubRepos";

function repo(over: Partial<GithubRepoView> & { id: string }): GithubRepoView {
  return {
    org: "gaiadabali", name: "some-repo", fullName: "gaiadabali/some-repo",
    htmlUrl: "https://github.com/gaiadabali/some-repo",
    visibility: "private", archived: false, topics: [],
    defaultBranch: "main", headSha: "abc123", headCommittedAt: "2026-08-30T00:00:00Z",
    headAuthor: "Gede Wirawan <gede@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: null, projectName: null,
    repoCreatedAt: "2026-01-01T00:00:00Z", pushedAt: "2026-08-30T00:00:00Z", lastSyncedAt: "2026-08-31T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-08-31T00:00:00Z",
    ...over,
  };
}

describe("isUnlinked — matches the backend's own idx_github_repos_unlinked predicate", () => {
  it("is unlinked only when BOTH webdevSiteId and projectId are absent", () => {
    expect(isUnlinked(repo({ id: "a" }))).toBe(true);
    expect(isUnlinked(repo({ id: "b", webdevSiteId: "site-1" }))).toBe(false);
    expect(isUnlinked(repo({ id: "c", projectId: "proj-1" }))).toBe(false);
    expect(isUnlinked(repo({ id: "d", webdevSiteId: "site-1", projectId: "proj-1" }))).toBe(false);
  });
});

describe("syncFreshness — §5.2's 'a stale row must be VISIBLY stale'", () => {
  const now = new Date("2026-08-31T12:00:00Z").getTime();

  it("is fresh within 24h", () => {
    expect(syncFreshness(new Date(now - 1 * 3600_000).toISOString(), now)).toBe("fresh");
    expect(syncFreshness(new Date(now - 24 * 3600_000).toISOString(), now)).toBe("fresh");
  });

  it("is stale between 24h and 7 days", () => {
    expect(syncFreshness(new Date(now - 25 * 3600_000).toISOString(), now)).toBe("stale");
    expect(syncFreshness(new Date(now - 7 * 24 * 3600_000).toISOString(), now)).toBe("stale");
  });

  it("is dark (sync overdue) beyond 7 days", () => {
    expect(syncFreshness(new Date(now - 8 * 24 * 3600_000).toISOString(), now)).toBe("dark");
  });

  it("is unknown for a missing or unparseable value — never a silent 'fresh'", () => {
    expect(syncFreshness(null, now)).toBe("unknown");
    expect(syncFreshness(undefined, now)).toBe("unknown");
    expect(syncFreshness("not-a-date", now)).toBe("unknown");
  });

  it("never reads clock skew (a future timestamp) as alarming", () => {
    expect(syncFreshness(new Date(now + 3600_000).toISOString(), now)).toBe("fresh");
  });

  it("maps freshness to the shared ok/progress/critical/idle tone vocabulary", () => {
    expect(freshnessTone("fresh")).toBe("ok");
    expect(freshnessTone("stale")).toBe("progress");
    expect(freshnessTone("dark")).toBe("critical");
    expect(freshnessTone("unknown")).toBe("idle");
  });
});

describe("deployedRefStatus — honest comparison only, never a fabricated ahead/behind", () => {
  it("is no_head for a genuinely empty repo", () => {
    expect(deployedRefStatus({ headSha: null, deployedRef: null })).toBe("no_head");
    expect(deployedRefStatus({ headSha: null, deployedRef: "some-branch" })).toBe("no_head");
  });

  it("is unknown (never a fabricated 'no deploy') when there is a head but no deployed ref — the GH-06 finding: this field is NULL for every row today, an absent fact, not a confirmed absence", () => {
    expect(deployedRefStatus({ headSha: "abc", deployedRef: null })).toBe("unknown");
  });

  it("is matches_head only on an exact string match", () => {
    expect(deployedRefStatus({ headSha: "abc", deployedRef: "abc" })).toBe("matches_head");
  });

  it("is differs for anything else, including a branch-name pointer — never ranked ahead/behind", () => {
    expect(deployedRefStatus({ headSha: "abc", deployedRef: "deploy/staging-abc" })).toBe("differs");
    expect(deployedRefStatus({ headSha: "abc", deployedRef: "def" })).toBe("differs");
  });
});

describe("runLabel / runTone — GitHub's own vocabulary, never guessed at", () => {
  it("reports no CI history plainly (the common case — 214/221 repos measured with none)", () => {
    expect(runLabel(null, null)).toBe("No CI runs on file");
    expect(runTone(null, null)).toBe("idle");
  });

  it("labels an in-flight run by its status, not a fabricated conclusion", () => {
    expect(runLabel("in_progress", null)).toBe("In progress");
    expect(runTone("in_progress", null)).toBe("progress");
  });

  it("labels a completed run by its conclusion", () => {
    expect(runLabel("completed", "success")).toBe("Success");
    expect(runTone("completed", "success")).toBe("ok");
    expect(runLabel("completed", "failure")).toBe("Failure");
    expect(runTone("completed", "failure")).toBe("critical");
  });

  it("degrades an unrecognized future conclusion token to idle rather than guessing", () => {
    expect(runTone("completed", "some_new_token_github_adds_later")).toBe("idle");
  });
});

describe("formatCommitAuthor — strips the email, never fabricates a name", () => {
  it("returns just the name from 'Name <email>'", () => {
    expect(formatCommitAuthor("Gede Wirawan <gede@gaiada.com>")).toBe("Gede Wirawan");
  });

  it("falls back to the raw string when it doesn't match that shape", () => {
    expect(formatCommitAuthor("just-a-login")).toBe("just-a-login");
  });

  it("is an em dash for a null author (empty repo), never a fabricated placeholder", () => {
    expect(formatCommitAuthor(null)).toBe("—");
  });
});

describe("linkDisplayName — §25's joined display name, never a raw id and never a guess", () => {
  it("is null when unlinked", () => {
    expect(linkDisplayName(repo({ id: "a" }))).toBeNull();
  });

  it("prefers the site domain when linked to a site", () => {
    expect(linkDisplayName(repo({ id: "b", webdevSiteId: "site-1", webdevSiteDomain: "example.gaiada.online" }))).toBe("example.gaiada.online");
  });

  it("falls back to the project name when linked to a project only", () => {
    expect(linkDisplayName(repo({ id: "c", projectId: "proj-1", projectName: "My Project" }))).toBe("My Project");
  });

  it("names a dangling link honestly rather than rendering a raw id or crashing", () => {
    expect(linkDisplayName(repo({ id: "d", webdevSiteId: "site-orphan", webdevSiteDomain: null }))).toBe("(site — name unavailable)");
  });
});

describe("suggestLinkTargets — GH-10's name-match proposal, never an auto-apply", () => {
  const site = (id: string, name: string): LinkCandidate => ({ id, name });

  it("is exact when the repo name matches a site slug with only cosmetic normalization (case/hyphen)", () => {
    const result = suggestLinkTargets({ name: "Anaya_Aesthetics" }, [site("s1", "anaya-aesthetics")], []);
    expect(result).toEqual([{ kind: "webdev_site", id: "s1", name: "anaya-aesthetics", quality: "exact" }]);
  });

  it("is fuzzy — never exact — once a known suffix must be stripped to line up (the ticket's own example)", () => {
    const result = suggestLinkTargets({ name: "anaya-aesthetics-wp" }, [site("s1", "anaya-aesthetics")], []);
    expect(result).toEqual([{ kind: "webdev_site", id: "s1", name: "anaya-aesthetics", quality: "fuzzy" }]);
  });

  it("strips every known suffix (-wp, -site, -theme, -preview), not just one", () => {
    for (const suffix of ["-wp", "-site", "-theme", "-preview"]) {
      const result = suggestLinkTargets({ name: `northwind${suffix}` }, [site("s1", "northwind")], []);
      expect(result, `suffix ${suffix}`).toEqual([{ kind: "webdev_site", id: "s1", name: "northwind", quality: "fuzzy" }]);
    }
  });

  it("strips a stacked suffix (theme + preview) in one call", () => {
    const result = suggestLinkTargets({ name: "northwind-theme-preview" }, [site("s1", "northwind")], []);
    expect(result).toEqual([{ kind: "webdev_site", id: "s1", name: "northwind", quality: "fuzzy" }]);
  });

  it("matches a project the same way, and prefers exact over fuzzy when both exist", () => {
    const result = suggestLinkTargets(
      { name: "viceroy-crm" },
      [site("s1", "viceroy-crm-wp")],
      [{ id: "p1", name: "viceroy-crm" }],
    );
    expect(result[0]).toEqual({ kind: "project", id: "p1", name: "viceroy-crm", quality: "exact" });
    expect(result[1]).toEqual({ kind: "webdev_site", id: "s1", name: "viceroy-crm-wp", quality: "fuzzy" });
  });

  it("returns an empty array — never a fabricated guess — when nothing lines up", () => {
    expect(suggestLinkTargets({ name: "totally-unrelated-repo" }, [site("s1", "anaya-aesthetics")], [])).toEqual([]);
  });

  it("never matches on a blank candidate name", () => {
    expect(suggestLinkTargets({ name: "" }, [site("s1", "")], [])).toEqual([]);
  });

  it("caps the result at `limit` (default 3) without changing the ordering", () => {
    const sites = [site("s1", "acme"), site("s2", "acme"), site("s3", "acme"), site("s4", "acme")];
    expect(suggestLinkTargets({ name: "acme" }, sites, [])).toHaveLength(3);
    expect(suggestLinkTargets({ name: "acme" }, sites, [], 2)).toHaveLength(2);
  });
});

describe("repoSearchText — feeds SearchableTable's client-side filter over an already-fetched page", () => {
  it("includes the fields an operator would actually search by", () => {
    const text = repoSearchText(repo({
      id: "a", fullName: "gaiadabali/my-repo",
      headAuthor: "Erica Susanto <erica@gaiada.com>", latestRunConclusion: "failure",
      projectId: "proj-1", projectName: "My Project",
    }));
    expect(text).toContain("gaiadabali/my-repo");
    expect(text).toContain("Erica Susanto");
    expect(text).toContain("failure");
    expect(text).toContain("My Project");
  });
});

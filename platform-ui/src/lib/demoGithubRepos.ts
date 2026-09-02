import "server-only";
// GH-09 — DEMO_MODE fixtures for GH-08's `GET /api/:t/github/repos` read (§25). Mirrors
// demoWebdevConsole.ts's convention: its own file, wired into demoFixtures.getDemoResponse via one
// import + one dispatch call, read-only (link/unlink exist in §25 but GH-09's phase-1 surface is
// read-mostly per the blueprint's own §5.4 framing — no write routes modelled here).
//
// ── DEMO_MODE DELIBERATELY DOES NOT REPRODUCE THE LIVE 403 ─────────────────────────────────────────
// §25 flags every route as fail-closed today (no `resource_github_repo.yaml` yet — GH-03). That is a
// REAL BACKEND state, not a demo-data concern: DEMO_MODE bypasses Nest/Cerbos entirely (see
// lib/platform.ts), so there is nothing this fixture could do to simulate it even if it wanted to.
// This file therefore models the surface as GH-03 will leave it once the policy ships — the shape
// the UI needs to be correct against — and the 403 path is exercised instead by
// lib/githubRepos-data.test.ts against a mocked PlatformError, not by DEMO_MODE.
//
// ── THE FIXTURE MUST PROVE THE HARD CASES, NOT A CALM TOY DATASET ──────────────────────────────────
// The ticket's own design constraints, each represented by at least one row below (ids are ghr-NN):
//   - Archived must never look broken by default — ghr-04/08/12/13/14 are archived, spanning fresh
//     AND stale sync, public AND private, linked AND unlinked, so the "archived != stale" and
//     "archived != error" claims are actually exercised, not just asserted in a comment.
//   - Staleness is its OWN axis from archived — ghr-03 (stale, active), ghr-13 (very stale, ARCHIVED
//     — an archived row can still go stale on the sync side, distinct from the archived-but-fresh
//     rows ghr-04/08/12/14).
//   - ghr-05/06/12/13 are UNLINKED (neither webdevSiteId nor projectId) — a finding, not an error —
//     spanning fresh/stale sync and archived+unlinked combinations so the bucket isn't only ever
//     "recent and interesting".
//   - ghr-11 is a genuinely empty repo (no head commit at all) — headSha/headCommittedAt/headAuthor
//     all null, proving deployedRefStatus()'s "no_head" branch and formatCommitAuthor(null) render
//     honestly rather than crashing on a null field.
//   - Only 2 of 221 repos are public (measured) — ghr-09/14 are the two public rows here.
//   - Most repos (214/221 measured) carry no CI history at all — ghr-02/05/06/07/08/10/11/12/13/14/
//     15 all have `latestRunStatus: null`, which is the COMMON case, not an edge case.
//   - ghr-08's `webdevSiteId` is set but `webdevSiteDomain` is null — a dangling link (the joined
//     `webdev_sites` row no longer resolves) — proving linkDisplayName()'s "(site — name
//     unavailable)" fallback renders honestly instead of crashing on a null join.
//   - `deployedRef` is `null` on every row EXCEPT ghr-01/ghr-03, per GH-06's own finding: this
//     column is NULL for all 221 real rows today (GH-07, the webhook ingestion that would populate
//     it, has not shipped) — so a demo where most rows carry a value would be a nicer-looking lie
//     than the real data. ghr-01 (matches head) and ghr-03 (differs) are kept as the two forward-
//     looking exceptions, proving deployedRefStatus()'s matches_head/differs branches still render
//     correctly for the day GH-07 starts populating this field — regression coverage for a state
//     DEMO_MODE cannot otherwise produce, not a claim that today's data looks like this.
import type { GithubRepoView } from "./githubRepos";

interface DemoResult {
  status: number;
  json: unknown;
}
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

const REPOS: GithubRepoView[] = [
  {
    id: "ghr-01", org: "gaiadabali", name: "northwind-site-redesign-kickoff",
    fullName: "gaiadabali/northwind-site-redesign-kickoff",
    htmlUrl: "https://github.com/gaiadabali/northwind-site-redesign-kickoff",
    visibility: "private", archived: false, topics: ["webdesk", "vite"],
    defaultBranch: "main", headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    headCommittedAt: hoursAgo(5), headAuthor: "Gede Wirawan <gede@gaiada.com>",
    openPrCount: 2, latestRunStatus: "completed", latestRunConclusion: "success", latestRunAt: hoursAgo(5),
    latestReleaseTag: "v1.4.0", deployedRef: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    webdevSiteId: "wps-console-1", webdevSiteDomain: "northwind-site-redesign-kickoff.gaiada.online",
    projectId: null, projectName: null,
    repoCreatedAt: "2026-07-19T02:05:00Z", pushedAt: hoursAgo(5), lastSyncedAt: hoursAgo(1),
    createdAt: "2026-07-19T02:10:00Z", updatedAt: hoursAgo(1),
  },
  {
    id: "ghr-02", org: "gaiadabali", name: "viceroy-crm-integration",
    fullName: "gaiadabali/viceroy-crm-integration",
    htmlUrl: "https://github.com/gaiadabali/viceroy-crm-integration",
    visibility: "private", archived: false, topics: [],
    defaultBranch: "main", headSha: "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
    headCommittedAt: hoursAgo(20), headAuthor: "Erica Susanto <erica@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: "proj-demo-1", projectName: "Viceroy CRM Integration",
    repoCreatedAt: "2026-08-01T09:00:00Z", pushedAt: hoursAgo(20), lastSyncedAt: hoursAgo(3),
    createdAt: "2026-08-01T09:05:00Z", updatedAt: hoursAgo(3),
  },
  {
    id: "ghr-03", org: "gaiadabali", name: "baligirls-new",
    fullName: "gaiadabali/baligirls-new",
    htmlUrl: "https://github.com/gaiadabali/baligirls-new",
    visibility: "private", archived: false, topics: ["legacy"],
    defaultBranch: "main", headSha: "c3d4e5f60718293a4b5c6d7e8f9012345678901a",
    headCommittedAt: daysAgo(9), headAuthor: "Hansel <web@gaiada.com>",
    openPrCount: 1, latestRunStatus: "completed", latestRunConclusion: "failure", latestRunAt: daysAgo(9),
    latestReleaseTag: null, deployedRef: "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
    webdevSiteId: "wps-console-2", webdevSiteDomain: "baligirls.gaiada.online",
    projectId: null, projectName: null,
    repoCreatedAt: "2026-05-02T09:00:00Z", pushedAt: daysAgo(9), lastSyncedAt: daysAgo(3),
    createdAt: "2026-05-02T09:05:00Z", updatedAt: daysAgo(3),
  },
  {
    id: "ghr-04", org: "gaiadabali", name: "sanur-resort-archive",
    fullName: "gaiadabali/sanur-resort-archive",
    htmlUrl: "https://github.com/gaiadabali/sanur-resort-archive",
    visibility: "private", archived: true, topics: ["legacy"],
    defaultBranch: "master", headSha: "d4e5f60718293a4b5c6d7e8f9012345678901ab2",
    headCommittedAt: "2026-02-11T04:00:00Z", headAuthor: "Former Contractor <ex@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: "proj-demo-2", projectName: "Sanur Resort (legacy)",
    repoCreatedAt: "2025-11-02T09:00:00Z", pushedAt: "2026-02-11T04:00:00Z", lastSyncedAt: daysAgo(12),
    createdAt: "2025-11-02T09:05:00Z", updatedAt: daysAgo(12),
  },
  {
    id: "ghr-05", org: "gaiadabali", name: "sandbox-experiment-42",
    fullName: "gaiadabali/sandbox-experiment-42",
    htmlUrl: "https://github.com/gaiadabali/sandbox-experiment-42",
    visibility: "private", archived: false, topics: [],
    defaultBranch: "main", headSha: "e5f60718293a4b5c6d7e8f9012345678901ab2c3",
    headCommittedAt: daysAgo(1), headAuthor: "Gede Wirawan <gede@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: null, projectName: null,
    repoCreatedAt: "2026-08-20T09:00:00Z", pushedAt: daysAgo(1), lastSyncedAt: hoursAgo(2),
    createdAt: "2026-08-20T09:05:00Z", updatedAt: hoursAgo(2),
  },
  {
    id: "ghr-06", org: "gaiadabali", name: "old-marketing-microsite",
    fullName: "gaiadabali/old-marketing-microsite",
    htmlUrl: "https://github.com/gaiadabali/old-marketing-microsite",
    visibility: "private", archived: false, topics: [],
    defaultBranch: "main", headSha: "f60718293a4b5c6d7e8f9012345678901ab2c3d4",
    headCommittedAt: daysAgo(15), headAuthor: "Erica Susanto <erica@gaiada.com>",
    openPrCount: 3, latestRunStatus: "completed", latestRunConclusion: "success", latestRunAt: daysAgo(15),
    latestReleaseTag: "v0.9.0", deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: null, projectName: null,
    repoCreatedAt: "2026-03-14T09:00:00Z", pushedAt: daysAgo(15), lastSyncedAt: daysAgo(5),
    createdAt: "2026-03-14T09:05:00Z", updatedAt: daysAgo(5),
  },
  {
    id: "ghr-07", org: "gaiadabali", name: "internal-billing-scripts",
    fullName: "gaiadabali/internal-billing-scripts",
    htmlUrl: "https://github.com/gaiadabali/internal-billing-scripts",
    visibility: "private", archived: false, topics: ["ops"],
    defaultBranch: "main", headSha: "0718293a4b5c6d7e8f9012345678901ab2c3d4e5",
    headCommittedAt: hoursAgo(30), headAuthor: "Hansel <web@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: "proj-demo-3", projectName: "Internal Billing Scripts",
    repoCreatedAt: "2026-06-01T09:00:00Z", pushedAt: hoursAgo(30), lastSyncedAt: hoursAgo(6),
    createdAt: "2026-06-01T09:05:00Z", updatedAt: hoursAgo(6),
  },
  {
    id: "ghr-08", org: "gaiadabali", name: "prospect-landing-2025",
    fullName: "gaiadabali/prospect-landing-2025",
    htmlUrl: "https://github.com/gaiadabali/prospect-landing-2025",
    visibility: "private", archived: true, topics: [],
    defaultBranch: "main", headSha: "18293a4b5c6d7e8f9012345678901ab2c3d4e5f6",
    headCommittedAt: "2025-12-04T09:00:00Z", headAuthor: "Former Contractor <ex@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    // Dangling link on purpose — see file header. The site id is set but the LEFT JOIN found
    // nothing (the webdev_sites row was deleted), so the domain comes back null.
    webdevSiteId: "wps-console-archived-1", webdevSiteDomain: null, projectId: null, projectName: null,
    repoCreatedAt: "2025-09-10T09:00:00Z", pushedAt: "2025-12-04T09:00:00Z", lastSyncedAt: hoursAgo(10),
    createdAt: "2025-09-10T09:05:00Z", updatedAt: hoursAgo(10),
  },
  {
    id: "ghr-09", org: "gaiadabali", name: "deploy-workflows",
    fullName: "gaiadabali/deploy-workflows",
    htmlUrl: "https://github.com/gaiadabali/deploy-workflows",
    visibility: "public", archived: false, topics: ["ci", "reusable-workflow"],
    defaultBranch: "main", headSha: "8293a4b5c6d7e8f9012345678901ab2c3d4e5f67",
    headCommittedAt: hoursAgo(12), headAuthor: "Hansel <web@gaiada.com>",
    openPrCount: 1, latestRunStatus: "completed", latestRunConclusion: "success", latestRunAt: hoursAgo(12),
    latestReleaseTag: "v3.2.1", deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: "proj-demo-4", projectName: "Deploy Workflows (shared)",
    repoCreatedAt: "2026-08-16T09:00:00Z", pushedAt: hoursAgo(12), lastSyncedAt: hoursAgo(1),
    createdAt: "2026-08-16T09:05:00Z", updatedAt: hoursAgo(1),
  },
  {
    id: "ghr-10", org: "gaiadabali", name: "team-runbooks",
    fullName: "gaiadabali/team-runbooks",
    htmlUrl: "https://github.com/gaiadabali/team-runbooks",
    visibility: "private", archived: false, topics: ["docs"],
    defaultBranch: "main", headSha: "293a4b5c6d7e8f9012345678901ab2c3d4e5f678",
    headCommittedAt: hoursAgo(48), headAuthor: "Gede Wirawan <gede@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: "proj-demo-5", projectName: "Team Runbooks",
    repoCreatedAt: "2026-04-22T09:00:00Z", pushedAt: hoursAgo(48), lastSyncedAt: hoursAgo(4),
    createdAt: "2026-04-22T09:05:00Z", updatedAt: hoursAgo(4),
  },
  {
    id: "ghr-11", org: "gaiadabali", name: "unlaunched-client-shell",
    fullName: "gaiadabali/unlaunched-client-shell",
    htmlUrl: "https://github.com/gaiadabali/unlaunched-client-shell",
    visibility: "private", archived: false, topics: [],
    // A genuinely empty repo: created, never pushed to. GitHub returns null head facts for this —
    // treating that as an error would be wrong, per the migration's own comment on head_sha.
    defaultBranch: "main", headSha: null, headCommittedAt: null, headAuthor: null,
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: "proj-demo-6", projectName: "Unlaunched Client Shell",
    repoCreatedAt: hoursAgo(60), pushedAt: null, lastSyncedAt: hoursAgo(2),
    createdAt: hoursAgo(60), updatedAt: hoursAgo(2),
  },
  {
    id: "ghr-12", org: "gaiadabali", name: "2024-holiday-promo-site",
    fullName: "gaiadabali/2024-holiday-promo-site",
    htmlUrl: "https://github.com/gaiadabali/2024-holiday-promo-site",
    visibility: "private", archived: true, topics: [],
    defaultBranch: "main", headSha: "93a4b5c6d7e8f9012345678901ab2c3d4e5f6789",
    headCommittedAt: "2025-01-08T09:00:00Z", headAuthor: "Former Contractor <ex@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: null, projectName: null,
    repoCreatedAt: "2024-11-01T09:00:00Z", pushedAt: "2025-01-08T09:00:00Z", lastSyncedAt: hoursAgo(8),
    createdAt: "2024-11-01T09:05:00Z", updatedAt: hoursAgo(8),
  },
  {
    id: "ghr-13", org: "gaiadabali", name: "abandoned-fork-of-cms",
    fullName: "gaiadabali/abandoned-fork-of-cms",
    htmlUrl: "https://github.com/gaiadabali/abandoned-fork-of-cms",
    visibility: "private", archived: true, topics: [],
    defaultBranch: "main", headSha: "3a4b5c6d7e8f9012345678901ab2c3d4e5f6789a",
    headCommittedAt: "2025-06-19T09:00:00Z", headAuthor: "Unknown Contributor <unknown@example.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: null, projectName: null,
    repoCreatedAt: "2025-05-01T09:00:00Z", pushedAt: "2025-06-19T09:00:00Z", lastSyncedAt: daysAgo(20),
    createdAt: "2025-05-01T09:05:00Z", updatedAt: daysAgo(20),
  },
  {
    id: "ghr-14", org: "gaiadabali", name: "gaiada-brand-assets",
    fullName: "gaiadabali/gaiada-brand-assets",
    htmlUrl: "https://github.com/gaiadabali/gaiada-brand-assets",
    visibility: "public", archived: true, topics: ["brand"],
    defaultBranch: "main", headSha: "a4b5c6d7e8f9012345678901ab2c3d4e5f6789ab",
    headCommittedAt: "2025-10-03T09:00:00Z", headAuthor: "Hansel <web@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: "v1.0.0", deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: "proj-demo-7", projectName: "Gaiada Brand Assets",
    repoCreatedAt: "2025-08-15T09:00:00Z", pushedAt: "2025-10-03T09:00:00Z", lastSyncedAt: hoursAgo(14),
    createdAt: "2025-08-15T09:05:00Z", updatedAt: hoursAgo(14),
  },
  {
    id: "ghr-15", org: "gaiadabali", name: "erica-personal-scratch",
    fullName: "gaiadabali/erica-personal-scratch",
    htmlUrl: "https://github.com/gaiadabali/erica-personal-scratch",
    visibility: "private", archived: false, topics: [],
    defaultBranch: "main", headSha: "4b5c6d7e8f9012345678901ab2c3d4e5f6789abc",
    headCommittedAt: daysAgo(2), headAuthor: "Erica Susanto <erica@gaiada.com>",
    openPrCount: 0, latestRunStatus: null, latestRunConclusion: null, latestRunAt: null,
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: null, webdevSiteDomain: null, projectId: "proj-demo-8", projectName: "Erica Personal Scratch",
    repoCreatedAt: "2026-07-01T09:00:00Z", pushedAt: daysAgo(2), lastSyncedAt: hoursAgo(5),
    createdAt: "2026-07-01T09:05:00Z", updatedAt: hoursAgo(5),
  },
  {
    id: "ghr-16", org: "gaiadabali", name: "queued-migration-check",
    fullName: "gaiadabali/queued-migration-check",
    htmlUrl: "https://github.com/gaiadabali/queued-migration-check",
    visibility: "private", archived: false, topics: [],
    defaultBranch: "main", headSha: "b5c6d7e8f9012345678901ab2c3d4e5f6789abcd",
    headCommittedAt: hoursAgo(1), headAuthor: "Gede Wirawan <gede@gaiada.com>",
    openPrCount: 1, latestRunStatus: "in_progress", latestRunConclusion: null, latestRunAt: hoursAgo(1),
    latestReleaseTag: null, deployedRef: null,
    webdevSiteId: "wps-console-1", webdevSiteDomain: "northwind-site-redesign-kickoff.gaiada.online",
    projectId: null, projectName: null,
    repoCreatedAt: "2026-08-25T09:00:00Z", pushedAt: hoursAgo(1), lastSyncedAt: hoursAgo(1),
    createdAt: "2026-08-25T09:05:00Z", updatedAt: hoursAgo(1),
  },
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Returns a DemoResult for GH-08's `/github/repos` route, or null if it doesn't match. Mirrors
 *  the real controller's filter/paginate/count behaviour (§25) closely enough that a caller cannot
 *  tell from the response shape alone whether it hit the fixture or the real backend. */
export function githubReposDemo(method: string, p: string, params: URLSearchParams): DemoResult | null {
  if (method.toUpperCase() !== "GET") return null;
  if (!p.match(/^\/api\/[^/]+\/github\/repos$/)) return null;

  const linkedQ = params.get("linked");
  const archivedQ = params.get("archived");
  const search = params.get("search")?.trim().toLowerCase();

  let filtered = REPOS;
  if (linkedQ === "true") filtered = filtered.filter((r) => r.webdevSiteId !== null || r.projectId !== null);
  if (linkedQ === "false") filtered = filtered.filter((r) => r.webdevSiteId === null && r.projectId === null);
  if (archivedQ === "true") filtered = filtered.filter((r) => r.archived);
  if (archivedQ === "false") filtered = filtered.filter((r) => !r.archived);
  if (search) filtered = filtered.filter((r) => r.name.toLowerCase().includes(search) || r.fullName.toLowerCase().includes(search));

  const total = filtered.length;
  const limit = Math.max(1, Math.min(Number(params.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT));
  const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);
  const page = [...filtered].sort((a, b) => a.fullName.localeCompare(b.fullName)).slice(offset, offset + limit);

  return ok({ repos: page, total, limit, offset });
}

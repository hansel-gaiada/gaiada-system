import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isStaff } from "@/lib/rbac";
import { listGithubRepos, type ListGithubReposResult } from "@/lib/githubRepos-data";
import { PageHeader } from "@/components/PageHeader";
import { BackendPending } from "@/components/BackendPending";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { GithubRepoRegistry } from "@/components/github/GithubRepoRegistry";

export const metadata = { title: "Sites & Repos" };
export const dynamic = "force-dynamic";

// GH-09 — Sites/Repos view per blueprint §5.4 (docs/blueprints/github-integration-foundation.md).
// Reads GH-08's BFF (docs/FRONTEND-BFF-CONTRACT.md §25) via lib/githubRepos-data.ts.
//
// ── STATE UPDATED 2026-08-31: GH-03 HAS SHIPPED. THIS PAGE RENDERS DATA. ────────────────────────────
// An earlier version of this comment said every /github/repos* route 403s for every principal.
// That is NO LONGER TRUE. `platform-nest/cerbos/policies/resource_github_repo.yaml` is live and
// grants read/link/unlink to company_admin/manager (+member on read); QA verified the full matrix
// against a real Cerbos on 2026-08-31. The fail-closed refusal branch below is still correct and
// must stay — it is what a genuinely unauthorized principal (e.g. an isClientOnly client, verified
// EFFECT_DENY on every action) sees — but it is no longer the expected resting state.
//
// ── GATE RESOLVED 2026-08-31 (owner decision: widen the UI to match Cerbos) ─────────────────────────
// This page previously gated on `isElevated(me) || can(me,"company.manage",tenant)`. Cerbos grants
// `github_repo:read` to `member` too, so a member Cerbos WOULD serve was refused here before the
// request even fired. The two gates disagreed.
//
// Now: `isStaff(me)` — "has any role that is not `client`". Deliberately COARSE. The UI's job here is
// to keep the external-client surface out (an isClientOnly principal is EFFECT_DENY on every action
// on this kind, verified against a live Cerbos); deciding WHICH staff may read is Cerbos's job, and
// duplicating that decision in the client is how the two drifted apart in the first place.
//
// Consequence, and it is the safe direction: a staff role Cerbos does NOT grant read (say a
// finance_manager, if the policy never lists it) now passes this gate and gets a 403 from the BFF.
// `ReadRefusal` renders that honestly as "not authorized" — never as an empty registry — so the
// failure is legible rather than a silent blank page. Cerbos stays the single authority.
//
// ── WHY THIS IS UNDER /systems, NOT /departments/[deptId]/repositories ──────────────────────────────
// `github_repos` is explicitly a CORE table (GH-05 migration header): it links to `webdev_site_id`
// AND `project_id` across every department, and §5.2's own ruling puts every row's tenant on Gaiada
// regardless of which client's work runs through it. A per-department page cannot show that without
// either fanning the same registry out under every department id or arbitrarily assigning each repo
// to one. Systems already holds Gaiada's own cross-cutting admin consoles (Hub, Gateway, Automation,
// Observability) for exactly this "not one department's data" reason; this joins them. The existing
// `departments/[deptId]/repositories` skeleton (F1/P1-08) is a DIFFERENT, narrower concept — a
// department's own connected repos via lib/webdesk connections — and is left untouched; reconciling
// the two is a product decision for whoever owns that skeleton next, not this ticket.
//
// ── THREE READS, ONE PAGE LOAD ──────────────────────────────────────────────────────────────────
// §25's `archived` filter is a plain boolean — there is no third "both" value, so "both" is
// requested by OMITTING the param, not by passing a specific value. The archived toggle
// (`?archived=1`, a Link-based server filter matching the Hub console's own `?source=` pattern) maps
// to that directly: off -> `archived: false` (active only, the default view), on -> `archived`
// omitted (both states). The registry (linked) and the unlinked bucket are separate reads —
// `linked=true` / `linked=false` — because §5.4 asks for unlinked as its OWN bucket, never merged
// into the same table. A third, cheap read (`archived=true&limit=1`, ignoring `linked` entirely) is
// ONLY for the toggle's own label — "Show archived (113)" should say the true org-wide archived
// count regardless of which bucket or archived-state the operator is currently looking at.
export default async function GithubRegistryPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const sp = await searchParams;
  const includeArchived = sp.archived === "1";

  const allowed = !!tenant && isStaff(me);

  return (
    <>
      <PageHeader title="Sites & Repos" />
      <p style={{ margin: "-8px 0 20px", font: "400 14px/1.5 var(--font-body)", color: "var(--erp-ink-60)", maxWidth: 760 }}>
        Every repo GitHub reports for the org — default branch, last commit, open PRs, CI, and
        deployed ref vs head — plus which ones no site or project has claimed. GitHub is truth for
        the repo facts; this registry is truth for the link (blueprint §5.1).
      </p>

      {!allowed || !tenant ? (
        <ReadRefusal subject="the GitHub repository registry" kind="forbidden" />
      ) : (
        <RegistryBody userId={userId} tenant={tenant} includeArchived={includeArchived} />
      )}
    </>
  );
}

function refusalOrPending(result: Extract<ListGithubReposResult, { ok: false }>) {
  if (result.reason === "refused") {
    return (
      <ReadRefusal
        subject="the GitHub repository registry"
        kind="forbidden"
        detail="Your account is not authorized to read the repository registry. The github_repo policy is live, so this is a real authorization decision — not a pending feature and not an outage."
      />
    );
  }
  return (
    <BackendPending
      what="The GitHub repository registry isn't reachable right now."
      contract="GET /api/:t/github/repos (docs/FRONTEND-BFF-CONTRACT.md §25)"
    />
  );
}

async function RegistryBody({ userId, tenant, includeArchived }: { userId: string; tenant: string; includeArchived: boolean }) {
  // `archived: undefined` (param omitted entirely) means "both states" per §25 — see the header note.
  const archivedFilter = includeArchived ? undefined : false;

  const [linkedResult, unlinkedResult, archivedCountResult] = await Promise.all([
    listGithubRepos(userId, tenant, { linked: true, archived: archivedFilter, limit: 200 }),
    listGithubRepos(userId, tenant, { linked: false, archived: archivedFilter, limit: 200 }),
    // Org-wide archived total for the toggle's own label, independent of the current bucket/filter.
    listGithubRepos(userId, tenant, { archived: true, limit: 1 }),
  ]);

  if (!linkedResult.ok) return refusalOrPending(linkedResult);
  if (!unlinkedResult.ok) return refusalOrPending(unlinkedResult);

  if (linkedResult.data.total === 0 && unlinkedResult.data.total === 0) {
    // A genuinely empty registry (crawl hasn't run yet, or a brand-new tenant) is a real, distinct
    // state from "couldn't read it" — EmptyNote, not BackendPending, and definitely not silence.
    return <EmptyNote>No repositories on file yet. The initial org crawl (GH-06) seeds this table.</EmptyNote>;
  }

  return (
    <GithubRepoRegistry
      linked={linkedResult.data}
      unlinked={unlinkedResult.data}
      archivedTotal={archivedCountResult.ok ? archivedCountResult.data.total : null}
      includeArchived={includeArchived}
    />
  );
}

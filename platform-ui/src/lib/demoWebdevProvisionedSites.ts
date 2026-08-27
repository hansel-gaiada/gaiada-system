import "server-only";
// PRV-04 — DEMO_MODE fixtures for the "Site & repo" card (run workspace, `/pipeline/[runId]`).
// Mirrors demoPipeline.ts / demoWebdevChangeRequests.ts's convention. Wired from
// demoFixtures.getDemoResponse, BEFORE the generic route matching.
//
// ── WHY globalThis, NOT A MODULE-LEVEL ARRAY ────────────────────────────────────────────────────
// Next bundles the `"use server"` action graph (webdevProvisionedSitesActions.ts, which imports this
// file indirectly through platformFetch -> demoFixtures) separately from the page's RSC read graph.
// A plain `const SITES: DemoSite[] = [...]` would give each graph its OWN module instance — a
// provision/reconcile POST would mutate one copy while the page's subsequent GET reads the other,
// so the workspace would never show the result of an action that just "succeeded". `lib/demoPortal.ts`'s
// `CR_STORE_KEY` is the worked example this follows verbatim (see that file's header for the same
// failure mode spelled out for the client-portal change-request store).
//
// ── TWO SEEDED ROWS COVER THE STATIC CASES; MAGIC SLUGS DRIVE THE REST ──────────────────────────
// run-demo-1 (PRD signed, fully extracted — demoPipeline.ts) gets a 2-row HISTORY: an older attempt
// that lost a slug fight on the far side (`failed/slug_conflict_foreign` — reprovision-only, never
// reconcilable) followed by the retry that succeeded (`live`, with real-looking repo/staging links).
// That's both a multi-row history AND the "pick a different name" failure shape, reachable with zero
// clicks (an e2e snapshot or a first look at the page sees it immediately).
//
// run-demo-2 (no PRD sign gate at all — a legitimate manual/staff-triggered run per design §04's
// secondary trigger) starts with ZERO rows, so the true empty state (EmptyNote + the Provision form)
// is what a fresh session sees. From there the demo POST handler is a small, genuinely drivable state
// machine keyed off the SLUG the user types, so every remaining status is reachable by clicking
// through rather than only visible in a fixture dump:
//   any slug containing "conflict" -> immediate 409 slug_conflict_foreign (row committed failed)
//   any slug containing "taken"    -> immediate 409 slug_taken (NO row — mirrors the real outcome)
//   an invalid slug                -> immediate 400 invalid_slug (no row)
//   slug containing "crash"        -> row created at `requested`, egress never runs (mirrors "stays
//                                      requested if the failure precedes any successful egress");
//                                      first Reconcile resumes it into the normal ladder below
//   slug containing "timeout"      -> egresses to `pending`, then the FIRST Reconcile lands
//                                      `failed/poll_timeout` (§04: "honest, not final") and the
//                                      SECOND Reconcile flips it forward to `live`
//   anything else                  -> egresses to `pending`; each Reconcile advances one step
//                                      (`pending` -> `provisioned` -> `live`), matching the real
//                                      certbot-after-DNS wait
import type { SiteFramework, SiteStatus } from "./webdevProvisionedSites";
import { runLineageForDemo } from "./demoPipeline";

interface DemoSite {
  id: string;
  tenantId: string;
  pipelineRunId: string | null;
  clientId: string | null;
  projectId: string | null;
  provider: string;
  providerRef: string | null;
  slug: string;
  framework: SiteFramework;
  repoUrl: string | null;
  stagingUrl: string | null;
  status: SiteStatus;
  failureReason: string | null;
  requestedBy: string | null;
  approvalId: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Sim-only bookkeeping, stripped before serializing. */
  _reconcileCount: number;
}

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });

const STORE_KEY = Symbol.for("gaiada.demoWebdevProvisionedSites.sites");
const SITES: DemoSite[] = ((globalThis as Record<symbol, unknown>)[STORE_KEY] ??= [
  {
    id: "wps-demo-1a", tenantId: "co-agency", pipelineRunId: "run-demo-1", clientId: "cl-1", projectId: "p-web-1",
    provider: "provision", providerRef: null,
    slug: "northwind-site-redesign-kickoff-old", framework: "vite",
    repoUrl: null, stagingUrl: null,
    status: "failed", failureReason: "slug_conflict_foreign",
    requestedBy: "demo-hansel", approvalId: null,
    lastReconciledAt: null, createdAt: "2026-07-19T02:00:00Z", updatedAt: "2026-07-19T02:00:05Z",
    _reconcileCount: 0,
  },
  {
    id: "wps-demo-1b", tenantId: "co-agency", pipelineRunId: "run-demo-1", clientId: "cl-1", projectId: "p-web-1",
    provider: "provision", providerRef: "prov-proj-1001",
    slug: "northwind-site-redesign-kickoff", framework: "vite",
    repoUrl: "https://github.com/Gaia-Digital-Agency/northwind-site-redesign-kickoff",
    stagingUrl: "https://northwind-site-redesign-kickoff.gaiada.online",
    status: "live", failureReason: null,
    requestedBy: "demo-hansel", approvalId: null,
    lastReconciledAt: "2026-07-19T02:12:00Z", createdAt: "2026-07-19T02:05:00Z", updatedAt: "2026-07-19T02:12:00Z",
    _reconcileCount: 2,
  },
]) as DemoSite[];

let seq = 100;
const nid = () => `wps-demo-sim-${++seq}`;

function toRow(s: DemoSite) {
  const { _reconcileCount: _rc, ...row } = s;
  void _rc;
  return row;
}

/** Returns a DemoResult for any /modules/webdev/provision(ed-sites) route, or null if it doesn't match. */
export function webdevProvisionedSitesDemo(
  method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string,
): DemoResult | null {
  const m = method.toUpperCase();

  const reconcileM = p.match(/^\/api\/[^/]+\/modules\/webdev\/provisioned-sites\/([^/]+)\/reconcile$/);
  if (reconcileM && m === "POST") {
    const site = SITES.find((s) => s.id === reconcileM[1]);
    if (!site) return err(404, "provisioned site not found");
    return ok(toRow(reconcileStep(site)));
  }

  const detailM = p.match(/^\/api\/[^/]+\/modules\/webdev\/provisioned-sites\/([^/]+)$/);
  if (detailM && m === "GET") {
    const site = SITES.find((s) => s.id === detailM[1]);
    if (!site) return err(404, "provisioned site not found");
    return ok(toRow(site));
  }

  const listM = p.match(/^\/api\/[^/]+\/modules\/webdev\/provisioned-sites$/);
  if (listM && m === "GET") {
    const runId = params.get("runId");
    let rows = SITES;
    if (runId) rows = rows.filter((s) => s.pipelineRunId === runId);
    return ok([...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toRow));
  }

  const provisionM = p.match(/^\/api\/[^/]+\/modules\/webdev\/provision$/);
  if (provisionM && m === "POST") {
    const b = JSON.parse(body || "{}") as { runId?: string; framework?: SiteFramework; slug?: string; clientId?: string; projectId?: string };
    const runId = b.runId?.trim() || null;
    // Mirror the real service: a run's site copies the run's client/project; a standalone one takes the caller's.
    const lineage = runId ? (runLineageForDemo(runId) ?? { clientId: null, projectId: null }) : { clientId: b.clientId?.trim() || null, projectId: b.projectId?.trim() || null };
    // Mirror the real controller: a run OR an explicit slug (standalone, off-pipeline) is required.
    if (!runId && !b.slug?.trim()) return err(400, "invalid_slug");
    const framework: SiteFramework = b.framework === "nextjs" ? "nextjs" : "vite";
    const slug = (b.slug?.trim() || `run-${runId}`).toLowerCase();

    // Idempotency mirror of the real precondition: a non-failed row already active for this run
    // gets handed BACK (200), never a second egress. Standalone rows key on the slug instead.
    const active = runId
      ? SITES.find((s) => s.pipelineRunId === runId && s.status !== "failed")
      : SITES.find((s) => s.slug === slug && s.status !== "failed");
    if (active) return runId ? ok(toRow(active), 200) : err(409, "slug_taken");

    if (!/^[a-z0-9-]{1,40}$/.test(slug)) return err(400, "invalid_slug");
    if (slug.includes("taken")) return err(409, "slug_taken");

    const now = new Date().toISOString();
    if (slug.includes("conflict")) {
      const site: DemoSite = {
        id: nid(), tenantId: "co-agency", pipelineRunId: runId, clientId: lineage.clientId, projectId: lineage.projectId, provider: "provision", providerRef: null,
        slug, framework, repoUrl: null, stagingUrl: null,
        status: "failed", failureReason: "slug_conflict_foreign",
        requestedBy: userId, approvalId: null, lastReconciledAt: null, createdAt: now, updatedAt: now,
        _reconcileCount: 0,
      };
      SITES.push(site);
      return err(409, "slug_conflict_foreign");
    }

    if (slug.includes("crash")) {
      // Egress never runs — the "stays requested" edge (design §03's unavailability contract).
      const site: DemoSite = {
        id: nid(), tenantId: "co-agency", pipelineRunId: runId, clientId: lineage.clientId, projectId: lineage.projectId, provider: "provision", providerRef: null,
        slug, framework, repoUrl: null, stagingUrl: null,
        status: "requested", failureReason: null,
        requestedBy: userId, approvalId: null, lastReconciledAt: null, createdAt: now, updatedAt: now,
        _reconcileCount: 0,
      };
      SITES.push(site);
      return ok(toRow(site), 201);
    }

    // Normal / "timeout" path — egress "succeeds" immediately (mirrors the real 201: "mirror row
    // created, egress begun"), landing `pending` with a provider handle.
    const site: DemoSite = {
      id: nid(), tenantId: "co-agency", pipelineRunId: runId, clientId: lineage.clientId, projectId: lineage.projectId, provider: "provision",
      providerRef: `prov-proj-${seq}`,
      slug, framework, repoUrl: null, stagingUrl: null,
      status: "pending", failureReason: null,
      requestedBy: userId, approvalId: null, lastReconciledAt: null, createdAt: now, updatedAt: now,
      _reconcileCount: 0,
    };
    SITES.push(site);
    return ok(toRow(site), 201);
  }

  return null;
}

/** One Reconcile click's worth of progress for a site — the small interactive state machine
 *  described in this file's header. `slug` (not an id) carries which script a row follows, so the
 *  behavior stays legible from the row itself rather than a hidden side table. */
function reconcileStep(site: DemoSite): DemoSite {
  site._reconcileCount += 1;
  site.lastReconciledAt = new Date().toISOString();

  if (site.slug.includes("timeout")) {
    if (site._reconcileCount === 1) {
      site.status = "failed";
      site.failureReason = "poll_timeout";
    } else {
      // §04: poll_timeout is "honest, not final" — the next reconcile flips it forward.
      site.status = "live";
      site.failureReason = null;
      site.repoUrl = `https://github.com/Gaia-Digital-Agency/${site.slug}`;
      site.stagingUrl = `https://${site.slug}.gaiada.online`;
    }
    site.updatedAt = site.lastReconciledAt;
    return site;
  }

  if (site.status === "requested") {
    // Resume: egress had never run (the "crash" case). Land it where a normal provision's 201 would.
    site.status = "pending";
    site.providerRef = site.providerRef ?? `prov-proj-${++seq}`;
    site.updatedAt = site.lastReconciledAt;
    return site;
  }

  if (site.status === "pending") {
    site.status = "provisioned";
    site.repoUrl = `https://github.com/Gaia-Digital-Agency/${site.slug}`;
    site.updatedAt = site.lastReconciledAt;
    return site;
  }
  if (site.status === "provisioned") {
    site.status = "live";
    site.stagingUrl = `https://${site.slug}.gaiada.online`;
    site.updatedAt = site.lastReconciledAt;
    return site;
  }
  // `live` (nothing left to do) or a non-reconcilable `failed` row (matches the real service's
  // `{outcome:"unchanged"}` no-op for a row with no providerRef to re-poll) — unchanged either way.
  return site;
}

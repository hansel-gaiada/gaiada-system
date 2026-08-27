import "server-only";
// WSK-24 — DEMO_MODE fixtures for WSK-23's console read model:
//   GET /api/:t/modules/webdev/console/sites
//   GET /api/:t/modules/webdev/console/sites/:slug/releases
//   GET /api/:t/modules/webdev/console/sites/:slug/submissions[?formId=]
//   GET /api/:t/modules/webdev/console/contract-pins[?slug=]
//
// Mirrors demoWebdevChangeRequests.ts / demoWebdevProvisionedSites.ts's convention: its own file,
// wired into demoFixtures.getDemoResponse via one import + one dispatch call, matched BEFORE the
// generic `ok([])` GET fallback (which would otherwise hand fetchSiteRegistry() etc. a bare array
// with no `.sites`/`.meta` — the exact "reads a field the backend never sends" bug class this
// program keeps naming). Pure read-only: §24 built ZERO write routes on this surface, so unlike
// demoWebdevProvisionedSites.ts there is no globalThis-backed mutable store to reconcile between
// the RSC read graph and a "use server" action graph — a plain module-level const is enough.
//
// ── THE FIXTURE MUST STAY HONEST, NOT JUST THE REAL BACKEND ────────────────────────────────────
// `lib/webdesk.ts`'s own header is the authority: THREE of these four reads (sites, releases,
// submissions) are ALWAYS `stale:true`/`source:"facts"` (or `"unavailable"` when nothing is on
// file) for real — Zone B's control plane (WSK-21) ships no live read for site/env status,
// releases, or submissions. Faking `stale:false`/`source:"live"` here would teach a reviewer to
// expect a state DEMO_MODE can never actually reproduce once this is pointed at the real backend.
// Only contract-pins gets the four-state live/cache/facts/unavailable spread, because that is the
// one read in this surface with a genuine live upstream (WSK-19's `getContractBundle`, reused).
import type { SiteFramework, SiteStatus } from "./webdevProvisionedSites";

interface DemoResult {
  status: number;
  json: unknown;
}
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const nowIso = () => new Date().toISOString();

interface DemoSiteRow {
  id: string;
  tenantId: string;
  pipelineRunId: string | null;
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
}

// Two rows, deliberately in different lifecycle states: one fully promoted (has BOTH a deploy and a
// promote fact, so the registry's "backend env" column can show "Production"), one staging-only (has
// a deploy fact but no promote fact, so the same column shows "Staging") — the split §08 v1.1 asks
// for, built from the two fact kinds the real contract actually guarantees (kind + receivedAt), not
// from a fabricated env column the schema doesn't have (see this ticket's own report on that gap).
const SITES: DemoSiteRow[] = [
  {
    id: "wps-console-1", tenantId: "co-agency", pipelineRunId: "run-demo-1",
    provider: "provision", providerRef: "prov-proj-1001",
    slug: "northwind-site-redesign-kickoff", framework: "vite",
    repoUrl: "https://github.com/Gaia-Digital-Agency/northwind-site-redesign-kickoff",
    stagingUrl: "https://northwind-site-redesign-kickoff.gaiada.online",
    status: "live", failureReason: null, requestedBy: "demo-hansel", approvalId: null,
    lastReconciledAt: hoursAgo(30), createdAt: "2026-07-19T02:05:00Z", updatedAt: hoursAgo(30),
  },
  {
    id: "wps-console-2", tenantId: "co-agency", pipelineRunId: "run-demo-2",
    provider: "provision", providerRef: "prov-proj-1050",
    slug: "viceroy-resort-microsite", framework: "vite",
    repoUrl: "https://github.com/Gaia-Digital-Agency/viceroy-resort-microsite",
    stagingUrl: "https://viceroy-resort-microsite.gaiada.online",
    status: "provisioned", failureReason: null, requestedBy: "demo-hansel", approvalId: null,
    lastReconciledAt: hoursAgo(4), createdAt: "2026-08-10T09:00:00Z", updatedAt: hoursAgo(4),
  },
];

type ReleaseKind = "deploy.done" | "promote.done" | "rollback.done";
interface Fact {
  kind: ReleaseKind;
  receivedAt: string;
  data: Record<string, unknown>;
}

const RELEASES: Record<string, Fact[]> = {
  "northwind-site-redesign-kickoff": [
    { kind: "deploy.done", receivedAt: hoursAgo(72), data: { slug: "northwind-site-redesign-kickoff" } },
    { kind: "promote.done", receivedAt: hoursAgo(30), data: { slug: "northwind-site-redesign-kickoff" } },
  ],
  "viceroy-resort-microsite": [
    { kind: "deploy.done", receivedAt: hoursAgo(4), data: { slug: "viceroy-resort-microsite" } },
  ],
};

interface DemoSubmission {
  submissionId: string;
  formId: string;
  hasAttachments: boolean;
  receivedAt: string;
}

const SUBMISSIONS: Record<string, DemoSubmission[]> = {
  "northwind-site-redesign-kickoff": [
    { submissionId: "sub-demo-1", formId: "contact", hasAttachments: false, receivedAt: hoursAgo(6) },
    { submissionId: "sub-demo-2", formId: "contact", hasAttachments: true, receivedAt: hoursAgo(20) },
    { submissionId: "sub-demo-3", formId: "booking-enquiry", hasAttachments: false, receivedAt: hoursAgo(50) },
  ],
  "viceroy-resort-microsite": [],
};

function latestOf(facts: Fact[] | undefined, kind: ReleaseKind): Fact | null {
  const matches = (facts ?? []).filter((f) => f.kind === kind).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return matches[0] ?? null;
}

/** Mirrors the real backend's DegradeMeta discipline: `asOf: null` <=> `source: "unavailable"`,
 *  never a confirmed-empty read pretending to be a confirmed-current one. */
function factsMeta(asOf: string | null, reason: string): { stale: true; source: "facts" | "unavailable"; asOf: string | null; reason: string } {
  return { stale: true, source: asOf ? "facts" : "unavailable", asOf, reason };
}

function siteRow(s: DemoSiteRow) {
  const facts = RELEASES[s.slug];
  return {
    ...s,
    lastKnownDeployment: latestOf(facts, "deploy.done"),
    lastKnownPromotion: latestOf(facts, "promote.done"),
    lastKnownRollback: latestOf(facts, "rollback.done"),
  };
}

/** Returns a DemoResult for any /modules/webdev/console/* route, or null if it doesn't match. */
export function webdevConsoleDemo(method: string, p: string, params: URLSearchParams): DemoResult | null {
  if (method.toUpperCase() !== "GET") return null;

  if (p.match(/^\/api\/[^/]+\/modules\/webdev\/console\/sites$/)) {
    const rows = SITES.map(siteRow);
    const newestFact = rows
      .flatMap((r) => [r.lastKnownDeployment, r.lastKnownPromotion, r.lastKnownRollback])
      .filter((f): f is Fact => f !== null)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
    return ok({
      sites: rows,
      meta: factsMeta(newestFact?.receivedAt ?? null, "zone_b_has_no_live_environment_status_read_endpoint_yet"),
    });
  }

  const releasesM = p.match(/^\/api\/[^/]+\/modules\/webdev\/console\/sites\/([^/]+)\/releases$/);
  if (releasesM) {
    const slug = decodeURIComponent(releasesM[1]);
    const releases = [...(RELEASES[slug] ?? [])].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return ok({ releases, meta: factsMeta(releases[0]?.receivedAt ?? null, "zone_b_has_no_live_release_read_endpoint_yet") });
  }

  const submissionsM = p.match(/^\/api\/[^/]+\/modules\/webdev\/console\/sites\/([^/]+)\/submissions$/);
  if (submissionsM) {
    const slug = decodeURIComponent(submissionsM[1]);
    const formId = params.get("formId");
    const all = SUBMISSIONS[slug] ?? [];
    const submissions = (formId ? all.filter((s) => s.formId === formId) : all)
      .slice()
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return ok({
      submissions,
      meta: factsMeta(submissions[0]?.receivedAt ?? null, "slim_pii_free_projection_from_zoneb_event_log_only"),
    });
  }

  if (p.match(/^\/api\/[^/]+\/modules\/webdev\/console\/contract-pins$/)) {
    const slugFilter = params.get("slug");
    const pins = [
      {
        webdeskTenantSlug: "northwind-site-redesign-kickoff",
        pinned: { snapshotId: "snap-demo-1", contractVersion: "1.3", vocabularyVersion: "1.0", contentHash: "sha256-demo1", fetchedAt: hoursAgo(30) },
        // The one row that gets to be genuinely live — proves the UI's "Live from WebDesk" branch
        // is reachable, not just the degrade branches.
        latest: { version: "1.4", vocabularyVersion: "1.0", stale: false, source: "live" as const, asOf: nowIso(), reason: "live_control_channel_read" },
      },
      {
        webdeskTenantSlug: "viceroy-resort-microsite",
        pinned: { snapshotId: "snap-demo-2", contractVersion: "1.0", vocabularyVersion: "1.0", contentHash: "sha256-demo2", fetchedAt: hoursAgo(4) },
        // The genuinely-unknown branch: no live/cache/fact answer for "latest" at all — isBehindLatest()
        // must return null here, never coerce this to "up to date".
        latest: { version: null, vocabularyVersion: null, stale: true, source: "unavailable" as const, asOf: null, reason: "control_channel_egress_error" },
      },
    ].filter((row) => !slugFilter || row.webdeskTenantSlug === slugFilter);
    return ok({ pins });
  }

  return null;
}

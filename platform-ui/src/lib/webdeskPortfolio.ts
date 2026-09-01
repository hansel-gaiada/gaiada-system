// The ESTATE PORTFOLIO read model — mirrors `platform-nest/src/modules/webdev/
// portfolio-reads.service.ts` field-for-field. Backend contract: docs/FRONTEND-BFF-CONTRACT.md §24.
//
//   GET /api/:t/modules/webdev/console/portfolio  ->  PortfolioResult
//
// ── THIS ONE IS NOT DEGRADED, AND THAT IS THE POINT ────────────────────────────────────────────
// `lib/webdesk.ts` opens with a warning that three of its four reads are ALWAYS `stale: true`,
// because Zone B's control plane has no live read endpoints. **This read is the opposite and must
// not be given the same treatment.** It queries Zone A's own tables — `webdev_sites` joined to
// `projects`, `clients` and `search_properties`. There is no egress, nothing to be stale about,
// and no `DegradeMeta` in the payload. Do not add a DegradeBanner here: a staleness notice on data
// that is definitionally current teaches people to ignore the banner where it genuinely matters.
//
// ── WHAT THE ROWS MEAN, BECAUSE THE HONEST ANSWERS ARE THE SUBTLE ONES ─────────────────────────
// `kind: null`        the stack was not determined. NOT "the site has no stack" — an external
//                     probe cannot see past a CDN, and most of these were never surveyed at all.
// `projectId: null`   the site is not attached to a project yet. Real for internal sites, and
//                     currently true of every surveyed row: the clients table holds demo data, so
//                     attributing them would have been invention.
// `crawlConsent`      whether `search_properties.verified_at` is set. MON-01 probes ONLY where this
//                     is true. Render it — a site nobody is allowed to probe looks identical to one
//                     that is simply healthy, and the difference is the whole compliance story.

// PURE, CLIENT-SAFE. Types + display helpers only — no `server-only`, no fetch. The client
// component `PortfolioPanel` imports from here, so nothing in this file may pull server code in.
// The network read lives in `webdeskPortfolio.server.ts`.
export type SiteEnvironment = "production" | "staging" | "preview" | "development";

export interface PortfolioSite {
  id: string;
  domain: string;
  environment: SiteEnvironment;
  hostKind: string;
  hostRef: string | null;
  access: string;
  kind: string | null;
  adoption: string;
  repoUrl: string | null;
  repoBranch: string | null;
  /** Free-text, e.g. a staging site's likely target domain when the host name encodes it. */
  notes?: string | null;
  contractVersion: string | null;
  origin: string;
  lastSeenAt: string | null;
  lastHttpStatus: number | null;
  hostingProvider: string | null;
  controlPanel: string | null;
  stack: string | null;
  topologyCheckedAt: string | null;
  crawlConsent: boolean;
}

export interface PortfolioProject {
  projectId: string | null;
  projectName: string | null;
  clientId: string | null;
  clientName: string | null;
  production: PortfolioSite | null;
  environments: PortfolioSite[];
}

export interface PortfolioResult {
  projects: PortfolioProject[];
  counts: {
    sites: number;
    projects: number;
    byAdoption: Record<string, number>;
    byEnvironment: Record<string, number>;
    withoutConsent: number;
  };
}

/** The adoption ladder, in the order a site climbs it (design v2.0 §07). */
export const ADOPTION_ORDER = ["tracked", "linked", "adopted", "mandated"] as const;

/** Plain-language copy. A console that renders `host_kind: client-cpanel` raw is asking the reader
 *  to know the schema; the point of these is that the answer to "can we deploy to this?" is
 *  legible without one. */
export const HOST_KIND_COPY: Record<string, string> = {
  "our-box": "Our server",
  "client-cpanel": "Client's cPanel",
  "shared-hosting": "Shared hosting",
  external: "External",
  unknown: "Unknown",
};

/** A short, on-point name for the SERVER a site sits on, keyed on `host_ref` (which identifies the
 *  actual box) rather than `host_kind` (which only says "shared hosting" for four different boxes).
 *  The portfolio groups by this, so it is where "which server is this from" is answered — helios vs
 *  delphi vs the shared WP box vs a client's own cPanel. Unknown refs fall back to a tidied form of
 *  the raw value rather than a schema slug. */
export const SERVER_COPY: Record<string, { label: string; kind: string }> = {
  helios:                     { label: "Helios", kind: "Our server · production" },
  delphi:                     { label: "Delphi", kind: "Our server · staging" },
  "gda-ce01":                 { label: "GDA-CE01", kind: "Our server" },
  "gda-aicenter":             { label: "GDA-AICenter", kind: "Our server · ERP" },
  "hstgr-shared-gda-staging": { label: "Shared WP (GDA-Staging)", kind: "Hostinger shared" },
  "hstgr-vps-srv599617":      { label: "Hostinger VPS", kind: "cPanel/WHM" },
  hostinger:                  { label: "Hostinger", kind: "Shared" },
  "hostinger-cdn":            { label: "Hostinger CDN", kind: "Shared / CDN" },
  "hostyourservices-syd5":    { label: "HostYourServices", kind: "Client cPanel" },
  godaddy:                    { label: "GoDaddy", kind: "Client-owned" },
};

/** The server a site belongs to, as a stable grouping key + display pair. Sites with no host_ref
 *  collapse into one honest "Unrecorded host" bucket rather than scattering. */
export function serverOf(site: PortfolioSite): { key: string; label: string; kind: string } {
  const ref = site.hostRef;
  if (!ref) return { key: "~unknown", label: "Unrecorded host", kind: HOST_KIND_COPY[site.hostKind] ?? site.hostKind };
  const copy = SERVER_COPY[ref];
  if (copy) return { key: ref, label: copy.label, kind: copy.kind };
  // Unknown ref: tidy it (an IP or a raw slug) instead of showing a schema value.
  return { key: ref, label: ref, kind: HOST_KIND_COPY[site.hostKind] ?? site.hostKind };
}

/** Every site in the result, flattened, each carrying its project/client label so a server-grouped
 *  or searched view keeps the "whose is this" answer the project grouping used to give. */
export interface FlatSite extends PortfolioSite {
  clientName: string | null;
  projectName: string | null;
}
export function flattenSites(data: PortfolioResult): FlatSite[] {
  return data.projects.flatMap((p) =>
    p.environments.map((s) => ({ ...s, clientName: p.clientName, projectName: p.projectName })),
  );
}

export const ADOPTION_COPY: Record<string, string> = {
  tracked: "Tracked only",
  linked: "Using one service",
  adopted: "On the platform",
  mandated: "Platform required",
};


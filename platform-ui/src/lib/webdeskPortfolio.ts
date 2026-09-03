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
//
// ── THERE IS NO HEALTH IN THIS MODEL, AND THAT IS DELIBERATE (2026-09-03) ──────────────────────
// `webdev_sites.last_http_status` / `last_seen_at` are SELECTed by the backend and were once
// rendered as a health column on a second WebDev tab ("Operations"). **Nothing in this program has
// ever written either column** — a repo-wide search returns exactly two hits: the migration that
// adds them, and the backend read that returns them. Their own migration comment promises MON-01
// will fill them; MON-01 never landed on this table. So every row read "Not checked" forever, and
// the tab's headline permanently claimed "0 showing a problem".
//
// They are therefore ABSENT from this type on purpose. Health for a site is owned by the monitoring
// module (`/monitoring` — live sweeps, uptime, incidents, cert expiry, alerting) and by nothing
// else. If you are tempted to add a status column here, wire it to `monitors` — never to these two
// columns, and never to absence-of-data, which is exactly how a dashboard learns to look green.

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
  /** The SEO property row for this domain, when one exists. NULL is NOT the same answer as
   *  `crawlConsent: false`: no property row means there is nothing that COULD carry consent, so
   *  consent cannot be requested for it either — a different problem with a different fix. The
   *  consent request flow needs this distinction, and it is what lets the monitor join match by
   *  identity instead of by parsing a display target. */
  propertyId: string | null;
  /** NOTE: the backend also returns `lastSeenAt` / `lastHttpStatus`. They are deliberately not
   *  modelled here — see the header. Nothing writes them, so any UI reading them renders a
   *  permanent "unknown" dressed as health. */
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
  /** The IDs, not just the names. The per-site page needs `projectId` to find a site's SIBLING
   *  environments, and a name is not an identity — two clients may both have a "Website" project,
   *  and grouping on the label would merge them. Null is the common case and a real answer: most
   *  surveyed rows are attached to nothing yet. */
  projectId: string | null;
  clientId: string | null;
}
export function flattenSites(data: PortfolioResult): FlatSite[] {
  return data.projects.flatMap((p) =>
    p.environments.map((s) => ({
      ...s,
      clientName: p.clientName,
      projectName: p.projectName,
      projectId: p.projectId,
      clientId: p.clientId,
    })),
  );
}

export const ADOPTION_COPY: Record<string, string> = {
  tracked: "Tracked only",
  linked: "Using one service",
  adopted: "On the platform",
  mandated: "Platform required",
};


// ── Shared display + shaping helpers ───────────────────────────────────────────────────────────
// These lived twice, copy-pasted verbatim, in `PortfolioPanel` and the deleted `OperationsConsole`
// (2026-09-03: the two panels were the same read, the same grouping and the same chips with a
// different column set — the duplication is what let them drift into looking like two features).
// One home, so a third site surface cannot fork them again.

/** `preview` and `staging` are distinct in the schema for a reason (design v2.0 §04): staging is
 *  durable and client-visible, preview slots are ephemeral and machine-generated. */
export const ENVIRONMENT_COPY: Record<string, string> = {
  production: "Production",
  staging: "Staging",
  preview: "Preview",
  development: "Dev",
};

export function environmentLabel(env: string): string {
  return ENVIRONMENT_COPY[env] ?? env;
}

/** Deployment order, not alphabetical — production first because that is the row that matters. */
export const ENVIRONMENT_ORDER = ["production", "staging", "development", "preview"] as const;

/** Our own boxes, in the order an operator thinks about them. Used to float them above hosting we
 *  do not control, so the busy shared box cannot bury helios. */
export const OUR_SERVERS = new Set(["helios", "delphi", "gda-ce01", "gda-aicenter"]);

export interface ServerGroup {
  key: string;
  label: string;
  kind: string;
  sites: FlatSite[];
}

/** Group by the SERVER a site sits on: ours first, then by size, then by name. */
export function groupByServer(sites: FlatSite[]): ServerGroup[] {
  const map = new Map<string, ServerGroup>();
  for (const s of sites) {
    const sv = serverOf(s);
    let g = map.get(sv.key);
    if (!g) { g = { key: sv.key, label: sv.label, kind: sv.kind, sites: [] }; map.set(sv.key, g); }
    g.sites.push(s);
  }
  return [...map.values()].sort((a, b) => {
    const ao = OUR_SERVERS.has(a.key) ? 0 : 1, bo = OUR_SERVERS.has(b.key) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (b.sites.length !== a.sites.length) return b.sites.length - a.sites.length;
    return a.label.localeCompare(b.label);
  });
}

/** The likely target a machine-generated staging host name encodes, pulled out of `notes` so it is
 *  searchable and legible — `goldenmonkeybali-com-303701.hostingersite.com` is opaque; the note
 *  says what it is going to be. */
export function targetHint(site: PortfolioSite): string | null {
  const m = site.notes?.match(/(?:likely target|project by repo):\s*([^\s;]+)/i);
  return m ? m[1] : null;
}

/** Everything one row can be found by. Includes the server LABEL (people search "helios", not
 *  `host_ref`) and the target hint (the only human-readable handle a machine-named host has). */
export function searchText(s: FlatSite): string {
  return [
    s.domain, s.notes, s.repoUrl, s.clientName, s.projectName, s.kind, s.stack,
    serverOf(s).label, targetHint(s),
  ].filter(Boolean).join(" ").toLowerCase();
}

/** Is this row a WordPress site? Two columns can say so and they disagree in the data: `kind` is
 *  webdev's own value ('wp'), `stack` is the SEO property survey's ('wordpress'). */
export function isWordPress(s: PortfolioSite): boolean {
  return s.kind === "wp" || s.stack === "wordpress";
}

export interface PortfolioStats {
  sites: number;
  servers: number;
  ourServers: number;
  wordpress: number;
  withoutConsent: number;
  unattached: number;
  unsurveyed: number;
}

/** The headline figures, as figures. The old panel ran them together into one sentence
 *  ("N sites across M servers · X WordPress · Y without recorded probe consent"), which reads as
 *  prose and scans as nothing. `withoutConsent` comes from the backend's own count, not a re-count
 *  of the rows, so it cannot disagree with the source. */
export function portfolioStats(data: PortfolioResult, sites: FlatSite[]): PortfolioStats {
  const groups = groupByServer(sites);
  return {
    sites: data.counts.sites,
    servers: groups.length,
    ourServers: groups.filter((g) => OUR_SERVERS.has(g.key)).reduce((n, g) => n + g.sites.length, 0),
    wordpress: sites.filter(isWordPress).length,
    withoutConsent: data.counts.withoutConsent,
    unattached: sites.filter((s) => !s.clientName && !s.projectName).length,
    // `kind`/`stack` both null = NOT SURVEYED, never "no stack" (see the header).
    unsurveyed: sites.filter((s) => !s.kind && !s.stack).length,
  };
}

/** The sortable axes of the table. Kept as data so the header cells, the a11y labels and the
 *  comparator cannot fall out of step. */
export const PORTFOLIO_SORTS = [
  { key: "domain", label: "Domain" },
  { key: "server", label: "Server" },
  { key: "environment", label: "Environment" },
  { key: "stack", label: "Stack" },
  { key: "whose", label: "Client / project" },
  { key: "consent", label: "Probe consent" },
] as const;
export type PortfolioSortKey = (typeof PORTFOLIO_SORTS)[number]["key"];
export type SortDir = "asc" | "desc";

function sortValue(s: FlatSite, key: PortfolioSortKey): string {
  switch (key) {
    // OURS FIRST, then by label — the same precedence `groupByServer` applies, because sorting on
    // this column is what replaced the old per-server card grouping and it has to mean the same
    // thing. A plain alphabetical sort on the label looked right and was not: it put Delphi (our
    // staging box) above Helios (our production box) above a client's cPanel purely by initial,
    // and buried our own infrastructure among hosting we cannot touch. Found by opening the page.
    case "server": {
      const sv = serverOf(s);
      return `${OUR_SERVERS.has(sv.key) ? 0 : 1}${sv.label.toLowerCase()}`;
    }
    // Sort by DEPLOYMENT order, not the label's alphabet — "Dev" before "Production" is nobody's
    // idea of sorted. Index-prefixed so the comparator stays a plain string compare.
    case "environment": {
      const i = (ENVIRONMENT_ORDER as readonly string[]).indexOf(s.environment);
      return `${i < 0 ? 9 : i}${s.environment}`;
    }
    // An unsurveyed stack sorts LAST in both directions would be a lie about ordering; it sorts as
    // an empty string, which puts the unknowns together — which is the useful grouping.
    case "stack": return (s.kind ?? s.stack ?? "").toLowerCase();
    case "whose": return (s.clientName ?? s.projectName ?? "").toLowerCase();
    case "consent": return s.crawlConsent ? "1" : "0";
    case "domain":
    default: return s.domain.toLowerCase();
  }
}

/** Stable sort: ties always fall back to the domain, so re-sorting on a coarse column (environment,
 *  consent) does not shuffle rows that compare equal. */
export function sortSites(sites: FlatSite[], key: PortfolioSortKey, dir: SortDir): FlatSite[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...sites].sort((a, b) => {
    const c = sortValue(a, key).localeCompare(sortValue(b, key));
    if (c !== 0) return c * sign;
    return a.domain.localeCompare(b.domain);
  });
}

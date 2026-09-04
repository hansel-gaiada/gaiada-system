// The site portfolio read model — webdesk-design-v2.md §04/§07.
//
// ── THIS IS NOT `console/sites` ────────────────────────────────────────────────────────────────
// `console-reads.service.ts`'s site registry answers "which Zone B tenants have we provisioned",
// and it is honestly `stale: true` because the control plane ships only three GET routes. THIS
// answers a different question: "what does the estate actually consist of", including — especially
// — the sites we do not host, do not control, and must not touch. Most rows here will never be a
// Zone B tenant. Merging the two surfaces would put an unreachable Zone B's staleness in front of
// facts we hold locally and can always render.
//
// Everything below reads Zone A's own tables. There is no egress, nothing to be stale about, and
// no reason for this endpoint to ever degrade.

import { withTenants } from "../../db";

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
  /** Free text; for a machine-named staging host it records the likely target domain. */
  notes: string | null;
  contractVersion: string | null;
  origin: string;
  lastSeenAt: string | null;
  lastHttpStatus: number | null;
  /** The SEO property row for this domain, when one exists. NULL is load-bearing and is NOT the
   *  same answer as `crawlConsent: false`: no property row means there is nothing that COULD carry
   *  consent, so consent cannot be requested for it either — a different problem with a different
   *  fix. The consent request flow needs this to tell those two apart, and the site<->monitor
   *  bridge uses it to match a monitor by IDENTITY instead of by parsing its display target. */
  propertyId: string | null;
  /** From the SEO module's property record, when the domain is registered there. */
  hostingProvider: string | null;
  controlPanel: string | null;
  stack: string | null;
  topologyCheckedAt: string | null;
  /** The consent gate. Probing is only permitted where this is true. */
  crawlConsent: boolean;
  /** VLT-2 (docs/plans/2026-09-04-client-hosting-credential-vault.md) — a POINTER to an
   *  `integration_connections.id` row, never a credential (WSK-D30). NULL means no hosting
   *  credential has been vaulted for this site yet — an honest "not wired up", not an error. */
  vaultRef: string | null;
}

export interface PortfolioProject {
  projectId: string | null;
  projectName: string | null;
  clientId: string | null;
  clientName: string | null;
  /** The one production row, when the project has one. Null is a real answer, not an error. */
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
    /** Sites with no recorded crawl consent. These are NOT probed by MON-01. */
    withoutConsent: number;
  };
}

/**
 * Left-joins the SEO module's `search_properties` for hosting topology rather than duplicating it.
 * One domain, one property row, one consent gate — a second copy of `control_panel` in this module
 * would be a second thing to disagree, and consent is the one fact that must never be ambiguous.
 *
 * The join is on `(tenant_id, domain)` and not on client, deliberately: a site may be registered
 * here before anyone has created its SEO property, and a portfolio that hides rows until a second
 * module catches up is a portfolio nobody trusts.
 */
const PORTFOLIO_SQL = `
  SELECT s.id, s.domain, s.environment, s.host_kind, s.host_ref, s.access, s.kind, s.adoption,
         s.repo_url, s.repo_branch, s.contract_version, s.origin, s.last_seen_at, s.last_http_status, s.notes,
         s.vault_ref,
         s.project_id, s.client_id,
         pr.name  AS project_name,
         cl.name  AS client_name,
         sp.id AS property_id,
         sp.hosting_provider, sp.control_panel, sp.stack, sp.topology_checked_at,
         (sp.verified_at IS NOT NULL) AS crawl_consent
    FROM webdev_sites s
    LEFT JOIN projects pr ON pr.id = s.project_id AND pr.tenant_id = s.tenant_id
    LEFT JOIN clients  cl ON cl.id = s.client_id
    LEFT JOIN search_properties sp
           ON sp.tenant_id = s.tenant_id AND sp.domain = s.domain AND sp.deleted_at IS NULL
   WHERE s.deleted_at IS NULL
   ORDER BY COALESCE(pr.name, cl.name, '~~unassigned'),
            CASE s.environment WHEN 'production' THEN 0 WHEN 'staging' THEN 1
                               WHEN 'development' THEN 2 ELSE 3 END,
            s.domain
`;

interface Row {
  id: string; domain: string; environment: SiteEnvironment; host_kind: string; host_ref: string | null;
  access: string; kind: string | null; adoption: string; repo_url: string | null; repo_branch: string | null;
  contract_version: string | null; origin: string; last_seen_at: Date | null; last_http_status: number | null;
  notes: string | null; vault_ref: string | null;
  project_id: string | null; client_id: string | null; project_name: string | null; client_name: string | null;
  property_id: string | null;
  hosting_provider: string | null; control_panel: string | null; stack: string | null;
  topology_checked_at: Date | null; crawl_consent: boolean;
}

function toSite(r: Row): PortfolioSite {
  return {
    id: r.id,
    domain: r.domain,
    environment: r.environment,
    hostKind: r.host_kind,
    hostRef: r.host_ref,
    access: r.access,
    kind: r.kind,
    adoption: r.adoption,
    repoUrl: r.repo_url,
    repoBranch: r.repo_branch,
    contractVersion: r.contract_version,
    notes: r.notes,
    origin: r.origin,
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    lastHttpStatus: r.last_http_status,
    propertyId: r.property_id,
    hostingProvider: r.hosting_provider,
    controlPanel: r.control_panel,
    stack: r.stack,
    topologyCheckedAt: r.topology_checked_at ? r.topology_checked_at.toISOString() : null,
    crawlConsent: r.crawl_consent === true,
    vaultRef: r.vault_ref,
  };
}

export async function getPortfolio(tenantId: string): Promise<PortfolioResult> {
  // ⚠ THE MODULE LIST IS LOAD-BEARING, AND ITS FAILURE MODE IS SILENT.
  //
  // `webdev_sites` and `search_properties` both carry an RLS policy of the shape
  //   (tenant_id = ANY (app_current_tenants())) AND app_module_allowed('<key>')
  // and `app_module_allowed(k)` is just `k = ANY(app.scopes)`. With `app.scopes` unset it returns
  // **NULL**, not false — so the AND yields NULL, every row is filtered out, and Postgres raises
  // nothing at all. Shipping this call without `modules` made the entire portfolio read EMPTY in
  // production while 20 live rows sat in the table: the console said "no sites provisioned yet",
  // which reads as a data problem and is actually a request-context problem.
  //
  // `search` is not garnish. Omitting it would NOT empty the result — the join to
  // `search_properties` is a LEFT JOIN — it would silently blank hosting topology on every row and
  // report `crawlConsent: false` everywhere, under-reporting consent while looking authoritative.
  //
  // `clients` and `projects` are deliberately absent: their policies gate on tenant only, no module.
  // Add a key here whenever a module-gated table joins into PORTFOLIO_SQL.
  const rows = await withTenants([tenantId], (c) => c.query<Row>(PORTFOLIO_SQL), {
    modules: ["webdev", "search"],
  });

  // Sites with no project group under a single null-keyed entry rather than vanishing. An internal
  // site or an unassigned legacy domain is exactly the thing a portfolio must not hide.
  const byProject = new Map<string, PortfolioProject>();
  const byAdoption: Record<string, number> = {};
  const byEnvironment: Record<string, number> = {};
  let withoutConsent = 0;

  for (const r of rows.rows) {
    const site = toSite(r);
    byAdoption[site.adoption] = (byAdoption[site.adoption] ?? 0) + 1;
    byEnvironment[site.environment] = (byEnvironment[site.environment] ?? 0) + 1;
    if (!site.crawlConsent) withoutConsent++;

    // Group by project when there IS one; otherwise fall back to the CLIENT.
    //
    // Keying project-less rows on a single literal collapsed every one of them into one anonymous
    // bucket: nine tracked domains discovered on our own boxes (the Viceroy DMS across three
    // environments, iSort's second domain, and the rest) all landed together under a group whose
    // clientName came from whichever row happened to be read first — so a site WITH a known owner
    // displayed as having none. The owner is on the row; the grouping was throwing it away.
    //
    // Prefixed so a client id can never collide with a project id in the same map.
    const key = r.project_id ?? (r.client_id ? `client:${r.client_id}` : "~unassigned");
    let group = byProject.get(key);
    if (!group) {
      group = {
        projectId: r.project_id,
        projectName: r.project_name,
        clientId: r.client_id,
        clientName: r.client_name,
        production: null,
        environments: [],
      };
      byProject.set(key, group);
    }
    group.environments.push(site);
    if (site.environment === "production") group.production = site;
  }

  return {
    projects: [...byProject.values()],
    counts: {
      sites: rows.rows.length,
      projects: byProject.size,
      byAdoption,
      byEnvironment,
      withoutConsent,
    },
  };
}

import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { safeConsoleRead } from "@/lib/webdesk";
import { fetchPortfolio } from "@/lib/webdeskPortfolio.server";
import {
  flattenSites, serverOf, environmentLabel, targetHint,
  HOST_KIND_COPY, ADOPTION_COPY,
  type FlatSite,
} from "@/lib/webdeskPortfolio";
import { fetchMonitoringFeed } from "@/lib/siteMonitoring-data";
import { indexMonitorsByDomain, siteMonitoring, createMonitorHref, type SiteMonitoring } from "@/lib/siteMonitoring";
import { formatUptime, formatAge, ageSeconds } from "@/lib/monitoring";
import { formatDateTime } from "@/lib/format";
import "@/components/webdesk/webdesk.css";

type Params = Promise<{ deptId: string; siteId: string }>;

// One site in the estate portfolio.
//
// ── WHY THIS PAGE EXISTS ───────────────────────────────────────────────────────────────────────
// The portfolio table used to carry every fact about a site in six columns, three of which stacked
// a second muted line inside the cell (the staging host's likely target under the domain, the
// project under the client). That is what made the list read as "clumped": ragged row heights, two
// type sizes per row, and still no room for hosting provider, control panel, adoption tier,
// provenance or when the topology was last surveyed — so those were simply not rendered anywhere.
// They live here, and the table went back to one line per row.
//
// ── THERE IS NO SINGLE-SITE ENDPOINT, AND THAT IS FINE ─────────────────────────────────────────
// §24 exposes the list only, so this resolves one row out of the same read the table makes — the
// identical approach `sites/[slug]` already takes for the Zone B registry. It costs one query for a
// page that is opened one at a time, and it guarantees the detail can never disagree with the row
// that linked to it. A `GET /portfolio/:id` would be a second code path to keep honest.
//
// A site id that is not in the read is a genuine 404: it is either not this tenant's, deleted, or
// invented. It must NOT render as an empty site page, which would read as "this site has no
// details" rather than "there is no such site".
export default async function PortfolioSitePage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, siteId } = await params;
  if (!tenant) notFound();

  const read = await safeConsoleRead(() => fetchPortfolio(userId, tenant));
  if (!read.ok) {
    if (read.reason === "not_enabled") {
      return (
        <Card title="Site">
          <EmptyNote>WebDesk isn&apos;t turned on for this company yet.</EmptyNote>
        </Card>
      );
    }
    return <ReadRefusal subject="this site" kind="forbidden" />;
  }

  const all = flattenSites(read.data);
  const site = all.find((s) => s.id === siteId);
  if (!site) notFound();

  // The monitoring bridge, for this one site. Read AFTER the 404 above so a bogus id costs nothing.
  const feed = await fetchMonitoringFeed(userId, tenant);
  const monitorState = siteMonitoring(
    site,
    feed,
    feed.available ? indexMonitorsByDomain(feed.monitors, feed.properties) : new Map(),
  );

  const listHref = `/departments/${deptId}/sites/portfolio`;
  const server = serverOf(site);
  const hint = targetHint(site);

  // The site's siblings — the other environments of the same project. Keyed on projectId when there
  // is one; when there is not (true of most surveyed rows, whose project attribution would have
  // been invention) there are no siblings to show, which is an honest empty rather than a guess
  // stitched together from a shared domain suffix.
  const siblings = site.projectId
    ? all.filter((s) => s.projectId === site.projectId)
    : [site];

  return (
    <>
      <p style={{ marginBottom: 12 }}>
        <Link href={listHref}>← Portfolio</Link>
      </p>

      <Card
        title={site.domain}
        headerRight={
          <a href={`https://${site.domain}`} target="_blank" rel="noreferrer noopener" className="wd-pf__link">
            Open the site ↗
          </a>
        }
      >
        <div className="wd-site__chips">
          <StatusBadge label={environmentLabel(site.environment)} />
          <StatusBadge label={ADOPTION_COPY[site.adoption] ?? site.adoption} />
          {site.crawlConsent
            ? <StatusBadge label="probe consent" />
            : <span className="wd-pf__none">No probe consent on record</span>}
        </div>

        <dl className="wd-site__facts">
          <Fact label="Server">
            {server.label}
            <span className="wd-pf__dim"> · {server.kind}</span>
          </Fact>

          <Fact label="Host kind">{HOST_KIND_COPY[site.hostKind] ?? site.hostKind}</Fact>

          {/* Stack: BOTH sources null means not surveyed, never "no stack" — an external probe
              cannot see past a CDN, and most of these rows were never surveyed at all. */}
          <Fact label="Stack" absent={!site.kind && !site.stack ? "Not surveyed — an external probe cannot always determine the stack" : undefined}>
            {(site.kind ?? site.stack) === "wp" ? "wordpress" : (site.kind ?? site.stack)}
          </Fact>

          <Fact label="Hosting provider" absent={!site.hostingProvider ? "Not recorded" : undefined}>
            {site.hostingProvider}
          </Fact>

          <Fact label="Control panel" absent={!site.controlPanel ? "Not recorded" : undefined}>
            {site.controlPanel}
          </Fact>

          <Fact label="Client" absent={!site.clientName ? "Not attached to a client" : undefined}>
            {site.clientName}
          </Fact>

          <Fact label="Project" absent={!site.projectName ? "Not attached to a project" : undefined}>
            {site.projectName}
          </Fact>

          <Fact label="Repository" absent={!site.repoUrl ? "None linked" : undefined}>
            <RepoValue url={site.repoUrl} branch={site.repoBranch} />
          </Fact>

          <Fact label="Contract version" absent={!site.contractVersion ? "Not pinned" : undefined}>
            {site.contractVersion}
          </Fact>

          {/* Provenance. 'probe' = observed from outside (DNS/HTTP/TLS), never read off a server;
              'nexus-import' = a lead to verify, not a measurement; 'manual' = a human asserted it;
              'provisioned' = we created it. The distinction is the whole reason the column exists
              (see migration 202608301116). */}
          <Fact label="How we know">{ORIGIN_COPY[site.origin] ?? site.origin}</Fact>

          <Fact label="Topology surveyed" absent={!site.topologyCheckedAt ? "Never surveyed" : undefined}>
            {site.topologyCheckedAt ? formatDateTime(site.topologyCheckedAt) : null}
          </Fact>

          {hint ? (
            <Fact label="Likely target">
              {hint}
              <span className="wd-pf__dim"> — this host name is machine-generated</span>
            </Fact>
          ) : null}
        </dl>

        {site.notes ? (
          <>
            <p className="type-eyebrow wd-pf__label" style={{ display: "block", marginTop: 20, marginBottom: 6 }}>Notes</p>
            <p style={{ margin: 0 }}>{site.notes}</p>
          </>
        ) : null}
      </Card>

      {siblings.length > 1 ? (
        <Card title="Other environments of this project" style={{ marginTop: 16 }}>
          <div className="wd-site__envs">
            {siblings.map((s) => (
              <Link
                key={s.id}
                href={`${listHref}/${s.id}`}
                className={`wd-site__env${s.id === site.id ? " wd-site__env--current" : ""}`}
                aria-current={s.id === site.id ? "page" : undefined}
              >
                {environmentLabel(s.environment)} · {s.domain}
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Health, reported rather than computed. This surface runs no check of its own — it says what
          the monitoring module says, and when it cannot reach that module it says THAT. The two
          database columns that once fed a status here (`last_http_status`/`last_seen_at`) have never
          been written by anything and are not read anywhere any more. */}
      <Card
        title="Health and monitoring"
        hint="Owned by Business > Monitoring, which is the only surface in the platform that actually probes. Nothing here is checked live by this page."
        style={{ marginTop: 16 }}
      >
        <MonitoringSection state={monitorState} site={site} />
      </Card>
    </>
  );
}

/** The five monitoring answers, each rendered as itself. Mirrors `monitoringCell` in
 *  `PortfolioPanel` — same five states, same vocabulary, more room to explain them. */
function MonitoringSection({ state, site }: { state: SiteMonitoring; site: FlatSite }) {
  if (state.kind === "unavailable") {
    return (
      <p style={{ margin: 0 }}>
        Coverage for this site is <strong>unknown</strong>:{" "}
        {state.reason === "refused"
          ? "you are not authorized to read this company's monitoring."
          : "the monitoring module is not enabled for this company."}{" "}
        That is not a claim that nothing is watching it — only that this page could not ask.
      </p>
    );
  }

  if (state.kind === "watched") {
    const m = state.monitor;
    return (
      <>
        <div className="wd-site__chips">
          <StatusBadge label={m.status} />
          {!m.enabled ? <StatusBadge label="suspended" /> : null}
          {!state.consented ? <StatusBadge label="no consent" /> : null}
        </div>
        <p style={{ margin: "0 0 8px" }}>
          Watched by <Link href={`/monitoring/${m.id}`}>{m.name}</Link> ({m.kind}, every{" "}
          {m.intervalSec}s). Last checked {formatAge(ageSeconds(m.lastCheckedAt ?? null, Date.now()))}
          {typeof m.uptime24h === "number" ? <> · {formatUptime(m.uptime24h)} uptime over 24h</> : null}.
        </p>
        {!m.enabled ? (
          <p className="wd-pf__none" style={{ margin: "0 0 8px" }}>
            This monitor is <strong>suspended</strong>, so the status above is the last thing it saw,
            not a current reading. A suspended monitor is not evidence of health.
          </p>
        ) : null}
        {!state.consented ? (
          <p style={{ margin: 0 }}>
            <strong>This domain is being probed with no crawl consent on record.</strong> Consent is
            the rule that decides what monitoring may touch (<code>search_properties.verified_at</code>),
            so either the consent should be recorded or this monitor should not exist. Worth
            resolving before anyone asks.
          </p>
        ) : null}
      </>
    );
  }

  if (state.kind === "no-consent") {
    return (
      <p style={{ margin: 0 }}>
        No crawl consent is recorded for this domain, so it is <strong>not</strong> probed. That is a
        rule, not an outage: consent lives on the SEO property record
        (<code>search_properties.verified_at</code>), and monitoring only ever checks domains that
        carry it. Until it does, this site has no health signal anywhere in the platform — and that
        is the correct state for a site we only track.
      </p>
    );
  }

  // kind === "none": consented, and genuinely nothing is watching it. The only state with an action.
  return (
    <>
      <p style={{ margin: "0 0 8px" }}>
        Consent is on record, so this site <em>may</em> be probed — but <strong>no monitor exists
        for it</strong>, so nothing is being checked. This is a real coverage gap, not a rule.
      </p>
      <p style={{ margin: 0 }}>
        <Link href={createMonitorHref(site, state.clientId)}>Create a monitor for {site.domain}</Link>
        {state.clientId
          ? " — the domain and client are filled in for you."
          : " — the domain is filled in; a monitor also needs a client, and this site has none on record yet."}
      </p>
    </>
  );
}

/** Provenance, in words. Mirrors the `webdev_sites.origin` column comment. */
const ORIGIN_COPY: Record<string, string> = {
  probe: "Observed from outside (DNS / HTTP / TLS)",
  "nexus-import": "Imported from Gaia Nexus — a lead to verify, not a measurement",
  manual: "Entered by a person",
  provisioned: "Created by our delivery pipeline",
};

/** One label/value pair. `absent` is the "why is this empty" sentence — a fact that is missing says
 *  which KIND of missing it is, because "—" cannot distinguish "we never looked" from "there is
 *  none", and those two have different next actions. */
function Fact({ label, children, absent }: { label: string; children?: ReactNode; absent?: string }) {
  return (
    <div className="wd-site__fact">
      <dt className="type-eyebrow">{label}</dt>
      {absent ? <dd className="wd-site__absent">{absent}</dd> : <dd>{children}</dd>}
    </div>
  );
}

/** A repo URL is not always a link. An SSH remote (a site another agency builds on GitLab) is a
 *  real value but not navigable, so it renders as text rather than a dead anchor. */
function RepoValue({ url, branch }: { url: string | null; branch: string | null }) {
  if (!url) return null;
  const name = url.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
  const suffix = branch ? <span className="wd-pf__dim"> @{branch}</span> : null;
  if (!/^https?:\/\//.test(url)) return <span title={url}>{name}{suffix}</span>;
  return (
    <>
      <a href={url} target="_blank" rel="noreferrer noopener">{name}</a>
      {suffix}
    </>
  );
}

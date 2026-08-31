import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import {
  ADOPTION_COPY, HOST_KIND_COPY,
  type PortfolioResult, type PortfolioProject, type PortfolioSite,
} from "@/lib/webdeskPortfolio";

// The estate portfolio — every site we know of, whether or not it is on the platform.
// Design: docs/blueprints/webdesk-design-v2.md §07. Backend: FRONTEND-BFF-CONTRACT §24
// (`console/portfolio`).
//
// ── NO DEGRADE BANNER HERE, DELIBERATELY ───────────────────────────────────────────────────────
// Its sibling `SiteRegistryPanel` renders one because Zone B's control plane has no live reads and
// that data is permanently `stale: true`. This panel reads Zone A's own tables, so there is nothing
// to be stale about. Adding a banner "for consistency" would teach people to ignore it on the panel
// where it carries real meaning.
//
// ── WHAT THIS PANEL IS CAREFUL ABOUT ───────────────────────────────────────────────────────────
// Most rows describe sites we do NOT host and must not touch. So the questions it answers first
// are "where does this live" and "are we allowed to look at it" — not deploy status, which for a
// tracked site is a category error.

const MUTED = { color: "var(--erp-ink-50)" } as const;

function environmentLabel(env: string): string {
  // `preview` and `staging` are distinct in the schema for a reason (v2.0 §04): staging is durable
  // and client-visible, preview slots are ephemeral and machine-generated. Collapsing them here
  // would undo the distinction the column exists to make.
  return ({ production: "Production", staging: "Staging", preview: "Preview", development: "Dev" } as Record<string, string>)[env] ?? env;
}

/** `null` means NOT SURVEYED — never "no stack". An outside probe cannot see past a CDN, and most
 *  of these were never surveyed at all. A dash with an explanation is honest; rendering "Unknown"
 *  as though it were a finding is not. */
function stackCell(site: PortfolioSite) {
  const detected = site.kind ?? site.stack;
  if (!detected) {
    return <span style={MUTED} title="Not surveyed — an external probe cannot always determine the stack">—</span>;
  }
  return <StatusBadge label={detected === "wp" ? "wordpress" : detected} />;
}

function hostCell(site: PortfolioSite) {
  const kind = HOST_KIND_COPY[site.hostKind] ?? site.hostKind;
  return (
    <span>
      {kind}
      {site.hostRef ? <span style={MUTED}> · {site.hostRef}</span> : null}
    </span>
  );
}

/** The consent gate, given a column rather than a footnote. A site nobody is allowed to probe looks
 *  exactly like a healthy one in a monitoring list, and the difference is the whole compliance
 *  position. */
function consentCell(site: PortfolioSite) {
  return site.crawlConsent
    ? <span title="Consent recorded — MON-01 probes this site">Yes</span>
    : <span style={MUTED} title="No recorded consent — this site is NOT probed">Not recorded</span>;
}

function repoCell(site: PortfolioSite) {
  if (!site.repoUrl) return <span style={MUTED}>—</span>;
  const name = site.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
  return (
    <a href={site.repoUrl} target="_blank" rel="noreferrer noopener">
      {name}
      {site.repoBranch ? <span style={MUTED}> @{site.repoBranch}</span> : null}
    </a>
  );
}

function ProjectBlock({ project }: { project: PortfolioProject }) {
  // A project with no production row is a real, reportable state — a site that lives only in
  // staging, or one whose production URL nobody has recorded. Not an error, and not rendered as one.
  const title = project.projectName ?? "Not assigned to a project";
  const note = project.clientName
    ?? (project.projectId
      ? "No client on file"
      : "Discovered by survey — not attached to a project or client yet.");

  return (
    <Card title={title}>
      <p style={{ ...MUTED, marginTop: 0 }}>{note}</p>
      <HairlineTable
        tcols="2.2fr 1fr 1.1fr 1.3fr 1fr 1fr 1fr"
        columns={[
          { label: "Domain" },
          { label: "Environment" },
          { label: "Stack" },
          { label: "Hosting" },
          { label: "Repository" },
          { label: "Platform" },
          { label: "Probe consent" },
        ]}
        rows={project.environments.map((s) => [
          <a key="d" href={`https://${s.domain}`} target="_blank" rel="noreferrer noopener">{s.domain}</a>,
          environmentLabel(s.environment),
          stackCell(s),
          hostCell(s),
          repoCell(s),
          ADOPTION_COPY[s.adoption] ?? s.adoption,
          consentCell(s),
        ])}
      />
    </Card>
  );
}

export function PortfolioPanel({ data }: { data: PortfolioResult }) {
  if (data.counts.sites === 0) {
    return (
      <Card title="Site portfolio">
        <EmptyNote>
          No sites recorded yet. This is the estate inventory — every site we build or operate,
          including the ones hosted elsewhere that we only track.
        </EmptyNote>
      </Card>
    );
  }

  const all = data.projects.flatMap((p) => p.environments);
  const wp = all.filter((s) => s.kind === "wp").length;
  const unsurveyed = all.filter((s) => !s.kind && !s.stack).length;

  return (
    <>
      <Card title="Site portfolio">
        <p style={{ marginTop: 0 }}>
          {data.counts.sites} site{data.counts.sites === 1 ? "" : "s"} in{" "}
          {data.counts.projects} group{data.counts.projects === 1 ? "" : "s"} · {wp} WordPress ·{" "}
          {unsurveyed} stack not surveyed · {data.counts.withoutConsent} without recorded probe consent
        </p>
        <p style={{ ...MUTED, marginBottom: 0 }}>
          Everything we build or operate, including sites hosted elsewhere that we only track.
          Tracked sites are never modified — they are listed so that nothing is invisible.
        </p>
      </Card>
      {data.projects.map((p) => (
        <ProjectBlock key={p.projectId ?? "unassigned"} project={p} />
      ))}
    </>
  );
}

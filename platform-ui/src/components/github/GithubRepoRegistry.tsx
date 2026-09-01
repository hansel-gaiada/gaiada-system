"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, KpiTile } from "@/components/ui";
import { SearchableTable } from "@/components/systems/SearchableTable";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatTimestamp } from "@/lib/format";
import {
  type GithubRepoView, type GithubRepoListResponse, type Tone,
  syncFreshness, freshnessTone, FRESHNESS_LABEL,
  deployedRefStatus, DEPLOY_HEAD_LABEL,
  runLabel, runTone,
  formatCommitAuthor, linkDisplayName, repoSearchText,
} from "@/lib/githubRepos";
import "@/components/systems/systems.css";
import "./github.css";

// GH-09 — Sites/Repos view per blueprint §5.4. Pure presentation over TWO already-fetched,
// server-filtered pages (`linked`/`unlinked`, each `{repos,total,limit,offset}` per §25) — the
// server component (page.tsx) does the filtering (archived toggle, linked=true|false) and the
// counting (`total`); this component's own client state is limited to per-bucket search/pagination
// (via SearchableTable, over whatever page the server already sent).
//
// ── THREE DESIGN CALLS THIS COMPONENT MAKES, RECORDED HERE RATHER THAN LEFT IMPLICIT ────────────────
// 1. Archived is OFF by default, with an explicit named toggle ("Show archived (N)") rather than a
//    plain filter pill — the count is IN the toggle label so the fact that more exists is visible
//    even while collapsed. 113/221 measured archived (51%): defaulting it OFF is what keeps the
//    registry reading as "what's live" on first load instead of a half-dead pile (§5.4 design note).
// 2. Unlinked repos render as their OWN card, always visible beneath the main registry — never a
//    tab someone has to think to click, and never merged into the same table (a merged table would
//    make "unlinked" just another column value, easy to scroll past on a company with 200+ rows).
// 3. Sync freshness is a badge on EVERY row, not a banner shown "when something is wrong" — matching
//    components/webdesk/DegradeBanner.tsx's own reasoning: a state that is normal-and-common must be
//    visible every time, or its absence gets learned as "this is current" everywhere else.
export function GithubRepoRegistry({
  linked, unlinked, archivedTotal, includeArchived, basePath,
}: {
  linked: GithubRepoListResponse;
  unlinked: GithubRepoListResponse;
  /** Org-wide archived count, independent of the current linked/archived filter — null when that
   *  lightweight read itself failed (non-fatal; the toggle just loses its number, not its function). */
  archivedTotal: number | null;
  includeArchived: boolean;
  /** The page this registry is mounted on, for the archived toggle's own href.
   *
   *  REQUIRED, and a prop rather than a hardcoded path because it already broke once: the toggle
   *  read `/systems/github` literally, so when the registry moved onto the Web Dev Repositories tab
   *  (2026-08-31, owner decision) clicking "Show archived" would have navigated the operator OFF the
   *  page they were reading and back to a route that no longer hosts it. A component that renders
   *  anywhere must not name one route. */
  basePath: string;
}) {
  // Frozen once per mount rather than re-read on every render — a freshness badge that silently
  // ticks from "Synced" to "Stale" while an operator is mid-read on an open tab is a worse surprise
  // than a badge that is a few minutes behind wall-clock; reload the page to refresh it, same as
  // Plane A's console.
  const [nowMs] = useState(() => Date.now());

  const columns = [
    { label: "Repository" }, { label: "Linked to" }, { label: "Branch" }, { label: "Last commit" },
    { label: "Open PRs", align: "right" as const }, { label: "Last CI run" },
    { label: "Deployed ref" }, { label: "Synced" },
  ];
  const tcols = "1.8fr 1.1fr 0.8fr 1.3fr 0.7fr 1.2fr 1.1fr 1.2fr";

  // ONE table over both server pages, not two. The linked/unlinked split shipped as two separate
  // tables on the assumption that unlinked would be the exception — on the real org it is 100% of
  // rows (0 linked, 108 unlinked), so the main table rendered "No linked, active repos" while every
  // repo sat in a bucket below it. That reads as "the crawl did not work", which is exactly the
  // wrong conclusion, and it is what an operator actually concluded on first look.
  //
  // Linkage is now a COLUMN and a KPI, not a partition: it is an attribute of a repo, not a
  // different kind of thing. The unlinked count stays prominent above because "nobody owns this
  // repo" is still a finding worth acting on — it just is not a reason to hide the repo.
  const allRepos = [...linked.repos, ...unlinked.repos].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const allTotal = linked.total + unlinked.total;

  const renderRow = (r: GithubRepoView) => {
    const freshness = syncFreshness(r.lastSyncedAt, nowMs);
    const run = runLabel(r.latestRunStatus, r.latestRunConclusion);
    const deploy = deployedRefStatus(r);
    const link = linkDisplayName(r);
    return [
      <div key="repo" className="ghr-repo-cell">
        <a className="ghr-repo-cell__link" href={r.htmlUrl} target="_blank" rel="noreferrer noopener">
          {r.fullName}
        </a>
        <span className="ghr-repo-cell__meta">
          {r.visibility === "public" ? "Public" : "Private"}
          {r.archived ? " · Archived" : ""}
        </span>
      </div>,
      link
        ? <span key="link" className="ghr-link-cell">{link}</span>
        : <span key="link" className="ghr-link-cell ghr-link-cell--none" title="No webdev site and no project claims this repo">Unlinked</span>,
      <code key="branch" style={{ font: "400 12px var(--font-mono, monospace)", color: "var(--erp-ink-60)" }}>{r.defaultBranch}</code>,
      <div key="commit" className="ghr-commit-cell">
        <span>{r.headSha ? formatCommitAuthor(r.headAuthor) : "No commits yet"}</span>
        {r.headCommittedAt && <span className="ghr-commit-cell__when">{formatTimestamp(r.headCommittedAt)}</span>}
      </div>,
      <span key="prs">{r.openPrCount}</span>,
      <Tag key="ci" label={run} tone={runTone(r.latestRunStatus, r.latestRunConclusion)} />,
      <Tag key="deploy" label={DEPLOY_HEAD_LABEL[deploy]} tone={deployTone(deploy)} />,
      <div key="sync" className="ghr-sync-cell">
        <Tag label={FRESHNESS_LABEL[freshness]} tone={freshnessTone(freshness)} />
        {r.lastSyncedAt && <span className="ghr-sync-cell__asof">as of {formatTimestamp(r.lastSyncedAt)}</span>}
      </div>,
    ];
  };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div className="sys-status-card__counters">
        <KpiTile label="Linked repos" value={String(linked.total)} />
        <KpiTile
          label="Unlinked"
          value={String(unlinked.total)}
          hint="Neither a webdev site nor a project links to this repo. Either a site nobody registered, or a repo nobody owns — a finding worth acting on, not an error state."
        />
        <KpiTile
          label="Archived (org-wide)"
          value={archivedTotal === null ? "—" : String(archivedTotal)}
          hint="A normal GitHub state, not an error — over half this org's repos are archived. Hidden by default; use the toggle below to include them."
        />
        <KpiTile
          label="Stale or overdue sync (this page)"
          value={String(countStaleOrDark(linked.repos, nowMs) + countStaleOrDark(unlinked.repos, nowMs))}
          hint="Rows on THIS page whose last_synced_at is more than 24h old. A stale row is a claim this registry cannot currently verify against live GitHub — shown honestly rather than presented as current. Counts only the loaded rows, not the full tenant-wide total, when a bucket is truncated by the page limit."
        />
      </div>
      <p className="sys-empty-note">
        Open PR count and last CI run update on the crawl/reconcile sweep&apos;s cadence, not live —
        a full org sweep costs hundreds of GitHub API calls, so these columns can lag. &ldquo;Synced&rdquo;
        on each row is the honest signal for how current it is; deployed ref is not tracked yet at all
        (GH-07, pending) and always reads &ldquo;Not tracked yet&rdquo; until it ships.
      </p>

      <div className="ghr-toolbar">
        <div className="ghr-toggle-row">
          {/* Plain Link + active class, matching the Hub console's own `?source=` filter row
              (components/systems/systems.css's `.sys-filter`/`.sys-filter--active`) — no
              `aria-pressed`, which is only valid ARIA on a button/toggle role, not a link. */}
          <Link
            href={includeArchived ? basePath : `${basePath}?archived=1`}
            className={`sys-filter${includeArchived ? " sys-filter--active" : ""}`}
          >
            {includeArchived
              ? `Showing archived${archivedTotal !== null ? ` (${archivedTotal})` : ""}`
              : `Show archived${archivedTotal !== null ? ` (${archivedTotal})` : ""}`}
          </Link>
        </div>
      </div>

      <Bucket
        title="Repository registry"
        data={{ repos: allRepos, total: allTotal, limit: linked.limit, offset: 0 }}
        columns={columns}
        tcols={tcols}
        renderRow={renderRow}
        emptyCopy={includeArchived ? "No repos match this view." : "No active repos — try “Show archived”."}
      />
    </div>
  );
}

function countStaleOrDark(repos: GithubRepoView[], nowMs: number): number {
  return repos.filter((r) => {
    const f = syncFreshness(r.lastSyncedAt, nowMs);
    return f === "stale" || f === "dark";
  }).length;
}

function Bucket({
  title, data, columns, tcols, renderRow, emptyCopy,
}: {
  title: string;
  data: GithubRepoListResponse;
  columns: { label: string; align?: "right" }[];
  tcols: string;
  renderRow: (r: GithubRepoView) => ReactNode[];
  emptyCopy: string;
}) {
  return (
    <Card title={title} headerRight={<span className="sys-empty-note">{data.total}</span>}>
      <BucketTable data={data} columns={columns} tcols={tcols} renderRow={renderRow} emptyCopy={emptyCopy} />
    </Card>
  );
}

function BucketTable({
  data, columns, tcols, renderRow, emptyCopy,
}: {
  data: GithubRepoListResponse;
  columns: { label: string; align?: "right" }[];
  tcols: string;
  renderRow: (r: GithubRepoView) => ReactNode[];
  emptyCopy: string;
}) {
  const truncated = data.total > data.repos.length;
  return (
    <>
      {data.repos.length === 0 ? (
        <EmptyNote>{emptyCopy}</EmptyNote>
      ) : (
        <>
          <SearchableTable
            items={data.repos}
            columns={columns}
            tcols={tcols}
            getSearchText={repoSearchText}
            searchLabel="Search repositories"
            searchPlaceholder="Filter by name, branch, author or CI state…"
            emptyState={<EmptyNote>{emptyCopy}</EmptyNote>}
            renderRow={renderRow}
          />
          {truncated && (
            <p className="sys-empty-note" style={{ marginTop: 10 }}>
              Showing the first {data.repos.length} of {data.total} — narrow with search, or ask an
              admin for a filtered link (this page does not yet page past the {data.limit}-row server
              limit).
            </p>
          )}
        </>
      )}
    </>
  );
}

function deployTone(status: ReturnType<typeof deployedRefStatus>): Tone {
  switch (status) {
    case "matches_head":
      return "ok";
    case "differs":
      return "progress";
    default:
      return "idle";
  }
}

function Tag({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className="ghr-tag" style={{ color: `var(--status-${tone}-fg)` }}>
      <span className="ghr-tag__dot" style={{ background: `var(--status-${tone})` }} />
      {label}
    </span>
  );
}

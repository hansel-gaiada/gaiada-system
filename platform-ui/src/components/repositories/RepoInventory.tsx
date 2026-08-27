"use client";
import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { HairlineTable, StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/webdevProvisionedSites";
import { REPO_STATUS_LABEL } from "@/lib/repoInventory";
import type { SiteActionResult } from "@/lib/webdevProvisionedSitesActions";
import type { ConnectionStatus } from "@/lib/connections";
import { repoCounts, type EligibleRun, type RepoRow } from "@/lib/repoInventory";
import { CreateRepoForm, type CreateRepoFormActions } from "./CreateRepoForm";
import "./repositories.css";

// The Web Dev department's code inventory, as a table — the same `HairlineTable` the Projects,
// admin and finance surfaces use, so it reads like the rest of the app. One row per repository the
// delivery pipeline provisioned: name → GitHub, whose site it is (client · project), what state it
// is in (with the plain-language reason when it failed), where it runs, which PRD run it came from,
// when the system last confirmed all that, and the one action that helps. Rows arrive problems-first
// from lib/repoInventory.ts.
//
// What this tab does NOT show yet: commits, PRs, per-repo activity, repos created outside the
// pipeline. All of that needs the GitHub App installed on the org (WD-21/WD-22 — an owner action), so
// the GitHub line says exactly that instead of leaving empty columns.
export interface RepoInventoryActions {
  /** `reconcileSiteAction` — re-poll the provisioning service for one site. */
  reconcile: (formData: FormData) => Promise<SiteActionResult>;
}

export type RepoInventoryState =
  | { kind: "ok"; rows: RepoRow[] }
  | { kind: "not_enabled" }
  | { kind: "refused" };

export interface GithubConnectionView { status: ConnectionStatus; account: string | null }

/** Everything the "Create repository" form needs; present only for people who may provision. */
export interface CreateRepoOptions { runs: EligibleRun[]; actions: CreateRepoFormActions; prdHref: string }

const BASE_COLUMNS = [
  { label: "Repository" },
  { label: "Client · Project" },
  { label: "Status" },
  { label: "URL" },
  { label: "From run" },
  { label: "Last checked" },
];
const BASE_TCOLS = "2fr 1.6fr 1.4fr 1.8fr 1.7fr 1fr";
// The actions column exists only when at least one row has an action (a re-check that can move it,
// or a re-provision link); otherwise it is not rendered at all — no column of dashes.
const ACTION_COLUMN = { label: "Action" };
const ACTION_TCOLS = " 1.3fr";

function rowHasAction(row: RepoRow, mayReconcile: boolean): boolean {
  return (mayReconcile && row.canReconcile) || row.failure?.remedy === "reprovision";
}

export function RepoInventory({
  state,
  github,
  mayReconcile,
  actions,
  pipelineHref,
  previewHref,
  sample,
  create,
}: {
  state: RepoInventoryState;
  /** The viewer's own GitHub connection, if any (Connections tab). */
  github: GithubConnectionView | null;
  mayReconcile: boolean;
  actions: RepoInventoryActions;
  pipelineHref: string;
  /** Where "Preview with sample data" goes (offered only when there is nothing real to show). */
  previewHref?: string;
  /** Set when `state.rows` are SAMPLES: renders the banner and disables every real action. */
  sample?: { exitHref: string };
  create?: CreateRepoOptions;
}) {
  const [creating, setCreating] = useState(false);
  const previewOffer = previewHref ? (
    <p className="repo-note">
      Want to see the layout with repositories in it? <Link href={previewHref}>Preview with sample data →</Link>
    </p>
  ) : null;

  if (state.kind === "not_enabled") {
    return (
      <div className="repo-inventory">
        <p className="repo-note">Site &amp; repo provisioning isn&rsquo;t turned on for this company yet, so there are no repositories to list.</p>
        {previewOffer}
      </div>
    );
  }
  if (state.kind === "refused") {
    return <p className="repo-note">You don&rsquo;t have access to view this department&rsquo;s repositories (ask an admin if you need it).</p>;
  }

  const { rows } = state;
  const inSample = !!sample;
  const canCreate = !!create && !inSample;
  const createButton = canCreate ? (
    <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" aria-expanded={creating} onClick={() => setCreating((v) => !v)}>
      {creating ? "Close" : "Create repository"}
    </button>
  ) : null;
  const hasActions = !inSample && rows.some((r) => rowHasAction(r, mayReconcile));
  const c = repoCounts(rows);
  const summary = rows.length === 0
    ? null
    : [
        `${c.total} ${c.total === 1 ? "repo" : "repos"}`,
        `${c.live} live`,
        c.staging > 0 && `${c.staging} on staging`,
        c.provisioning > 0 && `${c.provisioning} provisioning`,
        c.failed > 0 && `${c.failed} failed`,
      ].filter(Boolean).join(" · ");

  return (
    <div className="repo-inventory">
      {sample && (
        <div className="repo-sample" role="status">
          <strong>Sample data.</strong> This is what the tab looks like once runs have been provisioned — nothing here is from your platform, and the links are not real.{" "}
          <Link href={sample.exitHref}>Back to real data →</Link>
        </div>
      )}
      <div className="repo-inventory__head">
        <div className="repo-inventory__lead">
          {summary && <span className="repo-inventory__summary">{summary}</span>}
          {createButton}
        </div>
        <GithubLine github={github} />
      </div>
      {canCreate && creating && create && (
        <CreateRepoForm runs={create.runs} actions={create.actions} prdHref={create.prdHref} />
      )}

      {rows.length === 0 ? (
        <div className="repo-empty">
          <span className="repo-empty__glyph" aria-hidden="true">⎇</span>
          <span className="repo-empty__title">No repositories yet</span>
          <span className="repo-empty__body">
            A repository is created when a PRD run is provisioned — in the run workspace, under &ldquo;Site &amp; repo&rdquo;. It shows up here with its client, project and status.
          </span>
          <Link href={pipelineHref} className="lux-btn lux-btn--ghost lux-btn--sm">Open the pipeline →</Link>
          {previewOffer}
        </div>
      ) : (
        <div className="lux-table-scroll erp-scroll repo-table" style={{ ["--lux-table-min" as string]: hasActions ? "1040px" : "900px" }}>
          <HairlineTable
            columns={hasActions ? [...BASE_COLUMNS, ACTION_COLUMN] : BASE_COLUMNS}
            tcols={hasActions ? BASE_TCOLS + ACTION_TCOLS : BASE_TCOLS}
            rows={rows.map((r) => repoCells(r, { mayReconcile: mayReconcile && !inSample, withActions: hasActions, onReconcile: actions.reconcile }))}
          />
        </div>
      )}
    </div>
  );
}

function GithubLine({ github }: { github: GithubConnectionView | null }) {
  const label = !github
    ? "GitHub: not connected"
    : github.status === "linked"
      ? `GitHub: ${github.account ?? "connected"} · linked`
      : `GitHub: ${github.account ?? "—"} · identity only`;
  return (
    <div className="repo-github">
      <span className="repo-github__label">{label}</span>
      <span className="repo-github__hint">Commit and PR activity appears once the GitHub App is connected to the org.</span>
    </div>
  );
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function repoCells(row: RepoRow, opts: { mayReconcile: boolean; withActions: boolean; onReconcile: (fd: FormData) => Promise<SiteActionResult> }): ReactNode[] {
  const lineage = [row.clientName, row.projectName].filter(Boolean).join(" · ");
  const cells: ReactNode[] = [
    // Repository — name → GitHub (plain text until the repo exists), framework underneath.
    <span key="repo" className="repo-cell repo-cell--stack">
      {row.repoUrl ? (
        <a className="repo-cell__name" href={row.repoUrl} target="_blank" rel="noreferrer">{row.name}</a>
      ) : (
        <span className="repo-cell__name">{row.name}</span>
      )}
      <span className="repo-cell__sub">{row.frameworkLabel}</span>
    </span>,
    <span key="lineage" className="repo-cell">{lineage || <em className="repo-cell__muted">no client or project</em>}</span>,
    // Status — the badge, and for a failure the reason in plain words right under it.
    <span key="status" className="repo-cell repo-cell--stack">
      <StatusBadge label={REPO_STATUS_LABEL[row.status]} />
      {row.failure && (
        <details className="repo-why">
          <summary className="repo-why__summary">{row.failure.title}</summary>
          <span className="repo-cell__why">{row.failure.body}</span>
        </details>
      )}
    </span>,
    <span key="staging" className="repo-cell">
      {row.stagingUrl ? <a href={row.stagingUrl} target="_blank" rel="noreferrer">{stripScheme(row.stagingUrl)}</a> : <em className="repo-cell__muted">not available yet</em>}
    </span>,
    <span key="run" className="repo-cell"><Link href={`/pipeline/${row.run.id}`} className="repo-cell__run">{row.run.title} →</Link></span>,
    <span key="checked" className="repo-cell">{row.lastCheckedAt ? formatDate(row.lastCheckedAt) : <em className="repo-cell__muted">not checked yet</em>}</span>,
  ];
  if (opts.withActions) cells.push(<RowActions key="actions" row={row} mayReconcile={opts.mayReconcile} onReconcile={opts.onReconcile} />);
  return cells;
}

function RowActions({ row, mayReconcile, onReconcile }: {
  row: RepoRow;
  mayReconcile: boolean;
  onReconcile: (formData: FormData) => Promise<SiteActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SiteActionResult | null>(null);
  if (!rowHasAction(row, mayReconcile)) return <span className="repo-cell" />;
  const reconcile = () => {
    setResult(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("siteId", row.id);
      fd.set("runId", row.run.id);
      setResult(await onReconcile(fd));
    });
  };
  return (
    <span className="repo-cell repo-cell--stack">
      {mayReconcile && row.canReconcile && (
        <button type="button" className="btn" onClick={reconcile} disabled={pending}>{pending ? "Checking…" : "Check status now"}</button>
      )}
      {row.failure?.remedy === "reprovision" && (
        <Link href={`/pipeline/${row.run.id}`} className="btn">Start a new provision →</Link>
      )}
      {result && !result.ok && <span className="repo-cell__why repo-cell__why--error">{result.error}</span>}
      {result?.ok && <span className="repo-cell__sub">Now {STATUS_LABEL[result.site.status] ?? result.site.status} — reload to see it in place.</span>}
    </span>
  );
}

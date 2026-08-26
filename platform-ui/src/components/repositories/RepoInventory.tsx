"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/webdevProvisionedSites";
import type { SiteActionResult } from "@/lib/webdevProvisionedSitesActions";
import type { ConnectionStatus } from "@/lib/connections";
import { repoCounts, type RepoRow } from "@/lib/repoInventory";
import "./repositories.css";

// The Web Dev department's code inventory. One row per repository the delivery pipeline provisioned,
// with what a lead wants at a glance: name → GitHub, whose site it is (client · project), what state
// it is in, where it runs, which PRD run it came from, and when the system last confirmed all that.
// Problems come first (the rows arrive pre-sorted from lib/repoInventory.ts). A failed row says why
// in plain words and offers the one action that helps — "Check status now" when a re-check can move
// it, or a link to the run workspace when it needs a fresh provision (provisioning lives there).
//
// What this tab does NOT show yet: commits, PRs, per-repo activity, repos created outside the
// pipeline. All of that needs the GitHub App installed on the org (WD-21/WD-22 — an owner action), so
// the GitHub line says exactly that instead of leaving an empty box.
export interface RepoInventoryActions {
  /** `reconcileSiteAction` — re-poll the provisioning service for one site. */
  reconcile: (formData: FormData) => Promise<SiteActionResult>;
}

export type RepoInventoryState =
  | { kind: "ok"; rows: RepoRow[] }
  | { kind: "not_enabled" }
  | { kind: "refused" };

export interface GithubConnectionView { status: ConnectionStatus; account: string | null }

export function RepoInventory({
  state,
  github,
  mayReconcile,
  actions,
  pipelineHref,
}: {
  state: RepoInventoryState;
  /** The viewer's own GitHub connection, if any (Connections tab). */
  github: GithubConnectionView | null;
  mayReconcile: boolean;
  actions: RepoInventoryActions;
  pipelineHref: string;
}) {
  if (state.kind === "not_enabled") {
    return <p className="repo-note">Site &amp; repo provisioning isn&rsquo;t turned on for this company yet, so there are no repositories to list.</p>;
  }
  if (state.kind === "refused") {
    return <p className="repo-note">You don&rsquo;t have access to view this department&rsquo;s repositories (ask an admin if you need it).</p>;
  }

  const { rows } = state;
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
      <div className="repo-inventory__head">
        {summary ? <span className="repo-inventory__summary">{summary}</span> : <span />}
        <GithubLine github={github} />
      </div>

      {rows.length === 0 ? (
        <div className="repo-empty">
          <span className="repo-empty__glyph" aria-hidden="true">⎇</span>
          <span className="repo-empty__title">No repositories yet</span>
          <span className="repo-empty__body">
            A repository is created when a PRD run is provisioned — in the run workspace, under &ldquo;Site &amp; repo&rdquo;. It shows up here with its client, project and status.
          </span>
          <Link href={pipelineHref} className="lux-btn lux-btn--ghost lux-btn--sm">Open the pipeline →</Link>
        </div>
      ) : (
        <ul className="repo-list">
          {rows.map((r) => (
            <RepoRowItem key={r.id} row={r} mayReconcile={mayReconcile} onReconcile={actions.reconcile} />
          ))}
        </ul>
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

function RepoRowItem({ row, mayReconcile, onReconcile }: {
  row: RepoRow;
  mayReconcile: boolean;
  onReconcile: (formData: FormData) => Promise<SiteActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SiteActionResult | null>(null);
  const reconcile = () => {
    setResult(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("siteId", row.id);
      fd.set("runId", row.run.id);
      setResult(await onReconcile(fd));
    });
  };
  const lineage = [row.clientName, row.projectName].filter(Boolean).join(" · ");

  return (
    <li className={`repo-row${row.status === "failed" ? " repo-row--failed" : ""}`}>
      <div className="repo-row__main">
        <div className="repo-row__head">
          {row.repoUrl ? (
            <a className="repo-row__name" href={row.repoUrl} target="_blank" rel="noreferrer">{row.name}</a>
          ) : (
            <span className="repo-row__name">{row.name}</span>
          )}
          <StatusBadge label={STATUS_LABEL[row.status]} />
          <span className="repo-row__framework">{row.frameworkLabel}</span>
        </div>
        <div className="repo-row__lineage">
          {lineage && <span>{lineage}</span>}
          <Link href={`/pipeline/${row.run.id}`} className="repo-row__run">from run: {row.run.title} →</Link>
        </div>
        <div className="repo-row__where">
          <span>Repo: {row.repoUrl ? <a href={row.repoUrl} target="_blank" rel="noreferrer">{stripScheme(row.repoUrl)}</a> : <em>not available yet</em>}</span>
          <span>Staging: {row.stagingUrl ? <a href={row.stagingUrl} target="_blank" rel="noreferrer">{stripScheme(row.stagingUrl)}</a> : <em>not available yet</em>}</span>
        </div>
        <p className="repo-row__meta">
          Requested {formatDate(row.requestedAt)}{row.lastCheckedAt ? ` · last checked ${formatDate(row.lastCheckedAt)}` : " · not checked yet"}
        </p>
        {row.failure && (
          <div className="repo-row__failure">
            <strong>{row.failure.title}.</strong> {row.failure.body}
          </div>
        )}
        {(row.failure || row.status !== "live") && (
          <div className="repo-row__actions">
            {mayReconcile && row.canReconcile && (
              <button type="button" className="btn" onClick={reconcile} disabled={pending}>{pending ? "Checking…" : "Check status now"}</button>
            )}
            {row.failure?.remedy === "reprovision" && (
              <Link href={`/pipeline/${row.run.id}`} className="btn">Start a new provision →</Link>
            )}
            {result && !result.ok && <span className="repo-note repo-note--error">{result.error}</span>}
            {result?.ok && <span className="repo-note">Checked — status is now {STATUS_LABEL[result.site.status] ?? result.site.status}. Reload to see it in place.</span>}
          </div>
        )}
      </div>
    </li>
  );
}

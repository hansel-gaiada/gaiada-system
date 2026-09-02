import { formatTimestamp } from "@/lib/format";
import {
  appRoleLabel, appStatusLabel, appTone,
  freshnessTone, syncFreshness, FRESHNESS_LABEL,
  type GithubOrgStatus, type Tone,
} from "@/lib/githubOrgStatus";
import type { GetGithubOrgStatusResult } from "@/lib/githubOrgStatus-data";
import "./github.css";

// GHT-2/GHT-3 — the org App's OWN health chip, split out of the old combined "GitHub connection"
// badge (ruling §5). This answers "is the org's App installed and healthy", which is a DIFFERENT
// question than `RepoInventory.tsx`'s `GithubLine` ("do I personally have a GitHub link") — that
// component's `owner:"me"` read stays exactly as it is (its emptiness for almost everyone is
// CORRECT, per the ruling), and this one must never be collapsed into it or vice versa.
//
// ── EVERY STATE RENDERS AS ITSELF (the ticket's crux, applied to this widget too) ────────────────
// This is supplementary information next to the registry, not the registry itself, so a failure
// here must not blank out or hide the section — but it also must not go silent and let a stale
// "everything's fine" impression stand. `refused` / `no_org` / `unavailable` each get their own
// short, honest line, matching the vocabulary `githubRepos-data.ts`'s three-state result already
// established (see that file for why these three, and not a bare boolean).
export function GithubOrgHealth({ result }: { result: GetGithubOrgStatusResult }) {
  if (!result.ok) {
    return (
      <div className="ghr-apphealth ghr-apphealth--note" role="note">
        <span className="ghr-apphealth__label">GitHub App health:</span>{" "}
        <span className="ghr-apphealth__note">{appHealthFailureCopy(result.reason)}</span>
      </div>
    );
  }
  return <GithubOrgHealthOk status={result.data} />;
}

function appHealthFailureCopy(reason: "refused" | "no_org" | "unavailable"): string {
  switch (reason) {
    case "refused":
      // Deliberately unlikely in practice — org-status authorizes the SAME `github_repo read` at
      // the SAME resolved org tenant as the list read that must have already succeeded for this
      // component to be on screen at all. Shown anyway, honestly, rather than assumed impossible.
      return "You're not authorized to view this (unexpected alongside a visible registry — worth reporting).";
    case "no_org":
      return "No GitHub org is registered for this company's group — a configuration gap, not an outage.";
    case "unavailable":
      return "Not reachable right now.";
  }
}

function GithubOrgHealthOk({ status }: { status: GithubOrgStatus }) {
  const freshness = syncFreshness(status.sync.lastRepoSyncAt, Date.now());
  return (
    <div className="ghr-apphealth">
      <span className="ghr-apphealth__label">GitHub App health:</span>
      <div className="ghr-apphealth__apps">
        {status.apps.map((app) => (
          <span key={app.role} className="ghr-apphealth__app">
            <Tag label={`${appRoleLabel(app.role)}: ${appStatusLabel(app)}`} tone={appTone(app)} />
            {app.externalAccount && <span className="ghr-apphealth__account">{app.externalAccount}</span>}
          </span>
        ))}
      </div>
      {/* Last-known, never live — see githubOrgStatus.ts's own header comment. Every phrase here says
          "last known" / "as of", on purpose, mirroring the registry's own per-row "Synced" badges
          (GithubRepoRegistry.tsx) rather than inventing a second freshness vocabulary. */}
      <span className="ghr-apphealth__sync">
        <Tag label={`Repo sync: ${FRESHNESS_LABEL[freshness]}`} tone={freshnessTone(freshness)} />
        <span className="ghr-apphealth__asof">
          {status.sync.lastRepoSyncAt
            ? `Last known sync ${formatTimestamp(status.sync.lastRepoSyncAt)}`
            : "No sync on file yet"}
          {" — this status itself was read "}
          {formatTimestamp(status.sync.asOf)}
          {", not checked live just now"}
        </span>
        {status.sync.lastWebhookErrorClass && (
          <span className="ghr-apphealth__webhookerror">
            Last webhook delivery failed: {status.sync.lastWebhookErrorClass}
          </span>
        )}
      </span>
    </div>
  );
}

// Same minimal dot+label tag `GithubRepoRegistry.tsx` uses for its own tone badges — kept as a
// small local copy rather than an import so this component has no runtime dependency on that
// file's internals (both ride the same `ghr-tag`/`ghr-tag__dot` classes in github.css).
function Tag({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className="ghr-tag" style={{ color: `var(--status-${tone}-fg)` }}>
      <span className="ghr-tag__dot" style={{ background: `var(--status-${tone})` }} />
      {label}
    </span>
  );
}

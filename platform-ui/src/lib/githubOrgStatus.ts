// GHT-2/GHT-3 — client-safe types + pure, zero-I/O helpers for `GET /api/:t/github/org-status`
// (docs/blueprints/github-tenant-scope-ruling.md §3/§9). Same module-trio split as githubRepos.ts:
// this file holds ONLY types and pure functions; `githubOrgStatus-data.ts` is the server-only
// reader.
//
// ── WHY THIS EXISTS, AS DISTINCT FROM `githubRepos.ts` ──────────────────────────────────────────
// This is the GitHub ORG APP's health — a different fact than the viewer's OWN `owner:"me"` link
// (`RepoInventory.tsx`'s `GithubLine`). Conflating the two into one chip was exactly the framing bug
// the ruling's §5 closes: `web@gaiada.com` is the deliberate single shared ERP-to-GitHub identity,
// so almost every staff member's personal link is correctly empty — and that says NOTHING about
// whether the org's App is installed and healthy. `GithubOrgHealth.tsx` renders THIS shape;
// `RepoInventory.tsx` keeps rendering the personal one. Neither component may answer the other's
// question — see that file's own header comment.
//
// ── `sync` IS LAST-KNOWN, NEVER LIVE ─────────────────────────────────────────────────────────────
// The backend's own header (`github-org-status.ts`) is explicit: this endpoint does not call GitHub.
// `sync.asOf` is when the ROW WAS READ, not when a live check ran. Every label this file's helpers
// produce says "as of <time>" / "last known", never "checked just now" or "live" — see
// `syncAsOfLabel` below, which exists specifically so no call site has to phrase this from scratch
// (and get it wrong) each time.
import type { GithubOrgMeta } from "./githubRepos";
import { freshnessTone, syncFreshness, FRESHNESS_LABEL, type Tone } from "./githubRepos";

export type GithubAppRole = "erp" | "agents";

export interface GithubAppStatus {
  role: GithubAppRole;
  /** Human-readable bot identity ("gaiada-erp[bot]"), never the numeric app_id/installation_id. */
  slug: string;
  readOnly: boolean;
  /** Whether a credential row has ever been sealed for this role at all. */
  configured: boolean;
  externalAccount: string | null;
  /** `integration_connections.status` — unconfigured|pending|linked|error|revoked. */
  status: string;
  hasToken: boolean;
  tokenExpiresAt: string | null;
}

export interface GithubSyncFacts {
  /** When THIS response was assembled — not a live GitHub probe. */
  asOf: string;
  lastRepoSyncAt: string | null;
  lastWebhookReceivedAt: string | null;
  /** Only set when the most recent webhook delivery FAILED; a short class, never the raw error text. */
  lastWebhookErrorClass: string | null;
}

export interface GithubOrgStatus {
  org: GithubOrgMeta;
  apps: GithubAppStatus[];
  sync: GithubSyncFacts;
}

const APP_ROLE_LABEL: Record<GithubAppRole, string> = {
  erp: "ERP App",
  agents: "Agents App",
};

export function appRoleLabel(role: GithubAppRole): string {
  return APP_ROLE_LABEL[role] ?? role;
}

/** A coarse ok/attention read for a status dot. `status === "linked"` is the only healthy value;
 *  every other known value (`pending|error|revoked`) AND any future value this UI has never seen
 *  both read as "needs attention" — matched by exclusion, not by an exhaustive literal list, so an
 *  unrecognized future status degrades honestly instead of silently rendering as fine. A row that
 *  has never had a credential sealed (`configured: false`) is `idle`, not `critical` — "never set
 *  up" and "set up but broken" are different findings and must not share one alarming color. */
export function appTone(app: Pick<GithubAppStatus, "configured" | "status">): Tone {
  if (!app.configured) return "idle";
  return app.status === "linked" ? "ok" : "critical";
}

export function appStatusLabel(app: Pick<GithubAppStatus, "configured" | "status">): string {
  if (!app.configured) return "Not configured";
  switch (app.status) {
    case "linked":
      return "Linked";
    case "pending":
      return "Pending";
    case "error":
      return "Error";
    case "revoked":
      return "Revoked";
    default:
      return app.status;
  }
}

// Re-exported rather than duplicated: `lastRepoSyncAt` ages on the exact same crawl/reconcile
// cadence as a repo row's own `lastSyncedAt` (githubRepos.ts), so the org-health widget's freshness
// badge must use the identical fresh/stale/dark thresholds — a second copy of these constants would
// drift the day one file's threshold changes and not the other's.
export { freshnessTone, syncFreshness, FRESHNESS_LABEL };
export type { Tone };

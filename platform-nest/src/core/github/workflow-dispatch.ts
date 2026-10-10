// WSK-60 (docs/plans/2026-10-10-webdesk-write-plane-design.md §9) — the ONE place a human-approved
// `workflow_dispatch` is sent. Before this file the chokepoint knew only repo creation (GH-12), so
// the `deploy` action in `resource_github_repo.yaml` (D14-gated, approvalId required) had a rule and
// no caller. This is that caller.
//
//   POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches   { ref, inputs }  → 204
//
// ── WHAT AUTHORISES IT ───────────────────────────────────────────────────────────────────────────
// The APPROVAL id (WSK-D46 / R3: one human decision covers the publish and the rebuild). The decider
// is authorised against `github_repo · deploy` with `approvalId` set; that rule admits only a
// non-empty approvalId (resource_github_repo.yaml), so no approval, no dispatch, for every principal
// except platform_admin's wildcard. The resource's tenant is the GitHub ORG tenant, not the caller's
// company: `resolveGithubOrgTenant` is the GHT-1 substitution (every github_repo row, and the App
// credential, are stamped to the one operating company that owns the org), and authorising against
// the URL tenant instead is the cross-root leak that ruling exists to prevent.
//
// ── WHAT IT RECORDS ──────────────────────────────────────────────────────────────────────────────
// `withGithubLedger` writes the attempt BEFORE the call and the outcome after (two rows, the GH-04
// shape), now carrying `metadata.approvalId`. The ledger's correlation id is returned so the caller
// can store it next to its own record.
//
// ── NO EGRESS HERE ───────────────────────────────────────────────────────────────────────────────
// Every request goes through `githubRequest()`. This file holds no `fetch`, so
// egress-inventory.test.ts still pins http-client.ts as the single outbound file.
//
// ── FAIL CLOSED AND NAMED ────────────────────────────────────────────────────────────────────────
// A refusal is never swallowed and never reworded as success. Each way a dispatch can fail maps to ONE
// typed reason (below). The reason the owner must see first is `github_app_not_installed`: the
// `gaiada-erp` App is installed on the org's repositories one by one, and a repo it cannot see answers
// 404 to the dispatch AND to a plain `GET /repos/{repo}`. A 404 on the dispatch alone is ambiguous (the
// repo is visible but the workflow file or ref is missing), so a 404 is resolved by that second read.
import { ForbiddenException } from "@nestjs/common";
import { authorize } from "../http";
import { resolveGithubOrgTenant } from "../github-org-tenant";
import type { Principal } from "../../rbac/principal";
import { githubRequest } from "./github-app.service";
import {
  GithubApiError,
  GithubNotConfiguredError,
  GithubRateLimitedError,
  GithubTokenExchangeError,
} from "./errors";
import { withGithubLedger } from "./ledger";

/** Every typed reason a dispatch can fail with. Stored as `webdev_site_builds.failure_reason`. */
export const WORKFLOW_DISPATCH_FAILURES = [
  /** No App credential is configured or sealed for the `erp` role in this deployment. */
  "github_not_configured",
  /** The App cannot see the repo: not installed on it, uninstalled, or the installation is suspended. */
  "github_app_not_installed",
  /** The App is installed but its token lacks the permission (`actions: write`). */
  "github_app_permission_missing",
  /** The repo is visible, but the workflow file or ref does not exist there. */
  "workflow_not_found",
  /** The workflow exists but cannot be dispatched (no `workflow_dispatch` trigger, or unknown inputs). */
  "workflow_not_dispatchable",
  /** Cerbos refused `github_repo · deploy` for the decider. Nothing was sent. */
  "deploy_denied",
  /** The GitHub org's tenant could not be resolved for this company (misconfigured or a foreign root). */
  "github_org_unavailable",
  "github_rate_limited",
  /** Anything else GitHub or the network did to the call; the ledger row holds the detail. */
  "github_dispatch_failed",
] as const;
export type WorkflowDispatchFailure = (typeof WORKFLOW_DISPATCH_FAILURES)[number];

export class WorkflowDispatchError extends Error {
  constructor(
    readonly reason: WorkflowDispatchFailure,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowDispatchError";
  }
}

export interface WorkflowDispatchInput {
  /** The human who decided the approval; authorised against `github_repo · deploy`. */
  decider: Principal;
  /** The company the approval was filed under. The ORG tenant is resolved from it, never assumed. */
  requestTenantId: string;
  /** The approval that authorises this dispatch. Required, non-empty. */
  approvalId: string;
  /** `owner/name`. */
  repo: string;
  /** The workflow file name, e.g. `webdesk-rebuild.yml`. */
  workflow: string;
  ref: string;
  /** Workflow inputs. GitHub requires strings. */
  inputs: Record<string, string>;
}

export interface WorkflowDispatchResult {
  /** The attempt's activities row id (GH-04's correlation id). */
  correlationId: string;
  /** The tenant the ledger rows and the App credential live under. */
  orgTenantId: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_RE = /^[A-Za-z0-9_.-]{1,100}\.ya?ml$/;

/** Resolve the org tenant and run the D14 `deploy` rule for the decider. Exported so a caller can do
 *  the check at the approval's PREFLIGHT (before the decide UPDATE) with the identical logic. */
export async function authorizeDeploy(
  decider: Principal,
  requestTenantId: string,
  approvalId: string,
): Promise<string> {
  const org = await resolveGithubOrgTenant(requestTenantId);
  if (!org.ok) {
    throw new WorkflowDispatchError(
      "github_org_unavailable",
      org.reason === "unconfigured"
        ? "the GitHub org tenant is not configured (GITHUB_REPO_SYNC_TENANT_ID)"
        : "this company has no GitHub org registered for its root",
    );
  }
  try {
    await authorize(decider, { kind: "github_repo", tenantId: org.tenantId, module: "webdev", approvalId }, "deploy");
  } catch (err) {
    if (err instanceof ForbiddenException) {
      throw new WorkflowDispatchError("deploy_denied", `github_repo deploy was refused for the decider: ${err.message}`);
    }
    throw err;
  }
  return org.tenantId;
}

function statusOf(err: unknown): number | null {
  const d = (err as { detail?: { httpStatus?: unknown } })?.detail;
  return typeof d?.httpStatus === "number" ? d.httpStatus : null;
}

/** Turn what the call threw into ONE typed reason. `repoVisible` resolves the ambiguous 404. */
async function classify(
  err: unknown,
  orgTenantId: string,
  actorId: string,
  repo: string,
): Promise<WorkflowDispatchError> {
  if (err instanceof WorkflowDispatchError) return err;
  if (err instanceof GithubNotConfiguredError) {
    return new WorkflowDispatchError("github_not_configured", err.message);
  }
  if (err instanceof GithubTokenExchangeError) {
    // 401 = our App credential is wrong; 404 or 403 = the installation is gone or suspended.
    const s = statusOf(err);
    return s === 404 || s === 403
      ? new WorkflowDispatchError("github_app_not_installed", `the GitHub App installation was refused (HTTP ${s})`)
      : new WorkflowDispatchError("github_not_configured", `GitHub refused the App credential (HTTP ${s ?? "?"})`);
  }
  if (err instanceof GithubRateLimitedError) {
    return new WorkflowDispatchError("github_rate_limited", err.message);
  }
  if (err instanceof GithubApiError) {
    const s = statusOf(err);
    if (s === 404) {
      const [owner, name] = repo.split("/");
      try {
        await githubRequest(orgTenantId, "erp", actorId, {
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        });
      } catch (probe) {
        if (probe instanceof GithubApiError && statusOf(probe) === 404) {
          return new WorkflowDispatchError(
            "github_app_not_installed",
            `the GitHub App cannot see ${repo}: install it on that repository`,
          );
        }
        return new WorkflowDispatchError("github_dispatch_failed", "the dispatch was refused with 404 and the repo could not be read to tell why");
      }
      return new WorkflowDispatchError("workflow_not_found", `${repo} is visible but the workflow file or ref was not found`);
    }
    if (s === 403) return new WorkflowDispatchError("github_app_permission_missing", err.message);
    if (s === 422) return new WorkflowDispatchError("workflow_not_dispatchable", err.message);
    return new WorkflowDispatchError("github_dispatch_failed", err.message);
  }
  return new WorkflowDispatchError("github_dispatch_failed", err instanceof Error ? err.message : "dispatch failed");
}

/**
 * Send ONE `workflow_dispatch`, authorised by `approvalId`. Throws `WorkflowDispatchError` (typed,
 * never a raw GitHub error) on every failure; resolves only when GitHub answered 2xx.
 *
 * Not idempotent by itself: GitHub has no idempotency key for a dispatch, and a second call is a
 * second run. The caller owns "at most once per approval" (the `webdev_site_builds` unique key).
 */
export async function dispatchApprovedWorkflow(input: WorkflowDispatchInput): Promise<WorkflowDispatchResult> {
  if (!input.approvalId) throw new WorkflowDispatchError("deploy_denied", "a workflow dispatch needs an approval id");
  if (!REPO_RE.test(input.repo)) throw new WorkflowDispatchError("github_dispatch_failed", "repo must be owner/name");
  if (!WORKFLOW_RE.test(input.workflow)) throw new WorkflowDispatchError("github_dispatch_failed", "workflow must be a .yml/.yaml file name");
  if (!input.ref) throw new WorkflowDispatchError("github_dispatch_failed", "ref is required");
  const actorId = input.decider.userId;
  if (!actorId) throw new WorkflowDispatchError("deploy_denied", "an authenticated decider is required");

  const orgTenantId = await authorizeDeploy(input.decider, input.requestTenantId, input.approvalId);
  const [owner, name] = input.repo.split("/");

  try {
    const outcome = await withGithubLedger(
      { tenantId: orgTenantId, actorId, repo: input.repo, ref: input.ref, action: "deploy", approvalId: input.approvalId },
      async () => {
        const res = await githubRequest<unknown>(orgTenantId, "erp", actorId, {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
          body: { ref: input.ref, inputs: input.inputs },
        });
        return { data: res.status };
      },
    );
    return { correlationId: outcome.correlationId, orgTenantId };
  } catch (err) {
    throw await classify(err, orgTenantId, actorId, input.repo);
  }
}

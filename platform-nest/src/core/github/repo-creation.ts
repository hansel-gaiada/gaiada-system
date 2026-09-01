// GH-12 (docs/blueprints/github-integration-foundation.md §0.2, §4.2, §7 GH-12) — the ONE place a
// D14-approved GitHub repo-creation request turns into a real `POST /orgs/{org}/repos` (or the
// template-generate twin) call. Design precedent: `admin/iam-approval-execute.ts` ("the ONE place
// an approved IAM request turns into a write").
//
// ── WHY IN-BAND, NOT THROUGH THE D14 EXECUTABLE REGISTRY (`core/approval-executables.ts`) ─────────
// Every entry in that registry re-drives the approved write THROUGH mcp-hub
// (`core/approval-execute.ts#attemptRedrive` -> `callHubTool`), and Cerbos only lets that re-drive
// land when the tool is ALSO on `resource_mcp_tool.yaml`'s executable-tool list (the WSK-31/PRV-03
// "pairing doctrine" that file's own header documents). Two things make that path structurally
// unusable for repo creation, not just inconvenient:
//   1. GH-12's brief forbids touching ANY cerbos policy file, `resource_mcp_tool.yaml` included.
//   2. mcp-hub holds ONLY the read-only `gaiada-agents` App (§2.2/§4.1 — "No other service mints or
//      holds an installation token"). It must never be the thing that asks GitHub to create a repo,
//      even as a forwarder — §0.2/§4.1's whole point is that the agent-facing, prompt-injectable
//      surface must not carry the write arm.
// So this executes exactly like P2-08 part B's IAM overrides: synchronously, inside
// `automation-approvals.controller.ts`'s decide() request, on a fresh `origin='github'` (migration
// 202609010900) that `isIamRequest()` deliberately does NOT recognise — see that migration's own
// header for why the two are kept apart despite sharing a mechanism.
//
// ── THE REAL GATE IS resource_github_repo.yaml's OWN `create_repo` RULE, UNCHANGED ────────────────
// That policy already requires a non-empty, verified `resource.attr.approvalId` AND a company_admin
// (or platform_admin) derived role for `create_repo` — built and tested (GH-03,
// `rbac/cerbos-github.test.ts`) before this ticket existed. This file's only authorization job is to
// call `authorize()` against it, with THIS approval row's own id as `approvalId` — never to widen or
// duplicate that policy. `decide()`'s own `authorize(..., "decide")` call (unchanged, generic,
// already company_admin-only for this kind) is a SEPARATE, looser gate ("may you decide an
// automation_approval at all"); this file's `create_repo` check is the narrower, authoritative one
// that actually matches the blueprint's tier ("company_admin-only, irreversible org-structure
// change").
//
// ── TEMPLATE-GENERATE VS BARE REPO (§7 GH-12: "creating from a GitHub template repo... a bare repo
// must remain possible") ───────────────────────────────────────────────────────────────────────────
// `templateOwner`+`templateRepo` together select `POST /repos/{owner}/{repo}/generate` (GitHub's
// "create a repository using a template" endpoint — the estate's chosen provisioning shape per the
// ticket: the template holds the real folder structure/history, the ERP calls one API). Omitting
// both keeps the plain `POST /orgs/{org}/repos` path. No specific template name is assumed anywhere
// in this file — the ticket explicitly warns not to (measured org state changes over time); it is
// caller-supplied on every request.
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { config } from "../../config";
import { authorize } from "../http";
import { githubRequest } from "./github-app.service";
import { withGithubLedger } from "./ledger";
import type { Principal } from "../../rbac/principal";

/** `automation_approvals.workflow_id` for this request kind — mirrors `IAM_OVERRIDE_WORKFLOW`'s own
 *  naming convention (`iam-approval-execute.ts`). Exported so the filing endpoint
 *  (`github-repos.controller.ts`) and this module agree on one literal. */
export const GITHUB_CREATE_REPO_WORKFLOW = "github:create_repo";

/** Mirrors `isIamRequest()`'s shape exactly: origin AND workflow_id must both match, so a
 *  differently-shaped 'github'-origin row (there is only this one kind today, but the check costs
 *  nothing and keeps the door open) never silently reaches the executor. */
export function isGithubRepoCreationRequest(origin: string, workflowId: string | null): boolean {
  return origin === "github" && workflowId === GITHUB_CREATE_REPO_WORKFLOW;
}

/** GitHub's own repo-name charset (org repos: letters, digits, `.`, `-`, `_`, 1-100 chars). Checked
 *  here so a malformed name fails with a clean 400 naming the caller's mistake BEFORE any egress,
 *  rather than a raw GitHub 422 the caller has to decode. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface GithubCreateRepoArgs {
  name: string;
  private: boolean;
  description?: string;
  /** Both-or-neither with `templateRepo`. */
  templateOwner?: string;
  templateRepo?: string;
}

export type ParsedCreateRepoArgs =
  | { ok: true; args: GithubCreateRepoArgs }
  | { ok: false; error: string };

/** Shared validation for BOTH the filing endpoint (fail fast, before an approval row is even
 *  created) and the executor (re-validated at execution time — `toolArgs` is caller-controlled JSON
 *  read back out of the DB, never trusted as already-clean). */
export function parseCreateRepoArgs(raw: Record<string, unknown>): ParsedCreateRepoArgs {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || !REPO_NAME_RE.test(name)) {
    return { ok: false, error: "name is required and must match GitHub's repo-name charset (letters, digits, '.', '-', '_', max 100 chars)" };
  }
  const templateOwner = typeof raw.templateOwner === "string" ? raw.templateOwner.trim() : "";
  const templateRepo = typeof raw.templateRepo === "string" ? raw.templateRepo.trim() : "";
  if (Boolean(templateOwner) !== Boolean(templateRepo)) {
    return { ok: false, error: "templateOwner and templateRepo must both be set, or both omitted" };
  }
  const description = typeof raw.description === "string" ? raw.description.slice(0, 350) : undefined;
  // Default PRIVATE — §1's identity collapse means anything this bot creates is org-internal by
  // default; a caller must explicitly opt IN to public, never the reverse.
  const isPrivate = raw.private === false ? false : true;
  return {
    ok: true,
    args: {
      name,
      private: isPrivate,
      ...(description ? { description } : {}),
      ...(templateOwner ? { templateOwner, templateRepo } : {}),
    },
  };
}

export interface GithubRepoCreationResult {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  /** The ledger's own correlation id (§4.3/§4.4) — the same id a future GH-10 commit trailer would
   *  carry as `Gaiada-Activity:`. Handed back so the decide() response and the activity-log row this
   *  ticket writes both point at the same evidence. */
  correlationId: string;
}

interface RawGithubCreatedRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
}

/**
 * Execute an APPROVED github repo-creation request. Called only from
 * `automation-approvals.controller.ts#decide()`, after that handler has already flipped the row to
 * `approved` under the generic `decide` action (company_admin, unchanged Cerbos policy) — mirroring
 * `executeApprovedIamRequest`'s own contract note: this function does not re-check WHO may decide,
 * it enforces WHAT may be written, via the resource's OWN `create_repo` rule.
 *
 * `decider` is the acting principal (the human who clicked Approve) — authority for the ACTUAL
 * GitHub call is checked against THEM, not the original requester, exactly like `executeApprovedIamRequest`.
 */
export async function executeApprovedGithubRepoCreation(
  tenantId: string,
  approvalId: string,
  toolArgs: unknown,
  decider: Principal,
): Promise<GithubRepoCreationResult> {
  const parsed = parseCreateRepoArgs((toolArgs ?? {}) as Record<string, unknown>);
  if (!parsed.ok) {
    // The row is already `approved` by the time we get here — a malformed payload must not be
    // swallowed into a silent no-op (same reasoning `executeApprovedIamRequest` states for its own
    // malformed-payload throws).
    throw new BadRequestException(`github repo-creation payload is malformed: ${parsed.error}`);
  }
  const { name, private: isPrivate, description, templateOwner, templateRepo } = parsed.args;

  const org = config.githubOrg;
  if (!org) throw new ServiceUnavailableException("GITHUB_ORG is not configured");

  // `decide()` (the only caller) already requires `req.principal.userId` to be truthy for every
  // other branch of that handler — re-asserted here, as a local `const`, so TypeScript's narrowing
  // survives into the closure below (a property access on `decider` does not narrow across a
  // function boundary the way a local binding does).
  if (!decider.userId) throw new BadRequestException("an authenticated decider is required");
  const actorId: string = decider.userId;

  // THE D14 GATE ITSELF — resource_github_repo.yaml's own `create_repo` rule, unmodified. This is
  // the narrow, company_admin-only, approvalId-required check the blueprint actually specifies; the
  // `decide` action already checked in decide() is a different, looser question ("may you decide
  // ANY automation_approval"). Denial here throws ForbiddenException (authorize()'s own contract)
  // and the repo is never touched.
  await authorize(decider, { kind: "github_repo", tenantId, approvalId }, "create_repo");

  const usesTemplate = Boolean(templateOwner && templateRepo);
  const path = usesTemplate
    ? `/repos/${encodeURIComponent(templateOwner!)}/${encodeURIComponent(templateRepo!)}/generate`
    : `/orgs/${encodeURIComponent(org)}/repos`;
  const body = usesTemplate
    ? { owner: org, name, private: isPrivate, description, include_all_branches: false }
    : { name, private: isPrivate, description, auto_init: true }; // auto_init: a bare repo must not be born empty/unclonable

  const outcome = await withGithubLedger(
    {
      tenantId,
      actorId,
      repo: `${org}/${name}`,
      action: "create_repo",
    },
    async () => {
      const res = await githubRequest<RawGithubCreatedRepo>(tenantId, "erp", actorId, {
        method: "POST",
        path,
        body,
      });
      return { data: res.data };
    },
  );

  return {
    fullName: outcome.data.full_name,
    htmlUrl: outcome.data.html_url,
    defaultBranch: outcome.data.default_branch,
    correlationId: outcome.correlationId,
  };
}

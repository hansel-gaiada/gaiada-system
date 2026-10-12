// The repo GH-12 created for a provisioned row (M6-P4b2's resolution, shared with M6-P4g's deploy grant). Its own file so
// the scaffold commit and the deploy grant can both use it without importing each other.
//
// Three facts must agree, or there is no repo: the row's `provider_ref` is an APPROVED `github:create_repo` approval
// (origin 'github'), the repo is `config.githubOrg` / that approval's `tool_args.name`, and the row's `repo_url` names
// exactly that repo (case-insensitive, GitHub's rule).
import { withTenants } from "../../db";
import { config } from "../../config";
import type { RepoRef } from "../../core/github/git-data";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { repoUrlNames } from "./scaffold-commit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The repo GH-12 created for this row, or null when any of the three facts disagree. Also the deploy grant's (M6-P4g). */
export async function resolveProvisionedRepo(
  tenantId: string,
  row: { providerRef: string | null; repoUrl: string | null },
): Promise<RepoRef | null> {
  const org = config.githubOrg;
  if (!org || !row.providerRef || !row.repoUrl || !UUID_RE.test(row.providerRef)) return null;
  const r = await withTenants([tenantId], (c) =>
    c.query<{ status: string; tool_args: { name?: unknown } | null }>(
      `SELECT status, tool_args FROM automation_approvals
        WHERE id = $1 AND origin = 'github' AND workflow_id = $2 AND deleted_at IS NULL`,
      [row.providerRef, GITHUB_CREATE_REPO_WORKFLOW],
    ),
  );
  const a = r.rows[0];
  if (!a || a.status !== "approved") return null;
  const name = typeof a.tool_args?.name === "string" ? a.tool_args.name : "";
  if (!name || !repoUrlNames(row.repoUrl, org, name)) return null;
  return { owner: org, name };
}

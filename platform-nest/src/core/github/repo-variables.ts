// M5-P4 (WSK-D92, docs/blueprints/webdesk-design-v2.md section 14) — the GitHub calls the "Tracking tags" feature needs: read, create,
// update and delete a repository Actions VARIABLE. The variables today are `PUBLIC_LINKEDIN_PARTNER_ID`, which the gaiada.com
// rebuild workflow reads as `${{ vars.PUBLIC_LINKEDIN_PARTNER_ID }}` and bakes into the LinkedIn Insight tag, and (M5-P4g) the two Google
// Ads variables `PUBLIC_GOOGLE_ADS_IDS` and `PUBLIC_GOOGLE_ADS_CONVERSIONS`, read the same way. Staff set them from the ERP; they reach
// the site on its NEXT rebuild.
//
//   GET    /repos/{o}/{r}/actions/variables/{name}    -> {name, value, updated_at} | 404 (unset)
//   POST   /repos/{o}/{r}/actions/variables           {name, value} -> 201 (create); 409 when the name already exists
//   PATCH  /repos/{o}/{r}/actions/variables/{name}    {name, value} -> 204 (update); 404 when absent
//   DELETE /repos/{o}/{r}/actions/variables/{name}    -> 204; 404 when already absent
//
// ── A VARIABLE IS NOT A SECRET, AND THE NAME IS AN ALLOW-LIST ─────────────────────────────────────
// A repository variable is plain text GitHub returns on a read, so unlike org-secrets.ts this file reads values back. What it must never
// do is let a request choose WHICH variable: every call below refuses a name that is not in `ALLOWED_REPO_VARIABLES` (a constant here, not
// a parameter any route passes through), so the feature can touch exactly the variables it exists for and no other repo setting.
//
// ── NO EGRESS HERE, NO CREDENTIAL HERE ────────────────────────────────────────────────────────────
// Every request goes through a `GitCaller` (git-data.ts): production binds it to `githubRequest(orgTenant, "erp", actor, ...)`, tests to
// the in-memory fake (git-data.testkit.ts). This file holds no network call, so egress-inventory.test.ts still pins http-client.ts.
//
// ── WHAT IS AN ANSWER AND WHAT IS AN ERROR ────────────────────────────────────────────────────────
// A variable that is not set (GET 404) and a delete of one already gone (DELETE 404) are ANSWERS, returned as data. A 404 on a GET
// cannot say WHY (unset, or a repository the App cannot see), so the caller that must not report "not set" for an invisible repo
// confirms the repo is visible (`getRepoInfo`, org-secrets.ts) before it trusts a null. Everything else is thrown as a typed
// `RepoVariableError`: a 403 is `github_permission_missing` naming the permission `actions_variables` (the App needs Repository
// permissions > Variables: read and write), the rest are `github_request_failed`. A write that did not land is never read as one that did.
import { GithubApiError } from "./errors";
import type { GitCaller, RepoRef } from "./git-data";
import { githubStatusOf } from "./git-data";

/** The ONLY variable names the ERP may read or write through this file. */
export const LINKEDIN_PARTNER_ID_VARIABLE = "PUBLIC_LINKEDIN_PARTNER_ID";
/** M5-P4g: comma-separated Google Ads tag ids (`AW-123456789,AW-987654321`). */
export const GOOGLE_ADS_IDS_VARIABLE = "PUBLIC_GOOGLE_ADS_IDS";
/** M5-P4g: comma-separated conversions (`lead=AW-123456789/abcDEF,whatsapp=AW-123456789/xyz`). */
export const GOOGLE_ADS_CONVERSIONS_VARIABLE = "PUBLIC_GOOGLE_ADS_CONVERSIONS";
export const ALLOWED_REPO_VARIABLES: readonly string[] = [LINKEDIN_PARTNER_ID_VARIABLE, GOOGLE_ADS_IDS_VARIABLE, GOOGLE_ADS_CONVERSIONS_VARIABLE];

/** The permission the ERP GitHub App needs for these calls, as a 403 names it. */
export const REPO_VARIABLES_PERMISSION = "actions_variables";

export type RepoVariableErrorReason = "variable_not_allowed" | "github_permission_missing" | "github_request_failed";

export class RepoVariableError extends Error {
  constructor(
    readonly reason: RepoVariableErrorReason,
    message: string,
    /** Set for `github_permission_missing`: the App permission that is missing. */
    readonly permission?: typeof REPO_VARIABLES_PERMISSION,
  ) {
    super(message);
    this.name = "RepoVariableError";
  }
}

export interface RepoVariable {
  name: string;
  value: string;
  updatedAt: string | null;
}

function variablesBase(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/actions/variables`;
}

function requireAllowed(name: string): string {
  if (!ALLOWED_REPO_VARIABLES.includes(name)) throw new RepoVariableError("variable_not_allowed", `the ERP may not read or write the repository variable ${JSON.stringify(name)}`);
  return name;
}

function variablePath(repo: RepoRef, name: string): string {
  return `${variablesBase(repo)}/${encodeURIComponent(requireAllowed(name))}`;
}

/** Every thrown GitHub failure as one typed error. Anything that is not a GitHub refusal (a programming error) passes through. */
function classify(err: unknown, what: string): unknown {
  if (err instanceof RepoVariableError) return err;
  if (!(err instanceof GithubApiError)) return err;
  const s = githubStatusOf(err);
  if (s === 403) {
    return new RepoVariableError(
      "github_permission_missing",
      "actions_variables: the ERP GitHub App lacks Repository permissions > Variables: read and write on this repository. The org owner must grant it on the App and accept the updated permissions on the installation.",
      REPO_VARIABLES_PERMISSION,
    );
  }
  return new RepoVariableError("github_request_failed", `GitHub refused ${what} (HTTP ${s ?? "?"}): ${err.message}`);
}

/** The variable, or null when it is not set (404). See the header: a null cannot tell "unset" from "repo not visible". */
export async function getRepoVariable(call: GitCaller, repo: RepoRef, name: string): Promise<RepoVariable | null> {
  const path = variablePath(repo, name);
  try {
    const r = await call<{ name?: unknown; value?: unknown; updated_at?: unknown }>({ path });
    const value = r.data?.value;
    if (typeof value !== "string") throw new RepoVariableError("github_request_failed", "GitHub returned a variable with no value");
    return { name, value, updatedAt: typeof r.data?.updated_at === "string" ? r.data.updated_at : null };
  } catch (err) {
    if (githubStatusOf(err) === 404) return null;
    throw classify(err, "reading the repository variable");
  }
}

/** Create the variable. GitHub answers 201; a name that already exists is its 409, thrown (the caller decides to update). */
export async function createRepoVariable(call: GitCaller, repo: RepoRef, name: string, value: string): Promise<void> {
  requireAllowed(name);
  const path = variablesBase(repo);
  try {
    await call<unknown>({ method: "POST", path, body: { name, value } });
  } catch (err) {
    throw classify(err, "creating the repository variable");
  }
}

/** Update the variable. GitHub answers 204. Returns false when it does not exist (404), so the caller can create it instead. */
export async function updateRepoVariable(call: GitCaller, repo: RepoRef, name: string, value: string): Promise<boolean> {
  const path = variablePath(repo, name);
  try {
    await call<unknown>({ method: "PATCH", path, body: { name, value } });
    return true;
  } catch (err) {
    if (githubStatusOf(err) === 404) return false;
    throw classify(err, "updating the repository variable");
  }
}

/** Delete the variable. GitHub answers 204; a variable already gone (404) is "absent", an answer. */
export async function deleteRepoVariable(call: GitCaller, repo: RepoRef, name: string): Promise<"deleted" | "absent"> {
  const path = variablePath(repo, name);
  try {
    await call<unknown>({ method: "DELETE", path });
    return "deleted";
  } catch (err) {
    if (githubStatusOf(err) === 404) return "absent";
    throw classify(err, "deleting the repository variable");
  }
}

/**
 * Set the variable, creating it when absent: PATCH first (the common re-set), POST on 404, and one more PATCH when that POST loses a
 * race to another creator (409). Returns which write landed.
 */
export async function setRepoVariable(call: GitCaller, repo: RepoRef, name: string, value: string): Promise<"created" | "updated"> {
  if (await updateRepoVariable(call, repo, name, value)) return "updated";
  try {
    await createRepoVariable(call, repo, name, value);
    return "created";
  } catch (err) {
    // GitHub's 409 on a create: it exists now. Update it once; anything still wrong is thrown.
    if (err instanceof RepoVariableError && /HTTP 409/.test(err.message)) {
      if (await updateRepoVariable(call, repo, name, value)) return "updated";
    }
    throw err;
  }
}

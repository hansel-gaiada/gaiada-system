// The approvals detail page's reader for a GitHub repo-creation request (GH-12, `origin='github'`, `workflow_id='github:create_repo'`).
// `tool_args` is unknown JSON: the row is filed by the Create-repository click and by webdev.provisionSite, and read back here
// without trust. Mirrors the server's `parseCreateRepoArgs` (platform-nest/src/core/github/repo-creation.ts): a name is required,
// the template is both-or-neither, and `private` defaults to TRUE unless it is explicitly `false`.
export const GITHUB_CREATE_REPO_WORKFLOW = "github:create_repo";

export interface GithubRepoRequestArgs {
  name: string;
  private: boolean;
  description: string | null;
  template: string | null;
}

export function isGithubRepoRequest(origin: string, workflowId: string): boolean {
  return origin === "github" && workflowId === GITHUB_CREATE_REPO_WORKFLOW;
}

export function parseGithubRepoRequestArgs(raw: unknown): GithubRepoRequestArgs | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!name) return null;
  const owner = typeof a.templateOwner === "string" ? a.templateOwner.trim() : "";
  const repo = typeof a.templateRepo === "string" ? a.templateRepo.trim() : "";
  if (Boolean(owner) !== Boolean(repo)) return null;
  const description = typeof a.description === "string" && a.description.trim() ? a.description.trim() : null;
  return { name, private: a.private !== false, description, template: owner ? `${owner}/${repo}` : null };
}

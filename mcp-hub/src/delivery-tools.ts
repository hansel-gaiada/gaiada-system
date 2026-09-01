// WS11 build item 9 — GitHub + staging-deploy tools for the delivery track.
//
// GH-12 CUTOVER (docs/blueprints/github-integration-foundation.md §7 GH-12) — this file used to hold
// its own `GITHUB_TOKEN` and call api.github.com directly for `github.repoStatus`. That violated
// §4.1's single chokepoint ("no other service mints or holds an installation token") and, more to
// the point, meant the agent-facing hub held a live GitHub credential at all. Both GitHub tools now
// go through platform-nest, which is the ONLY thing that ever talks to api.github.com:
//   - `github.repoStatus` forwards (OBO) to platform-nest's `GET /api/:tenantId/github/repos`
//     (GH-08's registry read, already Cerbos + RLS gated there) — same `platformSend`/`oboHeaders`
//     shape as `platform-write-tools.ts`. The hub holds no GitHub credential, read-only or otherwise.
//   - `github.createRepo` STAYS PERMANENTLY REFUSED here. This is not "not configured yet" — it is a
//     structural decision: repo creation is an external, not-trivially-reversible act that must be
//     gated by a company_admin's D14 approval AND executed by platform-nest's `erp` (write) App
//     (`core/github/repo-creation.ts`). mcp-hub is the agent-facing tool surface and agents are
//     prompt-injectable (§2.2); if this tool ever forwarded instead of refusing, a poisoned prompt
//     would be one hub call away from creating a repo. The refusal names the real path
//     (`POST /api/:tenantId/github/repos/creation-requests`, then a company_admin decides it) so a
//     caller — human or agent — knows where the write actually lives.
//
// `deploy.staging`/`deploy.production` are unchanged by this cutover — they dispatch the WS10
// release pipeline's own webhook, never GitHub.
import { config } from "./config";
import { registerTool } from "./registry";
import { gatewayComplete } from "./gateway-client";
import { oboHeaders } from "./obo-headers";
import type { Principal } from "./principal";

interface PlatformGithubRepo {
  fullName: string;
  name: string;
  defaultBranch: string;
}

/** `github.repoStatus`'s own thin platform-front call. Deliberately NOT reusing
 *  `platform-write-tools.ts#platformSend` (a POST/PATCH-only helper) — this is a GET with no body. */
async function fetchRepoStatus(tenantId: string, repo: string, principal: Principal): Promise<PlatformGithubRepo | null> {
  const name = repo.includes("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo;
  const res = await fetch(
    `${config.platformUrl}/api/${encodeURIComponent(tenantId)}/github/repos?search=${encodeURIComponent(name)}&limit=10`,
    { headers: oboHeaders(principal, config.platformToken) },
  );
  if (res.status === 401 || res.status === 403) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform /github/repos ${res.status}`);
  const body = (await res.json()) as { repos?: PlatformGithubRepo[] };
  const repos = body.repos ?? [];
  // Exact match only: `search` is an ILIKE substring match on the registry side, but "does this repo
  // exist" (the whole point of this tool — gating the code stage) must not report a false positive
  // because a DIFFERENT repo's name happens to contain this one as a substring.
  return repos.find((r) => r.name === name || r.fullName === repo) ?? null;
}

export function registerDeliveryTools(): void {
  // ---- Claude Design / Claude Code (WS11 build item 7) ----
  // v1: synchronous Gateway-wrapped ARTIFACT generation (same pattern as llm.extract). The design
  // tool turns a signed PRD into a prototype/design brief; the code tool turns the approved prototype
  // into an implementation plan for the PM-created repo. A running prototype + a real git push are a
  // target-state refinement (a WS8 async specialist + github write) — documented, not faked here.
  registerTool({
    name: "design.prototype",
    description: "Claude Design: turn a signed PRD into a prototype/design brief (screens, components, user flows) as markdown. Returns { content }.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { prd: { type: "string", description: "the signed PRD text" }, notes: { type: "string" } },
      required: ["prd"],
    },
    handler: async (args) => {
      const prd = String(args.prd ?? "");
      if (!prd.trim()) throw new Error("prd required");
      const content = await gatewayComplete(
        `You are a senior product designer. From the PRD below, produce a PROTOTYPE/DESIGN BRIEF as ` +
        `markdown: screen inventory, key components, primary user flows, and states. Be concrete and ` +
        `buildable.${args.notes ? ` Reviewer notes to address: ${String(args.notes)}.` : ""}\n\nPRD:\n${prd}`,
      );
      return JSON.stringify({ content });
    },
  });

  registerTool({
    name: "code.scaffold",
    description: "Claude Code: turn an approved prototype + PRD into an implementation plan / scaffolding for the (PM-created) repo. Returns { content }. Note: v1 produces the code artifact; the real git push is target-state.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { prd: { type: "string" }, prototype: { type: "string" }, repo: { type: "string" }, notes: { type: "string" } },
      required: ["prd", "prototype"],
    },
    handler: async (args) => {
      const prd = String(args.prd ?? "");
      const prototype = String(args.prototype ?? "");
      if (!prd.trim() || !prototype.trim()) throw new Error("prd and prototype required");
      const content = await gatewayComplete(
        `You are a senior engineer. From the PRD + approved prototype below, produce an IMPLEMENTATION ` +
        `PLAN + code scaffolding (file tree, key modules, data model, API surface) as markdown for the ` +
        `repo ${args.repo ? String(args.repo) : "(to be created)"}.${args.notes ? ` Reviewer notes: ${String(args.notes)}.` : ""}` +
        `\n\nPRD:\n${prd}\n\nPROTOTYPE:\n${prototype}`,
      );
      return JSON.stringify({ content });
    },
  });

  registerTool({
    name: "github.repoStatus",
    description:
      "Check whether a GitHub repo exists (gates the Claude Code stage). Returns { exists, fullName, defaultBranch }. Reads platform-nest's own repo registry (GH-08) via OBO — the hub holds no GitHub credential of its own.",
    minAssurance: "low", // the platform resolves the real identity + Cerbos `read` decision
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        repo: { type: "string", description: "repo name, or full owner/name" },
      },
      required: ["tenantId", "repo"],
    },
    handler: async (args, principal) => {
      const tenantId = String(args.tenantId ?? "");
      const repo = String(args.repo ?? "");
      if (!tenantId) throw new Error("tenantId required");
      if (!repo.trim()) throw new Error("repo required");
      const match = await fetchRepoStatus(tenantId, repo, principal);
      if (!match) return JSON.stringify({ exists: false, fullName: repo.includes("/") ? repo : undefined });
      return JSON.stringify({ exists: true, fullName: match.fullName, defaultBranch: match.defaultBranch });
    },
  });

  registerTool({
    name: "github.createRepo",
    description:
      "Create a company GitHub repo — PERMANENTLY NOT ENABLED IN THE HUB. mcp-hub holds only the read-only GitHub App and structurally cannot write. File a D14 approval instead: POST /api/:tenantId/github/repos/creation-requests (a company_admin then approves it, which is what actually creates the repo).",
    minAssurance: "low",
    write: true,
    impact: "medium", // creating an external, not-trivially-reversible resource — see the file header
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, name: { type: "string" }, private: { type: "boolean" } },
      required: ["tenantId", "name"],
    },
    handler: async () => {
      throw new Error(
        "github.createRepo is not enabled in mcp-hub: the hub holds only the read-only GitHub App and " +
          "must never write to GitHub (see docs/blueprints/github-integration-foundation.md §2.2/§4.1). " +
          "File a D14 approval instead — POST /api/:tenantId/github/repos/creation-requests — a " +
          "company_admin approving it is what actually creates the repo.",
      );
    },
  });

  registerTool({
    name: "deploy.staging",
    description:
      "Trigger a staging deploy of a repo/ref via the WS10 release pipeline. LOW-impact: staging is isolated + reversible and is gated upstream by the web-dev-review Submission. Returns the dispatch response.",
    minAssurance: "low",
    write: true,
    impact: "low", // staging only; both Submission gates precede anything customer-facing (plan §7.2)
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "full owner/name of the repo to deploy" },
        ref: { type: "string", description: "git ref/branch/sha (default main)" },
        runId: { type: "string", description: "the pipeline run this deploy belongs to (for audit correlation)" },
      },
      required: ["repo"],
    },
    handler: async (args) => {
      if (!config.deployStagingUrl) throw new Error("deploy.staging not enabled: set DEPLOY_STAGING_URL (the WS10 release-pipeline dispatch webhook)");
      const res = await fetch(config.deployStagingUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.deployStagingToken ? { Authorization: `Bearer ${config.deployStagingToken}` } : {}),
        },
        body: JSON.stringify({ repo: args.repo, ref: args.ref ?? "main", runId: args.runId, target: "staging" }),
      });
      if (!res.ok) throw new Error(`deploy.staging dispatch ${res.status}`);
      const text = await res.text();
      return JSON.stringify({ dispatched: true, repo: args.repo, ref: args.ref ?? "main", response: text.slice(0, 500) });
    },
  });

  registerTool({
    name: "deploy.production",
    description:
      "Trigger a PRODUCTION deploy of a repo/ref via the WS10 release pipeline. HIGH-impact: customer-facing + not trivially reversible. The workflow only reaches this after a human PM prod-approval AND the client's staging sign-off (WS11 tail B). Returns the dispatch response.",
    minAssurance: "low",
    write: true,
    impact: "high", // production, customer-facing — gated on two human approvals upstream (plan §8 tail B)
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "full owner/name of the repo to deploy" },
        ref: { type: "string", description: "git ref/branch/sha (default main)" },
        runId: { type: "string", description: "the pipeline run this deploy belongs to (for audit correlation)" },
      },
      required: ["repo"],
    },
    handler: async (args) => {
      if (!config.deployProductionUrl) throw new Error("deploy.production not enabled: set DEPLOY_PRODUCTION_URL (the WS10 release-pipeline production dispatch webhook)");
      const res = await fetch(config.deployProductionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.deployProductionToken ? { Authorization: `Bearer ${config.deployProductionToken}` } : {}),
        },
        body: JSON.stringify({ repo: args.repo, ref: args.ref ?? "main", runId: args.runId, target: "production" }),
      });
      if (!res.ok) throw new Error(`deploy.production dispatch ${res.status}`);
      const text = await res.text();
      return JSON.stringify({ dispatched: true, repo: args.repo, ref: args.ref ?? "main", target: "production", response: text.slice(0, 500) });
    },
  });
}

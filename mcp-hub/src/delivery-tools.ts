// WS11 build item 9 — GitHub + staging-deploy tools for the delivery track.
//
// Placement of logic: repo creation is a HUMAN step (the PM creates the repo in company GitHub —
// WS11 decision), so `github.createRepo` is registered but fail-closed-not-enabled; the workflow
// gates the Claude Code stage on `github.repoStatus` (a read) instead. `deploy.staging` triggers the
// WS10 release pipeline via a workflow_dispatch-style webhook. Both fail CLOSED with a clear message
// when unconfigured (the honest pattern used by image.enhance) rather than pretending to succeed.
//
// Egress note: these tools call GitHub / the deploy webhook directly (a hub egress path distinct from
// the AI Gateway). Keep the tokens least-privilege (a deploy-only PAT; a single-repo dispatch token).
import { config } from "./config";
import { registerTool } from "./registry";
import { gatewayComplete } from "./gateway-client";

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
      "Check whether a GitHub repo exists (gates the Claude Code stage — the PM must create the repo first). Returns { exists, fullName, defaultBranch }.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "repo name (uses GITHUB_ORG) or full owner/name" },
      },
      required: ["repo"],
    },
    handler: async (args) => {
      if (!config.githubToken) throw new Error("github.repoStatus not enabled: set GITHUB_TOKEN (and GITHUB_ORG)");
      const repo = String(args.repo ?? "");
      const full = repo.includes("/") ? repo : `${config.githubOrg}/${repo}`;
      if (!full.includes("/") || full.startsWith("/")) throw new Error("repo must be owner/name or GITHUB_ORG must be set");
      const res = await fetch(`${config.githubApiUrl}/repos/${full}`, {
        headers: { Authorization: `Bearer ${config.githubToken}`, Accept: "application/vnd.github+json", "User-Agent": "gaiada-mcp-hub" },
      });
      if (res.status === 404) return JSON.stringify({ exists: false, fullName: full });
      if (!res.ok) throw new Error(`github ${res.status}`);
      const j = (await res.json()) as { full_name?: string; default_branch?: string };
      return JSON.stringify({ exists: true, fullName: j.full_name ?? full, defaultBranch: j.default_branch ?? "main" });
    },
  });

  registerTool({
    name: "github.createRepo",
    description: "Create a company GitHub repo — NOT ENABLED (WS11 decision: the PM creates the repo manually; use github.repoStatus to gate).",
    minAssurance: "low",
    write: true,
    impact: "medium", // creating an external, not-trivially-reversible resource
    inputSchema: { type: "object", properties: { name: { type: "string" }, private: { type: "boolean" } }, required: ["name"] },
    handler: async () => {
      throw new Error("github.createRepo is not enabled: repo creation is a manual PM step (WS11). Use github.repoStatus to gate the code stage.");
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
}

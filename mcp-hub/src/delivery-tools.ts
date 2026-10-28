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
import { runnerFetch, passthrough } from "./agents-tools";
import { oboHeaders } from "./obo-headers";
import type { Principal } from "./principal";

/** The ai-agents runner agent that code.scaffold v2 starts (ai-agents/src/code-scaffold/runner-job.ts). */
const SCAFFOLD_AGENT = "code-scaffold-v2";
const SCAFFOLD_SITE_KINDS = ["astro", "node", "wp"];

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
  // design.prototype is v1: synchronous Gateway-wrapped ARTIFACT generation (same pattern as llm.extract): it
  // turns a signed PRD into a prototype/design brief. code.scaffold is v2 (M6-P4b1, below): an async runner job.
  registerTool({
    name: "design.prototype",
    description: "Claude Design: turn a signed PRD into a prototype/design brief (screens, components, user flows) as markdown. Returns { content }.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        prd: { type: "string", description: "the signed PRD text" },
        notes: { type: "string" },
        tenantId: { type: "string", description: "Optional: the company (uuid) this call is for, so the AI usage is recorded against it. Agents get it stamped in; leave out only when no company applies." },
      },
      required: ["prd"],
    },
    handler: async (args) => {
      const prd = String(args.prd ?? "");
      if (!prd.trim()) throw new Error("prd required");
      const content = await gatewayComplete(
        `You are a senior product designer. From the PRD below, produce a PROTOTYPE/DESIGN BRIEF as ` +
        `markdown: screen inventory, key components, primary user flows, and states. Be concrete and ` +
        `buildable.${args.notes ? ` Reviewer notes to address: ${String(args.notes)}.` : ""}\n\nPRD:\n${prd}`,
        "draft",
      );
      return JSON.stringify({ content });
    },
  });

  // ---- code.scaffold v2 (M6-P4b1) ----
  // No longer a Gateway text stub. It starts an ai-agents runner job (agent "code-scaffold-v2", the same
  // POST /goals path agents.invoke uses, with the caller's OBO identity forwarded verbatim) and returns the goal
  // id at once. The job composes a site from the pinned contract snapshot, the signed PRD and the accepted
  // prototype, in DRY-RUN mode only: nothing is pushed anywhere (the hub and the agents hold no GitHub write
  // credential). Poll `agents.status` with the goal id: the finished goal carries the file list (path, size, sha256)
  // and the CONTRACT.lock text in its blackboard entry.
  //
  // M6-P4b2: with `provisionedSiteId`, the goal also carries `commit: { provisionedSiteId }` (beside the frozen envelope,
  // never inside it). The finished job then OFFERS the tree to platform-nest through `webdev.provisionedSites.commitScaffold`
  // with the same OBO identity; platform-nest verifies it and writes the first fill with its ERP App, or refuses. This
  // handler still sends no remote, no mode and no credential: it cannot select a push.
  //
  // AT MOST ONE JOB PER SITE AND SNAPSHOT (M6-P4e3). The workflow calls this tool, then creates the single-shot `claude_code`
  // stage afterwards, so two near-simultaneous deliveries (a gate decision plus the contract_pinned resume, or a redelivery
  // after a first attempt died between the two calls) both reach this handler. The idempotency key is derived by the RUNNER
  // from the goal text this handler sends, never chosen here: `provisionedSiteId` + `contractSnapshotId` when a commit is
  // asked for, else the envelope's identifying fields. While a goal with that key is queued, running or finished ok, the
  // runner answers 200 with THAT goal's id and status and queues nothing, and this tool returns the same shape with
  // `deduped: true` (the goalId is the existing goal's). A failed or cancelled goal frees the key: a retry is a new goal.
  // The atomic check lives in ai-agents (a partial unique index on the goal table), so there is no window to close here.
  //
  // INPUT. Required: tenantId, contractSnapshotId (webdev_contract_snapshots.id, THE pin), siteKind
  // ("astro" | "node" | "wp"), prdArtifact, prototypeArtifact (pipeline_stages.artifact_ref, resolved by the job
  // through pipeline.artifacts.get). Optional: repoUrl, runId, blockLibraryVersion (default: the snapshot's own),
  // maxRevise. The legacy keys `prd`, `prototype` and `repo` that wf:delivery sends today are accepted as aliases
  // of prdArtifact, prototypeArtifact and repoUrl. The result keeps a `content` string for the same caller.
  //
  // Impact is "low", the floor agents.invoke uses: this files a goal and mutates no business data.
  registerTool({
    name: "code.scaffold",
    description:
      "Claude Code v2: start a code.scaffold job that composes a site repo (siteKind astro, node = Next + Nest apps/web, or wp) from a pinned contract snapshot, the signed PRD and the accepted prototype. The job never pushes. With provisionedSiteId, the finished job hands the tree to platform-nest, which commits it as the FIRST FILL of that site's repo with the ERP App (webdev.provisionedSites.commitScaffold), or refuses. ASYNCHRONOUS: returns { goalId, status: 'queued', mode: 'dry_run', commitRequested, deduped, content } at once (IDEMPOTENT: while a goal for the same provisioned site and contract snapshot is queued, running or finished ok, returns THAT goal's id and status with deduped: true instead of filing another; a failed or cancelled one allows a retry); poll agents.status for the file list, the CONTRACT.lock and the commit result.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Company uuid the run belongs to." },
        contractSnapshotId: { type: "string", description: "webdev_contract_snapshots.id: the pin the scaffold is built against." },
        siteKind: { type: "string", enum: ["astro", "node", "wp"], description: "node = the fullstack Next + Nest template (fills apps/web)." },
        prdArtifact: { type: "string", description: "artifact_ref of the signed PRD stage (alias: prd)." },
        prototypeArtifact: { type: "string", description: "artifact_ref of the accepted design stage (alias: prototype)." },
        repoUrl: { type: "string", description: "The PM-created repo (alias: repo). Not used by a dry run." },
        provisionedSiteId: {
          type: "string",
          description: "webdev_provisioned_sites.id whose provisioning is complete: the finished tree is committed there by platform-nest (first fill only). Omit for a pure dry run.",
        },
        runId: { type: "string", description: "The pipeline run this belongs to, for correlation." },
        blockLibraryVersion: { type: "string", description: "Default: the snapshot's own pinned library version." },
        maxRevise: { type: "number" },
        requestedBy: { type: "string" },
      },
      required: ["tenantId", "contractSnapshotId", "siteKind", "prdArtifact", "prototypeArtifact"],
    },
    handler: async (args, principal) => {
      const str = (v: unknown): string => (typeof v === "string" ? v : "");
      const tenantId = str(args.tenantId);
      const contractSnapshotId = str(args.contractSnapshotId);
      const siteKind = str(args.siteKind);
      const prdArtifact = str(args.prdArtifact) || str(args.prd);
      const prototypeArtifact = str(args.prototypeArtifact) || str(args.prototype);
      if (!tenantId.trim()) throw new Error("tenantId required");
      if (!prdArtifact.trim() || !prototypeArtifact.trim()) throw new Error("prdArtifact and prototypeArtifact required (aliases: prd, prototype)");
      if (!contractSnapshotId.trim()) {
        throw new Error("contractSnapshotId required: code.scaffold v2 builds against a pinned contract snapshot (webdev_contract_snapshots.id)");
      }
      if (!SCAFFOLD_SITE_KINDS.includes(siteKind)) throw new Error(`siteKind must be one of ${SCAFFOLD_SITE_KINDS.join(", ")}`);
      const provisionedSiteId = str(args.provisionedSiteId).trim();
      if (provisionedSiteId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(provisionedSiteId)) {
        throw new Error("provisionedSiteId must be a webdev_provisioned_sites id (uuid)");
      }

      // The job's goal text is the frozen §06 scaffold envelope (ai-agents/src/code-scaffold/envelope.ts), and
      // nothing in it can select a push: the runner job is dry-run only.
      const envelope = {
        runId: str(args.runId) || "unbound",
        repoUrl: str(args.repoUrl) || str(args.repo) || "unbound",
        siteKind,
        prdArtifact,
        prototypeArtifact,
        contractSnapshotId,
        constraints: {
          blockLibraryVersion: str(args.blockLibraryVersion),
          maxRevise: typeof args.maxRevise === "number" ? args.maxRevise : 3,
        },
      };
      const r = await runnerFetch("POST", "/goals", principal, {
        tenantId,
        agent: SCAFFOLD_AGENT,
        goal: JSON.stringify(provisionedSiteId ? { ...envelope, commit: { provisionedSiteId } } : envelope),
        ...(typeof args.requestedBy === "string" ? { requestedBy: args.requestedBy } : {}),
        envelope: { provider: principal.provider, externalId: principal.externalId },
      });
      const accepted = JSON.parse(passthrough("POST /goals (code.scaffold)", r)) as { id?: string; status?: string; deduped?: boolean };
      const deduped = accepted.deduped === true;
      return JSON.stringify({
        goalId: accepted.id,
        status: accepted.status ?? "queued",
        mode: "dry_run",
        siteKind,
        contractSnapshotId,
        commitRequested: Boolean(provisionedSiteId),
        deduped,
        content: deduped
          ? `code.scaffold v2 job ${accepted.id} already exists for this ${provisionedSiteId ? `provisioned site (${provisionedSiteId}) and contract snapshot` : "request"} (status ${accepted.status}); no new job was queued. Poll agents.status with { goalId, tenantId }.`
          : provisionedSiteId
          ? `code.scaffold v2 job ${accepted.id} queued (${siteKind}); when it finishes, platform-nest commits the tree to provisioned site ${provisionedSiteId} (first fill). Poll agents.status with { goalId, tenantId } for the commit result.`
          : `code.scaffold v2 job ${accepted.id} queued (dry run, ${siteKind}); poll agents.status with { goalId, tenantId } for the file list and CONTRACT.lock.`,
      });
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

// WSK-D33 (webdesk-design-v2.md §08) — the ERP's OWN repo-control `ProvisionProvider`, replacing the
// dead `provision` (gda-s01, measured 000 on every request 2026-09-01) as the seam
// `provisioning.service.ts` egresses through. §08's ruling: "ERP repo control (new, replaces
// `provision`)" owns "the repo from a per-kind template + the `webdev_sites` row + the Zone B
// tenant"; `ai-agents/src/code-scaffold/` owns CONTENT WIRING inside that repo — "two scaffolders,
// one job each". This file is the FIRST half only: it creates the repo shell and nothing inside it.
//
// ── WHY THIS DOES NOT TALK TO GITHUB DIRECTLY ──────────────────────────────────────────────────
// §0.2 of docs/blueprints/github-integration-foundation.md is unmodified by this ticket: repo
// creation is external and not trivially reversible, so it may only happen behind a D14 approval a
// company_admin (or platform_admin) grants against `resource_github_repo.yaml`'s OWN `create_repo`
// rule, itself gated on a verified `approvalId` — see `core/github/repo-creation.ts`'s header for
// the full argument. This provider does not shortcut that: `createProject` below FILES a GH-12
// creation request (`fileAutomationApproval`, the same helper `github-repos.controller.ts`'s
// "Create repository" filing endpoint uses) and returns immediately with the approval as the
// correlation handle. The actual `POST /repos/{owner}/{repo}/generate` call happens later, exactly
// once, inside `automation-approvals.controller.ts#decide()`, when a company_admin approves it — a
// path this file never touches and never needs to.
//
// ── THE SHAPE THIS FORCES ON THE PRE-EXISTING `ProvisionProvider` CONTRACT ─────────────────────────
// `provision-provider.ts`'s discriminated union was designed around a provider that answers
// create/conflict/reject SYNCHRONOUSLY, because `provision` did. This driver's "egress" is filing an
// approval, which NEVER conflicts and NEVER rejects at file-time (whether the requested name is
// actually free on GitHub is unknowable until a human approves it, possibly days later) — so
// `createProject` only ever returns `accepted`, with `project.status: 'pending'` and `project.id` =
// the `automation_approvals.id`. That id becomes `webdev_provisioned_sites.provider_ref` (PRV-02's
// `performEgress`, unchanged) and is what `getProject` below is asked to resolve later. Widening
// "pending" to also mean "awaiting a human decision" (not only "infra is still spinning up", the
// meaning `provision` gave it) is the one semantic change this ticket makes to an existing status
// value — flagged here because a future reader of `mapProviderStatus` (provisioning.service.ts)
// should not assume the two meanings ever needed distinguishing; they do not, because both describe
// the exact same externally-visible fact: "not ready yet, keep polling/reconciling".
//
// ── IDEMPOTENCY / CRASH-RESUME (task requirement: "neither may regress") ──────────────────────────
// `provision`'s own layer-2 backstop was a global DB-unique `projects.name` the far side enforced;
// this seam has no equivalent at file-time (an approval can never collide on GitHub's namespace,
// only its own EVENTUAL execution can). The structurally equivalent hazard here is
// `reconcileProvisionedSite`'s RESUME arm re-calling `performEgress` -> `createProject` a second
// time for a site whose provider_ref was never recorded (a crash between this file's approval INSERT
// committing and provisioning.service's own `UPDATE ... SET provider_ref` committing — the same
// "KNOWN RESIDUAL WINDOW" class provisioning.service.ts's header already documents for the old
// driver). Left unguarded, a second resume would file a SECOND approval for the same slug, and
// nothing stops a human from approving both, creating two repos. `createProject` below closes this:
// before filing anything, it looks for an existing `pending`/`approved` GH-12 request THIS TENANT
// already filed for this exact name and ADOPTS it (returns its id) instead of filing a duplicate —
// the same "prove it's already ours before creating a second one" discipline
// `provisioning.service.ts#providerRefIsOurs` applies one layer up, applied here to the approval
// row instead of the far-side project.
//
// ── TEMPLATE SELECTION: CONFIG ONLY, NEVER A LITERAL IN THIS FILE ──────────────────────────────────
// `config.erpRepoTemplates` (config.ts) holds one `owner/repo` string per §08 kind
// (`static`/`fullstack`/`wp`). No kind's template name is assumed here — the org's own templates are
// measured mostly ARCHIVED and the one live template as of this ticket is a fact about today, not a
// contract this file may bake in. A kind with no configured template is answered honestly
// (`rejected`, 422, naming the missing env var) — never a guess, never a silent fall-through to a
// different kind's template.
import { withTenants } from "../../db";
import { config } from "../../config";
import { fileAutomationApproval } from "../../core/approval-filing";
import { githubRequest } from "../../core/github/github-app.service";
import { GithubApiError } from "../../core/github/errors";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import {
  ProvisionEgressError,
  type CanonicalFramework, type CreateProjectInput, type CreateProjectResult,
  type ProvisionProject, type ProvisionProvider,
} from "./provision-provider";

/** The seam is not usable in this deployment at all (no GitHub org configured — the same
 *  precondition `core/github/repo-creation.ts#executeApprovedGithubRepoCreation` itself checks
 *  before egressing). Distinct from a per-KIND template gap (`createProject`'s own `rejected`
 *  branch below): this is "nothing can ever be created here", checked once at driver construction,
 *  same fail-fast contract `ProvisionNotConfiguredError` gives the old driver. */
export class ErpRepoControlNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`ERP repo control provisioning is not configured (${reason})`);
    this.name = "ErpRepoControlNotConfiguredError";
  }
}

/** §08's kind vocabulary, keyed the other direction from `provisioning.service.ts`'s
 *  `STACK_TO_FRAMEWORK`: that map SELECTS a framework from a caller-supplied kind hint; this one
 *  recovers the kind FROM an already-selected canonical framework, purely to pick a template. Kept
 *  local to this file — no other module needs "which kind does this framework belong to". */
const FRAMEWORK_TO_KIND: Readonly<Record<CanonicalFramework, "static" | "fullstack" | "wp">> = {
  vite: "static", astro: "static",
  nextjs: "fullstack", node: "fullstack",
  wp: "wp",
};

type RepoKind = "static" | "fullstack" | "wp";

interface RepoTemplate {
  owner: string;
  repo: string;
}

/** Parses `config.erpRepoTemplates[kind]` ("owner/repo") into the two fields
 *  `parseCreateRepoArgs`/`executeApprovedGithubRepoCreation` want. `null` for anything not a clean
 *  two-segment `owner/repo` string — including empty (unconfigured) — so a malformed env value fails
 *  the same honest way as an absent one, never a confusing GitHub 404 three steps later. */
function templateForKind(kind: RepoKind): RepoTemplate | null {
  const raw = config.erpRepoTemplates[kind]?.trim() ?? "";
  if (!raw) return null;
  const parts = raw.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

const ENV_VAR_FOR_KIND: Readonly<Record<RepoKind, string>> = {
  static: "ERP_REPO_TEMPLATE_STATIC",
  fullstack: "ERP_REPO_TEMPLATE_FULLSTACK",
  wp: "ERP_REPO_TEMPLATE_WP",
};

interface ApprovalRow {
  status: "pending" | "approved" | "rejected";
  name: string;
}

/** Build the driver, or throw `ErpRepoControlNotConfiguredError`. Mirrors
 *  `createProvisionHttpDriver`'s fail-fast-at-construction contract: a deployment with no GitHub org
 *  configured gets a clean 503 the moment provisioning is attempted, never a half-attempt. */
export function createErpRepoControlProvider(tenantId: string, actorId: string | null): ProvisionProvider {
  if (!config.githubOrg) throw new ErpRepoControlNotConfiguredError("GITHUB_ORG is not configured");
  return new ErpRepoControlProvider(tenantId, actorId);
}

export class ErpRepoControlProvider implements ProvisionProvider {
  readonly key = "erp_repo" as const;

  constructor(
    private readonly tenantId: string,
    private readonly actorId: string | null,
  ) {}

  /** Find a GH-12 creation request THIS TENANT already filed for this exact name, still `pending`
   *  or `approved` (not yet a fact one way or the other). See this file's header on why the
   *  crash-resume argument needs this: the resume path must ADOPT an in-flight request of its own
   *  rather than file a second one for the same slug. Scoped by `withTenants([tenantId])`, so
   *  another tenant's identically-named request (a shared GitHub org is possible; see
   *  `config.githubOrg`) is structurally invisible here — the same tenant wall
   *  `providerRefIsOurs` leans on one layer up. */
  async #findOwnPendingOrApprovedRequest(name: string): Promise<{ id: string } | null> {
    const r = await withTenants([this.tenantId], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM automation_approvals
          WHERE origin = 'github' AND workflow_id = $1 AND status IN ('pending', 'approved')
            AND tool_args->>'name' = $2 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [GITHUB_CREATE_REPO_WORKFLOW, name],
      ),
    );
    return r.rows[0] ?? null;
  }

  async #readApproval(id: string): Promise<ApprovalRow | null> {
    const r = await withTenants([this.tenantId], (c) =>
      c.query<{ status: ApprovalRow["status"]; tool_args: { name?: unknown } }>(
        `SELECT status, tool_args FROM automation_approvals
          WHERE id = $1 AND origin = 'github' AND workflow_id = $2 AND deleted_at IS NULL`,
        [id, GITHUB_CREATE_REPO_WORKFLOW],
      ),
    );
    const row = r.rows[0];
    if (!row) return null;
    const name = typeof row.tool_args?.name === "string" ? row.tool_args.name : "";
    return { status: row.status, name };
  }

  /** Asks GitHub directly (the read-only `agents` App — least privilege for a poll: this driver
   *  never needs write reach to CHECK whether a repo exists) whether `name` now exists in the
   *  configured org. `null` on a clean 404 ("not there [yet]"); throws `ProvisionEgressError` for
   *  anything else (rate-limited, transport failure, or a GitHub-side fault) so the poller/reconciler
   *  treats it as ambiguous rather than a confident "no". Deliberately NOT the `github_repos` mirror
   *  table (GH-06's own periodic crawl, default 6h — far too slow for a poll window measured in
   *  minutes): this goes straight to GitHub, through the same rate-limited `githubRequest`
   *  chokepoint `repo-creation.ts` and `repo-sync.service.ts` already use, so it costs nothing this
   *  estate has not already decided to spend. */
  async #findLiveRepo(name: string): Promise<ProvisionProject | null> {
    const org = config.githubOrg;
    try {
      const res = await githubRequest<{ full_name: string; html_url: string }>(
        this.tenantId,
        "agents",
        this.actorId ?? "webdev-provision-poll",
        { method: "GET", path: `/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}` },
      );
      return { id: res.data.full_name, name, status: "live", repoUrl: res.data.html_url, stagingUrl: null };
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) return null;
      const detail = err instanceof Error ? err.message : String(err);
      throw new ProvisionEgressError(`erp repo control: repo lookup for '${name}' failed: ${detail}`);
    }
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    if (!this.actorId) {
      return {
        outcome: "rejected", status: 422,
        reason: "an authenticated requester is required to file a GitHub repo-creation approval",
      };
    }

    // Crash-resume: adopt an in-flight request of our own before ever filing a new one.
    const existing = await this.#findOwnPendingOrApprovedRequest(input.name);
    if (existing) {
      return {
        outcome: "accepted",
        project: { id: existing.id, name: input.name, status: "pending", repoUrl: null, stagingUrl: null },
      };
    }

    const kind = FRAMEWORK_TO_KIND[input.framework];
    const template = templateForKind(kind);
    if (!template) {
      return {
        outcome: "rejected", status: 422,
        reason:
          `no GitHub template repo is configured for kind '${kind}' — set ${ENV_VAR_FOR_KIND[kind]} `
          + `("owner/repo") before provisioning a ${kind} site through ERP repo control`,
      };
    }

    const filed = await fileAutomationApproval({
      tenantId: this.tenantId,
      workflowId: GITHUB_CREATE_REPO_WORKFLOW,
      toolName: "github.createRepo",
      toolArgs: {
        name: input.name,
        private: true,
        description: `Web Dev site '${input.name}' (${kind}) — requested by ${input.devName}`,
        templateOwner: template.owner,
        templateRepo: template.repo,
      },
      impact: "high",
      reason: `Web Dev: provision repo '${input.name}' (${kind}, template ${template.owner}/${template.repo})`,
      origin: "github",
      requestedBy: this.actorId,
    });

    return {
      outcome: "accepted",
      project: { id: filed.id, name: input.name, status: "pending", repoUrl: null, stagingUrl: null },
    };
  }

  /** `id` is an `automation_approvals.id` (the value `createProject` returned as `project.id`, and
   *  what `provisioning.service.ts` stores as `provider_ref`). `null` only when the approval row
   *  itself is gone (RLS-invisible or hard-deleted) — genuinely "the far side no longer knows about
   *  it", the same contract `provision-http.ts#getProject` gives a 404. */
  async getProject(id: string): Promise<ProvisionProject | null> {
    const approval = await this.#readApproval(id);
    if (!approval) return null;
    if (approval.status === "pending") {
      return { id, name: approval.name, status: "pending", repoUrl: null, stagingUrl: null };
    }
    if (approval.status === "rejected") {
      // A human declined the request — terminal, mapped by `mapProviderStatus` to
      // `failed/provider_failed`, exactly like a far-side `failed` lifecycle from the old driver.
      return { id, name: approval.name, status: "failed", repoUrl: null, stagingUrl: null };
    }
    // approved: `executeApprovedGithubRepoCreation` runs SYNCHRONOUSLY inside `decide()`, so by the
    // time a caller can observe `status='approved'` the real GitHub call has already been made (and
    // either succeeded or thrown without updating this row — see this file's header on the residual
    // window that leaves open). Ask GitHub directly rather than guess from the approval row alone.
    const live = await this.#findLiveRepo(approval.name);
    if (live) return live;
    // Approved but not yet visible: either GitHub's own eventual consistency for a brand-new repo,
    // or `executeApprovedGithubRepoCreation` threw (denied, misconfigured org, GitHub itself
    // refused) and nothing was created. Both read identically from here — stay `pending` and let the
    // poller/reconciler ask again; §04's "honest, not final" applies the same way it always has.
    return { id, name: approval.name, status: "pending", repoUrl: null, stagingUrl: null };
  }

  /** The 409-reconcile read on the OLD contract. Never actually invoked from within this driver's
   *  own `createProject` (see this file's header: filing an approval cannot synchronously conflict,
   *  so this driver never returns `outcome: 'conflict'`) — implemented anyway for interface
   *  completeness and because a future caller may reasonably ask "does a live repo with this name
   *  already exist" independent of any approval. */
  async findProjectByName(name: string): Promise<ProvisionProject | null> {
    return this.#findLiveRepo(name);
  }
}

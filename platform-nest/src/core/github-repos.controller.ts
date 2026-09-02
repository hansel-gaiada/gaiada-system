// GH-08 — BFF endpoints for the GitHub repo registry (blueprint §5.4, migration
// 202608310735_github_repos_registry.sql / GH-05). Read-mostly surface: list (filterable +
// paginated), detail, and link/unlink to a `webdev_site_id` or `project_id`.
//
// ── WHY THIS FILE LIVES OUTSIDE `core/github/` ───────────────────────────────────────────────────
// GH-08's own scope boundary forbids touching `core/github/*.ts` (GH-01/GH-02's credential/token/
// rate-limit/error-mapping surface, owned by other tickets in flight). This controller only reads
// and writes `github_repos` — it never mints a token, never calls the GitHub API — so it has no
// reason to live there. `core/github-repos.controller.ts` (sibling, not child) keeps it out of that
// directory's edit surface entirely.
//
// ── NO MODULE WALL, SAME AS THE TABLE ────────────────────────────────────────────────────────────
// `github_repos` is a CORE table (migration header: linked from both `webdev_site_id` AND
// `project_id`, not owned by one module — same reasoning as `integration_connections`). So, like
// `webdev-change-requests.controller.ts`, no `ModuleEnabledGuard` sits in front of these routes and
// no `withTenants(..., {modules:[...]})` scope is declared anywhere in this file — the table's RLS
// policy composes tenant isolation alone, with no `app_module_allowed()` predicate to satisfy.
//
// ── CERBOS: NO POLICY YET, AND THAT IS THE CORRECT RESTING STATE ────────────────────────────────
// GH-03 (Cerbos policy for github_repo actions) has not shipped as of this ticket. `authorize()`
// below still runs the standard boundary against resource kind `github_repo`
// (actions: `read` / `link` / `unlink`) — but with no `resource_github_repo.yaml` in the policy
// repo, Cerbos returns no verdict for that kind and `check()` treats an unmatched action as DENY
// (see `rbac/cerbos.ts::check`, `effect === "EFFECT_ALLOW"` is the only allow path). Every route in
// this file therefore 403s for every principal, including `platform_admin`, until GH-03 lands a
// policy. That is fail-closed by construction, not a bug in this ticket — flagged in the GH-08
// report for GH-03 rather than worked around here (this ticket's scope boundary explicitly forbids
// inventing new Cerbos policy).
//
// ── GHT-1: EVERY ROUTE AUTHORIZES AND SCOPES AGAINST THE RESOLVED ORG TENANT ────────────────────
// (docs/blueprints/github-tenant-scope-ruling.md §3/§9) `github_repos` is stamped to the SINGLE
// operating company that owns the `gaiadabali` GitHub org, always — but the caller may be standing
// anywhere in that company's root tree. Each route below now runs `resolveGithubOrgTenant(:tenantId)`
// FIRST, then `authorize()`s against the RESOLVED org tenant (never the URL tenant, never both),
// and only then opens `withTenants([org])`. A resolution failure (unset config, or the URL tenant
// sits in a different root) throws `ServiceUnavailableException` BEFORE any query runs against
// `github_repos` — never a silently-empty 200. A same-root caller who resolves the org fine but
// lacks Cerbos reach into it gets `authorize()`'s ordinary 403 — a DELIBERATE behaviour change from
// the old `authorize(..., tenantId)` shape, which some such callers passed (their own tenant had
// zero rows) and is now refused instead (see the ruling's §3 "Behavior change to pin").
//
// ── GITHUB IS TRUTH FOR REPO FACTS, THE ERP IS TRUTH FOR THE LINK (§5.1) ────────────────────────
// link()/unlink() below write ONLY `webdev_site_id` / `project_id` / `updated_at`. Every other
// column (org, name, visibility, archived, head_sha, CI state, …) is GitHub-owned and this
// controller never touches it — GH-06/07 (crawl/webhook) are the only writers of those columns.
//
// ── `tenant_id` NEVER MOVES ON LINK/UNLINK (binding ruling, migration header + blueprint §5.2) ────
// `tenant_id` is the operating company that owns the GitHub org, always — independent of which
// site/project a repo happens to be linked to. Neither `link()` nor `unlink()` below ever appears
// in the same UPDATE's SET list as `tenant_id`, and there is no code path that could make it so.
//
// ── ARCHIVED AND UNLINKED ARE FINDINGS, NOT ERRORS (§5.2, §5.4) ─────────────────────────────────
// `archived=true` filters IN, not out — an archived repo is a normal, expected row (113/221 measured
// 2026-08-31). `linked=false` is its own first-class bucket, matching `idx_github_repos_unlinked`.
// Neither state is ever mapped to a 4xx/5xx or silently dropped from the list.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolveGithubOrgTenant, throwGithubOrgUnavailable, githubOrgMeta } from "./github-org-tenant";
// GH-12 — the ONLY way a repo creation ever gets asked for. Filing is NOT creating: this endpoint
// writes a `pending` automation_approvals row and nothing else; the actual GitHub call happens
// exclusively in `automation-approvals.controller.ts#decide()` -> `executeApprovedGithubRepoCreation`
// once a company_admin approves it. There is deliberately no other endpoint, here or anywhere else,
// that calls githubRequest() with a create/generate path — see repo-creation.ts's own header.
import { fileAutomationApproval } from "./approval-filing";
import { GITHUB_CREATE_REPO_WORKFLOW, parseCreateRepoArgs } from "./github/repo-creation";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const UNLINK_TARGETS = new Set(["webdev_site", "project", "both"]);

/** The view every read endpoint returns — one shape for both list and detail, so the UI never has
 *  to reconcile two slightly different row shapes for the same entity (webdev-change-requests
 *  controller's CR_TRIAGE_COLUMNS follows the same discipline for the same reason). */
const REPO_VIEW_COLUMNS = `
  gr.id, gr.org, gr.name, gr.full_name AS "fullName", gr.html_url AS "htmlUrl",
  gr.visibility, gr.archived, gr.topics,
  gr.default_branch AS "defaultBranch", gr.head_sha AS "headSha",
  gr.head_committed_at AS "headCommittedAt", gr.head_author AS "headAuthor",
  gr.open_pr_count AS "openPrCount", gr.latest_run_status AS "latestRunStatus",
  gr.latest_run_conclusion AS "latestRunConclusion", gr.latest_run_at AS "latestRunAt",
  gr.latest_release_tag AS "latestReleaseTag", gr.deployed_ref AS "deployedRef",
  gr.webdev_site_id AS "webdevSiteId", ws.domain AS "webdevSiteDomain",
  gr.project_id AS "projectId", p.name AS "projectName",
  gr.repo_created_at AS "repoCreatedAt", gr.pushed_at AS "pushedAt",
  gr.last_synced_at AS "lastSyncedAt",
  gr.created_at AS "createdAt", gr.updated_at AS "updatedAt"`;

const REPO_VIEW_JOINS = `
   FROM github_repos gr
   LEFT JOIN webdev_sites ws ON ws.id = gr.webdev_site_id
   LEFT JOIN projects p ON p.id = gr.project_id`;

interface RepoRow {
  id: string;
  webdevSiteId: string | null;
  projectId: string | null;
}

@Controller("api")
@UseGuards(AuthGuard)
export class GithubReposController {
  // ── List ──────────────────────────────────────────────────────────────────────────────────────
  /** The §5.4 surface's list read: filterable on link state, archived state, and a name/full_name
   *  search, paginated. `linked=false` serves the "unlinked repos as their own bucket" requirement
   *  directly off `idx_github_repos_unlinked`'s predicate; `archived` is a plain boolean filter, not
   *  a staleness proxy (§5.2 — half the table is archived and that is normal). */
  @Get(":tenantId/github/repos")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("linked") linkedQ?: string,
    @Query("archived") archivedQ?: string,
    @Query("search") search?: string,
    @Query("limit") limitQ?: string,
    @Query("offset") offsetQ?: string,
  ) {
    if (linkedQ !== undefined && linkedQ !== "true" && linkedQ !== "false") {
      throw new BadRequestException("linked must be true|false");
    }
    if (archivedQ !== undefined && archivedQ !== "true" && archivedQ !== "false") {
      throw new BadRequestException("archived must be true|false");
    }
    const limit = Math.max(1, Math.min(Number(limitQ ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT));
    const offset = Math.max(0, Number(offsetQ ?? 0) || 0);

    // GHT-1: resolve -> authorize (against the ORG tenant) -> scope. See file header.
    const resolution = await resolveGithubOrgTenant(tenantId);
    if (!resolution.ok) throwGithubOrgUnavailable(resolution.reason);
    const org = resolution.tenantId;
    await authorize(req.principal, { kind: "github_repo", tenantId: org }, "read");

    const clauses = ["gr.deleted_at IS NULL"];
    const args: unknown[] = [];
    if (linkedQ === "true") clauses.push("(gr.webdev_site_id IS NOT NULL OR gr.project_id IS NOT NULL)");
    if (linkedQ === "false") clauses.push("(gr.webdev_site_id IS NULL AND gr.project_id IS NULL)");
    if (archivedQ === "true") clauses.push("gr.archived = true");
    if (archivedQ === "false") clauses.push("gr.archived = false");
    if (search?.trim()) {
      const idx = args.push(`%${search.trim()}%`);
      clauses.push(`(gr.name ILIKE $${idx} OR gr.full_name ILIKE $${idx})`);
    }
    const where = clauses.join(" AND ");

    const [{ repos, total }, org_meta] = await Promise.all([
      withTenants([org], async (c) => {
        const [rows, count] = await Promise.all([
          c.query(
            `SELECT ${REPO_VIEW_COLUMNS} ${REPO_VIEW_JOINS}
              WHERE ${where}
              ORDER BY gr.full_name ASC
              LIMIT $${args.push(limit)} OFFSET $${args.push(offset)}`,
            args,
          ),
          // Separate COUNT, same predicate minus the just-appended limit/offset params — the UI's
          // pagination (and any bucket-size chip: "N unlinked", "N archived") needs a real total, not
          // just "did this page fill up".
          c.query<{ n: string }>(`SELECT count(*)::text AS n FROM github_repos gr WHERE ${where}`, args.slice(0, args.length - 2)),
        ]);
        return { repos: rows.rows, total: Number(count.rows[0]?.n ?? 0) };
      }),
      githubOrgMeta(org),
    ]);
    return { repos, total, limit, offset, org: org_meta };
  }

  // ── Detail ────────────────────────────────────────────────────────────────────────────────────
  @Get(":tenantId/github/repos/:id")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    // GHT-1: resolve -> authorize (against the ORG tenant) -> scope. See file header.
    const resolution = await resolveGithubOrgTenant(tenantId);
    if (!resolution.ok) throwGithubOrgUnavailable(resolution.reason);
    const org = resolution.tenantId;
    await authorize(req.principal, { kind: "github_repo", tenantId: org, id }, "read");
    const [row, org_meta] = await Promise.all([
      withTenants([org], async (c) => {
        const r = await c.query(
          `SELECT ${REPO_VIEW_COLUMNS} ${REPO_VIEW_JOINS}
            WHERE gr.id::text = $1 AND gr.deleted_at IS NULL`,
          [id],
        );
        if (!r.rows[0]) throw new NotFoundException("repo not found");
        return r.rows[0];
      }),
      githubOrgMeta(org),
    ]);
    return { ...row, org: org_meta };
  }

  // ── Link ──────────────────────────────────────────────────────────────────────────────────────
  /** Sets `webdev_site_id` and/or `project_id` — whichever the caller supplies. Never touches
   *  `tenant_id` (binding ruling, see file header) and never any GitHub-owned column. A bad id
   *  (wrong tenant, or simply not existing) is refused by the composite FK (23503) exactly as
   *  webdev-change-requests.controller.ts's createInternal() refuses one — a 400 naming the
   *  caller's mistake, not a 500. */
  @Post(":tenantId/github/repos/:id/link")
  async link(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { webdevSiteId?: string; projectId?: string },
  ) {
    const webdevSiteId = body?.webdevSiteId;
    const projectId = body?.projectId;
    if (!webdevSiteId && !projectId) {
      throw new BadRequestException("webdevSiteId or projectId required");
    }
    // GHT-1: resolve -> authorize (against the ORG tenant) -> scope. See file header. Composite FKs
    // (webdev_site_id, tenant_id) / (project_id, tenant_id) still bind the linked row to the ORG
    // tenant's own projects/sites — scoping the UPDATE to `withTenants([org])` is what makes that
    // true from every same-root vantage, not just the URL tenant.
    const resolution = await resolveGithubOrgTenant(tenantId);
    if (!resolution.ok) throwGithubOrgUnavailable(resolution.reason);
    const org = resolution.tenantId;
    await authorize(req.principal, { kind: "github_repo", tenantId: org, id }, "link");

    const sets: string[] = [];
    const args: unknown[] = [];
    if (webdevSiteId) sets.push(`webdev_site_id = $${args.push(webdevSiteId)}`);
    if (projectId) sets.push(`project_id = $${args.push(projectId)}`);
    sets.push("updated_at = now()");

    let updated: RepoRow | undefined;
    try {
      updated = await withTenants([org], async (c) => {
        const r = await c.query<RepoRow>(
          `UPDATE github_repos SET ${sets.join(", ")}
            WHERE id::text = $${args.push(id)} AND deleted_at IS NULL
          RETURNING id, webdev_site_id AS "webdevSiteId", project_id AS "projectId"`,
          args,
        );
        return r.rows[0];
      });
    } catch (err) {
      // Composite FKs (webdev_site_id, tenant_id) / (project_id, tenant_id) run as the table owner,
      // OUTSIDE RLS — a cross-tenant or non-existent id is refused here, never silently accepted.
      if ((err as { code?: string }).code === "23503") {
        throw new BadRequestException("webdevSiteId/projectId must belong to this tenant");
      }
      throw err;
    }
    if (!updated) throw new NotFoundException("repo not found");

    await writeActivity(org, req.principal.userId, "linked", "github_repo", id, {
      webdevSiteId: webdevSiteId ?? null, projectId: projectId ?? null,
    });
    return { id: updated.id, webdevSiteId: updated.webdevSiteId, projectId: updated.projectId };
  }

  // ── Unlink ────────────────────────────────────────────────────────────────────────────────────
  /** Clears the link column(s) named by `target` (default `both`). Writes ONLY the link columns —
   *  same non-negotiable as link() above. An unlinked repo is a legitimate resting state (§5.2),
   *  never an error, so this always succeeds against a real row. */
  @Post(":tenantId/github/repos/:id/unlink")
  async unlink(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { target?: string },
  ) {
    const target = body?.target ?? "both";
    if (!UNLINK_TARGETS.has(target)) {
      throw new BadRequestException("target must be webdev_site|project|both");
    }
    // GHT-1: resolve -> authorize (against the ORG tenant) -> scope. See file header.
    const resolution = await resolveGithubOrgTenant(tenantId);
    if (!resolution.ok) throwGithubOrgUnavailable(resolution.reason);
    const org = resolution.tenantId;
    await authorize(req.principal, { kind: "github_repo", tenantId: org, id }, "unlink");

    const sets: string[] = [];
    if (target === "webdev_site" || target === "both") sets.push("webdev_site_id = NULL");
    if (target === "project" || target === "both") sets.push("project_id = NULL");
    sets.push("updated_at = now()");

    const updated = await withTenants([org], async (c) => {
      const r = await c.query<RepoRow>(
        `UPDATE github_repos SET ${sets.join(", ")}
          WHERE id::text = $1 AND deleted_at IS NULL
        RETURNING id, webdev_site_id AS "webdevSiteId", project_id AS "projectId"`,
        [id],
      );
      return r.rows[0];
    });
    if (!updated) throw new NotFoundException("repo not found");

    await writeActivity(org, req.principal.userId, "unlinked", "github_repo", id, { target });
    return { id: updated.id, webdevSiteId: updated.webdevSiteId, projectId: updated.projectId };
  }

  // ── GH-12: request repo creation (files a D14 approval; creates NOTHING itself) ─────────────────
  /** §0.2's reversal, closed the safe way: repo creation is re-enabled, but ONLY as something an
   *  approval can grant. This handler's entire job is the INSERT — `authorize()` here checks the
   *  generic `create` action on `automation_approval` (company_admin/manager/member, unchanged
   *  policy, the same gate every other suspended-write filing already uses), NOT `create_repo` on
   *  `github_repo` — that stricter, company_admin-only, approvalId-gated check runs later, at
   *  DECIDE time, against the DECIDER's own authority (`repo-creation.ts`'s own header explains why
   *  those are two different questions). A member who can file a request here may still have it
   *  refused by every decider if nobody with `create_repo` reach ever approves it — filing is not a
   *  promise of outcome, same as every other automation_approval in this table. */
  @Post(":tenantId/github/repos/creation-requests")
  @HttpCode(201)
  async requestCreation(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; private?: boolean; description?: string; templateOwner?: string; templateRepo?: string; reason?: string },
  ) {
    const parsed = parseCreateRepoArgs((body ?? {}) as Record<string, unknown>);
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    // GHT-1: resolve -> authorize (against the ORG tenant) -> file. Filing into ORG (rather than the
    // URL tenant) fixes a latent misfiling: a request from a holding-root vantage used to file its
    // automation_approval into the HOLDING tenant, where no agency company_admin inbox would ever
    // surface it and where the D14 decider set was wrong (ruling §3).
    const resolution = await resolveGithubOrgTenant(tenantId);
    if (!resolution.ok) throwGithubOrgUnavailable(resolution.reason);
    const org = resolution.tenantId;
    await authorize(req.principal, { kind: "automation_approval", tenantId: org }, "create");
    if (!req.principal.userId) throw new BadRequestException("an authenticated user is required");
    return fileAutomationApproval({
      tenantId: org,
      workflowId: GITHUB_CREATE_REPO_WORKFLOW,
      toolName: "github.createRepo",
      toolArgs: { ...parsed.args },
      impact: "high",
      reason: body?.reason ?? `create GitHub repo '${parsed.args.name}'`,
      origin: "github",
      requestedBy: req.principal.userId,
    });
  }
}

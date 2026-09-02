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
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";

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

    await authorize(req.principal, { kind: "github_repo", tenantId }, "read");

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

    return withTenants([tenantId], async (c) => {
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
      return { repos: rows.rows, total: Number(count.rows[0]?.n ?? 0), limit, offset };
    });
  }

  // ── Detail ────────────────────────────────────────────────────────────────────────────────────
  @Get(":tenantId/github/repos/:id")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "github_repo", tenantId, id }, "read");
    return withTenants([tenantId], async (c) => {
      const r = await c.query(
        `SELECT ${REPO_VIEW_COLUMNS} ${REPO_VIEW_JOINS}
          WHERE gr.id::text = $1 AND gr.deleted_at IS NULL`,
        [id],
      );
      if (!r.rows[0]) throw new NotFoundException("repo not found");
      return r.rows[0];
    });
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
    await authorize(req.principal, { kind: "github_repo", tenantId, id }, "link");

    const sets: string[] = [];
    const args: unknown[] = [];
    if (webdevSiteId) sets.push(`webdev_site_id = $${args.push(webdevSiteId)}`);
    if (projectId) sets.push(`project_id = $${args.push(projectId)}`);
    sets.push("updated_at = now()");

    let updated: RepoRow | undefined;
    try {
      updated = await withTenants([tenantId], async (c) => {
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

    await writeActivity(tenantId, req.principal.userId, "linked", "github_repo", id, {
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
    await authorize(req.principal, { kind: "github_repo", tenantId, id }, "unlink");

    const sets: string[] = [];
    if (target === "webdev_site" || target === "both") sets.push("webdev_site_id = NULL");
    if (target === "project" || target === "both") sets.push("project_id = NULL");
    sets.push("updated_at = now()");

    const updated = await withTenants([tenantId], async (c) => {
      const r = await c.query<RepoRow>(
        `UPDATE github_repos SET ${sets.join(", ")}
          WHERE id::text = $1 AND deleted_at IS NULL
        RETURNING id, webdev_site_id AS "webdevSiteId", project_id AS "projectId"`,
        [id],
      );
      return r.rows[0];
    });
    if (!updated) throw new NotFoundException("repo not found");

    await writeActivity(tenantId, req.principal.userId, "unlinked", "github_repo", id, { target });
    return { id: updated.id, webdevSiteId: updated.webdevSiteId, projectId: updated.projectId };
  }
}

// DW-6f (docs/FRONTEND-BFF-CONTRACT.md §34) — pull requests and CI status on PM tasks, against LIVE Postgres, RLS and
// Cerbos, driven over the real HTTP surface (the signed webhook receiver in, the PM read out).
//
// Proves, in order:
//   1. `pull_request` events fill github_pull_requests (upsert on repo + number) and link it to a task by key.
//   2. Editing a title or a branch re-links; the ordering guard (`updated_at`) refuses an older delivery.
//   3. A key that names no project, or a deleted task, links nothing, and the pull request is still stored.
//   4. `workflow_run` fills `ci` by `pull_requests[]` and by `head_sha`, one entry per workflow name, an older run refused.
//   5. The read: authorised like the task (403 for a caller refused `read`, 404 for another tenant's task), `linkable`
//      false outside the org tenant, `repoLinked`, open first then newest, and the CI summary computed on read.
//   6. A replayed delivery writes nothing twice; a malformed pull request never fails the delivery's existing writes.
//
// The payloads are the real GitHub shapes (`pull_request`, `workflow_run`), trimmed to the fields the receiver reads.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const SECRET = "dw6f-webhook-test-secret";
const REPO = "gaiadabali/dw6f-repo";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const sign = (bodyStr: string) => `sha256=${createHmac("sha256", SECRET).update(bodyStr).digest("hex")}`;

interface PrOpts {
  action?: string; number: number; title: string; ref?: string; sha?: string; state?: "open" | "closed";
  merged?: boolean; draft?: boolean; updatedAt: string; repo?: string;
}
function prPayload(o: PrOpts) {
  const repo = o.repo ?? REPO;
  return {
    action: o.action ?? "opened",
    number: o.number,
    pull_request: {
      number: o.number,
      state: o.state ?? "open",
      title: o.title,
      user: { login: "octocat", type: "User" },
      html_url: `https://github.com/${repo}/pull/${o.number}`,
      draft: o.draft ?? false,
      merged: o.merged ?? false,
      head: { ref: o.ref ?? "feature/untitled", sha: o.sha ?? "a".repeat(40) },
      base: { ref: "main" },
      created_at: "2026-10-13T08:00:00Z",
      updated_at: o.updatedAt,
    },
    repository: { full_name: repo, name: repo.split("/")[1], default_branch: "main", html_url: `https://github.com/${repo}` },
    sender: { login: "octocat", type: "User" },
  };
}

interface RunOpts {
  id: number; name: string; status: string; conclusion: string | null; startedAt: string | null;
  sha?: string; prNumbers?: number[]; repo?: string;
}
function runPayload(o: RunOpts) {
  const repo = o.repo ?? REPO;
  return {
    action: o.status === "completed" ? "completed" : "in_progress",
    workflow_run: {
      id: o.id,
      name: o.name,
      head_sha: o.sha ?? "a".repeat(40),
      head_branch: "feature/untitled",
      status: o.status,
      conclusion: o.conclusion,
      html_url: `https://github.com/${repo}/actions/runs/${o.id}`,
      created_at: o.startedAt ?? "2026-10-13T09:00:00Z",
      run_started_at: o.startedAt,
      pull_requests: (o.prNumbers ?? []).map((n) => ({
        id: 1000 + n, number: n, url: `https://api.github.com/repos/${repo}/pulls/${n}`,
        head: { ref: "feature/untitled", sha: o.sha ?? "a".repeat(40) }, base: { ref: "main" },
      })),
    },
    repository: { full_name: repo, name: repo.split("/")[1], default_branch: "main" },
    sender: { login: "octocat", type: "User" },
  };
}

describe.skipIf(!TEST_URL)("Pull requests and CI on PM tasks (DW-6f)", () => {
  let app: NestFastifyApplication;
  let org: string; // the org tenant: owns the GitHub organisation, and Web Dev's projects
  let other: string; // a company that does not
  let manager: string;
  let rival: string;
  const taskIds: Record<string, string> = {}; // "WEB-1" -> task id
  const projectIds: Record<string, string> = {};
  const savedSecret = config.githubWebhookSecret;
  const savedTenant = config.githubRepoSync.tenantId;
  const savedToken = config.serviceToken;

  async function post(event: string, deliveryId: string, payloadObj: unknown) {
    const body = JSON.stringify(payloadObj);
    return app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": sign(body),
      },
      payload: body,
    });
  }
  const sendPr = async (o: PrOpts) => (await post("pull_request", newId(), prPayload(o))).json() as { ok: boolean; note?: string };
  const sendRun = async (o: RunOpts) => (await post("workflow_run", newId(), runPayload(o))).json() as { ok: boolean; note?: string };

  async function prRow(number: number, repo = REPO) {
    const r = await adminPool().query(
      `SELECT * FROM github_pull_requests WHERE tenant_id = $1 AND repo_full_name = $2 AND number = $3`,
      [org, repo, number],
    );
    return r.rows[0] as undefined | {
      id: string; title: string; state: string; merged: boolean; draft: boolean; head_ref: string; head_sha: string | null;
      html_url: string; author_login: string | null; gh_updated_at: Date | null; pm_task_id: string | null;
      task_key: string | null; ci: Record<string, { runId: number; status: string; conclusion: string | null; url: string; at: string | null }>;
    };
  }

  const readPrs = (taskId: string, tenant = org, caller = manager) =>
    app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${taskId}/pull-requests`, headers: asUser(caller) });

  async function makeProject(name: string, shortCode: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: `/api/${org}/projects`, headers: asUser(manager), payload: { name, isInternal: true } });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { id: string }).id;
    // The short code is derived from the name on creation; pin it so the keys in the fixtures are the ones under test.
    await adminPool().query(`UPDATE projects SET short_code = $2 WHERE id = $1`, [id, shortCode]);
    return id;
  }
  async function makeTask(projectId: string, title: string): Promise<{ id: string; key: string }> {
    const r = await app.inject({ method: "POST", url: `/api/${org}/pm/tasks`, headers: asUser(manager), payload: { projectId, title } });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { id: string }).id;
    const got = (await app.inject({ method: "GET", url: `/api/${org}/pm/tasks/${id}`, headers: asUser(manager) })).json() as { displayCode: string };
    return { id, key: got.displayCode };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.githubWebhookSecret = SECRET;
    org = await createCompany("DW-6f Org Co", ["agency", "pm"]);
    other = await createCompany("DW-6f Other Co", ["agency", "pm"]);
    config.githubRepoSync.tenantId = org;
    manager = await createUser("mgr-dw6f@a.test", "Manager Mo");
    await addMembership(org, manager);
    await grantRole(manager, await createRole("manager"), "company", org);
    rival = await createUser("rival-dw6f@b.test", "Rival Admin");
    await addMembership(other, rival);
    await grantRole(rival, await createRole("manager"), "company", other);
    app = await buildApp();

    projectIds.WEB = await makeProject("Web DW6F", "WEB");
    projectIds.API = await makeProject("Api DW6F", "API");
    for (const [code, titles] of [["WEB", ["one", "two", "three"]], ["API", ["one"]]] as const) {
      for (const title of titles) {
        const t = await makeTask(projectIds[code], `${code} ${title}`);
        taskIds[t.key] = t.id;
      }
    }
  });

  afterAll(async () => {
    config.githubWebhookSecret = savedSecret;
    config.githubRepoSync.tenantId = savedTenant;
    config.serviceToken = savedToken;
    await app.close();
    await teardownTestDb();
  });

  afterEach(async () => {
    config.githubRepoSync.tenantId = org;
    await adminPool().query(`DELETE FROM github_pull_requests`);
    await adminPool().query(`DELETE FROM work_activity_links`);
    await adminPool().query(`DELETE FROM work_activity`);
    await adminPool().query(`DELETE FROM github_webhook_deliveries`);
    await adminPool().query(`DELETE FROM github_repos`);
  });

  it("the fixture tasks carry the keys the tests name", () => {
    expect(Object.keys(taskIds).sort()).toEqual(["API-1", "WEB-1", "WEB-2", "WEB-3"]);
  });

  // ── 1. opened ─────────────────────────────────────────────────────────────────────────────────
  describe("pull_request fills the row and links it", () => {
    it("opened: upserts every field and links by the key in the title", async () => {
      const res = await sendPr({ number: 7, title: "WEB-1 add the nav", ref: "feature/nav", sha: "b".repeat(40), updatedAt: "2026-10-13T10:00:00Z" });
      expect(res.ok).toBe(true);
      expect(res.note).toContain("pr_store=applied link=WEB-1");
      const row = await prRow(7);
      expect(row).toMatchObject({
        title: "WEB-1 add the nav", state: "open", merged: false, draft: false, head_ref: "feature/nav",
        head_sha: "b".repeat(40), html_url: `https://github.com/${REPO}/pull/7`, author_login: "octocat",
        pm_task_id: taskIds["WEB-1"], task_key: "WEB-1", ci: {},
      });
      expect(row!.gh_updated_at!.toISOString()).toBe("2026-10-13T10:00:00.000Z");
    });

    it("links by the branch alone, and a lowercase key in a branch counts", async () => {
      await sendPr({ number: 8, title: "Add the nav", ref: "feature/web-2-nav", updatedAt: "2026-10-13T10:00:00Z" });
      const row = await prRow(8);
      expect(row!.pm_task_id).toBe(taskIds["WEB-2"]);
      expect(row!.task_key).toBe("web-2"); // as written
    });

    it("the title wins over the branch, and the first key that resolves wins", async () => {
      await sendPr({ number: 9, title: "NOPE-9 then WEB-3 and WEB-1", ref: "feature/api-1", updatedAt: "2026-10-13T10:00:00Z" });
      // NOPE-9 names no project; WEB-3 is the next in the title (before the branch's API-1)
      expect((await prRow(9))!.pm_task_id).toBe(taskIds["WEB-3"]);
    });

    it("a key naming no project links nothing, and the pull request is still stored", async () => {
      await sendPr({ number: 10, title: "FIX-2 something", ref: "fix/fix-2", updatedAt: "2026-10-13T10:00:00Z" });
      const row = await prRow(10);
      expect(row).toBeDefined();
      expect(row!.pm_task_id).toBeNull();
      expect(row!.task_key).toBeNull();
    });

    it("a key whose seq names no task links nothing", async () => {
      await sendPr({ number: 11, title: "WEB-999 ghost", updatedAt: "2026-10-13T10:00:00Z" });
      expect((await prRow(11))!.pm_task_id).toBeNull();
    });

    it("a key naming a DELETED task does not link", async () => {
      const t = await makeTask(projectIds.WEB, "WEB doomed");
      expect(t.key).toBe("WEB-4");
      await adminPool().query(`UPDATE pm_tasks SET deleted_at = now() WHERE id = $1`, [t.id]);
      await sendPr({ number: 12, title: "WEB-4 on a deleted task", updatedAt: "2026-10-13T10:00:00Z" });
      expect((await prRow(12))!.pm_task_id).toBeNull();
    });

    it("keys glued to letters or digits do not link", async () => {
      await sendPr({ number: 13, title: "fooWEB-1 and WEB-1x and WEB-1000000", ref: "xAPI-1y", updatedAt: "2026-10-13T10:00:00Z" });
      expect((await prRow(13))!.pm_task_id).toBeNull();
    });

    it("a draft pull request, and a merged close, are recorded as GitHub says", async () => {
      await sendPr({ number: 14, title: "WEB-1 draft", draft: true, updatedAt: "2026-10-13T10:00:00Z" });
      expect((await prRow(14))).toMatchObject({ draft: true, state: "open", merged: false });
      await sendPr({ action: "closed", number: 14, title: "WEB-1 draft", draft: false, state: "closed", merged: true, updatedAt: "2026-10-13T11:00:00Z" });
      expect((await prRow(14))).toMatchObject({ draft: false, state: "closed", merged: true, pm_task_id: taskIds["WEB-1"] });
    });
  });

  // ── 2. edited re-links; ordering guard ────────────────────────────────────────────────────────
  describe("re-linking and the ordering guard", () => {
    it("edited: removing the key unlinks, adding another key links to that task", async () => {
      await sendPr({ number: 20, title: "WEB-1 first", updatedAt: "2026-10-13T10:00:00Z" });
      expect((await prRow(20))!.pm_task_id).toBe(taskIds["WEB-1"]);

      await sendPr({ action: "edited", number: 20, title: "no key any more", updatedAt: "2026-10-13T10:05:00Z" });
      let row = await prRow(20);
      expect(row!.pm_task_id).toBeNull();
      expect(row!.task_key).toBeNull();

      await sendPr({ action: "edited", number: 20, title: "now WEB-2", updatedAt: "2026-10-13T10:10:00Z" });
      row = await prRow(20);
      expect(row!.pm_task_id).toBe(taskIds["WEB-2"]);
      expect(row!.task_key).toBe("WEB-2");
    });

    it("synchronize moves head_sha and keeps the link and the CI already stored", async () => {
      await sendPr({ number: 21, title: "WEB-1 sync", sha: "c".repeat(40), updatedAt: "2026-10-13T10:00:00Z" });
      await sendRun({ id: 1, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:01:00Z", prNumbers: [21], sha: "c".repeat(40) });
      await sendPr({ action: "synchronize", number: 21, title: "WEB-1 sync", sha: "d".repeat(40), updatedAt: "2026-10-13T10:02:00Z" });
      const row = await prRow(21);
      expect(row!.head_sha).toBe("d".repeat(40));
      expect(row!.pm_task_id).toBe(taskIds["WEB-1"]);
      expect(row!.ci.CI.conclusion).toBe("success");
    });

    it("an OLDER updated_at delivered after a newer one changes nothing", async () => {
      await sendPr({ action: "edited", number: 22, title: "WEB-1 newer", updatedAt: "2026-10-13T12:00:00Z" });
      const stale = await sendPr({ action: "edited", number: 22, title: "WEB-2 older", state: "closed", updatedAt: "2026-10-13T11:00:00Z" });
      expect(stale.ok).toBe(true);
      expect(stale.note).toContain("pr_store=stale");
      const row = await prRow(22);
      expect(row).toMatchObject({ title: "WEB-1 newer", state: "open", pm_task_id: taskIds["WEB-1"], task_key: "WEB-1" });
      expect(row!.gh_updated_at!.toISOString()).toBe("2026-10-13T12:00:00.000Z");
    });

    it("the same updated_at is applied (at or after)", async () => {
      await sendPr({ number: 23, title: "WEB-1 a", updatedAt: "2026-10-13T12:00:00Z" });
      await sendPr({ action: "edited", number: 23, title: "WEB-2 b", updatedAt: "2026-10-13T12:00:00Z" });
      expect((await prRow(23))!.title).toBe("WEB-2 b");
    });
  });

  // ── 3. workflow_run → ci ──────────────────────────────────────────────────────────────────────
  describe("workflow_run fills ci", () => {
    it("matches by workflow_run.pull_requests[] numbers, and sets runId, status, conclusion, url, at", async () => {
      await sendPr({ number: 30, title: "WEB-1 ci", updatedAt: "2026-10-13T10:00:00Z" });
      await sendPr({ number: 31, title: "WEB-1 other pr", updatedAt: "2026-10-13T10:00:00Z" });
      const res = await sendRun({ id: 501, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:30:00Z", prNumbers: [30], sha: "e".repeat(40) });
      expect(res.note).toContain("ci_store=1");
      expect((await prRow(30))!.ci).toEqual({
        CI: { runId: 501, status: "completed", conclusion: "success", url: `https://github.com/${REPO}/actions/runs/501`, at: "2026-10-13T10:30:00.000Z" },
      });
      expect((await prRow(31))!.ci).toEqual({}); // not named by the run
    });

    it("matches by head_sha when pull_requests[] is empty (a fork's run)", async () => {
      await sendPr({ number: 32, title: "WEB-1 fork", sha: "f".repeat(40), updatedAt: "2026-10-13T10:00:00Z" });
      await sendPr({ number: 33, title: "WEB-1 not this one", sha: "9".repeat(40), updatedAt: "2026-10-13T10:00:00Z" });
      await sendRun({ id: 502, name: "CI", status: "in_progress", conclusion: null, startedAt: "2026-10-13T10:30:00Z", sha: "f".repeat(40) });
      expect((await prRow(32))!.ci.CI).toMatchObject({ runId: 502, status: "in_progress", conclusion: null });
      expect((await prRow(33))!.ci).toEqual({});
    });

    it("keeps one entry per workflow name, and a newer run of a workflow replaces its entry", async () => {
      await sendPr({ number: 34, title: "WEB-1 two workflows", updatedAt: "2026-10-13T10:00:00Z" });
      await sendRun({ id: 601, name: "CI", status: "completed", conclusion: "failure", startedAt: "2026-10-13T10:10:00Z", prNumbers: [34] });
      await sendRun({ id: 602, name: "Lint", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:11:00Z", prNumbers: [34] });
      await sendRun({ id: 603, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:20:00Z", prNumbers: [34] });
      const ci = (await prRow(34))!.ci;
      expect(Object.keys(ci).sort()).toEqual(["CI", "Lint"]);
      expect(ci.CI).toMatchObject({ runId: 603, conclusion: "success" });
      expect(ci.Lint).toMatchObject({ runId: 602, conclusion: "success" });
    });

    it("an OLDER run delivered after a newer one is refused", async () => {
      await sendPr({ number: 35, title: "WEB-1 out of order", updatedAt: "2026-10-13T10:00:00Z" });
      await sendRun({ id: 702, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:20:00Z", prNumbers: [35] });
      const older = await sendRun({ id: 701, name: "CI", status: "completed", conclusion: "failure", startedAt: "2026-10-13T10:10:00Z", prNumbers: [35] });
      expect(older.note).toContain("ci_store=0");
      expect((await prRow(35))!.ci.CI).toMatchObject({ runId: 702, conclusion: "success" });
    });

    it("the same run moving queued, in progress, completed updates its entry (at or after)", async () => {
      await sendPr({ number: 36, title: "WEB-1 progress", updatedAt: "2026-10-13T10:00:00Z" });
      await sendRun({ id: 801, name: "CI", status: "in_progress", conclusion: null, startedAt: "2026-10-13T10:10:00Z", prNumbers: [36] });
      await sendRun({ id: 801, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:10:00Z", prNumbers: [36] });
      expect((await prRow(36))!.ci.CI).toMatchObject({ runId: 801, status: "completed", conclusion: "success" });
    });

    it("a late 'in progress' of the SAME run delivered after its 'completed' never undoes it", async () => {
      await sendPr({ number: 37, title: "WEB-1 late event", updatedAt: "2026-10-13T10:00:00Z" });
      await sendRun({ id: 811, name: "CI", status: "completed", conclusion: "failure", startedAt: "2026-10-13T10:10:00Z", prNumbers: [37] });
      const late = await sendRun({ id: 811, name: "CI", status: "in_progress", conclusion: null, startedAt: "2026-10-13T10:10:00Z", prNumbers: [37] });
      expect(late.note).toContain("ci_store=0");
      expect((await prRow(37))!.ci.CI).toMatchObject({ runId: 811, status: "completed", conclusion: "failure" });
      // A re-run (a NEW run id, same start or later) still replaces it.
      await sendRun({ id: 812, name: "CI", status: "in_progress", conclusion: null, startedAt: "2026-10-13T10:30:00Z", prNumbers: [37] });
      expect((await prRow(37))!.ci.CI).toMatchObject({ runId: 812, status: "in_progress" });
    });

    it("a run for a pull request that is not stored yet writes nothing and fails nothing", async () => {
      const res = await sendRun({ id: 901, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:10:00Z", prNumbers: [999] });
      expect(res.ok).toBe(true);
      expect(res.note).toContain("ci_store=0");
    });

    it("an unlinked pull request still carries its CI", async () => {
      await sendPr({ number: 37, title: "no key here", updatedAt: "2026-10-13T10:00:00Z" });
      await sendRun({ id: 902, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:10:00Z", prNumbers: [37] });
      expect((await prRow(37))!.ci.CI.runId).toBe(902);
    });
  });

  // ── 4. the read ───────────────────────────────────────────────────────────────────────────────
  describe("GET /api/:t/pm/tasks/:taskId/pull-requests", () => {
    type Body = {
      taskKey: string | null; linkable: boolean; repoLinked: boolean;
      pullRequests: Array<{
        repo: string; number: number; title: string; state: string; merged: boolean; draft: boolean; headRef: string; url: string;
        authorLogin: string | null; updatedAt: string; ci: { summary: string; runs: Array<{ name: string; status: string; conclusion: string | null; url: string | null; at: string | null }> };
      }>;
    };

    it("answers the contract shape for a linked pull request", async () => {
      await sendPr({ number: 40, title: "WEB-1 shape", ref: "feature/shape", updatedAt: "2026-10-13T10:00:00Z" });
      await sendRun({ id: 1001, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:10:00Z", prNumbers: [40] });
      const res = await readPrs(taskIds["WEB-1"]);
      expect(res.statusCode).toBe(200);
      const body = res.json() as Body;
      expect(body.taskKey).toBe("WEB-1");
      expect(body.linkable).toBe(true);
      expect(body.repoLinked).toBe(false);
      expect(body.pullRequests).toEqual([
        {
          repo: REPO, number: 40, title: "WEB-1 shape", state: "open", merged: false, draft: false, headRef: "feature/shape",
          url: `https://github.com/${REPO}/pull/40`, authorLogin: "octocat", updatedAt: "2026-10-13T10:00:00.000Z",
          ci: {
            summary: "passing",
            runs: [{ name: "CI", status: "completed", conclusion: "success", url: `https://github.com/${REPO}/actions/runs/1001`, at: "2026-10-13T10:10:00.000Z" }],
          },
        },
      ]);
    });

    it("an empty list is a real none: 200, no pull requests, taskKey present", async () => {
      const res = await readPrs(taskIds["WEB-3"]);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ taskKey: "WEB-3", linkable: true, repoLinked: false, pullRequests: [] });
    });

    it("repoLinked is true when a live github_repos row points at the task's project", async () => {
      const repoId = newId();
      await adminPool().query(
        `INSERT INTO github_repos (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at, origin_site, project_id)
         VALUES ($1, $2, 'gaiadabali', 'dw6f-repo', $3, $4, 'main', now(), $5, $6)`,
        [repoId, org, REPO, `https://github.com/${REPO}`, config.originSite, projectIds.WEB],
      );
      expect(((await readPrs(taskIds["WEB-3"])).json() as Body).repoLinked).toBe(true);
      expect(((await readPrs(taskIds["API-1"])).json() as Body).repoLinked).toBe(false); // another project
      await adminPool().query(`UPDATE github_repos SET deleted_at = now() WHERE id = $1`, [repoId]);
      expect(((await readPrs(taskIds["WEB-3"])).json() as Body).repoLinked).toBe(false); // a deleted link does not count
    });

    it("orders open pull requests first, then by updatedAt descending", async () => {
      await sendPr({ number: 50, title: "WEB-2 closed latest", state: "closed", merged: true, updatedAt: "2026-10-13T15:00:00Z" });
      await sendPr({ number: 51, title: "WEB-2 open older", updatedAt: "2026-10-13T10:00:00Z" });
      await sendPr({ number: 52, title: "WEB-2 open newer", updatedAt: "2026-10-13T12:00:00Z" });
      await sendPr({ number: 53, title: "WEB-2 closed older", state: "closed", updatedAt: "2026-10-13T09:00:00Z" });
      const body = (await readPrs(taskIds["WEB-2"])).json() as Body;
      expect(body.pullRequests.map((p) => p.number)).toEqual([52, 51, 50, 53]);
    });

    it("lists only the pull requests linked to THIS task", async () => {
      await sendPr({ number: 54, title: "WEB-1 mine", updatedAt: "2026-10-13T10:00:00Z" });
      await sendPr({ number: 55, title: "API-1 not mine", updatedAt: "2026-10-13T10:00:00Z" });
      await sendPr({ number: 56, title: "unlinked", updatedAt: "2026-10-13T10:00:00Z" });
      expect(((await readPrs(taskIds["WEB-1"])).json() as Body).pullRequests.map((p) => p.number)).toEqual([54]);
      expect(((await readPrs(taskIds["API-1"])).json() as Body).pullRequests.map((p) => p.number)).toEqual([55]);
    });

    it("computes the CI summary on read: none, running, failing, passing", async () => {
      await sendPr({ number: 60, title: "WEB-3 summary", updatedAt: "2026-10-13T10:00:00Z" });
      const summary = async () => ((await readPrs(taskIds["WEB-3"])).json() as Body).pullRequests[0].ci.summary;
      expect(await summary()).toBe("none");
      await sendRun({ id: 1101, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:10:00Z", prNumbers: [60] });
      await sendRun({ id: 1102, name: "Lint", status: "in_progress", conclusion: null, startedAt: "2026-10-13T10:11:00Z", prNumbers: [60] });
      expect(await summary()).toBe("running");
      await sendRun({ id: 1103, name: "Lint", status: "completed", conclusion: "failure", startedAt: "2026-10-13T10:12:00Z", prNumbers: [60] });
      expect(await summary()).toBe("failing");
      await sendRun({ id: 1104, name: "Lint", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:13:00Z", prNumbers: [60] });
      expect(await summary()).toBe("passing");
      const runs = ((await readPrs(taskIds["WEB-3"])).json() as Body).pullRequests[0].ci.runs;
      expect(runs.map((r) => r.name)).toEqual(["CI", "Lint"]);
    });

    it("403 for a caller refused read on the task (a user of another company on this company's URL)", async () => {
      await sendPr({ number: 61, title: "WEB-1 secret", updatedAt: "2026-10-13T10:00:00Z" });
      expect((await readPrs(taskIds["WEB-1"], org, rival)).statusCode).toBe(403);
    });

    it("404 for another tenant's task, on the caller's own tenant URL (RLS), never a body", async () => {
      await sendPr({ number: 62, title: "WEB-1 not yours", updatedAt: "2026-10-13T10:00:00Z" });
      const res = await readPrs(taskIds["WEB-1"], other, rival);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("not yours");
    });

    it("404 for an unknown or a deleted task in the caller's own tenant", async () => {
      expect((await readPrs(newId())).statusCode).toBe(404);
      const t = await makeTask(projectIds.API, "API doomed read");
      await adminPool().query(`UPDATE pm_tasks SET deleted_at = now() WHERE id = $1`, [t.id]);
      expect((await readPrs(t.id)).statusCode).toBe(404);
    });

    it("linkable is false (and the list empty) in a tenant that does not own the GitHub organisation", async () => {
      const proj = await app.inject({ method: "POST", url: `/api/${other}/projects`, headers: asUser(rival), payload: { name: "Other Proj", isInternal: true } });
      const task = await app.inject({ method: "POST", url: `/api/${other}/pm/tasks`, headers: asUser(rival), payload: { projectId: (proj.json() as { id: string }).id, title: "other task" } });
      expect(task.statusCode).toBe(201);
      const res = await readPrs((task.json() as { id: string }).id, other, rival);
      expect(res.statusCode).toBe(200);
      const body = res.json() as Body;
      expect(body.linkable).toBe(false);
      expect(body.pullRequests).toEqual([]);
      expect(typeof body.taskKey).toBe("string"); // the task has a key; it just cannot be linked here
    });

    it("linkable is false everywhere when the org tenant is not configured", async () => {
      config.githubRepoSync.tenantId = "";
      const body = (await readPrs(taskIds["WEB-1"])).json() as Body;
      expect(body.linkable).toBe(false);
      expect(body.pullRequests).toEqual([]);
    });
  });

  // ── 5. replay and robustness ──────────────────────────────────────────────────────────────────
  describe("delivery handling", () => {
    it("a replayed delivery (same delivery_id) writes nothing twice", async () => {
      const delivery = newId();
      const first = await post("pull_request", delivery, prPayload({ number: 70, title: "WEB-1 replay", updatedAt: "2026-10-13T10:00:00Z" }));
      expect((first.json() as { ok: boolean }).ok).toBe(true);
      const second = await post("pull_request", delivery, prPayload({ action: "edited", number: 70, title: "WEB-2 replayed edit", updatedAt: "2026-10-13T11:00:00Z" }));
      expect(second.json()).toEqual({ ok: true, duplicate: true });
      expect(await prRow(70)).toMatchObject({ title: "WEB-1 replay", pm_task_id: taskIds["WEB-1"] });

      const runDelivery = newId();
      await post("workflow_run", runDelivery, runPayload({ id: 1201, name: "CI", status: "completed", conclusion: "success", startedAt: "2026-10-13T10:10:00Z", prNumbers: [70] }));
      const replay = await post("workflow_run", runDelivery, runPayload({ id: 1202, name: "CI", status: "completed", conclusion: "failure", startedAt: "2026-10-13T10:20:00Z", prNumbers: [70] }));
      expect(replay.json()).toEqual({ ok: true, duplicate: true });
      expect((await prRow(70))!.ci.CI).toMatchObject({ runId: 1201, conclusion: "success" });
      const count = await adminPool().query(`SELECT count(*)::int AS n FROM github_pull_requests WHERE number = 70`);
      expect(count.rows[0].n).toBe(1);
    });

    it("a malformed pull_request payload stores no pull request but never fails the delivery's existing writes", async () => {
      await adminPool().query(
        `INSERT INTO github_repos (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at, origin_site)
         VALUES ($1, $2, 'gaiadabali', 'dw6f-repo', $3, $4, 'main', now(), $5)`,
        [newId(), org, REPO, `https://github.com/${REPO}`, config.originSite],
      );
      const payload = prPayload({ number: 71, title: "WEB-1 malformed", updatedAt: "2026-10-13T10:00:00Z" });
      delete (payload.pull_request as { head?: unknown }).head; // no head.ref: the new part cannot store it
      const res = (await post("pull_request", newId(), payload)).json() as { ok: boolean; note?: string };
      expect(res.ok).toBe(true);
      expect(res.note).toContain("pr_store=skipped");
      expect(await prRow(71)).toBeUndefined();
      const repo = await adminPool().query(`SELECT open_pr_count FROM github_repos WHERE full_name = $1`, [REPO]);
      expect(repo.rows[0].open_pr_count).toBe(1); // today's write still happened
      const wa = await adminPool().query(`SELECT 1 FROM work_activity WHERE source = 'github' AND source_ref = $1`, [`${REPO}#71:opened`]);
      expect(wa.rows.length).toBe(1);
    });

    it("the same pull request number in two repositories is two rows", async () => {
      await sendPr({ number: 72, title: "WEB-1 here", updatedAt: "2026-10-13T10:00:00Z" });
      await sendPr({ number: 72, title: "API-1 there", updatedAt: "2026-10-13T10:00:00Z", repo: "gaiadabali/other-repo" });
      expect((await prRow(72))!.pm_task_id).toBe(taskIds["WEB-1"]);
      expect((await prRow(72, "gaiadabali/other-repo"))!.pm_task_id).toBe(taskIds["API-1"]);
    });
  });
});

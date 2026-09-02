// GH-07 (docs/blueprints/github-integration-foundation.md §4.5, §5.3) — against LIVE Postgres.
// Proves, in order:
//   1. The signature IS the authentication: 401 unsigned/wrong-secret/tampered-body, fail-closed
//      when unconfigured, 400 on missing GitHub headers, 503 when the tenant isn't configured.
//   2. Idempotency on X-GitHub-Delivery, including a TRUE CONCURRENT redelivery storm (same shape
//      as this estate's d14-09-redelivery-storm.test.ts) — exactly one processing, never a
//      double-write.
//   3. §4.5 reverse attribution: a bot push correlates to the right human via the ledger; a copied/
//      stale trailer does NOT falsely attribute (the sha cross-check); a push with no matching
//      ledger row lands unattributed (actor_user_id=NULL, actor_external='gaiada-erp[bot]',
//      payload.unattributed=true) — never silently credited to the bot; an event authored by
//      someone OTHER than the bot is flagged out-of-band, not silently accepted.
//   4. §5.3's volatile github_repos columns update on push/pull_request/workflow_run/repository/
//      release/deployment_status, and the deployed_ref bonus fires on a deploy/* branch push.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { writeActivity } from "./http";
import { resolveGithubActor } from "./github-webhook-handlers";

const SECRET = "gh-webhook-test-secret";
const BOT_LOGIN = "gaiada-erp[bot]";

function sign(bodyStr: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(bodyStr).digest("hex")}`;
}

describe.skipIf(!TEST_URL)("GitHub webhook receiver — POST /api/webhooks/github (GH-07)", () => {
  let app: NestFastifyApplication;
  let co: string;
  const savedSecret = config.githubWebhookSecret;
  const savedTenant = config.githubRepoSync.tenantId;

  async function post(event: string, deliveryId: string, payloadObj: unknown, opts?: { secret?: string; badSig?: boolean }) {
    const body = JSON.stringify(payloadObj);
    const secret = opts?.secret ?? config.githubWebhookSecret;
    const signature = opts?.badSig ? `sha256=${"0".repeat(64)}` : sign(body, secret);
    return app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signature,
      },
      payload: body,
    });
  }

  async function insertRepoRow(fullName: string, defaultBranch = "main"): Promise<void> {
    const [org, name] = fullName.split("/");
    await adminPool().query(
      `INSERT INTO github_repos (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
      [newId(), co, org, name, fullName, `https://github.com/${fullName}`, defaultBranch, config.originSite],
    );
  }

  async function repoRow(fullName: string) {
    const r = await adminPool().query(
      `SELECT * FROM github_repos WHERE full_name = $1 AND deleted_at IS NULL`,
      [fullName],
    );
    return r.rows[0];
  }

  async function workActivityRows(sourceRef: string) {
    const r = await adminPool().query(
      `SELECT * FROM work_activity WHERE source = 'github' AND source_ref = $1`,
      [sourceRef],
    );
    return r.rows;
  }

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("GH-07 Webhook Co");
    config.githubWebhookSecret = SECRET;
    config.githubRepoSync.tenantId = co;
    app = await buildApp();
  });

  afterAll(async () => {
    config.githubWebhookSecret = savedSecret;
    config.githubRepoSync.tenantId = savedTenant;
    await app.close();
    await teardownTestDb();
  });

  afterEach(async () => {
    await adminPool().query(`DELETE FROM work_activity_links`);
    await adminPool().query(`DELETE FROM work_activity`);
    await adminPool().query(`DELETE FROM github_webhook_deliveries`);
    await adminPool().query(`DELETE FROM github_repos`);
    await adminPool().query(`DELETE FROM activities`);
    config.githubWebhookSecret = SECRET;
    config.githubRepoSync.tenantId = co;
  });

  // ── 1. Signature IS the authentication ────────────────────────────────────────────────────────
  describe("signature verification — reject before parsing", () => {
    it("401s with no signature header at all", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/webhooks/github",
        headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": newId() },
        payload: JSON.stringify({ zen: "test" }),
      });
      expect(res.statusCode).toBe(401);
    });

    it("401s with a well-formed but WRONG signature", async () => {
      const res = await post("ping", newId(), { zen: "test" }, { badSig: true });
      expect(res.statusCode).toBe(401);
    });

    it("401s when the body is tampered after signing (signature no longer matches)", async () => {
      const deliveryId = newId();
      const realBody = JSON.stringify({ zen: "real" });
      const signature = sign(realBody, SECRET);
      const res = await app.inject({
        method: "POST", url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json", "x-github-event": "ping",
          "x-github-delivery": deliveryId, "x-hub-signature-256": signature,
        },
        payload: JSON.stringify({ zen: "tampered" }),
      });
      expect(res.statusCode).toBe(401);
    });

    it("FAIL-CLOSED: refuses every request when GITHUB_WEBHOOK_SECRET is unset, even a signature computed with an empty secret", async () => {
      config.githubWebhookSecret = "";
      const body = JSON.stringify({ zen: "x" });
      const res = await app.inject({
        method: "POST", url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json", "x-github-event": "ping",
          "x-github-delivery": newId(), "x-hub-signature-256": sign(body, ""),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    });

    it("400s a correctly-signed request missing X-GitHub-Delivery/X-GitHub-Event", async () => {
      const body = JSON.stringify({ zen: "x" });
      const res = await app.inject({
        method: "POST", url: "/api/webhooks/github",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, SECRET) },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });

    it("503s a correctly-signed, correctly-headered request when the receiver's tenant is unconfigured", async () => {
      config.githubRepoSync.tenantId = "";
      const res = await post("ping", newId(), { zen: "x" });
      expect(res.statusCode).toBe(503);
    });

    it("200s a valid ping", async () => {
      const res = await post("ping", newId(), { zen: "keep it logically awesome" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
    });
  });

  // ── 2. Idempotency on X-GitHub-Delivery ───────────────────────────────────────────────────────
  describe("idempotency", () => {
    it("a SEQUENTIAL redelivery of the same delivery id is a true no-op the second time", async () => {
      await insertRepoRow("gaiadabali/idem-repo");
      const deliveryId = newId();
      const sha = "a".repeat(40);
      const payload = {
        ref: "refs/heads/main",
        after: sha,
        repository: { full_name: "gaiadabali/idem-repo", default_branch: "main" },
        head_commit: { id: sha, message: "seq test", timestamp: new Date().toISOString(), author: { name: "Someone", email: "s@x.test" } },
        commits: [{ id: sha, message: "seq test", timestamp: new Date().toISOString() }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      };
      const first = await post("push", deliveryId, payload);
      const second = await post("push", deliveryId, payload);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(first.body).duplicate).not.toBe(true);
      expect(JSON.parse(second.body).duplicate).toBe(true);

      const rows = await adminPool().query(`SELECT count(*)::int AS n FROM github_webhook_deliveries WHERE delivery_id = $1`, [deliveryId]);
      expect(rows.rows[0].n).toBe(1);
      const activityRows = await workActivityRows(`gaiadabali/idem-repo@${sha}`);
      expect(activityRows).toHaveLength(1);
    });

    it("5 CONCURRENT redeliveries of the SAME delivery id ⇒ exactly ONE processed, no double-write", async () => {
      await insertRepoRow("gaiadabali/storm-repo");
      const deliveryId = newId();
      const sha = "b".repeat(40);
      const payload = {
        ref: "refs/heads/main",
        after: sha,
        repository: { full_name: "gaiadabali/storm-repo", default_branch: "main" },
        head_commit: { id: sha, message: "storm test", timestamp: new Date().toISOString(), author: { name: "Storm", email: "storm@x.test" } },
        commits: [{ id: sha, message: "storm test", timestamp: new Date().toISOString() }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      };
      const results = await Promise.all(Array.from({ length: 5 }, () => post("push", deliveryId, payload)));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      const duplicateFlags = results.map((r) => JSON.parse(r.body).duplicate === true);
      expect(duplicateFlags.filter((d) => d).length).toBe(4);
      expect(duplicateFlags.filter((d) => !d).length).toBe(1);

      const deliveryRows = await adminPool().query(`SELECT count(*)::int AS n FROM github_webhook_deliveries WHERE delivery_id = $1`, [deliveryId]);
      expect(deliveryRows.rows[0].n).toBe(1);
      const activityRows = await workActivityRows(`gaiadabali/storm-repo@${sha}`);
      expect(activityRows).toHaveLength(1);
      const repo = await repoRow("gaiadabali/storm-repo");
      expect(repo.head_sha).toBe(sha);
    });

    it("10 CONCURRENT redeliveries across TWO different delivery ids never cross-contaminate", async () => {
      await insertRepoRow("gaiadabali/storm-repo-2");
      const idA = newId();
      const idB = newId();
      const shaA = "c".repeat(40);
      const shaB = "d".repeat(40);
      const mk = (sha: string) => ({
        ref: "refs/heads/main", after: sha,
        repository: { full_name: "gaiadabali/storm-repo-2", default_branch: "main" },
        head_commit: { id: sha, message: `commit ${sha.slice(0, 4)}`, timestamp: new Date().toISOString() },
        commits: [{ id: sha, message: `commit ${sha.slice(0, 4)}`, timestamp: new Date().toISOString() }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      await Promise.all([
        ...Array.from({ length: 5 }, () => post("push", idA, mk(shaA))),
        ...Array.from({ length: 5 }, () => post("push", idB, mk(shaB))),
      ]);
      const rowsA = await workActivityRows(`gaiadabali/storm-repo-2@${shaA}`);
      const rowsB = await workActivityRows(`gaiadabali/storm-repo-2@${shaB}`);
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
    });
  });

  // ── 3. §4.5 reverse attribution ───────────────────────────────────────────────────────────────
  describe("reverse attribution", () => {
    it("a bot push correlates to the right human via a matching ledger (activities) row", async () => {
      await insertRepoRow("gaiadabali/attr-repo");
      const human = await createUser("attributed-human@gaiada.test");
      const sha = "e".repeat(40);
      await writeActivity(co, human, "github.push", "github_repo", null, {
        repo: "gaiadabali/attr-repo", sha, outcome: "succeeded",
      });
      const res = await post("push", newId(), {
        ref: "refs/heads/main", after: sha,
        repository: { full_name: "gaiadabali/attr-repo", default_branch: "main" },
        head_commit: { id: sha, message: "real work", timestamp: new Date().toISOString() },
        commits: [{ id: sha, message: "real work", timestamp: new Date().toISOString() }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      expect(res.statusCode).toBe(200);
      const rows = await workActivityRows(`gaiadabali/attr-repo@${sha}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(human);
      expect(rows[0].actor_external).toBe(BOT_LOGIN);
      expect(rows[0].payload.unattributed).toBe(false);
    });

    it("REQUIRED PATH: a bot push with NO matching ledger row lands unattributed, never credited to the bot", async () => {
      await insertRepoRow("gaiadabali/gap-repo");
      const sha = "f".repeat(40);
      const res = await post("push", newId(), {
        ref: "refs/heads/main", after: sha,
        repository: { full_name: "gaiadabali/gap-repo", default_branch: "main" },
        head_commit: { id: sha, message: "out of band or a ledger gap", timestamp: new Date().toISOString() },
        commits: [{ id: sha, message: "out of band or a ledger gap", timestamp: new Date().toISOString() }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      expect(res.statusCode).toBe(200);
      const rows = await workActivityRows(`gaiadabali/gap-repo@${sha}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBeNull();
      expect(rows[0].actor_external).toBe(BOT_LOGIN);
      expect(rows[0].payload.unattributed).toBe(true);
    });

    it("an event NOT authored by the bot at all (a human account pushed directly) is flagged out-of-band, never treated as the bot's own gap", async () => {
      await insertRepoRow("gaiadabali/oob-repo");
      const sha = "1".repeat(40);
      const res = await post("push", newId(), {
        ref: "refs/heads/main", after: sha,
        repository: { full_name: "gaiadabali/oob-repo", default_branch: "main" },
        head_commit: { id: sha, message: "direct human push", timestamp: new Date().toISOString() },
        commits: [{ id: sha, message: "direct human push", timestamp: new Date().toISOString() }],
        sender: { login: "some-human-account", type: "User" },
      });
      expect(res.statusCode).toBe(200);
      const rows = await workActivityRows(`gaiadabali/oob-repo@${sha}`);
      expect(rows[0].actor_user_id).toBeNull();
      expect(rows[0].actor_external).toBe("some-human-account");
      expect(rows[0].payload.unattributed).toBe(true);
      expect(rows[0].payload.reason).toMatch(/out-of-band/);
    });

    it("SECURITY: a copied/stale Gaiada-Activity trailer (real row, WRONG sha) does not falsely attribute", async () => {
      await insertRepoRow("gaiadabali/spoof-repo");
      const human = await createUser("spoof-victim@gaiada.test");
      const originalSha = "2".repeat(40);
      const activityId = await writeActivity(co, human, "github.push", "github_repo", null, {
        repo: "gaiadabali/spoof-repo", sha: originalSha, outcome: "succeeded",
      });
      // A NEW commit, a DIFFERENT sha, carrying a copy-pasted trailer pointing at the old (real)
      // activity row. If the trailer alone were trusted, this would wrongly attribute to `human`.
      const forgedSha = "3".repeat(40);
      const res = await post("push", newId(), {
        ref: "refs/heads/main", after: forgedSha,
        repository: { full_name: "gaiadabali/spoof-repo", default_branch: "main" },
        head_commit: { id: forgedSha, message: `unrelated change\n\nGaiada-Activity: ${activityId}`, timestamp: new Date().toISOString() },
        commits: [{ id: forgedSha, message: `unrelated change\n\nGaiada-Activity: ${activityId}`, timestamp: new Date().toISOString() }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      expect(res.statusCode).toBe(200);
      const rows = await workActivityRows(`gaiadabali/spoof-repo@${forgedSha}`);
      expect(rows[0].actor_user_id).toBeNull();
      expect(rows[0].payload.unattributed).toBe(true);
    });

    it("resolveGithubActor: a genuine trailer match (same id AND same sha) short-circuits straight to the human", async () => {
      const human = await createUser("trailer-human@gaiada.test");
      const sha = "4".repeat(40);
      const activityId = await writeActivity(co, human, "github.merge", "github_repo", null, {
        repo: "gaiadabali/trailer-repo", sha, outcome: "succeeded",
      });
      const result = await withTenants([co], (client) =>
        resolveGithubActor(client, co, {
          fullName: "gaiadabali/trailer-repo", sha, commitMessage: `merge PR\n\nGaiada-Activity: ${activityId}`,
          senderLogin: BOT_LOGIN, senderType: "Bot",
        }),
      );
      expect(result.actorUserId).toBe(human);
      expect(result.unattributed).toBe(false);
      expect(result.correlationId).toBe(activityId);
    });
  });

  // ── 4. §5.3 volatile columns ──────────────────────────────────────────────────────────────────
  describe("github_repos fast-path updates", () => {
    it("push to the default branch updates head_sha/head_committed_at/head_author/pushed_at", async () => {
      await insertRepoRow("gaiadabali/state-repo");
      const sha = "5".repeat(40);
      const ts = new Date().toISOString();
      await post("push", newId(), {
        ref: "refs/heads/main", after: sha,
        repository: { full_name: "gaiadabali/state-repo", default_branch: "main" },
        head_commit: { id: sha, message: "state update", timestamp: ts, author: { name: "Jane Dev", email: "jane@gaiada.test" } },
        commits: [{ id: sha, message: "state update", timestamp: ts }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      const repo = await repoRow("gaiadabali/state-repo");
      expect(repo.head_sha).toBe(sha);
      expect(repo.head_author).toBe("Jane Dev <jane@gaiada.test>");
      expect(repo.pushed_at).not.toBeNull();
    });

    it("a push to a NON-default branch does NOT move head_sha", async () => {
      await insertRepoRow("gaiadabali/branch-repo");
      const sha = "6".repeat(40);
      await post("push", newId(), {
        ref: "refs/heads/feature-x", after: sha,
        repository: { full_name: "gaiadabali/branch-repo", default_branch: "main" },
        head_commit: { id: sha, message: "feature work", timestamp: new Date().toISOString() },
        commits: [{ id: sha, message: "feature work", timestamp: new Date().toISOString() }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      const repo = await repoRow("gaiadabali/branch-repo");
      expect(repo.head_sha).toBeNull();
    });

    it("DEPLOYED_REF BONUS: a push to deploy/staging-* sets deployed_ref from the artifact branch", async () => {
      await insertRepoRow("gaiadabali/deploy-repo");
      const sha = "7".repeat(40);
      await post("push", newId(), {
        ref: "refs/heads/deploy/staging-abc123", after: sha,
        repository: { full_name: "gaiadabali/deploy-repo", default_branch: "main" },
        commits: [{ id: sha, message: "artifact publish", timestamp: new Date().toISOString() }],
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      const repo = await repoRow("gaiadabali/deploy-repo");
      expect(repo.deployed_ref).toBe("deploy/staging-abc123");
    });

    it("pull_request opened/closed adjusts open_pr_count (approximate fast path), floored at zero", async () => {
      await insertRepoRow("gaiadabali/pr-repo");
      await post("pull_request", newId(), {
        action: "opened",
        pull_request: { number: 1, title: "add feature", merged: false },
        repository: { full_name: "gaiadabali/pr-repo", default_branch: "main" },
        sender: { login: "someone", type: "User" },
      });
      let repo = await repoRow("gaiadabali/pr-repo");
      expect(repo.open_pr_count).toBe(1);
      await post("pull_request", newId(), {
        action: "closed",
        pull_request: { number: 1, title: "add feature", merged: false },
        repository: { full_name: "gaiadabali/pr-repo", default_branch: "main" },
        sender: { login: "someone", type: "User" },
      });
      repo = await repoRow("gaiadabali/pr-repo");
      expect(repo.open_pr_count).toBe(0);
      // A second close (e.g. a redelivery reaching a DIFFERENT delivery id for the same PR — not
      // idempotency-deduped) must never go negative.
      await post("pull_request", newId(), {
        action: "closed",
        pull_request: { number: 1, title: "add feature", merged: false },
        repository: { full_name: "gaiadabali/pr-repo", default_branch: "main" },
        sender: { login: "someone", type: "User" },
      });
      repo = await repoRow("gaiadabali/pr-repo");
      expect(repo.open_pr_count).toBe(0);
    });

    it("a merged PR correlates via merge_commit_sha exactly like a push", async () => {
      await insertRepoRow("gaiadabali/merge-repo");
      const human = await createUser("merger@gaiada.test");
      const mergeSha = "8".repeat(40);
      await writeActivity(co, human, "github.merge", "github_repo", null, {
        repo: "gaiadabali/merge-repo", sha: mergeSha, outcome: "succeeded",
      });
      await post("pull_request", newId(), {
        action: "closed",
        pull_request: { number: 2, title: "merge me", merged: true, merge_commit_sha: mergeSha },
        repository: { full_name: "gaiadabali/merge-repo", default_branch: "main" },
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      const rows = await workActivityRows("gaiadabali/merge-repo#2:closed");
      expect(rows[0].actor_user_id).toBe(human);
      expect(rows[0].verb).toBe("merged");
    });

    it("workflow_run updates latest_run_status/conclusion/at, and never regresses on an OUT-OF-ORDER older delivery", async () => {
      await insertRepoRow("gaiadabali/ci-repo");
      const newer = new Date(Date.now()).toISOString();
      const older = new Date(Date.now() - 60_000).toISOString();
      await post("workflow_run", newId(), {
        workflow_run: { id: 100, status: "completed", conclusion: "success", run_started_at: newer },
        repository: { full_name: "gaiadabali/ci-repo", default_branch: "main" },
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      await post("workflow_run", newId(), {
        workflow_run: { id: 99, status: "completed", conclusion: "failure", run_started_at: older },
        repository: { full_name: "gaiadabali/ci-repo", default_branch: "main" },
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      const repo = await repoRow("gaiadabali/ci-repo");
      expect(repo.latest_run_conclusion).toBe("success");
    });

    it("repository archived/unarchived flips the boolean", async () => {
      await insertRepoRow("gaiadabali/archive-repo");
      await post("repository", newId(), {
        action: "archived",
        repository: { full_name: "gaiadabali/archive-repo", name: "archive-repo", default_branch: "main", html_url: "https://github.com/gaiadabali/archive-repo" },
        sender: { login: "someone", type: "User" },
      });
      let repo = await repoRow("gaiadabali/archive-repo");
      expect(repo.archived).toBe(true);
      await post("repository", newId(), {
        action: "unarchived",
        repository: { full_name: "gaiadabali/archive-repo", name: "archive-repo", default_branch: "main", html_url: "https://github.com/gaiadabali/archive-repo" },
        sender: { login: "someone", type: "User" },
      });
      repo = await repoRow("gaiadabali/archive-repo");
      expect(repo.archived).toBe(false);
    });

    it("repository deleted soft-deletes the row", async () => {
      await insertRepoRow("gaiadabali/del-repo");
      await post("repository", newId(), {
        action: "deleted",
        repository: { full_name: "gaiadabali/del-repo", name: "del-repo", default_branch: "main", html_url: "https://github.com/gaiadabali/del-repo" },
        sender: { login: "someone", type: "User" },
      });
      const repo = await repoRow("gaiadabali/del-repo");
      expect(repo).toBeUndefined();
    });

    it("release published sets latest_release_tag", async () => {
      await insertRepoRow("gaiadabali/rel-repo");
      await post("release", newId(), {
        action: "published",
        release: { id: 55, tag_name: "v1.2.3" },
        repository: { full_name: "gaiadabali/rel-repo", default_branch: "main" },
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      const repo = await repoRow("gaiadabali/rel-repo");
      expect(repo.latest_release_tag).toBe("v1.2.3");
    });

    it("deployment_status success sets deployed_ref", async () => {
      await insertRepoRow("gaiadabali/ds-repo");
      await post("deployment_status", newId(), {
        deployment_status: { id: 1, state: "success" },
        deployment: { id: 2, ref: "deploy/production-xyz", environment: "production" },
        repository: { full_name: "gaiadabali/ds-repo", default_branch: "main" },
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      const repo = await repoRow("gaiadabali/ds-repo");
      expect(repo.deployed_ref).toBe("deploy/production-xyz");
    });

    it("check_suite is logged as work_activity but NEVER writes latest_run_status (workflow_run owns it)", async () => {
      await insertRepoRow("gaiadabali/cs-repo");
      await post("workflow_run", newId(), {
        workflow_run: { id: 1, status: "completed", conclusion: "success", run_started_at: new Date().toISOString() },
        repository: { full_name: "gaiadabali/cs-repo", default_branch: "main" },
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      await post("check_suite", newId(), {
        action: "completed",
        check_suite: { id: 77, status: "completed", conclusion: "failure" },
        repository: { full_name: "gaiadabali/cs-repo", default_branch: "main" },
        sender: { login: BOT_LOGIN, type: "Bot" },
      });
      const repo = await repoRow("gaiadabali/cs-repo");
      expect(repo.latest_run_conclusion).toBe("success");
      const rows = await workActivityRows("gaiadabali/cs-repo:check_suite:77:completed");
      expect(rows).toHaveLength(1);
    });
  });
});

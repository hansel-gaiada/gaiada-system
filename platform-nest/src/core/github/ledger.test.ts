// GH-04 (docs/blueprints/github-integration-foundation.md §4.3/§4.4/§4.6) — the activities ledger
// wrapper, against LIVE Postgres (RLS, FORCE) — same convention as credential-store.test.ts, needs
// DATABASE_URL_TEST, skips otherwise. No live GitHub call anywhere here: `perform` is a plain fake
// closure, matching the ticket's "no live GitHub API calls from tests" constraint.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser } from "../../testing/fixtures";
import { withGithubLedger, findDanglingGithubAttempts, type GithubLedgerRequest } from "./ledger";
import { writeActivity } from "../http";

describe.skipIf(!TEST_URL)("GH-04 — GitHub activities ledger", () => {
  let co: string;
  let actor: string;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Gaiada GH-04 Co");
    actor = await createUser("actor@gh04.test");
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  async function activityRows(verbLike: string) {
    const r = await adminPool().query(
      `SELECT id, actor_id, verb, target_entity_id, metadata, occurred_at
         FROM activities WHERE tenant_id = $1 AND verb = $2 ORDER BY occurred_at ASC`,
      [co, verbLike],
    );
    return r.rows;
  }

  it("writes an ATTEMPTED row BEFORE perform() runs, and a SUCCEEDED row after — correlated by id", async () => {
    let attemptedRowExistedDuringPerform = false;
    const req: GithubLedgerRequest = {
      tenantId: co, actorId: actor, repo: "gaiadabali/site-a", ref: "refs/heads/main",
      action: "push", attribution: { name: "Real Name", email: "person@gaiada.com" },
    };
    const outcome = await withGithubLedger(req, async ({ correlationId }) => {
      // §4.3: "written before the call" — prove it, don't just trust the ordering of two awaits.
      const rows = await activityRows("github.push");
      attemptedRowExistedDuringPerform = rows.some((r) => r.id === correlationId && r.metadata.outcome === "attempted");
      return { data: { ok: true }, sha: "abc1234" };
    });
    expect(attemptedRowExistedDuringPerform).toBe(true);

    const rows = await activityRows("github.push");
    expect(rows.length).toBe(2);
    const [attempted, succeeded] = rows;
    expect(attempted.metadata.outcome).toBe("attempted");
    expect(attempted.target_entity_id).toBeNull(); // no github_repos.id supplied — GH-04's widening
    expect(attempted.metadata.repo).toBe("gaiadabali/site-a");
    expect(attempted.metadata.attribution).toEqual({ name: "Real Name", email: "person@gaiada.com" });
    expect(succeeded.metadata.outcome).toBe("succeeded");
    expect(succeeded.metadata.correlationId).toBe(attempted.id);
    expect(succeeded.metadata.sha).toBe("abc1234");
    expect(outcome.correlationId).toBe(attempted.id);
    expect(outcome.data).toEqual({ ok: true });
  });

  it("a throwing perform() still leaves the ATTEMPTED row, adds a FAILED row, and re-throws", async () => {
    const req: GithubLedgerRequest = {
      tenantId: co, actorId: actor, repo: "gaiadabali/site-crash",
      action: "deploy",
    };
    await expect(
      withGithubLedger(req, async () => {
        throw new Error("simulated network failure");
      }),
    ).rejects.toThrow("simulated network failure");

    const rows = await activityRows("github.deploy");
    expect(rows.length).toBe(2);
    expect(rows[0].metadata.outcome).toBe("attempted");
    expect(rows[1].metadata.outcome).toBe("failed");
    expect(rows[1].metadata.error).toBe("simulated network failure");
    expect(rows[1].metadata.correlationId).toBe(rows[0].id);
  });

  it("non-commit actions (deploy/secret_write/create_repo/delete_repo) work with NO attribution", async () => {
    const req: GithubLedgerRequest = { tenantId: co, actorId: actor, repo: "gaiadabali/site-b", action: "create_repo" };
    const outcome = await withGithubLedger(req, async () => ({ data: { created: true } }));
    const rows = await activityRows("github.create_repo");
    expect(rows.some((r) => r.id === outcome.correlationId)).toBe(true);
    expect(rows.find((r) => r.metadata.outcome === "attempted")!.metadata.attribution).toBeNull();
  });

  it("actor_id is the human passed in, not null and not a bot marker", async () => {
    const req: GithubLedgerRequest = { tenantId: co, actorId: actor, repo: "gaiadabali/site-c", action: "secret_write" };
    await withGithubLedger(req, async () => ({ data: null }));
    const rows = await activityRows("github.secret_write");
    for (const r of rows) expect(r.actor_id).toBe(actor);
  });

  describe("findDanglingGithubAttempts (§4.6's other half)", () => {
    it("finds an attempted row with no matching succeeded/failed row, once past the grace window", async () => {
      // Simulate the crash case directly: an attempted row with NOTHING after it — withGithubLedger
      // always writes a second row, so this bypasses it deliberately, the same way a real crash
      // between the two writes would.
      const danglingId = await writeActivity(co, actor, "github.merge", "github_repo", null, {
        repo: "gaiadabali/site-dangling", outcome: "attempted", attribution: null,
      });

      const foundImmediately = await findDanglingGithubAttempts(co, 0);
      expect(foundImmediately.some((d) => d.correlationId === danglingId)).toBe(true);
      expect(foundImmediately.find((d) => d.correlationId === danglingId)?.repo).toBe("gaiadabali/site-dangling");
      expect(foundImmediately.find((d) => d.correlationId === danglingId)?.action).toBe("merge");

      // A generous grace window (1 hour) should NOT flag a row written moments ago.
      const foundWithGrace = await findDanglingGithubAttempts(co, 60 * 60 * 1000);
      expect(foundWithGrace.some((d) => d.correlationId === danglingId)).toBe(false);
    });

    it("does NOT flag a completed attempt (has a succeeded row)", async () => {
      const req: GithubLedgerRequest = { tenantId: co, actorId: actor, repo: "gaiadabali/site-complete", action: "deploy" };
      const { correlationId } = await withGithubLedger(req, async () => ({ data: null }));
      const dangling = await findDanglingGithubAttempts(co, 0);
      expect(dangling.some((d) => d.correlationId === correlationId)).toBe(false);
    });

    it("is tenant-scoped — a dangling row in another tenant is invisible", async () => {
      const other = await createCompany("Gaiada GH-04 Rival Co");
      const otherActor = await createUser("rival@gh04.test");
      const danglingId = await writeActivity(other, otherActor, "github.push", "github_repo", null, {
        repo: "rival/repo", outcome: "attempted", attribution: null,
      });
      const foundInHome = await findDanglingGithubAttempts(co, 0);
      expect(foundInHome.some((d) => d.correlationId === danglingId)).toBe(false);
      const foundInOther = await findDanglingGithubAttempts(other, 0);
      expect(foundInOther.some((d) => d.correlationId === danglingId)).toBe(true);
    });
  });
});

// VLT-3 (docs/plans/2026-09-04-client-hosting-credential-vault.md) — the human credential-reveal
// path, against REAL Cerbos + RLS (same posture as `integrations.test.ts`). Rated the highest-risk
// ticket in the set, so every acceptance criterion is driven end to end here, not merely asserted:
//   1. reveal without a grant -> denied (Cerbos DENY, 403/401 — or a domain-level "no such grant").
//   2. single-use: a second reveal on the SAME grant is denied.
//   3. TTL: an expired grant is denied.
//   4. the plaintext never appears in ANY captured log line, nor in any OTHER endpoint's response.
//   5. exactly one audit row per SUCCESSFUL reveal; a denied attempt writes none.
//   6. never self-grantable: the decider may not be the requester.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { setConnectionTokens } from "./integrations.service";
import { setRevealGrantTtlMsForTests } from "./connection-reveal";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("VLT-3 · the credential reveal path", () => {
  let app: NestFastifyApplication;
  let co: string;
  let member: string; // no standing at all on the company-owned connection
  let admin1: string; // files
  let admin2: string; // decides
  let companyConnId: string;
  const PLAINTEXT = "cpanel-super-secret-should-never-leak-vlt3";

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.integrationTokenKey = randomBytes(32).toString("base64");
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Reveal Co");
    member = await createUser("member@reveal.test");
    admin1 = await createUser("admin1@reveal.test");
    admin2 = await createUser("admin2@reveal.test");
    await addMembership(co, member);
    await addMembership(co, admin1);
    await addMembership(co, admin2);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(admin1, await createRole("company_admin"), "company", co);
    await grantRole(admin2, await createRole("company_admin"), "company", co);
    app = await buildApp();

    const create = await app.inject({
      method: "POST", url: `/api/${co}/integrations/connections`, headers: asUser(admin1),
      payload: { ownerKind: "company", provider: "cpanel" },
    });
    companyConnId = create.json().id;
    await setConnectionTokens(co, companyConnId, { accessToken: PLAINTEXT });
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const connBase = () => `/api/${co}/integrations/connections/${companyConnId}`;
  const decideUrl = (id: string) => `/api/${co}/automation-approvals/${id}/decide`;

  async function activityCount(verb: string): Promise<number> {
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM activities WHERE tenant_id = $1 AND verb = $2 AND target_entity_id = $3`,
      [co, verb, companyConnId],
    );
    return Number(rows[0].n);
  }

  // ── Criterion 1: reveal without a grant is denied ────────────────────────────────────────────────
  it("a principal with NO standing on this connection at all gets a Cerbos DENY filing a request", async () => {
    const r = await app.inject({
      method: "POST", url: `${connBase()}/reveal-requests`, headers: asUser(member), payload: {},
    });
    expect(r.statusCode).toBe(403);
  });

  it("redeem with a bogus/never-filed approvalId is denied (no grant to spend)", async () => {
    const r = await app.inject({
      method: "POST", url: `${connBase()}/reveal`, headers: asUser(admin1),
      payload: { approvalId: "00000000-0000-0000-0000-000000000000" },
    });
    expect([400, 404]).toContain(r.statusCode);
  });

  it("redeem before ANY decision (still pending in the approval sense, i.e. status!='approved') is denied", async () => {
    const file = await app.inject({
      method: "POST", url: `${connBase()}/reveal-requests`, headers: asUser(admin1), payload: {},
    });
    expect(file.statusCode).toBe(201);
    const approvalId = file.json().id;
    const r = await app.inject({
      method: "POST", url: `${connBase()}/reveal`, headers: asUser(admin1), payload: { approvalId },
    });
    expect(r.statusCode).toBe(400);
    expect(await activityCount("revealed")).toBe(0);
  });

  // ── Criterion 6: never self-grantable ────────────────────────────────────────────────────────────
  it("the FILER may not also be the DECIDER — self-approval is refused, and the row stays pending", async () => {
    const file = await app.inject({
      method: "POST", url: `${connBase()}/reveal-requests`, headers: asUser(admin1), payload: {},
    });
    const approvalId = file.json().id;
    const r = await app.inject({
      method: "POST", url: decideUrl(approvalId), headers: asUser(admin1), payload: { decision: "approved" },
    });
    expect(r.statusCode).toBe(403);
    // Confirm it is genuinely still undecided — a DIFFERENT admin can still approve it below.
    const redeemAttempt = await app.inject({
      method: "POST", url: `${connBase()}/reveal`, headers: asUser(admin1), payload: { approvalId },
    });
    expect(redeemAttempt.statusCode).toBe(400); // grant_not_approved
  });

  // ── The full happy path + single-use + audit + no-logging, all against ONE grant ────────────────
  let happyApprovalId: string;
  it("files, a DIFFERENT admin approves (lifts the gate only — no plaintext in the decide response)", async () => {
    const file = await app.inject({
      method: "POST", url: `${connBase()}/reveal-requests`, headers: asUser(admin1), payload: {},
    });
    happyApprovalId = file.json().id;
    const decide = await app.inject({
      method: "POST", url: decideUrl(happyApprovalId), headers: asUser(admin2), payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);
    expect(JSON.stringify(decide.json())).not.toContain(PLAINTEXT);
  });

  it("redeems successfully exactly once, and the plaintext never touches any log line", async () => {
    const captured: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => {
      const orig = console[m];
      console[m] = (...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        return orig.apply(console, args as []);
      };
      return { m, orig };
    });
    let r: Awaited<ReturnType<typeof app.inject>>;
    try {
      r = await app.inject({
        method: "POST", url: `${connBase()}/reveal`, headers: asUser(admin1), payload: { approvalId: happyApprovalId },
      });
    } finally {
      for (const { m, orig } of spies) console[m] = orig;
    }
    expect(r.statusCode).toBe(200);
    expect(r.json().value).toBe(PLAINTEXT);
    expect(captured.some((line) => line.includes(PLAINTEXT))).toBe(false);
    expect(await activityCount("revealed")).toBe(1);
  });

  it("SINGLE-USE: a second redeem on the SAME approvalId is denied — server-side, not client convention", async () => {
    const r = await app.inject({
      method: "POST", url: `${connBase()}/reveal`, headers: asUser(admin1), payload: { approvalId: happyApprovalId },
    });
    expect(r.statusCode).toBe(400);
    // The audit table's row count is the ground truth: still exactly one, never two.
    expect(await activityCount("revealed")).toBe(1);
  });

  it("the plaintext never appears in the approvals list/detail response, nor in the connections list", async () => {
    const detail = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals/${happyApprovalId}`, headers: asUser(admin1) });
    expect(JSON.stringify(detail.json())).not.toContain(PLAINTEXT);
    const list = await app.inject({ method: "GET", url: `/api/${co}/integrations/connections?owner=company`, headers: asUser(admin1) });
    expect(JSON.stringify(list.json())).not.toContain(PLAINTEXT);
  });

  it("increments reveal_count and stamps last_revealed_at on the connection row", async () => {
    const { rows } = await adminPool().query<{ reveal_count: number; last_revealed_at: Date | null }>(
      `SELECT reveal_count, last_revealed_at FROM integration_connections WHERE id = $1`, [companyConnId],
    );
    expect(rows[0].reveal_count).toBeGreaterThanOrEqual(1);
    expect(rows[0].last_revealed_at).not.toBeNull();
  });

  // ── Criterion 3: TTL expiry denies, never decrypts ───────────────────────────────────────────────
  it("TTL: an approved grant past its TTL is denied, and never returns the plaintext", async () => {
    setRevealGrantTtlMsForTests(30);
    try {
      const file = await app.inject({
        method: "POST", url: `${connBase()}/reveal-requests`, headers: asUser(admin1), payload: {},
      });
      const approvalId = file.json().id;
      const decide = await app.inject({
        method: "POST", url: decideUrl(approvalId), headers: asUser(admin2), payload: { decision: "approved" },
      });
      expect(decide.statusCode).toBe(200);
      await new Promise((res) => setTimeout(res, 60));
      const r = await app.inject({
        method: "POST", url: `${connBase()}/reveal`, headers: asUser(admin1), payload: { approvalId },
      });
      expect(r.statusCode).toBe(400);
      expect(JSON.stringify(r.json())).not.toContain(PLAINTEXT);
    } finally {
      setRevealGrantTtlMsForTests(null);
    }
  });

  it("a REJECTED request can never be redeemed", async () => {
    const file = await app.inject({
      method: "POST", url: `${connBase()}/reveal-requests`, headers: asUser(admin1), payload: {},
    });
    const approvalId = file.json().id;
    const decide = await app.inject({
      method: "POST", url: decideUrl(approvalId), headers: asUser(admin2), payload: { decision: "rejected" },
    });
    expect(decide.statusCode).toBe(200);
    const r = await app.inject({
      method: "POST", url: `${connBase()}/reveal`, headers: asUser(admin1), payload: { approvalId },
    });
    expect(r.statusCode).toBe(400);
  });

  it("filing is refused outright when the connection has no stored credential", async () => {
    const bare = await app.inject({
      method: "POST", url: `/api/${co}/integrations/connections`, headers: asUser(admin1),
      payload: { ownerKind: "company", provider: "ftp" },
    });
    const bareId = bare.json().id;
    const r = await app.inject({
      method: "POST", url: `/api/${co}/integrations/connections/${bareId}/reveal-requests`, headers: asUser(admin1), payload: {},
    });
    expect(r.statusCode).toBe(400);
  });
});

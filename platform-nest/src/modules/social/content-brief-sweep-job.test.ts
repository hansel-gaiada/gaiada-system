// SMM-26 follow-up — the scheduled `smm-content-brief-sweep`, against LIVE Postgres (RLS) + the
// real `/principal/resolve` endpoint. The identity boundary is the whole point of this ticket, so
// it is TESTED here rather than merely asserted in a comment: what the sweep's dedicated automation
// principal can and cannot see, both before and after this file's own reconciliation runs.
//
// Cerbos is never touched — this sweep calls `authorize()` nowhere (same as every other
// `*-job.ts` file in this module), so there is nothing to stub.
//
// A LOCALLY-SCOPED "gateway"/knowledge stand-in (recurring defect class #7) — never
// `content-brief.test.ts`'s own module-level mocks, which that file's own `it()`s already depend on
// in file-declaration order.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withGlobal, withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";
import {
  ensureContentBriefSweepPrincipal,
  reconcileContentBriefSweepMembership,
  runContentBriefSweep,
  CONTENT_BRIEF_SWEEP_PRINCIPAL_EMAIL,
} from "./content-brief-sweep-job";
import { queryBrandKnowledge } from "./knowledge-client";

const { completeMock, prompts } = vi.hoisted(() => ({
  completeMock: vi.fn(async (prompt: string) => {
    if (prompt.includes("Write in this brand's voice")) {
      return { text: JSON.stringify({ body: "swept caption", hashtags: [] }), provider: "hermes-mock" };
    }
    if (prompt.includes("Generate exactly")) {
      const m = prompt.match(/Generate exactly (\d+) distinct/);
      const n = m ? Number(m[1]) : 1;
      const ideas = Array.from({ length: n }, (_, i) => ({ title: `Swept idea ${i + 1}`, brief: `Brief ${i + 1}` }));
      return { text: JSON.stringify({ ideas }), provider: "hermes-mock" };
    }
    return { text: "{}", provider: "hermes-mock" };
  }),
  prompts: [] as Array<{ scope: string | undefined; prompt: string }>,
}));
vi.mock("./gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-client")>();
  return {
    ...actual,
    completeViaGateway: async (prompt: string) => completeMock(prompt),
  };
});

const svc = { authorization: "Bearer svc-token" };

describe.skipIf(!TEST_URL)("social smm-content-brief-sweep (SMM-26 follow-up)", () => {
  let app: NestFastifyApplication;
  let A: string; // tenant with an opted-in engagement
  let B: string; // tenant with NO opted-in engagement, ever
  let clientA: string;
  let clientA2: string;
  let fakeServer: Server;
  let ingested: Record<string, string[]>;
  let searches: Array<{ scope: string; query: string }>;

  async function makeAccount(tenantId: string, clientId: string, network = "instagram"): Promise<string> {
    const accId = newId();
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
         VALUES ($1,$2,$3,$4,'env:KEY','central') ON CONFLICT (tenant_id, client_id) DO NOTHING`,
        [newId(), tenantId, clientId, `org-${tenantId}-${clientId}`],
      );
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM social_publisher_orgs WHERE tenant_id=$1 AND client_id=$2`, [tenantId, clientId],
      );
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'connected','{}'::jsonb,'central')`,
        [accId, tenantId, clientId, rows[0].id, network, `@h-${accId}`],
      );
    }, { modules: ["social"] });
    return accId;
  }

  /** Raw-SQL engagement creation (not through the HTTP endpoint) — this file's own scope is the
   *  sweep's DB-level behavior, not the controller SMM-26 already covers. */
  async function makeEngagement(
    tenantId: string, clientId: string, name: string, toolScope: Record<string, unknown>,
  ): Promise<string> {
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, tool_scope, origin_site)
         VALUES ($1,$2,$3,$4,$5,'central')`,
        [id, tenantId, clientId, name, JSON.stringify(toolScope)],
      ),
    { modules: ["social"] });
    return id;
  }

  async function resolvePrincipal(): Promise<{ assurance: string; companies: string[]; userId: string | null }> {
    const res = await app.inject({
      method: "POST", url: "/principal/resolve", headers: svc,
      payload: { provider: "platform", externalId: await ensureContentBriefSweepPrincipal() },
    });
    return res.json();
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.services.gateway = { url: "https://gateway.test", token: "gw-tok" };

    A = await createCompany("SMM26-Sweep Co A", ["social"]);
    B = await createCompany("SMM26-Sweep Co B", ["social"]);
    clientA = await createClient(A, "Sweep Brand A1");
    clientA2 = await createClient(A, "Sweep Brand A2");

    ingested = {};
    searches = [];
    fakeServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === "POST" && req.url === "/search") {
          searches.push({ scope: body.scope, query: body.query });
          const chunks = ingested[body.scope as string] ?? [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ hits: chunks.map((text, i) => ({ sourceRef: `${body.scope}#${i}`, text, score: 0.9 })) }));
        } else {
          res.writeHead(404);
          res.end("{}");
        }
      });
    });
    const base = await new Promise<string>((resolve) => {
      fakeServer.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`));
    });
    config.services.knowledge = { url: base, token: "kn-tok" };

    app = await buildApp();

    // Warm the principal's self-link ONCE, through the REAL mechanism
    // (`knowledge-client.ts#queryBrandKnowledge` -> `selfLinkUpsert`) — the same lazy, on-first-use
    // path a human caller's own OBO userId already rides (SMM-19). Isolated here, in `beforeAll`,
    // specifically so the (P2)/(P3)/(P4) tests below are testing the MEMBERSHIP boundary this
    // ticket adds, not the pre-existing self-link lifecycle every `queryBrandKnowledge` caller
    // shares — proven as its OWN fact, not assumed.
    const principalUserId = await ensureContentBriefSweepPrincipal();
    await queryBrandKnowledge(principalUserId, A, clientA, "warm self-link", 1);
    const linked = await withGlobal((c) =>
      c.query<{ verified_at: string | null }>(
        `SELECT verified_at FROM identity_links WHERE provider = 'platform' AND external_id = $1`,
        [principalUserId],
      ),
    );
    if (!linked.rows[0]?.verified_at) throw new Error("self-link warm-up did not verify — test setup is wrong, not the code under test");
  });

  afterAll(async () => {
    await app?.close();
    config.services.knowledge = { url: "", token: "" };
    await new Promise<void>((r) => fakeServer.close(() => r()));
    await teardownTestDb();
  });

  beforeEach(() => {
    completeMock.mockClear();
    prompts.length = 0;
    searches.length = 0;
  });

  // ══════════════════════════════════════ IDENTITY BOUNDARY ═══════════════════════════════════════

  it("(P0) the sweep principal is a real, idempotent users row, kind='automation', with the documented email", async () => {
    const id1 = await ensureContentBriefSweepPrincipal();
    const id2 = await ensureContentBriefSweepPrincipal(); // second call must find, not duplicate
    expect(id2).toBe(id1);

    const { rows } = await withGlobal((c) =>
      c.query<{ email: string; kind: string }>(`SELECT email, kind FROM users WHERE id = $1`, [id1]),
    );
    expect(rows[0]).toEqual({ email: CONTENT_BRIEF_SWEEP_PRINCIPAL_EMAIL, kind: "automation" });
  });

  it("(P1) the sweep principal NEVER holds a Cerbos role grant, before or after operating across tenants", async () => {
    const principalUserId = await ensureContentBriefSweepPrincipal();
    await reconcileContentBriefSweepMembership(principalUserId, [A, B]);

    const { rows } = await withGlobal((c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM user_roles WHERE user_id = $1`, [principalUserId]),
    );
    expect(rows[0].n).toBe("0");

    await reconcileContentBriefSweepMembership(principalUserId, []); // clean up for later tests
  });

  it("(P2) BEFORE any opted-in engagement exists for a tenant, /principal/resolve does NOT authorize it — the coarse gate genuinely denies on absent membership, not merely because the identity is unresolvable", async () => {
    const principalUserId = await ensureContentBriefSweepPrincipal();
    await reconcileContentBriefSweepMembership(principalUserId, []); // start from zero membership

    const resolved = await resolvePrincipal();
    // The self-link is already warmed (beforeAll), so this identity DOES resolve — "linked", NOT
    // mcp-hub's separate "low" concept (see file header of content-brief-sweep-job.ts). The denial
    // below is therefore genuinely about the ABSENT MEMBERSHIP, not about an unresolvable identity.
    expect(resolved.assurance).toBe("linked");
    expect(resolved.companies).not.toContain(A);
    expect(resolved.companies).not.toContain(B);
  });

  it("(P3) reconciliation grants a tenant ONLY once it has >=1 currently opted-in engagement, and /principal/resolve reflects it immediately", async () => {
    const principalUserId = await ensureContentBriefSweepPrincipal();
    await reconcileContentBriefSweepMembership(principalUserId, []); // start clean

    const before = await resolvePrincipal();
    expect(before.companies).not.toContain(A);

    const { granted, revoked } = await reconcileContentBriefSweepMembership(principalUserId, [A]);
    expect(granted).toEqual([A]);
    expect(revoked).toEqual([]);

    const after = await resolvePrincipal();
    expect(after.companies).toContain(A);
    expect(after.companies).not.toContain(B); // never widened to a tenant it was not given
  });

  it("(P4) losing its last opted-in engagement REVOKES the tenant, and it can be re-granted later — scope tracks the LIVE opt-in set, not a high-water mark", async () => {
    const principalUserId = await ensureContentBriefSweepPrincipal();
    await reconcileContentBriefSweepMembership(principalUserId, [A]);
    expect((await resolvePrincipal()).companies).toContain(A);

    const { revoked } = await reconcileContentBriefSweepMembership(principalUserId, []); // A opted every engagement out
    expect(revoked).toEqual([A]);
    expect((await resolvePrincipal()).companies).not.toContain(A);

    const { granted } = await reconcileContentBriefSweepMembership(principalUserId, [A]); // re-opts in later
    expect(granted).toEqual([A]);
    expect((await resolvePrincipal()).companies).toContain(A);

    await reconcileContentBriefSweepMembership(principalUserId, []); // leave clean for later tests
  });

  // ══════════════════════════════════════ THE SWEEP ITSELF ════════════════════════════════════════

  it("(T1) drafts for an opted-in engagement, and a second sweep on the SAME tick does NOT double-draft (restart-safety)", async () => {
    const acc = await makeAccount(A, clientA, "instagram");
    const eng = await makeEngagement(A, clientA, "Weekly Eng", {
      networks: { instagram: true }, posting: { cadencePerWeek: 2 }, contentBrief: { scheduledEnabled: true },
    });

    const first = await runContentBriefSweep();
    expect(first.engagementsDue).toBe(1);
    expect(first.drafted).toBe(1);
    expect(first.errors).toBe(0);
    expect(first.membershipsGranted).toContain(A);

    const postsAfterFirst = await withTenants([A], (c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM social_posts WHERE engagement_id = $1`, [eng]),
    { modules: ["social"] });
    expect(postsAfterFirst.rows[0].n).toBe("2"); // cadencePerWeek, never invented

    // RED (would-be defect): calling the sweep again immediately, with NO cadence gate, would draft
    // a SECOND batch of 2 ideas for the same engagement — restart-induced duplicate spend. Proven
    // GREEN below: the cadence check (`content_brief_last_run_at` stamped by the first call) makes
    // the SAME engagement NOT due on an immediate second tick.
    const second = await runContentBriefSweep();
    expect(second.engagementsDue).toBe(0); // NOT due — stamped by the first run, cutoff not elapsed

    const postsAfterSecond = await withTenants([A], (c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM social_posts WHERE engagement_id = $1`, [eng]),
    { modules: ["social"] });
    expect(postsAfterSecond.rows[0].n).toBe("2"); // UNCHANGED — no double-draft

    // Membership follows the live opt-in set: A now has an opted-in engagement, so it was granted.
    expect((await resolvePrincipal()).companies).toContain(A);

    await withTenants([A], (c) => c.query(`UPDATE social_engagements SET tool_scope = '{}' WHERE id = $1`, [eng]), { modules: ["social"] });
    void acc;
  });

  it("(T2) an engagement with NO contentBrief.scheduledEnabled flag is never swept, even sitting next to one that IS opted in", async () => {
    await makeAccount(A, clientA2, "linkedin");
    const optedOut = await makeEngagement(A, clientA2, "Never Opted In", {
      networks: { linkedin: true }, posting: { cadencePerWeek: 3 }, // no contentBrief key at all — absence
    });
    const optedIn = await makeEngagement(A, clientA2, "Opted In", {
      networks: { linkedin: true }, posting: { cadencePerWeek: 1 }, contentBrief: { scheduledEnabled: true },
    });

    const result = await runContentBriefSweep();
    expect(result.engagementsDue).toBe(1); // ONLY the opted-in one

    const optedOutPosts = await withTenants([A], (c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM social_posts WHERE engagement_id = $1`, [optedOut]),
    { modules: ["social"] });
    expect(optedOutPosts.rows[0].n).toBe("0");

    const optedInPosts = await withTenants([A], (c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM social_posts WHERE engagement_id = $1`, [optedIn]),
    { modules: ["social"] });
    expect(optedInPosts.rows[0].n).toBe("1");
  });

  it("(T3) a tenant with ZERO opted-in engagements is never granted membership by the sweep, and its own WS8 corpus stays outside the principal's coarse gate", async () => {
    const principalUserId = await ensureContentBriefSweepPrincipal();
    await reconcileContentBriefSweepMembership(principalUserId, []); // clean slate

    const result = await runContentBriefSweep();
    expect(result.membershipsGranted).not.toContain(B); // B never had an opted-in engagement in this suite
    const resolved = await resolvePrincipal();
    expect(resolved.companies).not.toContain(B);
  });
});

// SMM-19 — brand-voice RAG + AI drafting against LIVE Postgres (RLS) + the real HTTP layer, same
// harness as search/search-ai-drafts.test.ts. Cerbos is stubbed to always-allow (parity matrix is
// social.test.ts's job) — this file exercises what SMM-19 actually owns: brand-corpus ingest,
// caption/hashtag/idea drafting through the gateway, the hashtag_strategy + media-rules.ts cap
// enforcement, the ai.drafting/ai.imageGen refusals, and — the assertion that matters most —
// PROVABLE cross-client retrieval isolation.
//
// completeViaGateway is mocked at the module boundary (gateway-client.test.ts already proves the
// real single-host HTTP contract in isolation); the WS8 knowledge service is a REAL local HTTP
// server (node:http) that reimplements the actual isolation predicate WS8's store.search enforces
// (ai-agents/src/knowledge/store.ts: chunks are only ever returned to a `scope` that matches how
// they were ingested) — so the leak test below is not just "we called the client with the right
// argument", it is "even a store holding BOTH clients' corpora never hands back the wrong one".
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

// Deterministic "gateway" stand-in: echoes which brand's excerpt (if any) reached the prompt, so
// assertions can prove the grounding directly rather than trusting the plumbing.
const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(async (prompt: string, opts?: { provider?: string }) => {
    if (prompt.includes("caption")) {
      const sawA = prompt.includes("CLIENT_A_SECRET_CAMPAIGN");
      const sawB = prompt.includes("CLIENT_B_SECRET_CAMPAIGN");
      return {
        text: JSON.stringify({ body: `caption sawA=${sawA} sawB=${sawB}`, hashtags: ["brandtag", "promo", "extra"] }),
        provider: opts?.provider === "claude" ? "claude-mock" : "hermes-mock",
      };
    }
    if (prompt.includes("content ideas")) {
      return { text: JSON.stringify({ ideas: [{ title: "Spring idea", brief: "b1" }, { title: "Summer idea", brief: "b2" }] }), provider: "hermes-mock" };
    }
    return { text: "{}", provider: "hermes-mock" };
  }),
}));
vi.mock("./gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-client")>();
  return { ...actual, completeViaGateway: completeMock };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("social brand-voice RAG + AI drafting (SMM-19)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let uA: string;
  let clientA: string;
  let clientB: string;
  let engA: string;
  let engB: string;
  let fakeServer: Server;
  let ingested: Record<string, string[]>;
  let searches: Array<{ scope: string; query: string }>;

  async function makeAccount(client: string, network = "instagram"): Promise<string> {
    const accId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
         VALUES ($1,$2,$3,$4,'env:KEY','central') ON CONFLICT (tenant_id, client_id) DO NOTHING`,
        [newId(), A, client, `org-${A}-${client}`],
      );
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM social_publisher_orgs WHERE tenant_id=$1 AND client_id=$2`, [A, client]);
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'connected','{}'::jsonb,'central')`,
        [accId, A, client, rows[0].id, network, `@h-${accId}`],
      );
    }, { modules: ["social"] });
    return accId;
  }

  async function makePost(engagementId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts`, headers: asUser(uA),
      payload: { engagementId, title: "SMM-19 probe" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function makeVariant(postId: string, accountId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants`, headers: asUser(uA),
      payload: { accountId, body: "placeholder" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.services.gateway = { url: "https://gateway.test", token: "gw-tok" };
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SMM19 Co", ["social"]);
    uA = await createUser("smm19@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "Brand A");
    clientB = await createClient(A, "Brand B");

    app = await buildApp();

    const engARes = await app.inject({ method: "POST", url: `/api/${A}/modules/social/engagements`, headers: asUser(uA), payload: { clientId: clientA, name: "Engagement A" } });
    engA = engARes.json().id;
    const engBRes = await app.inject({ method: "POST", url: `/api/${A}/modules/social/engagements`, headers: asUser(uA), payload: { clientId: clientB, name: "Engagement B" } });
    engB = engBRes.json().id;

    // The fake WS8 knowledge service: /ingest records chunks under the REQUESTED scope; /search
    // filters by the requested scope. This is the SAME predicate real WS8 enforces
    // (store.search: `acl = '{}' OR scope = ANY(acl)`, and ingest sets `acl:[scope]`) — a fixture
    // that actually behaves like the isolation boundary, not just a stub that echoes the input.
    ingested = {};
    searches = [];
    fakeServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === "POST" && req.url === "/ingest") {
          ingested[body.sourceRef as string] = body.chunks as string[];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ written: (body.chunks as string[]).length }));
        } else if (req.method === "POST" && req.url === "/search") {
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
  });

  afterAll(async () => {
    await app?.close();
    config.services.knowledge = { url: "", token: "" };
    await new Promise<void>((r) => fakeServer.close(() => r()));
    await teardownTestDb();
  });

  // ── ingest ─────────────────────────────────────────────────────────────────────────────────────
  it("ingests each client's brand corpus into its OWN WS8 scope, and records the pointer (never text)", async () => {
    const ingestA = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/brand-corpus/ingest`, headers: asUser(uA),
      payload: { chunks: ["We always highlight the CLIENT_A_SECRET_CAMPAIGN launch details."] },
    });
    expect(ingestA.statusCode).toBe(200);
    expect(ingestA.json().knowledgeSourceIds).toEqual([`social-brand:${A}:${clientA}`]);

    const ingestB = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engB}/brand-corpus/ingest`, headers: asUser(uA),
      payload: { chunks: ["We always highlight the CLIENT_B_SECRET_CAMPAIGN launch details."] },
    });
    expect(ingestB.statusCode).toBe(200);
    expect(ingestB.json().knowledgeSourceIds).toEqual([`social-brand:${A}:${clientB}`]);

    // The knowledge_source_ids POINTER landed on the brand profile — never the chunk text itself.
    const profileA = await app.inject({ method: "GET", url: `/api/${A}/modules/social/brand-profiles/${clientA}`, headers: asUser(uA) });
    expect(profileA.json().knowledgeSourceIds).toEqual([`social-brand:${A}:${clientA}`]);
    expect(JSON.stringify(profileA.json())).not.toContain("CLIENT_A_SECRET_CAMPAIGN");

    expect(Object.keys(ingested).sort()).toEqual([`social-brand:${A}:${clientA}`, `social-brand:${A}:${clientB}`].sort());
  });

  // ── THE CROSS-CLIENT LEAK TEST — the assertion the ticket calls out as mattering most ──────────
  it("CROSS-CLIENT LEAK TEST: drafting for client A's variant never retrieves or quotes client B's corpus", async () => {
    const postId = await makePost(engA);
    const accountId = await makeAccount(clientA, "instagram");
    const variantId = await makeVariant(postId, accountId);

    completeMock.mockClear();
    const draft = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants/${variantId}/draft-caption`, headers: asUser(uA),
    });
    expect(draft.statusCode).toBe(200);
    // The prompt Hermes actually saw contained client A's excerpt and NEVER client B's — even
    // though the fake store holds both, and even though this is the same tenant/company.
    expect(draft.json().draft.body).toContain("sawA=true");
    expect(draft.json().draft.body).toContain("sawB=false");
    // groundedOn only ever names client A's own scope-prefixed sourceRefs.
    const refs = draft.json().groundedOn as string[];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref.startsWith(`social-brand:${A}:${clientA}#`)).toBe(true);
    // The WS8 request itself only ever asked for client A's scope.
    const lastSearch = searches[searches.length - 1];
    expect(lastSearch.scope).toBe(`social-brand:${A}:${clientA}`);
    expect(lastSearch.scope).not.toBe(`social-brand:${A}:${clientB}`);
  });

  it("...and the same holds in reverse: client B's draft never sees client A's corpus", async () => {
    const postId = await makePost(engB);
    const accountId = await makeAccount(clientB, "linkedin");
    const variantId = await makeVariant(postId, accountId);

    completeMock.mockClear();
    const draft = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants/${variantId}/draft-caption`, headers: asUser(uA),
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().draft.body).toContain("sawA=false");
    expect(draft.json().draft.body).toContain("sawB=true");
    const lastSearch = searches[searches.length - 1];
    expect(lastSearch.scope).toBe(`social-brand:${A}:${clientB}`);
  });

  // ── hashtag_strategy + media-rules.ts reuse ───────────────────────────────────────────────────
  it("hashtags respect hashtag_strategy AND the network's own cap — media-rules.ts is REUSED, not duplicated", async () => {
    await app.inject({
      method: "PATCH", url: `/api/${A}/modules/social/brand-profiles/${clientA}`, headers: asUser(uA),
      payload: { hashtagStrategy: { maxCount: 1, requiredTags: ["AlwaysThis"] } },
    });
    const postId = await makePost(engA);
    const accountId = await makeAccount(clientA, "instagram");
    const variantId = await makeVariant(postId, accountId);

    const draft = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants/${variantId}/draft-caption`, headers: asUser(uA),
    });
    expect(draft.statusCode).toBe(200);
    // The model proposed 3 tags (brandtag, promo, extra); the brand's strategy caps at 1 and
    // requires "AlwaysThis" — the required tag wins the one slot, not the model's own choice.
    expect(draft.json().draft.hashtags).toEqual(["AlwaysThis"]);

    // reset for later tests
    await app.inject({
      method: "PATCH", url: `/api/${A}/modules/social/brand-profiles/${clientA}`, headers: asUser(uA),
      payload: { hashtagStrategy: {} },
    });
  });

  // ── the AI edit is still an edit: the state law holds at this call site too ──────────────────
  it("an AI-authored edit invalidates an existing approval, exactly like a human PATCH", async () => {
    const postId = await makePost(engA);
    const accountId = await makeAccount(clientA, "linkedin");
    const variantId = await makeVariant(postId, accountId);
    const approvalId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, origin, requested_by, origin_site)
         VALUES ($1,$2,'smm19-fixture','social.publishPost','{}'::jsonb,'high','approved','automation',$3,'central')`,
        [approvalId, A, uA],
      );
      await c.query(`UPDATE social_post_variants SET status='approved', approval_id=$1 WHERE id=$2`, [approvalId, variantId]);
    }, { modules: ["social"] });

    const draft = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants/${variantId}/draft-caption`, headers: asUser(uA),
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().approvalInvalidated).toBe(true);

    const { rows } = await withTenants([A], (c) => c.query<{ status: string; approval_id: string | null }>(
      `SELECT status, approval_id FROM social_post_variants WHERE id=$1`, [variantId]), { modules: ["social"] });
    expect(rows[0].status).toBe("draft");
    expect(rows[0].approval_id).toBeNull();
  });

  // ── tool_scope gates ──────────────────────────────────────────────────────────────────────────
  it("refuses ai_drafting_disabled (named toggle) when the engagement's tool_scope.ai.drafting is off", async () => {
    await app.inject({
      method: "PATCH", url: `/api/${A}/modules/social/engagements/${engA}/scope`, headers: asUser(uA),
      payload: { toolScope: { ai: { drafting: false } } },
    });
    const postId = await makePost(engA);
    const accountId = await makeAccount(clientA, "instagram");
    const variantId = await makeVariant(postId, accountId);

    completeMock.mockClear();
    const draft = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants/${variantId}/draft-caption`, headers: asUser(uA),
    });
    expect(draft.statusCode).toBe(400);
    expect(draft.json().error).toBe("ai_drafting_disabled");
    expect(completeMock).not.toHaveBeenCalled(); // refused BEFORE any gateway egress was attempted

    await app.inject({
      method: "PATCH", url: `/api/${A}/modules/social/engagements/${engA}/scope`, headers: asUser(uA),
      payload: { toolScope: { ai: { drafting: true } } },
    });
  });

  it("refuses image_generation_unavailable without ever calling the gateway (D-17 — no image path exists)", async () => {
    const postId = await makePost(engA);
    const accountId = await makeAccount(clientA, "instagram");
    const variantId = await makeVariant(postId, accountId);

    completeMock.mockClear();
    const draft = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants/${variantId}/draft-caption`, headers: asUser(uA),
      payload: { wantImage: true },
    });
    expect(draft.statusCode).toBe(400);
    expect(draft.json().error).toBe("image_generation_unavailable");
    expect(completeMock).not.toHaveBeenCalled();

    const ideas = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/draft-ideas`, headers: asUser(uA),
      payload: { engagementId: engA, wantImage: true },
    });
    expect(ideas.statusCode).toBe(400);
    expect(ideas.json().error).toBe("image_generation_unavailable");
  });

  // ── cloudPolish is a pure reorder hint, only when the toggle is on ───────────────────────────
  it("passes the cloudPolish provider hint ONLY when the engagement's tool_scope.ai.cloudPolish is on", async () => {
    const postId = await makePost(engA);
    const accountId = await makeAccount(clientA, "facebook");
    const variantId = await makeVariant(postId, accountId);

    completeMock.mockClear();
    await app.inject({ method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants/${variantId}/draft-caption`, headers: asUser(uA) });
    expect(completeMock.mock.calls.at(-1)?.[1]).toBeUndefined(); // cloudPolish off by default -> no hint

    await app.inject({
      method: "PATCH", url: `/api/${A}/modules/social/engagements/${engA}/scope`, headers: asUser(uA),
      payload: { toolScope: { ai: { cloudPolish: true } } },
    });
    completeMock.mockClear();
    await app.inject({ method: "POST", url: `/api/${A}/modules/social/posts/${postId}/variants/${variantId}/draft-caption`, headers: asUser(uA) });
    expect(completeMock.mock.calls.at(-1)?.[1]).toEqual({ provider: "claude" });

    await app.inject({
      method: "PATCH", url: `/api/${A}/modules/social/engagements/${engA}/scope`, headers: asUser(uA),
      payload: { toolScope: { ai: { cloudPolish: false } } },
    });
  });

  // ── idea drafting: rows, idempotency, count clamp ────────────────────────────────────────────
  it("drafts N idea posts as status='idea' rows (never dispatched), idempotent via a caller-supplied ids array", async () => {
    const ids = [newId(), newId()];
    const first = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/draft-ideas`, headers: asUser(uA),
      payload: { engagementId: engA, campaignGoal: "Spring launch", count: 2, ids },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().ideas.map((i: { created: boolean }) => i.created)).toEqual([true, true]);

    const retry = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/draft-ideas`, headers: asUser(uA),
      payload: { engagementId: engA, campaignGoal: "Spring launch", count: 2, ids },
    });
    expect(retry.statusCode).toBe(201);
    // Retried with the SAME ids: no new rows, not an error — the idempotency key doing its job.
    expect(retry.json().ideas.map((i: { created: boolean }) => i.created)).toEqual([false, false]);

    const list = await withTenants([A], (c) => c.query<{ status: string; source: string }>(
      `SELECT status, source FROM social_posts WHERE id = ANY($1::uuid[])`, [ids]), { modules: ["social"] });
    expect(list.rows).toHaveLength(2);
    for (const row of list.rows) expect(row).toMatchObject({ status: "idea", source: "ai" });
  });

  it("refuses invalid_ids when the ids array length does not match count", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/draft-ideas`, headers: asUser(uA),
      payload: { engagementId: engA, count: 3, ids: [newId()] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_ids");
  });
});

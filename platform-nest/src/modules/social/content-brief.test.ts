// SMM-26 — the `smm-agent-content-brief` flow against LIVE Postgres (RLS) + the real HTTP layer,
// same harness as social-ai-drafts.test.ts (SMM-19). A DEDICATED file, not appended to that one —
// this ticket's own recurring-defect-class #6/#7 instruction: scope stubs locally, never share a
// module-level mock across a file whose `it()`s were not designed to run in this exact order.
//
// Cerbos is stubbed to always-allow (parity matrix is social.test.ts's job) — this file exercises
// what SMM-26 actually owns: the composite draft-N-ideas-with-variants orchestration, its own
// idempotency, its own "never a silent $0" discipline, its own call-volume cap, and — the assertion
// that matters most for an AGENT-DRIVEN drafting path — provable cross-client isolation across TWO
// separate content-brief calls against the SAME running app.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

// Deterministic "gateway" stand-in, scoped to THIS FILE only (defect class #7) — echoes which
// client's marker (if any) reached the prompt, and records EVERY prompt sent so the leak test can
// inspect the full transcript, not just the last call.
const { completeMock, prompts } = vi.hoisted(() => ({
  completeMock: vi.fn(async (prompt: string, opts?: { provider?: string }) => {
    if (prompt.includes("Write in this brand's voice")) {
      // caption prompt
      return { text: JSON.stringify({ body: "drafted caption", hashtags: ["tag1", "tag2"] }), provider: opts?.provider === "claude" ? "claude-mock" : "hermes-mock" };
    }
    if (prompt.includes("Generate exactly")) {
      // idea prompt — one idea per call is enough for these tests; count is honoured by the CALLER
      // (parseIdeaDraft's own cap), never invented here.
      const m = prompt.match(/Generate exactly (\d+) distinct/);
      const n = m ? Number(m[1]) : 1;
      const ideas = Array.from({ length: n }, (_, i) => ({ title: `Idea ${i + 1}`, brief: `Brief ${i + 1}` }));
      return { text: JSON.stringify({ ideas }), provider: "hermes-mock" };
    }
    return { text: "{}", provider: "hermes-mock" };
  }),
  prompts: [] as string[],
}));
vi.mock("./gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-client")>();
  return {
    ...actual,
    completeViaGateway: async (prompt: string, opts?: { provider?: string }) => {
      prompts.push(prompt);
      return completeMock(prompt, opts);
    },
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("social smm-agent-content-brief flow (SMM-26)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let uA: string;
  let clientA: string;
  let clientB: string;
  let fakeServer: Server;
  let ingested: Record<string, string[]>;
  let searches: Array<{ scope: string; query: string }>;

  async function makeAccount(client: string, network = "instagram", status = "connected"): Promise<string> {
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
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,'central')`,
        [accId, A, client, rows[0].id, network, `@h-${accId}`, status],
      );
    }, { modules: ["social"] });
    return accId;
  }

  async function makeEngagement(client: string, name: string, toolScope: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements`, headers: asUser(uA),
      payload: { clientId: client, name },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    if (Object.keys(toolScope).length > 0) {
      const patch = await app.inject({
        method: "PATCH", url: `/api/${A}/modules/social/engagements/${id}/scope`, headers: asUser(uA),
        payload: { toolScope },
      });
      expect(patch.statusCode).toBe(200);
    }
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.services.gateway = { url: "https://gateway.test", token: "gw-tok" };

    A = await createCompany("SMM26 Co", ["social"]);
    uA = await createUser("smm26@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "Brief Brand A");
    clientB = await createClient(A, "Brief Brand B");

    // The fake WS8 knowledge service — same isolation predicate as social-ai-drafts.test.ts's own
    // fixture (SMM-19): /ingest records under the requested scope, /search filters by it.
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

    resetModules();
    registerModule(socialModule);
    app = await buildApp();
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
  });

  it("drafts N idea posts (source='agent') and one variant per connected+enabled account, honoring cadencePerWeek as the default count", async () => {
    const acc = await makeAccount(clientA, "instagram");
    const eng = await makeEngagement(clientA, "Cadence Eng", { networks: { instagram: true }, posting: { cadencePerWeek: 2 } });

    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${eng}/agent-content-brief`, headers: asUser(uA),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ideas).toHaveLength(2); // cadencePerWeek, never an invented default
    for (const idea of body.ideas) {
      expect(idea.variants).toHaveLength(1);
      expect(idea.variants[0]).toMatchObject({ accountId: acc, network: "instagram", created: true, draftedVia: "ai" });
    }

    const posts = await withTenants([A], (c) => c.query<{ source: string; status: string }>(
      `SELECT source, status FROM social_posts WHERE id = ANY($1::uuid[])`, [body.ideas.map((i: { id: string }) => i.id)]),
    { modules: ["social"] });
    expect(posts.rows).toHaveLength(2);
    for (const row of posts.rows) expect(row).toMatchObject({ source: "agent", status: "idea" }); // honest attribution, never 'ai'

    const variants = await withTenants([A], (c) => c.query<{ body: string; args_sha256: string }>(
      `SELECT body, args_sha256 FROM social_post_variants WHERE post_id = ANY($1::uuid[])`, [body.ideas.map((i: { id: string }) => i.id)]),
    { modules: ["social"] });
    expect(variants.rows).toHaveLength(2);
    for (const row of variants.rows) {
      // The mock's proposed hashtags survive applyHashtagStrategy (media-rules.ts reuse, not a
      // second cap) and land appended to the body — the SAME shape draftPostVariantCaption produces.
      expect(row.body).toBe("drafted caption\n\n#tag1 #tag2");
      expect(row.args_sha256).toBeTruthy();
    }
  });

  it("is idempotent per (idea, account): a retry with the SAME ids skips the already-drafted pairing without a second gateway call", async () => {
    const acc = await makeAccount(clientA, "facebook");
    const eng = await makeEngagement(clientA, "Idempotent Eng", { networks: { facebook: true }, posting: { cadencePerWeek: 1 } });
    const ids = [newId()];

    const first = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${eng}/agent-content-brief`, headers: asUser(uA),
      payload: { ids },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().ideas[0].created).toBe(true);
    expect(first.json().ideas[0].variants[0]).toMatchObject({ accountId: acc, created: true });
    const firstVariantId = first.json().ideas[0].variants[0].variantId;

    completeMock.mockClear();
    prompts.length = 0; // isolate this call's own transcript — the first call's caption prompt must not leak into this assertion
    const retry = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${eng}/agent-content-brief`, headers: asUser(uA),
      payload: { ids },
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().ideas[0].created).toBe(false); // idea post: ON CONFLICT DO NOTHING, same id
    expect(retry.json().ideas[0].variants[0]).toMatchObject({ variantId: firstVariantId, created: false, draftedVia: "existing" });
    // The gateway is never re-consulted for a pairing that already has a variant — not even to
    // "check" it. The idea-generation prompt IS still sent (it has no per-idea idempotency key of
    // its own for CONTENT, only for the row), so we assert no CAPTION prompt fired this time.
    expect(prompts.some((p) => p.includes("Write in this brand's voice"))).toBe(false);

    const variantCount = await withTenants([A], (c) => c.query<{ n: string }>(
      `SELECT count(*) AS n FROM social_post_variants WHERE post_id = $1`, [first.json().ideas[0].id]),
    { modules: ["social"] });
    expect(variantCount.rows[0].n).toBe("1"); // never a second variant for the same pairing
  });

  it("refuses ai_drafting_disabled without ever calling the gateway", async () => {
    const eng = await makeEngagement(clientA, "Disabled Eng", { ai: { drafting: false } });
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${eng}/agent-content-brief`, headers: asUser(uA),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("ai_drafting_disabled");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("refuses image_generation_unavailable without ever calling the gateway (D-17)", async () => {
    const eng = await makeEngagement(clientA, "Image Eng", {});
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${eng}/agent-content-brief`, headers: asUser(uA),
      payload: { wantImage: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("image_generation_unavailable");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("NEVER writes a silent $0 for an unpriced metered network: an X variant is skipped and honestly reported, never created", async () => {
    const acc = await makeAccount(clientA, "x");
    const eng = await makeEngagement(clientA, "X Eng", { networks: { x: true }, posting: { cadencePerWeek: 1 } });
    // No SOCIAL_X_PER_POST_COST_USD configured in this test env — resolveXPricing() returns null.

    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${eng}/agent-content-brief`, headers: asUser(uA),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ideas[0].variants).toHaveLength(0); // the X pairing never became a row
    expect(body.variantsSkipped.unpriced_network).toBe(1);

    const rows = await withTenants([A], (c) => c.query(
      `SELECT id FROM social_post_variants WHERE post_id = $1 AND account_id = $2`, [body.ideas[0].id, acc]),
    { modules: ["social"] });
    expect(rows.rows).toHaveLength(0);
  });

  it("refuses unknown_account when an explicit accountIds entry belongs to a DIFFERENT client", async () => {
    const accB = await makeAccount(clientB, "linkedin");
    const engA = await makeEngagement(clientA, "Cross Eng", { posting: { cadencePerWeek: 1 } });
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/agent-content-brief`, headers: asUser(uA),
      payload: { accountIds: [accB] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_account");
  });

  it("caps total variant creation at the self-imposed config.social.contentBrief.maxVariantsPerCall", async () => {
    // A DEDICATED, fresh client — never `clientA` — so no OTHER test's connected account (accounts
    // are client-scoped, not engagement-scoped, matching the real schema) is swept into this
    // engagement's own network-enabled account resolution and silently changes the count this test
    // asserts on.
    const clientCap = await createClient(A, "Brief Brand Cap");
    const prior = config.social.contentBrief.maxVariantsPerCall;
    config.social.contentBrief.maxVariantsPerCall = 1;
    try {
      const acc1 = await makeAccount(clientCap, "instagram");
      const acc2 = await makeAccount(clientCap, "linkedin");
      const eng = await makeEngagement(clientCap, "Capped Eng", {
        networks: { instagram: true, linkedin: true }, posting: { cadencePerWeek: 1 },
      });
      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/social/engagements/${eng}/agent-content-brief`, headers: asUser(uA),
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      const created = body.ideas[0].variants.filter((v: { created: boolean }) => v.created);
      expect(created).toHaveLength(1); // the cap, not the two enabled+connected accounts
      expect(body.variantsSkipped.call_volume_cap).toBe(1);
      void acc1; void acc2;
    } finally {
      config.social.contentBrief.maxVariantsPerCall = prior;
    }
  });

  // ── THE CROSS-CLIENT LEAK TEST — mandatory per this ticket's own spec ────────────────────────────
  // Unlike SMM-19's single-item draft-caption endpoint, this flow drafts MULTIPLE ideas x accounts in
  // ONE call — the new risk this ticket introduces is a batching bug that lets one iteration's
  // grounding facts leak into another's prompt. This test seeds two DIFFERENT clients (under the
  // SAME tenant) with distinctive corpus markers, runs the flow for BOTH back to back against the
  // SAME mocked gateway/knowledge transcript, and asserts NEITHER client's marker ever reaches the
  // OTHER's prompts — proving both (a) the existing per-call WS8 scope isolation still holds through
  // this new composite, and (b) this file's own per-idea/per-variant loop never accumulates a shared
  // prompt or a shared knowledge-hit list across iterations, which is the property unique to this
  // ticket's new N x M orchestration.
  it("CROSS-CLIENT LEAK TEST: two engagements' content-brief calls never share a prompt or a knowledge scope", async () => {
    const accA = await makeAccount(clientA, "instagram");
    const accB = await makeAccount(clientB, "instagram");
    const engA = await makeEngagement(clientA, "Leak Eng A", { networks: { instagram: true }, posting: { cadencePerWeek: 1 } });
    const engB = await makeEngagement(clientB, "Leak Eng B", { networks: { instagram: true }, posting: { cadencePerWeek: 1 } });

    await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/brand-corpus/ingest`, headers: asUser(uA),
      payload: { chunks: ["The CLIENT_A_BRIEF_SECRET campaign launches next week."] },
    });
    await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engB}/brand-corpus/ingest`, headers: asUser(uA),
      payload: { chunks: ["The CLIENT_B_BRIEF_SECRET campaign launches next week."] },
    });

    prompts.length = 0;
    searches.length = 0;
    const resA = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/agent-content-brief`, headers: asUser(uA),
      payload: { brief: "spring push" },
    });
    expect(resA.statusCode).toBe(201);
    const resB = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engB}/agent-content-brief`, headers: asUser(uA),
      payload: { brief: "spring push" },
    });
    expect(resB.statusCode).toBe(201);

    // Every prompt containing one client's marker NEVER contains the other's, in EITHER direction —
    // across the WHOLE transcript (idea-generation AND caption-drafting prompts alike), not just the
    // last call.
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      const sawA = p.includes("CLIENT_A_BRIEF_SECRET");
      const sawB = p.includes("CLIENT_B_BRIEF_SECRET");
      expect(sawA && sawB).toBe(false);
    }
    expect(prompts.some((p) => p.includes("CLIENT_A_BRIEF_SECRET"))).toBe(true);
    expect(prompts.some((p) => p.includes("CLIENT_B_BRIEF_SECRET"))).toBe(true);

    // Every WS8 search this run made asked for exactly one client's own scope — never the other's,
    // and never an unscoped/wildcard query.
    const scopeA = `social-brand:${A}:${clientA}`;
    const scopeB = `social-brand:${A}:${clientB}`;
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) expect([scopeA, scopeB]).toContain(s.scope);

    // groundedOn on each response only ever names ITS OWN client's scope-prefixed refs.
    for (const ref of resA.json().groundedOn as string[]) expect(ref.startsWith(scopeA)).toBe(true);
    for (const ref of resB.json().groundedOn as string[]) expect(ref.startsWith(scopeB)).toBe(true);

    void accA; void accB;
  });
});

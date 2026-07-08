import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { KnowledgeStore } from "./store";
import { buildKnowledgeApp, knowledgeConfig } from "./service";

const url = process.env.DATABASE_URL_TEST ?? "";
const T_A = "bbbbbbbb-0000-4000-8000-000000000001";

async function hashEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(32).fill(0);
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    v[h % 32] += 1;
  }
  return v;
}

describe.skipIf(!url)("knowledge service", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildKnowledgeApp>;
  const svc = { authorization: "Bearer know-token" };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    const store = new KnowledgeStore(pool, hashEmbed);
    await store.init();
    knowledgeConfig.serviceToken = "know-token";
    // Fake platform resolver: verified telegram user belongs to tenant A; others none.
    app = buildKnowledgeApp(store, async (provider, externalId) =>
      provider === "telegram" && externalId === "tg:555" ? [T_A] : [],
    );
    await app.inject({
      method: "POST", url: "/ingest", headers: svc,
      payload: { tenantId: T_A, sourceRef: "svc-doc", acl: [], kind: "doc", chunks: ["diesel delivery arrives thursday morning"], provenance: "human", trust: "trusted" },
    });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("fail-closed without the service token", async () => {
    const r = await app.inject({ method: "POST", url: "/search", payload: { query: "x", scope: "s" } });
    expect(r.statusCode).toBe(401);
  });

  it("a resolved envelope searches its own tenant's knowledge", async () => {
    const r = await app.inject({
      method: "POST", url: "/search", headers: { ...svc, "x-obo-provider": "telegram", "x-obo-external-id": "tg:555" },
      payload: { query: "diesel delivery thursday", scope: "anything" },
    });
    const { hits } = r.json() as { hits: Array<{ text: string }> };
    expect(hits[0].text).toContain("diesel");
  });

  it("an unknown envelope resolves to an empty tenant set → zero hits", async () => {
    const r = await app.inject({
      method: "POST", url: "/search", headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "nobody" },
      payload: { query: "diesel delivery thursday", scope: "anything" },
    });
    expect((r.json() as { hits: unknown[] }).hits).toEqual([]);
  });

  it("erase hard-deletes by source", async () => {
    const r = await app.inject({ method: "POST", url: "/erase", headers: svc, payload: { sourceRef: "svc-doc" } });
    expect((r.json() as { deleted: number }).deleted).toBeGreaterThan(0);
  });
});

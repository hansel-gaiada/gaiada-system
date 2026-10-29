// AIP-12 — `searchKnowledgeStrict`'s wire to the knowledge service's POST /search: the department hint rides only when given
// (the body without it is byte for byte the pre-AIP-12 body), and each hit's `departmentId` is a string or null. No database: the
// self-link upsert is stubbed, and `fetch` is a recorder.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../db", () => ({ newId: () => "id", withGlobal: async (fn: (c: unknown) => unknown) => fn({ query: async () => ({}) }) }));

import { config } from "../../config";
import { searchKnowledgeStrict } from "./knowledge-client";

const T = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

let bodies: string[];
let answer: unknown;
const realFetch = globalThis.fetch;
const before = { ...config.services.knowledge };

beforeEach(() => {
  bodies = [];
  answer = { hits: [] };
  config.services.knowledge = { ...before, url: "http://knowledge.test", token: "tok" };
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  config.services.knowledge = before;
});

describe("searchKnowledgeStrict body (AIP-12)", () => {
  it("without a department the body is exactly what it was before AIP-12", async () => {
    await searchKnowledgeStrict(OWNER, "q", 16);
    await searchKnowledgeStrict(OWNER, "q", 16, undefined);
    await searchKnowledgeStrict(OWNER, "q", 16, {});
    expect(bodies).toEqual(Array(3).fill('{"query":"q","scope":"","topK":16,"publicOnly":false}'));
  });

  it("with a department the body carries it, after the existing fields", async () => {
    await searchKnowledgeStrict(OWNER, "q", 16, { department: { tenantId: T, nodeId: "d-seo" } });
    expect(JSON.parse(bodies[0])).toEqual({ query: "q", scope: "", topK: 16, publicOnly: false, department: { tenantId: T, nodeId: "d-seo" } });
  });
});

describe("searchKnowledgeStrict hits (AIP-12)", () => {
  const raw = (over: Record<string, unknown>) => ({ tenantId: T, sourceRef: `erp:project:${T}`, kind: "doc", text: "t", provenance: "erp", confidence: 1, score: 0.5, audience: "internal", ...over });

  it("departmentId is the string the store sent, else null (a store that does not report it yet, or a bad value)", async () => {
    answer = { hits: [raw({ departmentId: "d-seo" }), raw({ departmentId: null }), raw({}), raw({ departmentId: 7 })] };
    const hits = await searchKnowledgeStrict(OWNER, "q", 4);
    expect(hits.map((h) => h.departmentId)).toEqual(["d-seo", null, null, null]);
  });

  it("the boosted score is passed through as the hit's score", async () => {
    answer = { hits: [raw({ score: 0.8125, departmentId: "d-seo" })] };
    expect((await searchKnowledgeStrict(OWNER, "q", 4, { department: { tenantId: T, nodeId: "d-seo" } }))[0].score).toBe(0.8125);
  });
});

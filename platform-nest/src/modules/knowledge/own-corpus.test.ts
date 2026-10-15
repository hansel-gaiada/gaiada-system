// DW-D31 (BFF §46.10): the SEO property brief's and social's brand-draft lookups keep only their own corpus. The store's ACL
// pre-filter lets every internal ERP chunk (empty acl) match ANY scope, so without this a meeting transcript or a contract file
// could ground an AI draft. No database and no knowledge service: the self-link write is mocked and the store is a fake fetch.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("../../db", async (orig) => ({ ...(await orig<typeof import("../../db")>()), withGlobal: vi.fn(async () => ({ rows: [] })) }));

import { config } from "../../config";
import { keepOwnCorpus, ownCorpusTopK } from "./own-corpus";
import { queryPropertyKnowledge } from "../search/knowledge-client";
import { brandCorpusScope, queryBrandKnowledge } from "../social/knowledge-client";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "99999999-9999-4999-8999-999999999999";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const PROPERTY = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

const hit = (sourceRef: string, text: string, score: number) => ({ sourceRef, text, score, tenantId: T, audience: "internal" });

/** A fake store answering `hits`, recording the request body. */
function fakeStore(hits: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ hits }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fn, bodies };
}

let savedUrl = "";
beforeAll(() => {
  savedUrl = config.services.knowledge.url;
  config.services.knowledge.url = "http://knowledge.test";
});
afterAll(() => {
  config.services.knowledge.url = savedUrl;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("own-corpus helpers", () => {
  it("asks for four times the hits, at least 4 and at most 80", () => {
    expect(ownCorpusTopK(5)).toBe(20);
    expect(ownCorpusTopK(8)).toBe(32);
    expect(ownCorpusTopK(0)).toBe(4);
    expect(ownCorpusTopK(50)).toBe(80);
  });

  it("keeps only exact matches of the corpus ref, in the store's order, cut to topK", () => {
    const hits = [hit("erp:meeting:m1", "MEETING", 0.99), hit("own", "A", 0.9), hit("own:x", "PREFIX", 0.85), hit("own", "B", 0.8), hit("own", "C", 0.7)];
    expect(keepOwnCorpus(hits, "own", 2).map((h) => h.text)).toEqual(["A", "B"]);
    expect(keepOwnCorpus(hits, "own", 0)).toEqual([]);
  });
});

describe("social's brand drafts (queryBrandKnowledge)", () => {
  const scope = brandCorpusScope(T, CLIENT);

  it("returns only this client's brand corpus: never an ERP record, the public tier, another client or another company", async () => {
    const store = fakeStore([
      hit("erp:meeting:aaaa", "MEETING_TRANSCRIPT_SECRET", 0.99),
      hit("erp:file:bbbb", "CONTRACT_FILE_SECRET", 0.98),
      { ...hit("web:gaiada.com/about", "PUBLIC_PAGE", 0.97), audience: "public" },
      hit(brandCorpusScope(T, "55555555-5555-4555-8555-555555555555"), "OTHER_CLIENT_BRAND", 0.96),
      { ...hit(brandCorpusScope(OTHER_T, CLIENT), "OTHER_COMPANY_BRAND", 0.95), tenantId: OTHER_T },
      hit(scope, "BRAND_VOICE_1", 0.9),
      hit(scope, "BRAND_VOICE_2", 0.8),
    ]);
    const out = await queryBrandKnowledge(USER, T, CLIENT, "tone for the launch post", 5, { fetchImpl: store.fn as unknown as typeof fetch });
    expect(out.map((h) => h.text)).toEqual(["BRAND_VOICE_1", "BRAND_VOICE_2"]);
    expect(out.every((h) => h.sourceRef === scope)).toBe(true);
    // the scope is still asked for, with room for the hits that are dropped
    expect(store.bodies[0]).toMatchObject({ scope, topK: 20 });
  });

  it("an answer with nothing of the corpus is an empty list, not the other hits", async () => {
    const store = fakeStore([hit("erp:meeting:aaaa", "MEETING_TRANSCRIPT_SECRET", 0.99)]);
    expect(await queryBrandKnowledge(USER, T, CLIENT, "anything", 3, { fetchImpl: store.fn as unknown as typeof fetch })).toEqual([]);
  });
});

describe("the SEO property brief (queryPropertyKnowledge)", () => {
  const ownRef = `search-property:${PROPERTY}:grounding`;

  it("returns only the property's own grounding corpus, cut to topK", async () => {
    const store = fakeStore([
      hit("erp:meeting:aaaa", "MEETING_TRANSCRIPT_SECRET", 0.99),
      hit("erp:client:cccc", "CLIENT_RECORD", 0.97),
      hit("search-property:66666666-6666-4666-8666-666666666666:grounding", "OTHER_PROPERTY", 0.95),
      hit(ownRef, "FINDING_1", 0.9),
      hit(ownRef, "FINDING_2", 0.8),
      hit(ownRef, "FINDING_3", 0.7),
    ]);
    vi.stubGlobal("fetch", store.fn);
    const out = await queryPropertyKnowledge(USER, PROPERTY, ownRef, "seo topic", 2);
    expect(out.map((h) => h.text)).toEqual(["FINDING_1", "FINDING_2"]);
    expect(store.bodies[0]).toMatchObject({ scope: PROPERTY, topK: 8 });
  });
});

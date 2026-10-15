// DW-D26 (docs/FRONTEND-BFF-CONTRACT.md §46.9) — the assistant's retrieval goes through DW-8i's per-record read filter.
//
// Asserted at the level that matters, as in context-memory.test.ts: the assembled PROMPT string and the returned CITATIONS.
// No database, no Cerbos, no knowledge service: the store and the filter are mocked, and the model of "who can read what" is
// the mocked filter's own verdict. What is pinned here is the WIRING: the candidates the store returns reach the filter as the
// thread owner and the thread's company, only what the filter returns is quoted or cited, a failure leaves the turn with no
// knowledge (never the unfiltered chunks), and topK is applied AFTER the filter.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

const strict = vi.hoisted(() => vi.fn());
const filter = vi.hoisted(() => vi.fn());
const principalFor = vi.hoisted(() => vi.fn());

vi.mock("../search/knowledge-client", () => ({ searchKnowledgeStrict: strict }));
vi.mock("../knowledge/search-filter", async (orig) => ({ ...(await orig<typeof import("../knowledge/search-filter")>()), filterReadableHits: filter }));
vi.mock("../../rbac/principal", async (orig) => ({ ...(await orig<typeof import("../../rbac/principal")>()), assemblePrincipal: principalFor }));

import { assembleContext } from "./context";
import type { AllowedHit, StoreHit } from "../knowledge/search-filter";
import type { Principal } from "../../rbac/principal";

const T = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

const hit = (n: number, over: Partial<StoreHit> = {}): StoreHit => ({
  tenantId: T, sourceRef: `erp:meeting:${id(n)}`, kind: "doc", text: `CHUNK_TEXT_${n}`, provenance: "erp", confidence: 1, score: 1 - n / 100, audience: "internal", ...over,
});

/** A fake client: one user message, no memory rows. */
function fakeClient(): PoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      if (/FROM assistant_messages/.test(sql)) return { rows: [{ seq: 1, role: "user", content: "what did we decide about Acme?" }] };
      return { rows: [] };
    }),
  } as unknown as PoolClient;
}
const thread = { ownerUserId: OWNER, compactionSummary: null, compactionSummaryUptoSeq: null };
const ownerPrincipal = { userId: OWNER, assurance: "linked", companies: [T], rootCompanies: [], roles: [], perms: [], sessionVersion: 1 } as unknown as Principal;

/** The filter lets through exactly the refs in `readable`, keeping the order it was given. */
function allowOnly(readable: string[]): void {
  filter.mockImplementation(async (_p: Principal, _t: string, cands: Array<{ hit: StoreHit; family: string; id: string }>) =>
    cands.filter((c) => readable.includes(c.hit.sourceRef)).map((c): AllowedHit => ({ candidate: c as never, title: "t", href: "/x" })),
  );
}

beforeEach(() => {
  strict.mockReset();
  filter.mockReset();
  principalFor.mockReset();
  principalFor.mockResolvedValue(ownerPrincipal);
});

describe("assistant retrieval goes through the DW-8i read filter (DW-D26)", () => {
  it("a chunk of a record the owner cannot read reaches neither the prompt nor the citations", async () => {
    strict.mockResolvedValue([hit(1), hit(2), hit(3)]);
    allowOnly([hit(1).sourceRef, hit(3).sourceRef]); // the owner cannot open meeting 2
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4 });
    expect(out.citations.map((c) => c.sourceRef)).toEqual([hit(1).sourceRef, hit(3).sourceRef]);
    expect(out.prompt).toContain("CHUNK_TEXT_1");
    expect(out.prompt).toContain("CHUNK_TEXT_3");
    expect(out.prompt).not.toContain("CHUNK_TEXT_2");
    expect(out.prompt).not.toContain(id(2));
  });

  it("the filter is asked as the thread OWNER, for the thread's company, with internal-tier candidates of that company only", async () => {
    strict.mockResolvedValue([
      hit(1),
      hit(2, { tenantId: "99999999-9999-4999-8999-999999999999" }), // another company's chunk
      hit(3, { audience: "public" }), // the public website corpus
      hit(4, { sourceRef: `erp:person:${T}:${OWNER}` }), // a withheld family
    ]);
    allowOnly([hit(1).sourceRef, hit(2).sourceRef, hit(3).sourceRef]);
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4 });
    expect(filter).toHaveBeenCalledTimes(1);
    const [p, tenant, cands] = filter.mock.calls[0];
    expect(p).toBe(ownerPrincipal);
    expect(principalFor).toHaveBeenCalledWith(OWNER, "low");
    expect(tenant).toBe(T);
    expect(cands.map((c: { hit: StoreHit }) => c.hit.sourceRef)).toEqual([hit(1).sourceRef]);
    // the public chunk is published: it needs no check and stays cited, as before DW-D26
    expect(out.citations.map((c) => c.sourceRef)).toEqual([hit(1).sourceRef, hit(3).sourceRef]);
    expect(out.prompt).not.toContain("CHUNK_TEXT_2");
    expect(out.prompt).not.toContain("CHUNK_TEXT_4");
    // the store is asked as the owner, for more candidates than are kept (min(topK * 4, 80))
    expect(strict).toHaveBeenCalledWith(OWNER, "what did we decide about Acme?", 16);
  });

  it("the requester's own principal is used (real assurance) when it is the owner, and not when it is someone else", async () => {
    strict.mockResolvedValue([hit(1)]);
    allowOnly([hit(1).sourceRef]);
    await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, principal: ownerPrincipal });
    expect(filter.mock.calls[0][0]).toBe(ownerPrincipal);
    expect(principalFor).not.toHaveBeenCalled();

    filter.mockClear();
    const someoneElse = { ...ownerPrincipal, userId: "33333333-3333-4333-8333-333333333333" } as Principal;
    await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, principal: someoneElse });
    expect(principalFor).toHaveBeenCalledWith(OWNER, "low");
  });

  it("a filter failure (Cerbos down) gives NO knowledge, never the unfiltered chunks, and the turn still assembles", async () => {
    strict.mockResolvedValue([hit(1), hit(2)]);
    filter.mockRejectedValue(new Error("cerbos 503"));
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T });
    expect(out.citations).toEqual([]);
    expect(out.prompt).not.toContain("CHUNK_TEXT");
    expect(out.prompt).not.toContain("Relevant company knowledge");
    expect(out.prompt).toContain("what did we decide about Acme?");
    expect(out.prompt.endsWith("Assistant:")).toBe(true);
  });

  it("a store failure, an unresolvable owner and a missing company all give no knowledge, and the filter is not reached without a principal", async () => {
    strict.mockRejectedValueOnce(new Error("knowledge unavailable"));
    expect((await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T })).citations).toEqual([]);

    strict.mockResolvedValue([hit(1)]);
    principalFor.mockResolvedValue(null);
    expect((await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T })).citations).toEqual([]);
    expect(filter).not.toHaveBeenCalled();

    strict.mockClear();
    expect((await assembleContext(fakeClient(), "t", thread, 2, {})).citations).toEqual([]); // no tenant in scope
    expect(strict).not.toHaveBeenCalled();
  });

  it("topK is applied AFTER the filter: dropped records do not use up the quota", async () => {
    // 6 candidates; the best three are unreadable; topK is 2 -> the next two readable ones, not the first two overall.
    strict.mockResolvedValue([1, 2, 3, 4, 5, 6].map((n) => hit(n)));
    allowOnly([4, 5, 6].map((n) => hit(n).sourceRef));
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 2 });
    expect(out.citations.map((c) => c.sourceRef)).toEqual([hit(4).sourceRef, hit(5).sourceRef]);
    expect(out.prompt).not.toContain("CHUNK_TEXT_6");
    expect(strict).toHaveBeenCalledWith(OWNER, expect.any(String), 8); // 2 * 4
  });

  it("public-tier chunks are cited without a record check, merged with the readable internal ones by score", async () => {
    const pub = (n: number) => hit(n, { audience: "public", sourceRef: `web:gaiada.com/page-${n}` });
    strict.mockResolvedValue([pub(1), pub(1), pub(5)]); // no internal candidates at all; a duplicate public chunk
    const onlyPublic = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4 });
    expect(onlyPublic.citations.map((c) => c.sourceRef)).toEqual([pub(1).sourceRef, pub(5).sourceRef]);
    expect(filter).not.toHaveBeenCalled();
    expect(principalFor).not.toHaveBeenCalled();

    strict.mockResolvedValue([pub(1), hit(2), hit(3), pub(4)]);
    allowOnly([hit(3).sourceRef]);
    const mixed = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 2 });
    expect(mixed.citations.map((c) => c.sourceRef)).toEqual([pub(1).sourceRef, hit(3).sourceRef]);
    expect(mixed.prompt).not.toContain("CHUNK_TEXT_2");
  });

  it("knowledgeTopK 0 skips retrieval entirely", async () => {
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 0 });
    expect(out.citations).toEqual([]);
    expect(strict).not.toHaveBeenCalled();
    expect(filter).not.toHaveBeenCalled();
  });
});

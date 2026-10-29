// AIP-12 (plan §3.3 and §6.2 item 5) — department ranking is behind DW-D26's per-record read filter. ADVERSARIAL.
//
// The claim under test: a department RANKS, it never ADMITS. Same level and seams as context-knowledge-filter.test.ts: the
// assembled PROMPT string and the returned CITATIONS, with the store (`queryKnowledge`) and the filter (`filterKnowledge`)
// injected. The store here plays the part of the real one after AIP-12: it hands back its candidates with the department's
// chunks already BOOSTED (a higher `score`) and tagged with `departmentId`; the filter's verdict stands in for "who can read what".
// What is pinned is the wiring: the boost never changes who may be cited, another company's chunk with the same node id never
// gets through, the public tier is untouched, and with no department (flag off, or no context) the call and the prompt are the
// ones from before Phase 3.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

const principalFor = vi.hoisted(() => vi.fn());
vi.mock("../../rbac/principal", async (orig) => ({ ...(await orig<typeof import("../../rbac/principal")>()), assemblePrincipal: principalFor }));

import { assembleContext, type KnowledgeQueryFn } from "./context";
import { DEFAULT_DEPT_PREAMBLES, type TurnContext } from "./department-context";
import type { AllowedHit } from "../knowledge/search-filter";
import type { KnowledgeStoreHit } from "../search/knowledge-client";
import type { Principal } from "../../rbac/principal";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "99999999-9999-4999-8999-999999999999";
const OWNER = "22222222-2222-4222-8222-222222222222";
const NODE = "d-seo";
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

const hit = (n: number, over: Partial<KnowledgeStoreHit> = {}): KnowledgeStoreHit => ({
  tenantId: T, sourceRef: `erp:meeting:${id(n)}`, kind: "doc", text: `CHUNK_TEXT_${n}`, provenance: "erp", confidence: 1,
  score: 0.5, audience: "internal", departmentId: null, ...over,
});
/** A chunk of the SEO department's own record, as the store returns it once the boost has been applied. */
const deptHit = (n: number, score: number, over: Partial<KnowledgeStoreHit> = {}) => hit(n, { departmentId: NODE, score, ...over });

function fakeClient(): PoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      if (/FROM assistant_messages/.test(sql)) return { rows: [{ seq: 1, role: "user", content: "what do we know about the Acme audit?" }] };
      return { rows: [] };
    }),
  } as unknown as PoolClient;
}
const thread = { ownerUserId: OWNER, compactionSummary: null, compactionSummaryUptoSeq: null };
const ownerPrincipal = { userId: OWNER, assurance: "linked", companies: [T], rootCompanies: [], roles: [], perms: [], sessionVersion: 1 } as unknown as Principal;

const seoContext: TurnContext = { type: "turn_context", department: { nodeId: NODE, name: "SEO", key: "seo" }, page: "Rankings" };

/** A recording store: `query` answers with `hits`, and `calls` keeps the exact argument lists it was called with. */
function store(hits: KnowledgeStoreHit[]): { query: KnowledgeQueryFn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const query: KnowledgeQueryFn = async (...args) => {
    calls.push(args);
    return hits;
  };
  return { query, calls };
}

/** The filter lets through exactly the refs in `readable`, keeping the order it was given, and records what it was asked. */
function filterOnly(readable: string[]) {
  const seen: Array<{ principal: Principal; tenantId: string; refs: string[] }> = [];
  const fn = vi.fn(async (principal: Principal, tenantId: string, cands: Array<{ hit: KnowledgeStoreHit; family: string; id: string }>) => {
    seen.push({ principal, tenantId, refs: cands.map((c) => c.hit.sourceRef) });
    return cands.filter((c) => readable.includes(c.hit.sourceRef)).map((c): AllowedHit => ({ candidate: c as never, title: "t", href: "/x" }));
  });
  return { fn: fn as unknown as typeof import("../knowledge/search-filter").filterReadableHits, seen, mock: fn };
}

beforeEach(() => {
  principalFor.mockReset();
  principalFor.mockResolvedValue(ownerPrincipal);
});

describe("AIP-12: the department ranks, the DW-D26 filter admits", () => {
  it("(a) a department record the owner cannot open is the top boosted candidate: it is not cited and its text is not in the prompt", async () => {
    const secret = deptHit(1, 0.9); // boosted to the top of the list
    const readable = hit(2, { score: 0.6 });
    const s = store([secret, readable, deptHit(3, 0.7)]);
    const f = filterOnly([readable.sourceRef, deptHit(3, 0.7).sourceRef]); // the owner cannot open meeting 1
    const out = await assembleContext(fakeClient(), "t", thread, 2, {
      tenantId: T, knowledgeTopK: 4, turnContext: seoContext, queryKnowledge: s.query, filterKnowledge: f.fn,
    });
    // the boosted record WAS a candidate (the filter was asked about it, first, by score) ...
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].refs[0]).toBe(secret.sourceRef);
    // ... and was dropped by the filter: never cited, never in the prompt, never named
    expect(out.citations.map((c) => c.sourceRef)).toEqual([deptHit(3, 0.7).sourceRef, readable.sourceRef]);
    expect(out.prompt).not.toContain("CHUNK_TEXT_1");
    expect(out.prompt).not.toContain(id(1));
    expect(out.prompt).toContain("CHUNK_TEXT_3");
  });

  it("the department hint is the thread's own company and the department's node id, and the filter still runs as the OWNER for that company", async () => {
    const s = store([deptHit(1, 0.9)]);
    const f = filterOnly([deptHit(1, 0.9).sourceRef]);
    await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4, turnContext: seoContext, queryKnowledge: s.query, filterKnowledge: f.fn });
    expect(s.calls).toEqual([[OWNER, "what do we know about the Acme audit?", 16, { department: { tenantId: T, nodeId: NODE } }]]);
    expect(f.seen[0].principal).toBe(ownerPrincipal);
    expect(f.seen[0].tenantId).toBe(T);
    expect(principalFor).toHaveBeenCalledWith(OWNER, "low");
  });

  it("(b) no context, a null context and an empty context: the store is called with exactly three arguments and the prompt has no context line", async () => {
    const runs: string[] = [];
    for (const turnContext of [undefined, null, { type: "turn_context", department: null, page: null } as TurnContext]) {
      const s = store([hit(1)]);
      const f = filterOnly([hit(1).sourceRef]);
      const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4, turnContext, queryKnowledge: s.query, filterKnowledge: f.fn });
      expect(s.calls).toEqual([[OWNER, "what do we know about the Acme audit?", 16]]); // length 3: no fourth argument at all
      expect(s.calls[0]).toHaveLength(3);
      expect(out.prompt).not.toContain("You are helping someone");
      expect(out.prompt).not.toContain("Department guidance");
      runs.push(out.prompt);
    }
    // the same prompt every time, and exactly today's shape: the preamble, the transcript, the knowledge block, the cue
    expect(new Set(runs).size).toBe(1);
    const sections = runs[0].split("\n\n");
    expect(sections[0]).toMatch(/^You are the Gaiada ERP Assistant/);
    expect(sections[1]).toBe("User: what do we know about the Acme audit?");
    expect(sections[2]).toMatch(/^Relevant company knowledge/);
    expect(sections[sections.length - 1]).toBe("Assistant:");
  });

  it("(b) a page-only context asks the store nothing about a department", async () => {
    const s = store([hit(1)]);
    const f = filterOnly([hit(1).sourceRef]);
    const out = await assembleContext(fakeClient(), "t", thread, 2, {
      tenantId: T, knowledgeTopK: 4, turnContext: { type: "turn_context", department: null, page: "Rankings" }, queryKnowledge: s.query, filterKnowledge: f.fn,
    });
    expect(s.calls[0]).toHaveLength(3);
    expect(out.prompt).toContain("You are helping someone on the Rankings page.");
    expect(out.prompt).not.toContain("Department guidance");
  });

  it("(c) another company's chunk with the SAME node id and a high score is not cited, and never reaches the filter", async () => {
    const foreign = deptHit(1, 0.99, { tenantId: OTHER_T }); // node ids repeat across companies
    const mine = hit(2, { score: 0.4 });
    const s = store([foreign, mine]);
    const f = filterOnly([foreign.sourceRef, mine.sourceRef]); // even a filter that would say yes to the foreign ref
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4, turnContext: seoContext, queryKnowledge: s.query, filterKnowledge: f.fn });
    expect(f.seen[0].refs).toEqual([mine.sourceRef]);
    expect(out.citations.map((c) => c.sourceRef)).toEqual([mine.sourceRef]);
    expect(out.prompt).not.toContain("CHUNK_TEXT_1");
  });

  it("(d) a public-tier hit is still cited with a department in play, without a record check", async () => {
    const pub = hit(5, { audience: "public", sourceRef: "web:gaiada.com/seo-services", score: 0.8, tenantId: OTHER_T });
    const s = store([pub, deptHit(1, 0.5)]);
    const f = filterOnly([deptHit(1, 0.5).sourceRef]);
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4, turnContext: seoContext, queryKnowledge: s.query, filterKnowledge: f.fn });
    expect(out.citations.map((c) => c.sourceRef)).toEqual([pub.sourceRef, deptHit(1, 0.5).sourceRef]);
    expect(f.seen[0].refs).toEqual([deptHit(1, 0.5).sourceRef]); // the public chunk was not sent to the filter
  });

  it("(e) a readable department hit returned with a higher (boosted) score is cited above a readable company hit", async () => {
    const company = hit(1, { score: 0.7 });
    const dept = deptHit(2, 0.8); // 0.64 * 1.25, say: boosted past the company chunk
    const s = store([company, dept]); // the store's own order is not relied on
    const f = filterOnly([company.sourceRef, dept.sourceRef]);
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4, turnContext: seoContext, queryKnowledge: s.query, filterKnowledge: f.fn });
    expect(out.citations.map((c) => c.sourceRef)).toEqual([dept.sourceRef, company.sourceRef]);
    expect(out.citations.map((c) => c.score)).toEqual([0.8, 0.7]); // the boosted score is the one that ranks and is reported
    expect(out.prompt.indexOf("CHUNK_TEXT_2")).toBeLessThan(out.prompt.indexOf("CHUNK_TEXT_1"));
  });

  it("(e) it is a boost, not a partition: a far more relevant company hit still outranks a weak department one", async () => {
    const company = hit(1, { score: 0.9 });
    const dept = deptHit(2, 0.4);
    const f = filterOnly([company.sourceRef, dept.sourceRef]);
    const out = await assembleContext(fakeClient(), "t", thread, 2, { tenantId: T, knowledgeTopK: 4, turnContext: seoContext, queryKnowledge: store([dept, company]).query, filterKnowledge: f.fn });
    expect(out.citations.map((c) => c.sourceRef)).toEqual([company.sourceRef, dept.sourceRef]);
  });

  it("a filter failure with a department in play still gives NO knowledge, never the boosted chunks", async () => {
    const f = vi.fn().mockRejectedValue(new Error("cerbos 503"));
    const out = await assembleContext(fakeClient(), "t", thread, 2, {
      tenantId: T, knowledgeTopK: 4, turnContext: seoContext, queryKnowledge: store([deptHit(1, 0.99)]).query, filterKnowledge: f as never,
    });
    expect(out.citations).toEqual([]);
    expect(out.prompt).not.toContain("CHUNK_TEXT");
    expect(out.prompt).toContain("You are helping someone in the SEO department, on the Rankings page."); // the label survives; no data does
  });
});

describe("AIP-10 / AIP-13: the context line and the department's preamble in the prompt", () => {
  const run = (turnContext: TurnContext | null | undefined, tenantId: string | undefined = T) =>
    assembleContext(fakeClient(), "t", thread, 2, { tenantId, knowledgeTopK: 0, turnContext });

  it("adds the line and 'Department guidance:' with the preamble right after the generic preamble, before the transcript", async () => {
    const { prompt } = await run(seoContext);
    const sections = prompt.split("\n\n");
    expect(sections[0]).toMatch(/^You are the Gaiada ERP Assistant/);
    expect(sections[1]).toBe("You are helping someone in the SEO department, on the Rankings page.");
    expect(sections[2]).toBe(`Department guidance:\n${DEFAULT_DEPT_PREAMBLES.seo}`);
    expect(sections[3]).toBe("User: what do we know about the Acme audit?");
    expect(sections[sections.length - 1]).toBe("Assistant:");
  });

  it("without a page, the line has no page clause", async () => {
    const { prompt } = await run({ ...seoContext, page: null });
    expect(prompt).toContain("You are helping someone in the SEO department.\n\n");
    expect(prompt).not.toContain("page.");
  });

  it("a department with no default preamble gets the line and no guidance block", async () => {
    const { prompt } = await run({ type: "turn_context", department: { nodeId: "d-x", name: "Legal", key: "legal" }, page: null });
    expect(prompt).toContain("You are helping someone in the Legal department.");
    expect(prompt).not.toContain("Department guidance");
  });

  it("a page-only context adds a line naming the page", async () => {
    const { prompt } = await run({ type: "turn_context", department: null, page: "Board" });
    expect(prompt).toContain("You are helping someone on the Board page.");
    expect(prompt).not.toContain("Department guidance");
  });

  it("no context at all leaves the prompt without either", async () => {
    for (const none of [undefined, null]) {
      const { prompt } = await run(none);
      expect(prompt).not.toContain("You are helping someone");
      expect(prompt).not.toContain("Department guidance");
    }
  });
});

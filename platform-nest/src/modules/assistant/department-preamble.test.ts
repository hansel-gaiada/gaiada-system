// AIP-13b (docs/plans/2026-10-27-ai-plan.md §6.2 item 7; owner ruling AIP-D10) — the seam `resolvePreamble` and the preview, pure.
//
// What is pinned, with the database faked at `withTenants` (the DB-backed half, with the real table and the real routes, is
// src/core/dept-assistant-preamble.test.ts on the Linux gate):
//   1. the company's own row for (tenant, node) REPLACES the default; no row -> the default; no default and no row -> null;
//   2. ANY read failure (the pool throws, the table is missing, the query rejects) answers the default and never throws: a preamble is
//      additive and must never fail a turn;
//   3. the read is under `withTenants([tenantId])` (one tenant, never a wider set) and its SQL names `tenant_id` AND the node id;
//   4. a text longer than the cap is cut by CODE POINTS, never mid-surrogate; a whitespace-only row is no row;
//   5. the preview the route returns is, byte for byte, the department block of the prompt `assembleContext` builds for the same turn.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

const db = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  failWith: null as Error | null,
  calls: [] as Array<{ tenants: string[]; sql: string; params: unknown[] }>,
}));
vi.mock("../../db", async (orig) => ({
  ...(await orig<typeof import("../../db")>()),
  withTenants: async <T>(tenants: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    if (db.failWith) throw db.failWith;
    const client = {
      query: async (sql: string, params: unknown[]) => {
        db.calls.push({ tenants, sql, params });
        const body = db.rows.get(`${params[0]}|${params[1]}`);
        return { rows: body === undefined ? [] : [{ body }] };
      },
    } as unknown as PoolClient;
    return fn(client);
  },
}));
const principalFor = vi.hoisted(() => vi.fn());
vi.mock("../../rbac/principal", async (orig) => ({ ...(await orig<typeof import("../../rbac/principal")>()), assemblePrincipal: principalFor }));

import { assembleContext } from "./context";
import {
  DEFAULT_DEPT_PREAMBLES, GUIDANCE_HEADING, PREAMBLE_MAX_CHARS, capPreamble, contextLine, defaultPreamble, previewText, resolvePreamble,
  type TurnContext,
} from "./department-context";
import type { Principal } from "../../rbac/principal";

const A = "11111111-1111-4111-8111-111111111111";
const B = "99999999-9999-4999-8999-999999999999";
const OWNER = "22222222-2222-4222-8222-222222222222";
const put = (tenant: string, node: string, body: string) => db.rows.set(`${tenant}|${node}`, body);

beforeEach(() => {
  db.rows.clear();
  db.failWith = null;
  db.calls.length = 0;
  principalFor.mockReset();
  principalFor.mockResolvedValue({ userId: OWNER, assurance: "linked", companies: [A], rootCompanies: [], roles: [], perms: [], sessionVersion: 1 } as unknown as Principal);
});

describe("resolvePreamble (AIP-13b): the company's row replaces the default", () => {
  it("a row for (tenant, node) wins over the registry default", async () => {
    put(A, "d-seo", "SEO here: quote the audit id, never the client's name.");
    expect(await resolvePreamble(A, "d-seo", "seo")).toBe("SEO here: quote the audit id, never the client's name.");
  });

  it("no row: the default for the key, as before AIP-13b; no default and no row: null", async () => {
    expect(await resolvePreamble(A, "d-seo", "seo")).toBe(DEFAULT_DEPT_PREAMBLES.seo);
    expect(await resolvePreamble(A, "d-x", "marketing")).toBeNull();
    expect(await resolvePreamble(A, "d-x", "constructor")).toBeNull();
  });

  it("a row for a department with NO registry default is still used (a custom department can have a preamble)", async () => {
    put(A, "d-ops", "Operations: answer in short lists.");
    expect(await resolvePreamble(A, "d-ops", "operations")).toBe("Operations: answer in short lists.");
  });

  it("the row is per company: another company's row for the SAME node id is never used", async () => {
    put(B, "d-seo", "COMPANY B ONLY");
    expect(await resolvePreamble(A, "d-seo", "seo")).toBe(DEFAULT_DEPT_PREAMBLES.seo);
    expect(await resolvePreamble(B, "d-seo", "seo")).toBe("COMPANY B ONLY");
  });

  it("the read is ONE tenant, and the query names the tenant and the node id", async () => {
    await resolvePreamble(A, "d-seo", "seo");
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].tenants).toEqual([A]);
    expect(db.calls[0].params).toEqual([A, "d-seo"]);
    expect(db.calls[0].sql).toMatch(/FROM assistant_dept_preambles/);
    expect(db.calls[0].sql).toMatch(/tenant_id = \$1 AND unit_node_id = \$2/);
  });

  it("ANY read failure answers the default and never throws", async () => {
    for (const err of [new Error("DATABASE_URL not set"), new Error('relation "assistant_dept_preambles" does not exist'), new Error("timeout exceeded when trying to connect")]) {
      db.failWith = err;
      put(A, "d-seo", "never read");
      await expect(resolvePreamble(A, "d-seo", "seo")).resolves.toBe(DEFAULT_DEPT_PREAMBLES.seo);
      await expect(resolvePreamble(A, "d-x", "marketing")).resolves.toBeNull();
    }
  });

  it("a whitespace-only row is no row (the default stands)", async () => {
    put(A, "d-seo", "   \n  ");
    expect(await resolvePreamble(A, "d-seo", "seo")).toBe(DEFAULT_DEPT_PREAMBLES.seo);
  });

  it("a text over the cap is cut at the cap in CODE POINTS: an astral character is never split", async () => {
    put(A, "d-seo", "\u{1F600}".repeat(PREAMBLE_MAX_CHARS + 5));
    const out = (await resolvePreamble(A, "d-seo", "seo")) as string;
    expect(Array.from(out)).toHaveLength(PREAMBLE_MAX_CHARS);
    expect(out).toBe("\u{1F600}".repeat(PREAMBLE_MAX_CHARS)); // no lone surrogate at the cut
    expect(capPreamble("short")).toBe("short");
  });

  it("defaultPreamble: the registry text for an own key, null otherwise", () => {
    expect(defaultPreamble("seo")).toBe(DEFAULT_DEPT_PREAMBLES.seo);
    expect(defaultPreamble("nope")).toBeNull();
    expect(defaultPreamble("")).toBeNull();
    expect(defaultPreamble("toString")).toBeNull();
  });
});

describe("the preview is the department block of the real prompt", () => {
  const seo = { nodeId: "d-seo", name: "SEO", key: "seo" };
  const ctx = (page: string | null = null): TurnContext => ({ type: "turn_context", department: seo, page });
  const thread = { ownerUserId: OWNER, compactionSummary: null, compactionSummaryUptoSeq: null };
  const client = {
    query: async (sql: string) =>
      /FROM assistant_messages/.test(sql) ? { rows: [{ seq: 1, role: "user", content: "hello" }] } : { rows: [] },
  } as unknown as PoolClient;
  const prompt = async (turnContext: TurnContext) =>
    (await assembleContext(client, "t", thread, 2, { tenantId: A, knowledgeTopK: 0, turnContext })).prompt;

  it("a custom text: the preview sits, byte for byte, in the assembled prompt (the context line, a blank line, 'Department guidance:' and the text)", async () => {
    put(A, "d-seo", "Line one.\nLine two with a rule.");
    const preview = previewText(seo, "Line one.\nLine two with a rule.");
    expect(preview).toBe(`${contextLine(seo, null)}\n\n${GUIDANCE_HEADING}\nLine one.\nLine two with a rule.`);
    expect((await prompt(ctx())).includes(preview as string)).toBe(true);
  });

  it("the default text: the same, with no row", async () => {
    const preview = previewText(seo, DEFAULT_DEPT_PREAMBLES.seo);
    expect((await prompt(ctx())).includes(preview as string)).toBe(true);
  });

  it("with a page the context line carries it, so a preview (no page) is the line without the page clause and the guidance after it", async () => {
    const p = await prompt(ctx("Rankings"));
    expect(p).toContain("You are helping someone in the SEO department, on the Rankings page.");
    expect(p).toContain(`${GUIDANCE_HEADING}\n${DEFAULT_DEPT_PREAMBLES.seo}`);
  });

  it("no preamble: the preview is the context line alone; nothing at all is null", () => {
    expect(previewText(seo, null)).toBe("You are helping someone in the SEO department.");
    expect(previewText(null, null)).toBeNull();
    expect(previewText(null, "orphan guidance")).toBe(`${GUIDANCE_HEADING}\norphan guidance`);
  });
});

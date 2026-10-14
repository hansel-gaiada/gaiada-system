// DW-8i (docs/FRONTEND-BFF-CONTRACT.md §46.5) — the pure half of the knowledge-search filter. No database, no Cerbos: it runs anywhere.
// The I/O half (existence, title, the batched Cerbos read) is driven over HTTP in search.controller.test.ts on the Linux gate.
import { describe, it, expect } from "vitest";
import {
  FAMILIES, FAMILY_SPECS, SNIPPET_MAX, collapseHits, parseSourceRef, searchTopK, snippetOf, type StoreHit,
} from "./search-filter";

const T = "11111111-1111-4111-8111-111111111111";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const hit = (over: Partial<StoreHit>): StoreHit => ({
  tenantId: T, sourceRef: `erp:client:${U1}`, kind: "doc", text: "t", provenance: "human", confidence: 1, score: 0.5, audience: "internal", ...over,
});

describe("parseSourceRef (§46.2: the allowlist)", () => {
  it.each(FAMILIES)("parses an allowlisted family: %s", (family) => {
    expect(parseSourceRef(`erp:${family}:${U1}`)).toEqual({ family, id: U1 });
  });

  it("lower-cases the id so one record is one key", () => {
    expect(parseSourceRef(`erp:meeting:${U1.toUpperCase()}`)).toEqual({ family: "meeting", id: U1 });
  });

  it.each(["report", "person", "org", "orgunits"])("withholds the family %s (its read rule depends on who the person is)", (family) => {
    expect(parseSourceRef(`erp:${family}:${U1}`)).toBeNull();
  });

  it("withholds the refs the ingest writes for the withheld families, in their real shapes", () => {
    expect(parseSourceRef(`erp:person:${T}:${U1}`)).toBeNull();
    expect(parseSourceRef(`erp:report:department:${U1}`)).toBeNull();
    expect(parseSourceRef(`erp:org:${T}`)).toBeNull();
    expect(parseSourceRef(`erp:orgunits:${T}`)).toBeNull();
  });

  it("withholds an unknown family and a ref that is not an ERP ref (a public-site URL, a Drive path)", () => {
    expect(parseSourceRef(`erp:invoice:${U1}`)).toBeNull();
    expect(parseSourceRef("https://gaiada.com/about")).toBeNull();
    expect(parseSourceRef("drive://folder/doc")).toBeNull();
    expect(parseSourceRef(`web:client:${U1}`)).toBeNull();
  });

  it.each([
    ["no id", "erp:client:"],
    ["no family", `erp::${U1}`],
    ["a bare prefix", "erp:"],
    ["empty", ""],
    ["a non-uuid id", "erp:client:not-a-uuid"],
    ["a short id", "erp:client:1234"],
    ["an extra segment", `erp:client:${U1}:extra`],
    ["a trailing newline", `erp:client:${U1}\n`],
    ["a SQL-shaped id", `erp:client:${U1}'; DROP TABLE clients;--`],
    ["upper-case prefix", `ERP:client:${U1}`],
    ["a family in the wrong case", `erp:Client:${U1}`],
  ])("withholds a malformed ref: %s", (_label, ref) => {
    expect(parseSourceRef(ref)).toBeNull();
  });

  it("withholds a value that is not a string", () => {
    expect(parseSourceRef(undefined)).toBeNull();
    expect(parseSourceRef(null)).toBeNull();
    expect(parseSourceRef(42)).toBeNull();
    expect(parseSourceRef({ toString: () => `erp:client:${U1}` })).toBeNull();
  });
});

describe("collapseHits (§46.3: one result per record, best score, score order; §46.1: internal tier of this tenant only)", () => {
  it("collapses several chunks of one record to the best-scoring one", () => {
    const out = collapseHits([hit({ score: 0.3, text: "low" }), hit({ score: 0.9, text: "high" }), hit({ score: 0.5, text: "mid" })], T);
    expect(out).toHaveLength(1);
    expect(out[0].hit.text).toBe("high");
    expect(out[0]).toMatchObject({ family: "client", id: U1 });
  });

  it("a tie keeps the first chunk", () => {
    const out = collapseHits([hit({ score: 0.5, text: "first" }), hit({ score: 0.5, text: "second" })], T);
    expect(out[0].hit.text).toBe("first");
  });

  it("keeps different records and different families apart, in score order", () => {
    const out = collapseHits(
      [
        hit({ sourceRef: `erp:project:${U1}`, score: 0.4 }),
        hit({ sourceRef: `erp:client:${U1}`, score: 0.8 }), // same uuid, another family: another record
        hit({ sourceRef: `erp:client:${U2}`, score: 0.6 }),
      ],
      T,
    );
    expect(out.map((c) => `${c.family}:${c.id}:${c.hit.score}`)).toEqual([`client:${U1}:0.8`, `client:${U2}:0.6`, `project:${U1}:0.4`]);
  });

  it("collapses by the normalised id, whatever the case the ref was written in", () => {
    const out = collapseHits([hit({ sourceRef: `erp:client:${U1.toUpperCase()}`, score: 0.7 }), hit({ sourceRef: `erp:client:${U1}`, score: 0.2 })], T);
    expect(out).toHaveLength(1);
    expect(out[0].hit.score).toBe(0.7);
  });

  it("drops a public-tier hit, another tenant's hit and an unknown audience", () => {
    const out = collapseHits(
      [
        hit({ audience: "public" }),
        hit({ tenantId: "22222222-2222-4222-8222-222222222222", sourceRef: `erp:client:${U2}` }),
        hit({ audience: "" , sourceRef: `erp:client:${U2}` }),
        hit({ sourceRef: `erp:task:${U2}`, score: 0.1 }),
      ],
      T,
    );
    expect(out.map((c) => c.family)).toEqual(["task"]);
  });

  it("drops unparseable and withheld-family hits, and nothing else", () => {
    const out = collapseHits(
      [hit({ sourceRef: `erp:report:grain:scope` }), hit({ sourceRef: `erp:person:${T}:${U1}` }), hit({ sourceRef: "garbage" }), hit({ sourceRef: `erp:file:${U2}`, score: 0.2 })],
      T,
    );
    expect(out.map((c) => c.family)).toEqual(["file"]);
  });

  it("answers nothing for nothing", () => {
    expect(collapseHits([], T)).toEqual([]);
  });
});

describe("searchTopK (§46.1: min(limit x 4, 80))", () => {
  it.each([[1, 4], [5, 20], [10, 40], [19, 76], [20, 80], [21, 80], [100, 80]])("limit %i asks the store for %i chunks", (limit, topK) => {
    expect(searchTopK(limit)).toBe(topK);
  });
});

describe("snippetOf (§46.3: at most 300 characters, whitespace collapsed)", () => {
  it("collapses runs of whitespace and newlines, and trims", () => {
    expect(snippetOf("  Client:  Acme\n\n\tStatus:   active \r\n ")).toBe("Client: Acme Status: active");
  });
  it("leaves a short text alone and never exceeds the cap", () => {
    expect(snippetOf("short")).toBe("short");
    const long = "word ".repeat(200);
    expect(snippetOf(long).length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(snippetOf(long).endsWith("…")).toBe(true);
    expect(snippetOf("x".repeat(SNIPPET_MAX))).toHaveLength(SNIPPET_MAX);
    expect(snippetOf("x".repeat(SNIPPET_MAX)).endsWith("…")).toBe(false);
  });
});

describe("the per-family table (a family with no read check is never returned)", () => {
  const row = (over: Record<string, string | null> = {}) => ({ id: U1, title: "T", project_id: U2, target_type: null, target_id: null, ...over });

  it("has a spec for exactly the allowlist", () => {
    expect(Object.keys(FAMILY_SPECS).sort()).toEqual([...FAMILIES].sort());
  });

  it("every family asks Cerbos for a resource scoped to the tenant (a spec that returns none withholds the hit)", () => {
    for (const f of FAMILIES) {
      const r = FAMILY_SPECS[f].resources(row({ target_type: "project", target_id: U2 }), T);
      expect(r.length, f).toBeGreaterThan(0);
      for (const res of r) expect(res.tenantId, f).toBe(T);
    }
  });

  it("mirrors the read route's resource shape for each family", () => {
    const res = (f: (typeof FAMILIES)[number], r = row()) => FAMILY_SPECS[f].resources(r, T);
    expect(res("client")).toEqual([{ kind: "client", id: U1, tenantId: T }]);
    expect(res("project")).toEqual([{ kind: "project", tenantId: T, id: U1 }]);
    expect(res("task")).toEqual([{ kind: "task", tenantId: T, id: U1 }]);
    expect(res("pmtask")).toEqual([{ kind: "pm_task", tenantId: T, id: U1 }]);
    expect(res("deliverable")).toEqual([{ kind: "deliverable", id: U1, tenantId: T }]);
    // The recordings read route sends no id.
    expect(res("meeting")).toEqual([{ kind: "meeting_recording", tenantId: T }]);
    // A doc is read through its PROJECT.
    expect(res("pmdoc")).toEqual([{ kind: "pm_project", tenantId: T, id: U2 }]);
  });

  it("a file needs BOTH the file read and its parent's read, and a parent the upload route cannot attach to is withheld", () => {
    const ok = FAMILY_SPECS.file.resources(row({ target_type: "contract", target_id: U2 }), T);
    expect(ok).toEqual([{ kind: "file", id: U1, tenantId: T }, { kind: "contract", id: U2, tenantId: T }]);
    // The DW-8h kinds keep their own read shape (work_request: `{ kind, tenantId, id }` through readResourceOf).
    const wr = FAMILY_SPECS.file.resources(row({ target_type: "work_request", target_id: U2 }), T);
    expect(wr[0]).toEqual({ kind: "file", id: U1, tenantId: T });
    expect(wr[1]).toMatchObject({ kind: "work_request", tenantId: T, id: U2 });
    expect(FAMILY_SPECS.file.resources(row({ target_type: "hr_employee_file", target_id: U2 }), T)).toEqual([]);
    expect(FAMILY_SPECS.file.resources(row({ target_type: null, target_id: null }), T)).toEqual([]);
  });

  it("a doc with no project is withheld", () => {
    expect(FAMILY_SPECS.pmdoc.resources(row({ project_id: null }), T)).toEqual([]);
  });

  it("the two module-guarded routes name their module (pm, clients); the core ones name none", () => {
    expect(FAMILY_SPECS.client.module).toBe("clients");
    expect(FAMILY_SPECS.pmtask.module).toBe("pm");
    expect(FAMILY_SPECS.pmdoc.module).toBe("pm");
    for (const f of ["project", "task", "deliverable", "meeting", "file"] as const) expect(FAMILY_SPECS[f].module, f).toBeUndefined();
  });

  it("every family's SQL excludes soft-deleted rows where the table has them, and reads by $1 uuid[] only", () => {
    for (const f of FAMILIES) {
      const sql = FAMILY_SPECS[f].sql;
      expect(sql, f).toContain("ANY($1::uuid[])");
      expect(sql, f).toContain("deleted_at IS NULL");
      expect(sql, f).not.toMatch(/\$2/);
    }
  });

  it("hrefs point at real UI routes", () => {
    const h = (f: (typeof FAMILIES)[number], r = row()) => FAMILY_SPECS[f].href(r);
    expect(h("client")).toBe(`/clients/${U1}`);
    expect(h("project")).toBe(`/projects/${U1}`);
    expect(h("task")).toBe(`/tasks/${U1}`);
    expect(h("pmtask")).toBe(`/tasks/${U1}`);
    expect(h("deliverable")).toBe(`/projects/${U2}`);
    expect(h("deliverable", row({ project_id: null }))).toBe("/deliverables");
    expect(h("meeting")).toBe(`/meetings/${U1}`);
    expect(h("pmdoc")).toBe(`/projects/${U2}?view=docs`);
    expect(h("file", row({ target_type: "project", target_id: U2 }))).toBe(`/projects/${U2}`);
    expect(h("file", row({ target_type: "client", target_id: U2 }))).toBe(`/clients/${U2}`);
    expect(h("file", row({ target_type: "contract", target_id: U2 }))).toBe(`/api/files/${U1}`);
  });
});

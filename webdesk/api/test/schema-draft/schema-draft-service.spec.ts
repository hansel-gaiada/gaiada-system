// WSK-32 — the service-level wiring test: PRD -> gateway -> parse -> validate -> diff, using
// FAKE DbService/TenantLookupService (constructed directly, no Nest bootstrap, no Postgres — same
// "pure" style as test/control-command-registry.spec.ts) plus the REAL AuditService (unedited,
// ../../src/audit/audit.service.ts) to prove the audit row shape without needing a live database.
// The central assertion this file exists for: every query issued anywhere in this flow, valid or
// rejected, targets ONLY `collections` (a SELECT) and `audit_entries` (an INSERT) — never an
// INSERT/UPDATE into `collections` — which is what "a rejected proposal leaves zero side effects"
// and "never applies" mean operationally, proven rather than asserted from a comment.
import { describe, expect, it, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { SchemaDraftService } from "../../src/schema-draft/schema-draft.service";
import { AuditService } from "../../src/audit/audit.service";
import type { GatewayCompleter } from "../../src/schema-draft/gateway-client";

interface QueryCall {
  sql: string;
  params: unknown[];
}

class FakeDb {
  readonly calls: QueryCall[] = [];
  currentSchemaRow: { schema: unknown } | undefined = undefined;

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    if (/SELECT schema FROM collections/.test(sql)) {
      return { rows: this.currentSchemaRow ? [this.currentSchemaRow] : [] };
    }
    if (/INSERT INTO audit_entries/.test(sql)) {
      return { rows: [] };
    }
    throw new Error(`FakeDb: unexpected query: ${sql}`);
  }

  async withTenant<T>(_tenantId: string, fn: (db: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async transaction<T>(fn: (client: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class FakeTenants {
  bySlug = async (slug: string) => {
    if (slug === "missing-tenant") return null;
    if (slug === "suspended-tenant") return { id: "tenant-2", slug, status: "suspended" };
    return { id: "tenant-1", slug, status: "active" };
  };
}

class FakeCompleter implements GatewayCompleter {
  nextText = '{"blocks":["hero"]}';
  calls: string[] = [];
  async complete(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return this.nextText;
  }
}

function build(currentSchema?: unknown) {
  const db = new FakeDb();
  db.currentSchemaRow = currentSchema === undefined ? undefined : { schema: currentSchema };
  const tenants = new FakeTenants();
  const completer = new FakeCompleter();
  const audit = new AuditService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new SchemaDraftService(db as any, tenants as any, audit, completer);
  return { db, tenants, completer, service };
}

describe("SchemaDraftService.draftFromPrd", () => {
  it("404s on an unknown tenant slug, before any gateway call is made", async () => {
    const { service, completer } = build();
    await expect(
      service.draftFromPrd({ tenantSlug: "missing-tenant", siteId: "site-1", collectionKey: "case-study", prd: "x", actor: "human:qa" }),
    ).rejects.toThrow(NotFoundException);
    expect(completer.calls).toHaveLength(0);
  });

  it("404s on a non-active tenant", async () => {
    const { service, completer } = build();
    await expect(
      service.draftFromPrd({ tenantSlug: "suspended-tenant", siteId: "site-1", collectionKey: "case-study", prd: "x", actor: "human:qa" }),
    ).rejects.toThrow(NotFoundException);
    expect(completer.calls).toHaveLength(0);
  });

  it("VALID draft: returns valid:true, a diff, persisted:false, and writes exactly one audit row (never a collections write)", async () => {
    const { db, completer, service } = build({ blocks: ["testimonial"] });
    completer.nextText = '{"blocks":["hero","testimonial"]}';
    const result = await service.draftFromPrd({ tenantSlug: "acme", siteId: "11111111-1111-1111-1111-111111111111", collectionKey: "landing", prd: "add a hero", actor: "human:qa" });

    expect(result.validation.valid).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.diff).not.toBeNull();
    expect(result.diff!.addedBlocks).toEqual(["hero"]);
    expect(result.diff!.destructive).toBe(false);

    const writes = db.calls.filter((c) => /INSERT|UPDATE/.test(c.sql));
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toMatch(/INSERT INTO audit_entries/);
    expect(db.calls.some((c) => /INSERT INTO collections|UPDATE collections/.test(c.sql))).toBe(false);
  });

  it("INVALID draft (unknown block from the model): valid:false, diff:null, persisted:false, still exactly one audit row, zero collections writes", async () => {
    const { db, completer, service } = build(null);
    completer.nextText = '{"blocks":["hero","pricingTable"]}';
    const result = await service.draftFromPrd({ tenantSlug: "acme", siteId: "11111111-1111-1111-1111-111111111111", collectionKey: "landing", prd: "add a pricing table", actor: "human:qa" });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues[0].message).toMatch(/"pricingTable" is not one of the 9 vocabulary block types/);
    expect(result.diff).toBeNull();
    expect(result.persisted).toBe(false);

    const writes = db.calls.filter((c) => /INSERT|UPDATE/.test(c.sql));
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toMatch(/INSERT INTO audit_entries/);
    expect(db.calls.some((c) => /INSERT INTO collections|UPDATE collections/.test(c.sql))).toBe(false);
  });

  it("a model reply with no parseable JSON is rejected with a named reason, still audited, still zero collections writes", async () => {
    const { db, completer, service } = build(null);
    completer.nextText = "I could not determine a schema from that PRD.";
    const result = await service.draftFromPrd({ tenantSlug: "acme", siteId: "11111111-1111-1111-1111-111111111111", collectionKey: "landing", prd: "???", actor: "human:qa" });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues[0].message).toMatch(/no JSON object/);
    expect(result.proposedSchema).toBeNull();
    const writes = db.calls.filter((c) => /INSERT|UPDATE/.test(c.sql));
    expect(writes).toHaveLength(1);
  });

  it("a destructive proposal (removes an existing field) is still VALID (structurally in-vocabulary) but the diff flags it — the human decides, the validator does not silently block it", async () => {
    const { completer, service } = build({ fields: [{ name: "legacyNotes", primitive: "text" }] });
    completer.nextText = '{"fields":[]}';
    const result = await service.draftFromPrd({ tenantSlug: "acme", siteId: "11111111-1111-1111-1111-111111111111", collectionKey: "case-study", prd: "drop legacy notes", actor: "human:qa" });

    expect(result.validation.valid).toBe(true);
    expect(result.diff!.destructive).toBe(true);
    expect(result.diff!.removedFieldNames).toEqual(["legacyNotes"]);
    expect(result.persisted).toBe(false);
  });
});

describe("SchemaDraftService.validateAndDiff", () => {
  it("is usable directly without a gateway call, for a human-edited counter-proposal", () => {
    const { service } = build();
    const out = service.validateAndDiff("case-study", null, { fields: [{ name: "title", primitive: "text" }] });
    expect(out.validation.valid).toBe(true);
    expect(out.diff!.isNewCollection).toBe(true);
  });
});

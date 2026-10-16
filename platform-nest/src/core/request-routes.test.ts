// DW-10e-1 (BFF §60.2 and §60.11) — the routing keys, and the pins that keep every reader of them honest. No database, no Cerbos:
// this file runs on a laptop and in the fast gates. The behaviour it pins statically (the reconciler, the module gate, the fact
// job, the provider view) is PROVEN against a real database by `admin/service-assignments-routes.test.ts`; what is here is the part
// that fails the moment someone deletes a line, before any database is involved.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import {
  REQUEST_ROUTE_KEYS, isRequestRouteKey, routeKeyForKind, kindForRouteKey, resolveGroupClient,
} from "./request-routes";
import { REQUEST_KINDS, clientIntakeProjectName, CLIENT_INTAKE_NAME_MAX } from "./work-requests.service";

const NEST = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(NEST, ...p), "utf8");

// ── the keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("routing keys (core/request-routes.ts)", () => {
  it("are exactly asset_requests and engineering_requests, one per request kind", () => {
    expect([...REQUEST_ROUTE_KEYS]).toEqual(["asset_requests", "engineering_requests"]);
    expect(REQUEST_ROUTE_KEYS).toHaveLength(REQUEST_KINDS.length);
  });

  it("isRequestRouteKey is true for the two keys and for nothing else, never throwing", () => {
    for (const key of REQUEST_ROUTE_KEYS) expect(isRequestRouteKey(key)).toBe(true);
    for (const not of ["pm", "webdev", "asset_request", "Asset_Requests", " asset_requests", "", "assets", "engineering"]) {
      expect(isRequestRouteKey(not), JSON.stringify(not)).toBe(false);
    }
    for (const not of [null, undefined, 0, 1, {}, [], ["asset_requests"], true, Symbol("x")]) {
      expect(isRequestRouteKey(not as unknown)).toBe(false);
    }
  });

  it("routeKeyForKind and kindForRouteKey are inverse bijections over every kind", () => {
    const seen = new Set<string>();
    for (const kind of REQUEST_KINDS) {
      const key = routeKeyForKind(kind);
      expect(isRequestRouteKey(key)).toBe(true);
      expect(kindForRouteKey(key)).toBe(kind);
      seen.add(key);
    }
    expect(seen.size).toBe(REQUEST_KINDS.length);
    for (const key of REQUEST_ROUTE_KEYS) expect(routeKeyForKind(kindForRouteKey(key))).toBe(key);
    expect(routeKeyForKind("assets")).toBe("asset_requests");
    expect(routeKeyForKind("engineering")).toBe("engineering_requests");
  });
});

// ── the trigger's CASE is pinned to the keys ─────────────────────────────────────────────────────────────────────────────────
describe("migration 202610160500 spells the routing keys exactly as core/request-routes.ts does", () => {
  const sql = read("migrations", "202610160500_work_requests_across.sql");

  it("the route guard's `CASE NEW.kind` maps every request kind to its routing key, and nothing else", () => {
    const block = /sa\.module_key = CASE NEW\.kind([\s\S]*?)END/.exec(sql);
    expect(block, "the guard must compare sa.module_key to a CASE over NEW.kind").not.toBeNull();
    const pairs = [...block![1].matchAll(/WHEN '(\w+)' THEN '(\w+)'/g)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(pairs)).toEqual(Object.fromEntries(REQUEST_KINDS.map((k) => [k, routeKeyForKind(k)])));
    expect(pairs).toHaveLength(REQUEST_KINDS.length);
  });

  it("no other literal routing-key string appears in the migration's executable text", () => {
    const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    const literals = [...code.matchAll(/'(asset_requests|engineering_requests)'/g)].map((m) => m[1]);
    expect(literals.sort()).toEqual([...REQUEST_ROUTE_KEYS].sort());
  });

  it("declares both triggers with the contract's SQLSTATEs and the five CHECKs by name", () => {
    expect(sql).toContain("CREATE TRIGGER trg_work_requests_route_guard");
    expect(sql).toContain("BEFORE INSERT ON work_requests");
    expect(sql).toContain("CREATE TRIGGER trg_work_requests_freeze_requester");
    expect(sql).toContain("BEFORE UPDATE ON work_requests");
    expect(sql.match(/ERRCODE = 'PD060'/g)).toHaveLength(1);
    expect(sql.match(/ERRCODE = 'PD062'/g)).toHaveLength(2);
    expect(sql.match(/ERRCODE = 'PD061'/g)).toHaveLength(2);
    for (const name of [
      "work_requests_requester_route_ck", "work_requests_requester_client_ck", "work_requests_requester_unit_ck",
      "work_requests_across_from_ck", "work_requests_across_part_ck",
    ]) expect(sql, name).toContain(`ADD CONSTRAINT ${name}`);
  });

  it("is a pure additive migration: no policy on work_requests, no grant, no role", () => {
    const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(code).not.toMatch(/CREATE POLICY \w+ ON work_requests\b/);
    expect(code).not.toMatch(/\bGRANT\b/);
    expect(code).not.toMatch(/\bCREATE ROLE\b/);
    expect(code).not.toMatch(/\bSECURITY DEFINER\b/);
  });

  it("the backfill walks the companies one at a time under the tenant GUC, and SET NOT NULL follows it", () => {
    const walk = sql.indexOf("FOR co IN SELECT id FROM companies");
    const guc = sql.indexOf("set_config('app.current_tenant_ids', co.id::text, true)");
    const update = sql.indexOf("UPDATE work_requests SET requester_tenant_id = tenant_id");
    const notNull = sql.indexOf("ALTER COLUMN requester_tenant_id SET NOT NULL");
    expect(walk).toBeGreaterThan(0);
    expect(guc).toBeGreaterThan(walk);
    expect(update).toBeGreaterThan(guc);
    expect(notNull).toBeGreaterThan(update);
    // the triggers come AFTER the backfill, so the backfill's own UPDATE is never a frozen-column write
    expect(sql.indexOf("CREATE TRIGGER trg_work_requests_freeze_requester")).toBeGreaterThan(notNull);
  });
});

// ── no code names a department or a company, and no role is named after a key ───────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("a route is never a role (BFF §60.2 'Roles')", () => {
  it("no role named <routing key>_staff, _manager or _approver is seeded anywhere: migrations, seeds, Cerbos policies, bundles", () => {
    const names = REQUEST_ROUTE_KEYS.flatMap((k) => ["staff", "manager", "approver"].map((s) => `${k}_${s}`));
    const files = [
      ...walk(join(NEST, "migrations")),
      ...walk(join(NEST, "src")).filter((f) => !/\.test\.ts$/.test(f)),
      ...walk(join(NEST, "cerbos")),
    ].filter((f) => /\.(sql|ts|json|ya?ml)$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const n of names) if (text.includes(n)) hits.push(`${f}: ${n}`);
    }
    expect(hits).toEqual([]);
  });
});

// ── every reader of service_assignments that must leave routes out, still does ──────────────────────────────────────────────
describe("the readers that must leave routing keys out (static pins; the database proof is service-assignments-routes.test.ts)", () => {
  it("registry.ts enabledModuleKeys, fact-job.ts gatherForeignContext and report-rollups.ts computeProviderViewRollups filter on REQUEST_ROUTE_KEYS", () => {
    for (const file of [["src", "modules", "registry.ts"], ["src", "modules", "reports", "fact-job.ts"], ["src", "modules", "reports", "report-rollups.ts"]]) {
      const text = read(...file);
      expect(text, file.join("/")).toContain("REQUEST_ROUTE_KEYS");
      expect(text, file.join("/")).toMatch(/module_key <> ALL\(\$\d+::text\[\]\)/);
      expect(text, file.join("/")).toContain("core/request-routes");
    }
  });

  it("every service_assignments read of the module gate path filters; the shared-service tables are read nowhere else unfiltered", () => {
    // Every non-test source file that SELECTs module_key or provider/target rows from service_assignments for a module decision
    // must either filter routing keys or be one of the reviewed exceptions below (claims-based, or per-assignment, or a write).
    const reviewed = new Set([
      "src/admin/service-assignments.controller.ts", // the ORG-13 surface itself: lists and lifecycle, by assignment id
      "src/admin/service-reconciler.ts", // per-assignment; the desired set is EMPTY for a routing key (pinned below)
      "src/core/service-scopes.ts", // claims-based: a route has no claim, so it has no scope (database-proven)
      "src/seed/reassign-retired.ts", // a comment
      "src/core/dept-resolution.ts", // a comment
      "src/modules/registry.ts", "src/modules/reports/fact-job.ts", "src/modules/reports/report-rollups.ts",
      // DW-10e-2: the sender's routes read ONLY routing keys (`module_key = ANY(REQUEST_ROUTE_KEYS)`), the opposite filter: they
      // look for routes, never for a module decision (pinned in work-requests-outbound.service.test.ts)
      "src/core/work-requests-outbound.controller.ts", "src/core/work-requests-outbound.service.ts",
    ]);
    const offenders: string[] = [];
    for (const f of walk(join(NEST, "src")).filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
      const rel = f.slice(NEST.length + 1).replace(/\\/g, "/");
      if (reviewed.has(rel)) continue;
      if (/FROM\s+service_assignments|JOIN\s+service_assignments/i.test(readFileSync(f, "utf8"))) offenders.push(rel);
    }
    expect(offenders, "a NEW reader of service_assignments must filter routing keys (or be reviewed and listed here)").toEqual([]);
  });

  it("service-reconciler.ts collects no one for a routing key but still refreshes the unit and detects orphans", () => {
    const text = read("src", "admin", "service-reconciler.ts");
    expect(text).toContain('import { isRequestRouteKey } from "../core/request-routes"');
    expect(text).toMatch(/isRequestRouteKey\(row\.module_key\) \? \[\] : collectSubtreePersons\(node\)/);
    // the refresh and the orphan freeze sit BEFORE the placement, so they run for a route too
    expect(text.indexOf("org_unit.orphaned")).toBeLessThan(text.indexOf("isRequestRouteKey(row.module_key)"));
    expect(text.indexOf("SET unit_name = $2, unit_kind = $3, unit_status = 'active'")).toBeLessThan(text.indexOf("isRequestRouteKey(row.module_key)"));
  });

  it("service-assignments.controller.ts accepts a routing key in assertValidModuleKey and refuses lead, division and a missing client", () => {
    const text = read("src", "admin", "service-assignments.controller.ts");
    expect(text).toMatch(/if \(isRequestRouteKey\(key\)\) return;/);
    for (const code of ["route_unit_not_department", "route_has_no_lead", "route_needs_group_client", "group_client_ambiguous"]) {
      expect(text, code).toContain(code);
    }
    expect(text).toContain("routeOnly: true");
    expect(text).toContain('reason: "no_group_client"');
  });
});

// ── mocked reads: the parameters really carry the keys ──────────────────────────────────────────────────────────────────────
const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
let rowsFor: (sql: string) => unknown[] = () => [];
vi.mock("../db", async (importActual) => {
  const actual = await importActual<typeof import("../db")>();
  const run = async (_tenants: string[], fn: (c: PoolClient) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: rowsFor(sql), rowCount: rowsFor(sql).length };
      },
    } as unknown as PoolClient);
  return { ...actual, withTenants: run, withGlobal: run };
});

describe("the module gate and the fact job pass the routing keys to their queries", () => {
  beforeEach(() => {
    queries.length = 0;
    rowsFor = () => [];
  });

  it("enabledModuleKeys binds [tenant, REQUEST_ROUTE_KEYS] and excludes them with <> ALL", async () => {
    const { enabledModuleKeys } = await import("../modules/registry");
    rowsFor = () => [{ key: "pm" }];
    expect(await enabledModuleKeys("t-1")).toEqual(["pm"]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/module_key <> ALL\(\$2::text\[\]\)/);
    expect(queries[0].params).toEqual(["t-1", [...REQUEST_ROUTE_KEYS]]);
  });

  it("gatherForeignContext binds [tenant, REQUEST_ROUTE_KEYS] on its edge read, and with no edge returns the empty context", async () => {
    const { gatherForeignContext } = await import("../modules/reports/fact-job");
    const ctx = await gatherForeignContext("t-1");
    expect(ctx.memberships).toEqual({});
    expect(ctx.activeProviderUnits.size).toBe(0);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/FROM service_assignments/);
    expect(queries[0].sql).toMatch(/module_key <> ALL\(\$2::text\[\]\)/);
    expect(queries[0].params).toEqual(["t-1", [...REQUEST_ROUTE_KEYS]]);
  });
});

// ── the shared client lookup ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("resolveGroupClient", () => {
  const client = (rows: Array<{ id: string }>) => {
    const query = vi.fn(async () => ({ rows }));
    return { c: { query } as unknown as PoolClient, query };
  };

  it("one live record resolves to it; none and several are the two refusals", async () => {
    expect(await resolveGroupClient(client([{ id: "c1" }]).c, "P", "H")).toEqual({ status: "one", clientId: "c1" });
    expect(await resolveGroupClient(client([]).c, "P", "H")).toEqual({ status: "none" });
    expect(await resolveGroupClient(client([{ id: "c1" }, { id: "c2" }]).c, "P", "H")).toEqual({ status: "ambiguous" });
  });

  it("asks for a live, non-internal record of the PROVIDER linked to the TARGET, in that order of parameters", async () => {
    const { c, query } = client([]);
    await resolveGroupClient(c, "provider-id", "target-id");
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/tenant_id = \$1 AND group_company_id = \$2 AND deleted_at IS NULL AND NOT is_internal/);
    expect(sql).toMatch(/LIMIT 2/);
    expect(params).toEqual(["provider-id", "target-id"]);
  });
});

// ── the client requests project's name ───────────────────────────────────────────────────────────────────────────────────────
describe("clientIntakeProjectName (BFF §60.6a)", () => {
  it("is '<Department> · Requests · <Client>'", () => {
    expect(clientIntakeProjectName("Creatives", "Viceroy Bali")).toBe("Creatives · Requests · Viceroy Bali");
  });

  it("is never longer than 200 characters: the client's name is cut to fit", () => {
    const name = clientIntakeProjectName("Creatives", "x".repeat(500));
    expect([...name].length).toBe(CLIENT_INTAKE_NAME_MAX);
    expect(name.startsWith("Creatives · Requests · x")).toBe(true);
  });

  it("keeps a name of exactly 200 characters whole", () => {
    const prefix = "Web Dev · Requests · ";
    const client = "y".repeat(CLIENT_INTAKE_NAME_MAX - [...prefix].length);
    expect(clientIntakeProjectName("Web Dev", client)).toBe(`${prefix}${client}`);
  });

  it("cuts a department name so long that nothing of the client fits, never past the bound", () => {
    const name = clientIntakeProjectName("D".repeat(400), "Client");
    expect([...name].length).toBeLessThanOrEqual(CLIENT_INTAKE_NAME_MAX);
    expect(name.startsWith("DDDD")).toBe(true);
  });

  it("never splits a surrogate pair when it cuts", () => {
    const name = clientIntakeProjectName("A", "\u{1F600}".repeat(300));
    expect([...name].length).toBeLessThanOrEqual(CLIENT_INTAKE_NAME_MAX);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(name).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

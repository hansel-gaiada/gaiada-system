// Module registry: aggregates compiled-in modules; the per-tenant enable flag
// (companies.enabled_modules) gates ACCESS at request time (spec §1.1).
import { withTenants, withGlobal } from "../db";
import type { ModuleContract } from "./contract";

const modules = new Map<string, ModuleContract>();

export function registerModule(m: ModuleContract): void {
  if (modules.has(m.key)) throw new Error(`module ${m.key} already registered`);
  modules.set(m.key, m);
}

export function allModules(): ModuleContract[] {
  return [...modules.values()];
}

export function getModule(key: string): ModuleContract | undefined {
  return modules.get(key);
}

export function resetModules(): void {
  modules.clear();
}

/**
 * WSD-4 (HR design §4 / GATE-3): a module is enabled for `tenantId` when EITHER
 * `key` is in that company's own `enabled_modules` array OR there is an ACTIVE
 * service_assignment serving `key` to this tenant (the shared-service path — the served
 * company's own enabled_modules is deliberately NEVER mutated by serving; see design §4).
 * This is the ONE place the OR-clause lives (not duplicated into the guard) precisely
 * because the event consumer (consumer.service.ts) and the rollups engine
 * (rollups/engine.ts) both call this same function — putting the OR only in
 * ModuleEnabledGuard would silently break served-tenant event handling and rollups.
 *
 * Runs under `withTenants([tenantId])` (not withGlobal) because the service_assignments
 * EXISTS check must satisfy that table's dual-side `sa_select` RLS policy (0026), which
 * requires tenantId to be in the transaction's authorized-tenant-set; companies has no RLS
 * so folding both reads into one tenant-scoped query is safe either way.
 */
export async function isModuleEnabled(tenantId: string, key: string): Promise<boolean> {
  return (await enabledModuleKeys(tenantId)).includes(key);
}

/**
 * The SET form of the rule above: every module key enabled for `tenantId`, from BOTH sources.
 * `isModuleEnabled` delegates here so the OR-clause exists in exactly one query — a second
 * hand-written copy of it is how a served tenant ends up authorized on one code path and denied
 * on another.
 *
 * Exists because callers that must reason about the whole set (the settings UI's toggle list, any
 * surface that wants to say "this module is off" instead of rendering an empty page) would
 * otherwise fan out one round-trip per compiled-in module. Returns keys that are enabled but NOT
 * compiled into this build too — that combination is real (a renamed/removed module, or an active
 * assignment for a key this build doesn't ship) and callers need to see it to clear it.
 *
 * Same `withTenants` reasoning as above (service_assignments' dual-side `sa_select` RLS policy).
 */
export async function enabledModuleKeys(tenantId: string): Promise<string[]> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{ key: string }>(
      `SELECT unnest(enabled_modules) AS key FROM companies
        WHERE id = $1 AND deleted_at IS NULL
       UNION
       SELECT module_key AS key FROM service_assignments
        WHERE target_tenant_id = $1 AND status = 'active'`,
      [tenantId],
    ),
  );
  return rows.map((r) => r.key);
}

/**
 * IAM-01d: fail-closed drift guard between `ModuleContract.permissions` (compile-time, this
 * registry) and the DB permission catalog (IAM-01c, `permissions` table seeded by migration
 * 0093 from `src/rbac/permission-catalog.json`).
 *
 * Every module-declared permission key must resolve to a `class = 'grantable'` (and not
 * `deprecated_at`) row in the catalog. This deliberately EXCLUDES `class = 'relationship'` rows
 * (the 15 bypass-exempt pairs, Ruling 3 — assistant thread/memory/agent_run + `mcp_tool.call`) —
 * a module declaring one of those is exactly the defect class this guard exists to catch, not a
 * pass. Coverage is asymmetric on purpose: `module-declared ⊆ catalog`, never equality (161 of
 * 215 grantable permissions have no module declaration at all, per the IAM-01b reconciliation —
 * see docs/superpowers/plans/2026-08-10-permission-catalog.md §7), so this only checks the
 * declared-subset direction.
 *
 * Call this ONCE, after every `registerModule()` call in bootstrap (main.ts), with the DB pool
 * already up (i.e. after `migrate()`). Throws — refusing to start the process — rather than
 * logging and continuing, because a module whose declared permission is invisible to the catalog
 * is a module the UI/MCP/future bundle-authoring layer cannot reason about safely; per the ticket,
 * "a module declaring an uncatalogued permission must refuse to start, not silently no-op."
 *
 * Uses `withGlobal` (no tenant/module GUC) because `permissions` is global reference data — no
 * `tenant_id` column, never FORCE-RLS (see migration 0093's own header) — exactly like the
 * `users`/`identity_links` reads that already use this helper.
 */
export async function validateModulePermissions(): Promise<void> {
  const { rows } = await withGlobal((c) =>
    c.query<{ key: string }>(
      `SELECT key FROM permissions WHERE class = 'grantable' AND deprecated_at IS NULL`,
    ),
  );
  const catalog = new Set(rows.map((r) => r.key));

  const problems: string[] = [];
  for (const mod of allModules()) {
    for (const perm of mod.permissions) {
      if (!catalog.has(perm.key)) {
        problems.push(`${mod.key}: "${perm.key}"`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "IAM-01d boot-block: the following module-declared permissions are not catalogued as a " +
        "role-grantable permission in the DB 'permissions' table (either uncatalogued, or the " +
        "catalog itself has not been seeded — run migrations first). A module must never declare " +
        "a permission the catalog does not recognize as grantable (this also rejects the 15 " +
        "class='relationship' pairs, which by Ruling 3 must never be role-grantable). " +
        `Refusing to start:\n  ${problems.join("\n  ")}`,
    );
  }
}

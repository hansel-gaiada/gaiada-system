// Module registry: aggregates compiled-in modules; the per-tenant enable flag
// (companies.enabled_modules) gates ACCESS at request time (spec §1.1).
import { withTenants } from "../db";
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
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{ enabled: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM companies
           WHERE id = $1 AND deleted_at IS NULL AND $2 = ANY(enabled_modules)
         )
         OR EXISTS (
           SELECT 1 FROM service_assignments
           WHERE target_tenant_id = $1 AND module_key = $2 AND status = 'active'
         )
       ) AS enabled`,
      [tenantId, key],
    ),
  );
  return rows[0]?.enabled ?? false;
}

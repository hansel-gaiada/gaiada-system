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

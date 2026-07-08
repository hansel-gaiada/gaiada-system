// Module registry: aggregates compiled-in modules; the per-tenant enable flag
// (companies.enabled_modules) gates ACCESS at request time (spec §1.1).
import { withGlobal } from "../db";
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

export async function isModuleEnabled(tenantId: string, key: string): Promise<boolean> {
  const { rows } = await withGlobal((c) =>
    c.query<{ enabled: boolean }>(
      `SELECT $2 = ANY(enabled_modules) AS enabled FROM companies WHERE id = $1 AND deleted_at IS NULL`,
      [tenantId, key],
    ),
  );
  return rows[0]?.enabled ?? false;
}

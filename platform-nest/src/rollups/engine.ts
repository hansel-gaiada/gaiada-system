// Rollup engine (D12). Metrics exist ONLY if declared in the governed metric_definitions
// registry; recompute is idempotent on (tenant, module, metric_key, period, dimensions);
// ratios live as numerator/denominator; providers compute from LOCAL tenant data.
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { allModules, isModuleEnabled } from "../modules/registry";
import type { MetricDef, RollupProvider, RollupRow } from "../modules/contract";

const coreProviders: Array<{ module: string; provider: RollupProvider }> = [];

export function registerCoreRollupProvider(provider: RollupProvider): void {
  coreProviders.push({ module: "core", provider });
}

export function resetCoreRollupProviders(): void {
  coreProviders.length = 0;
}

export async function syncMetricDefinitions(): Promise<void> {
  const defs: Array<{ module: string; def: MetricDef }> = [
    ...coreProviders.flatMap((p) => p.provider.metrics.map((def) => ({ module: p.module, def }))),
    ...allModules().flatMap((m) => m.rollupProviders.flatMap((p) => p.metrics.map((def) => ({ module: m.key, def })))),
  ];
  await withGlobal(async (c) => {
    for (const { module, def } of defs) {
      await c.query(
        `INSERT INTO metric_definitions (metric_key, module, description, unit, is_monetary, aggregation_rule)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (metric_key) DO UPDATE SET description = $3, unit = $4, is_monetary = $5, aggregation_rule = $6`,
        [def.metricKey, module, def.description, def.unit, def.isMonetary, def.aggregationRule],
      );
    }
  });
}

async function upsertRows(tenantId: string, module: string, period: string, rows: RollupRow[]): Promise<void> {
  const asOf = new Date();
  await withTenants([tenantId], async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO rollup_metrics (id, tenant_id, module, metric_key, period, numerator, denominator, currency, dimensions, as_of, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, module, metric_key, period, dimensions)
         DO UPDATE SET numerator = $6, denominator = $7, currency = $8, as_of = $10, computed_at = now()`,
        [
          newId(), tenantId, module, r.metricKey, period,
          r.numerator, r.denominator ?? null, r.currency ?? null,
          JSON.stringify(r.dimensions ?? {}), asOf, config.originSite,
        ],
      );
    }
  });
}

/** Recompute one tenant's rollups for a period: core providers + enabled modules'. */
export async function recomputeRollups(tenantId: string, period: string): Promise<number> {
  let written = 0;
  for (const { module, provider } of coreProviders) {
    const rows = await withTenants([tenantId], (c) => provider.compute(c, tenantId, period));
    await upsertRows(tenantId, module, period, rows);
    written += rows.length;
  }
  for (const mod of allModules()) {
    if (!(await isModuleEnabled(tenantId, mod.key))) continue;
    for (const provider of mod.rollupProviders) {
      const rows = await withTenants([tenantId], (c) => provider.compute(c, tenantId, period));
      await upsertRows(tenantId, mod.key, period, rows);
      written += rows.length;
    }
  }
  return written;
}

/** Core provider: task status counts + open ratio (numerator/denominator form). */
export const coreTaskRollups: RollupProvider = {
  metrics: [
    {
      metricKey: "core.tasks.by_status",
      description: "Task count per status",
      unit: "count",
      isMonetary: false,
      aggregationRule: "sum",
    },
    {
      metricKey: "core.tasks.open_ratio",
      description: "Open tasks over all tasks (ratio of sums — never a pre-divided %)",
      unit: "ratio",
      isMonetary: false,
      aggregationRule: "ratio_of_sums",
    },
  ],
  compute: async (client) => {
    const byStatus = await client.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM tasks WHERE deleted_at IS NULL GROUP BY status`,
    );
    const rows: RollupRow[] = byStatus.rows.map((r) => ({
      metricKey: "core.tasks.by_status",
      numerator: Number(r.n),
      dimensions: { status: r.status },
    }));
    const total = byStatus.rows.reduce((s, r) => s + Number(r.n), 0);
    const open = byStatus.rows.filter((r) => r.status !== "done").reduce((s, r) => s + Number(r.n), 0);
    rows.push({ metricKey: "core.tasks.open_ratio", numerator: open, denominator: total });
    return rows;
  },
};

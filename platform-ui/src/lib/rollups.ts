import type { RollupRow } from "@/lib/entities";

export interface CompanyRollup {
  company: string;
  tenantId: string;
  metrics: { key: string; value: number; ratio: number | null; currency: string | null }[];
}

// Groups the flat rollup rows returned by the backend into one entry per
// tenant (company), each carrying its metrics. Preserves the order companies
// and metrics first appear in `rows` — the backend already orders these
// sensibly and this keeps the UI stable across renders.
export function groupRollups(rows: RollupRow[]): CompanyRollup[] {
  const byTenant = new Map<string, CompanyRollup>();
  for (const row of rows) {
    let entry = byTenant.get(row.tenant_id);
    if (!entry) {
      entry = { company: row.company, tenantId: row.tenant_id, metrics: [] };
      byTenant.set(row.tenant_id, entry);
    }
    entry.metrics.push({
      key: row.metric_key,
      value: row.numerator,
      ratio: row.denominator ? row.numerator / row.denominator : null,
      currency: row.currency,
    });
  }
  return [...byTenant.values()];
}

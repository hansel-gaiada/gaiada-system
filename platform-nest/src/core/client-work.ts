// Core client-work rollup provider (ported). The routes are a controller now; this file
// keeps the RollupProvider so it can be registered as a core provider and imported by tests.
import type { RollupProvider } from "../modules/contract";

export const clientWorkRollups: RollupProvider = {
  metrics: [
    {
      metricKey: "core.time.billable_minutes",
      description: "Billable minutes logged in the period",
      unit: "minutes",
      isMonetary: false,
      aggregationRule: "sum",
    },
    {
      metricKey: "core.deliverables.open",
      description: "Deliverables not yet delivered or accepted",
      unit: "count",
      isMonetary: false,
      aggregationRule: "sum",
    },
  ],
  compute: async (client, _tenantId, period) => {
    const minutes = await client.query<{ n: string }>(
      `SELECT COALESCE(sum(minutes), 0) AS n FROM time_entries
       WHERE billable = true AND deleted_at IS NULL AND entry_date = $1::date`,
      [period],
    );
    const open = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM deliverables WHERE status NOT IN ('delivered','accepted') AND deleted_at IS NULL`,
    );
    return [
      { metricKey: "core.time.billable_minutes", numerator: Number(minutes.rows[0].n) },
      { metricKey: "core.deliverables.open", numerator: Number(open.rows[0].n) },
    ];
  },
};

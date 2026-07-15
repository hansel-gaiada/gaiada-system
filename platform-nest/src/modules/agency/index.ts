// Digital-agency module contract (NestJS port). The ROUTES now live in AgencyController; this
// object carries the registry/rollup metadata (rollupProviders, permissions, customFieldTargets,
// mcpTools, migrations, uiManifest) that the engine + registry + health list consume.
import type { ModuleContract, RollupProvider } from "../contract";

const agencyRollups: RollupProvider = {
  metrics: [
    { metricKey: "agency.campaigns.active", description: "Active campaigns", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "agency.approvals.pending", description: "Approvals waiting for a decision", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "agency.assets.in_review", description: "Creative assets awaiting review", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "agency.utilization", description: "Billable minutes over capacity (ratio of sums)", unit: "ratio", isMonetary: false, aggregationRule: "ratio_of_sums" },
    { metricKey: "agency.deliverables.due_week", description: "Open deliverables due within 7 days of the period", unit: "count", isMonetary: false, aggregationRule: "sum" },
  ],
  compute: async (client, _tenantId, period) => {
    const campaigns = await client.query<{ n: string }>(`SELECT count(*) AS n FROM agency_campaigns WHERE status = 'active' AND deleted_at IS NULL`);
    const approvals = await client.query<{ n: string }>(`SELECT count(*) AS n FROM agency_approvals WHERE status = 'pending' AND deleted_at IS NULL`);
    const assets = await client.query<{ n: string }>(`SELECT count(*) AS n FROM agency_creative_assets WHERE review_status = 'in_review' AND deleted_at IS NULL`);
    const billable = await client.query<{ n: string }>(
      `SELECT COALESCE(sum(minutes), 0) AS n FROM time_entries WHERE billable = true AND deleted_at IS NULL AND entry_date = $1::date`, [period],
    );
    const members = await client.query<{ n: string }>(`SELECT count(*) AS n FROM company_memberships WHERE deleted_at IS NULL AND status = 'active'`);
    const capacity = Number(members.rows[0].n) * 8 * 60;
    const due = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM deliverables WHERE deleted_at IS NULL AND status NOT IN ('delivered','accepted')
         AND due_date IS NOT NULL AND due_date >= $1::date AND due_date < $1::date + interval '7 days'`, [period],
    );
    return [
      { metricKey: "agency.campaigns.active", numerator: Number(campaigns.rows[0].n) },
      { metricKey: "agency.approvals.pending", numerator: Number(approvals.rows[0].n) },
      { metricKey: "agency.assets.in_review", numerator: Number(assets.rows[0].n) },
      { metricKey: "agency.utilization", numerator: Number(billable.rows[0].n), denominator: capacity },
      { metricKey: "agency.deliverables.due_week", numerator: Number(due.rows[0].n) },
    ];
  },
};

export const agencyModule: ModuleContract = {
  key: "agency",
  migrations: ["0002_module_agency.sql", "0006_agency_creative_assets.sql"],
  permissions: [
    { key: "agency:campaign:read", description: "View campaigns" },
    { key: "agency:campaign:create", description: "Create campaigns" },
    { key: "agency:brief:write", description: "Write campaign briefs" },
    { key: "agency:asset:write", description: "Add/update creative assets" },
    { key: "agency:approval:approve", description: "Decide approvals" },
  ],
  customFieldTargets: ["agency_campaign", "agency_creative_asset"],
  mcpTools: [
    {
      name: "agency.listCampaigns",
      description: "List the tenant's campaigns with status",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/agency/campaigns",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "agency.pendingApprovals",
      description: "Approvals waiting for a decision",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/agency/approvals/pending",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
  ],
  rollupProviders: [agencyRollups],
  uiManifest: [
    { label: "Campaigns", path: "/agency/campaigns" },
    { label: "Creative", path: "/agency/assets" },
    { label: "Approvals", path: "/agency/approvals" },
  ],
  // routes: omitted — served by AgencyController in the NestJS port.
};

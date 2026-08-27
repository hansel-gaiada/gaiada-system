// Automation service accounts (WS4 §3). An n8n workflow reaches the platform via its OBO
// envelope (provider "n8n", external_id "wf:<name>"). The AuthGuard resolves a VERIFIED
// identity_link to a real principal — so without this seed every automation call lands as
// ANONYMOUS and Cerbos denies it. Here each workflow gets a dedicated, least-privilege service
// user + membership + a single scoped role + a verified link. Combined with the mcp-hub tool
// allow-list, that's two-layer least privilege: the hub bounds WHICH tools, Cerbos bounds WHICH
// data/actions. Idempotent. RBAC-minted short-lived per-workflow creds are the target-state.
//
// Run after the agency seed: DATABASE_URL=... tsx src/seed/automation.ts
import { withGlobal, closePool } from "../db";
import { migrate } from "../db/migrate";
import { createUser, addMembership, createRole, grantRole, linkIdentity } from "../testing/fixtures";

// Must match the company `seed:agency` actually creates (seed/agency.ts). These drifted apart —
// the old literal "Gaiada Creative" matched no row, so findAgencyTenant() returned null and this
// seed exited 1 before creating a single service account, leaving every workflow anonymous.
// Overridable for non-default tenants: AGENCY_NAME=... tsx src/seed/automation.ts
const AGENCY_NAME = process.env.AGENCY_NAME ?? "Gaia Digital Agency";

// Each account's role is the MINIMUM its workflow's tools need (verified against the Cerbos
// resource policies): read approvals -> member; read+update tasks -> member; create project/task
// + notify -> manager; read compliance gates -> company_admin.
export const AUTOMATION_ACCOUNTS: ReadonlyArray<{ workflowId: string; role: string; email: string; name: string }> = [
  // manager (not member): raises in-app notifications (Cerbos gates notification.create to admin/manager).
  { workflowId: "wf:stale-approval-chaser", role: "manager", email: "automation+stale-approval-chaser@gaiada.system", name: "Automation — Stale-approval chaser" },
  { workflowId: "wf:task-sla", role: "member", email: "automation+task-sla@gaiada.system", name: "Automation — Task SLA escalation" },
  { workflowId: "wf:new-client-seed", role: "manager", email: "automation+new-client-seed@gaiada.system", name: "Automation — New-client seed" },
  { workflowId: "wf:compliance-gate-nag", role: "company_admin", email: "automation+compliance-gate-nag@gaiada.system", name: "Automation — Compliance-gate nag" },
  { workflowId: "wf:inbound-lead-intake", role: "manager", email: "automation+inbound-lead-intake@gaiada.system", name: "Automation — Inbound lead intake" },
  // Event notify flow (org_structure.updated -> in-app notification). manager = can notify.
  { workflowId: "wf:org-updated-notify", role: "manager", email: "automation+org-updated-notify@gaiada.system", name: "Automation — Org-updated notify" },
  // WS11 meeting-to-delivery pipeline. Dispatcher/delivery/scope create runs+stages and open gates
  // (create posture = member/manager, like new-client-seed); report only notifies. None DECIDE gates
  // (that stays a human governance action). manager covers create-run/stage/gate + notify.
  { workflowId: "wf:mtg-dispatcher", role: "manager", email: "automation+mtg-dispatcher@gaiada.system", name: "Automation — Meeting dispatcher" },
  { workflowId: "wf:delivery", role: "manager", email: "automation+delivery@gaiada.system", name: "Automation — Delivery track" },
  { workflowId: "wf:scope", role: "manager", email: "automation+scope@gaiada.system", name: "Automation — Scope agreement track" },
  { workflowId: "wf:report", role: "manager", email: "automation+report@gaiada.system", name: "Automation — Report track" },
  // WD-26: digests read work_activity (member+) + notify (manager+) + workActivity.relink, which is
  // gated to the SAME admin/service tier as work_activity's ingest ("create") — company_admin is the
  // minimum role that covers all three.
  { workflowId: "wf:wd-digests", role: "company_admin", email: "automation+wd-digests@gaiada.system", name: "Automation — WD digests" },
  // WD-26: stale-nag only reads work_activity (member+) and notifies (manager+) — manager covers both.
  { workflowId: "wf:wd-stale-nag", role: "manager", email: "automation+wd-stale-nag@gaiada.system", name: "Automation — WD stale-task nag" },
  // TR-11: the three reports/check-in flows. All three call platform-nest DIRECTLY for their main
  // read/write (bypassing the hub — `facts/recompute` is deliberately never an MCP tool per §9.2,
  // and the two checkin service reads are ops/service-tier, not agent-callable either),
  // authenticated with the platform's own PLATFORM_SERVICE_TOKEN. company_admin is the MINIMUM
  // role that satisfies every Cerbos check each flow makes: `report_admin`'s recompute
  // (nightly-facts), `checkin`'s pending_reminders + missed_by_unit (eod-reminder /
  // morning-escalation) — see resource_report_admin.yaml / resource_checkin.yaml. All three ALSO
  // call the hub's `notify` tool (dead-letter alert / in-app fallback / per-lead escalation
  // respectively), which needs the matching mcp-hub AUTOMATION_ALLOWLIST entry (automation-policy.ts).
  { workflowId: "wf:reports-nightly-facts", role: "company_admin", email: "automation+reports-nightly-facts@gaiada.system", name: "Automation — Reports nightly facts" },
  { workflowId: "wf:reports-eod-reminder", role: "company_admin", email: "automation+reports-eod-reminder@gaiada.system", name: "Automation — Check-in EOD reminder" },
  { workflowId: "wf:reports-morning-escalation", role: "company_admin", email: "automation+reports-morning-escalation@gaiada.system", name: "Automation — Check-in morning escalation" },
  // TR-22: the two P4 seal/generate/deliver flows (§10 flows 4/5). Same reasoning as TR-11's
  // three accounts above — company_admin is the MINIMUM role that satisfies every Cerbos check
  // either flow makes: `report_period`'s `view`/`seal` (resource_report_period.yaml) and
  // `report_document`'s `read_department`/`read_company` (resource_report_document.yaml, via the
  // `overview` listing and the `export` create endpoint both flows call to render PDFs). Neither
  // flow calls `amend` or `pin` — no broader grant is needed. Both also call the hub's `notify`
  // tool (dead-letter alert on a genuine seal/render failure), matching the mcp-hub
  // AUTOMATION_ALLOWLIST entries (automation-policy.ts).
  { workflowId: "wf:reports-weekly-seal", role: "company_admin", email: "automation+reports-weekly-seal@gaiada.system", name: "Automation — Reports weekly seal" },
  { workflowId: "wf:reports-monthly-seal", role: "company_admin", email: "automation+reports-monthly-seal@gaiada.system", name: "Automation — Reports monthly seal" },
  // WSK-31 — the WebDesk Zone B->A bridge identity (webdesk-design.md §03 channel 1 / §09;
  // ZoneBEventsController's own header names this seed as its job). `resource_webdev_zoneb_event.yaml`
  // grants `record` to company_admin/manager/module_manager, gated on `variables.inTenant &&
  // variables.notLow` — `manager` is the SAME MINIMUM tier every other single-purpose bridge/CRON
  // account above already uses (wf:mtg-dispatcher, wf:delivery, wf:org-updated-notify: all
  // "manager" for "can notify / can record a fact"), so this follows that precedent rather than
  // inventing a new one. Scoped to the SAME agency tenant every other wf: account here is scoped to
  // (AGENCY_NAME) — the live Zone A mirror for WebDesk sites is agency-owned today (WSK-D26's
  // tenant-zero finding); a genuinely multi-company WebDesk tenant set is WSK-23/24's Sites-tab
  // scope, not this bridge identity's. Before this row landed, the `wd-zoneb-intake` flow's OBO
  // envelope (provider n8n, external_id wf:webdesk-zoneb-intake) resolved to NO identity_links row
  // at all -> ANONYMOUS -> Cerbos denies everything -> every real call 403s. This is the exact
  // production gap this ticket exists to close (PROGRESS.md WSK-12 session log, 2026-08-27).
  { workflowId: "wf:webdesk-zoneb-intake", role: "manager", email: "automation+webdesk-zoneb-intake@gaiada.system", name: "Automation — WebDesk Zone B intake" },
];

async function existingLink(externalId: string): Promise<boolean> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM identity_links WHERE provider = 'n8n' AND external_id = $1`, [externalId]),
  );
  return rows.length > 0;
}

async function userIdByEmail(email: string): Promise<string | null> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]),
  );
  return rows[0]?.id ?? null;
}

async function findAgencyTenant(): Promise<string | null> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  return rows[0]?.id ?? null;
}

/** Seed the automation service accounts for a tenant. Returns the count newly created.
 * Idempotent AND self-healing: membership + the scoped role are (re)ensured on every run
 * (fixtures use ON CONFLICT DO NOTHING), so changing an account's `role` here and re-running
 * applies the new grant to an already-linked service user — no manual RBAC edits. */
export async function seedAutomationAccounts(tenantId: string): Promise<number> {
  let created = 0;
  for (const acc of AUTOMATION_ACCOUNTS) {
    const linked = await existingLink(acc.workflowId);
    let userId = linked ? await userIdByEmail(acc.email) : null;
    if (!userId) {
      userId = await createUser(acc.email, acc.name, "Automation service account");
      if (!linked) created++;
    }
    // kind='service': these are workflows, not staff. Without it they take the column default
    // 'employee' and every people-shaped surface counts them as colleagues.
    await addMembership(tenantId, userId, "service"); // idempotent
    await grantRole(userId, await createRole(acc.role), "company", tenantId); // idempotent; ensures/upgrades role
    if (!linked) await linkIdentity(userId, "n8n", acc.workflowId, true); // verified -> AuthGuard mints a real principal
  }
  return created;
}

if (require.main === module) {
  (async () => {
    await migrate();
    const tenantId = await findAgencyTenant();
    if (!tenantId) {
      console.error(`agency tenant "${AGENCY_NAME}" not found — run \`npm run seed:agency\` first`);
      process.exit(1);
    }
    const n = await seedAutomationAccounts(tenantId);
    console.log(`automation accounts: ${n} created (${AUTOMATION_ACCOUNTS.length - n} already present) for tenant ${tenantId}`);
    await closePool();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

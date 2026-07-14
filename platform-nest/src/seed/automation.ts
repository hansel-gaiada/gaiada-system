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

const AGENCY_NAME = "Gaiada Creative";

// Each account's role is the MINIMUM its workflow's tools need (verified against the Cerbos
// resource policies): read approvals -> member; create project/task + notify -> manager;
// read compliance gates -> company_admin.
export const AUTOMATION_ACCOUNTS: ReadonlyArray<{ workflowId: string; role: string; email: string; name: string }> = [
  { workflowId: "wf:stale-approval-chaser", role: "member", email: "automation+stale-approval-chaser@gaiada.system", name: "Automation — Stale-approval chaser" },
  { workflowId: "wf:new-client-seed", role: "manager", email: "automation+new-client-seed@gaiada.system", name: "Automation — New-client seed" },
  { workflowId: "wf:compliance-gate-nag", role: "company_admin", email: "automation+compliance-gate-nag@gaiada.system", name: "Automation — Compliance-gate nag" },
  { workflowId: "wf:inbound-lead-intake", role: "manager", email: "automation+inbound-lead-intake@gaiada.system", name: "Automation — Inbound lead intake" },
];

async function existingLink(externalId: string): Promise<boolean> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM identity_links WHERE provider = 'n8n' AND external_id = $1`, [externalId]),
  );
  return rows.length > 0;
}

async function findAgencyTenant(): Promise<string | null> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  return rows[0]?.id ?? null;
}

/** Seed the automation service accounts for a tenant. Returns the count newly created. */
export async function seedAutomationAccounts(tenantId: string): Promise<number> {
  let created = 0;
  for (const acc of AUTOMATION_ACCOUNTS) {
    if (await existingLink(acc.workflowId)) continue; // idempotent
    const userId = await createUser(acc.email, acc.name, "Automation service account");
    await addMembership(tenantId, userId);
    await grantRole(userId, await createRole(acc.role), "company", tenantId);
    await linkIdentity(userId, "n8n", acc.workflowId, true); // verified -> AuthGuard mints a real principal
    created++;
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

// First-deploy seed (5c.7): a realistic digital-agency tenant so the platform is operable
// from minute one — users with the full role spread, clients, client-linked projects, a
// live campaign with briefs + creative assets, deliverables due this week, assigned tasks,
// and logged billable time. Direct DB inserts (no running server needed). Idempotent: a
// second run is a no-op if the tenant already exists.
//
// Run: DATABASE_URL=... tsx src/seed/agency.ts   (use a NOBYPASSRLS app role in real envs)
import { newId, withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { migrate } from "../db/migrate";
import {
  createCompany, createUser, addMembership, createRole, grantRole, createProject, createTask,
} from "../testing/fixtures";

const AGENCY_NAME = "Gaiada Creative";

export interface SeededAgency {
  tenantId: string;
  users: Record<string, string>;
  clients: string[];
  projects: string[];
  campaignId: string;
}

async function alreadySeeded(): Promise<string | null> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  return rows[0]?.id ?? null;
}

export async function seedAgency(): Promise<SeededAgency> {
  const existing = await alreadySeeded();
  if (existing) {
    return { tenantId: existing, users: {}, clients: [], projects: [], campaignId: "" };
  }
  const site = config.originSite;
  const tenantId = await createCompany(AGENCY_NAME, ["agency"]);

  // People: the full role spread the agency needs at first deploy.
  const users = {
    admin: await createUser("owner@gaiada-creative.test", "Ayu (Owner)", "Managing Director"),
    pm: await createUser("pm@gaiada-creative.test", "Budi (PM)", "Project Manager"),
    designer: await createUser("design@gaiada-creative.test", "Citra (Design)", "Senior Designer"),
    copy: await createUser("copy@gaiada-creative.test", "Dewi (Copy)", "Copywriter"),
    approver: await createUser("approver@gaiada-creative.test", "Eka (Client Lead)", "Client Lead"),
    exec: await createUser("exec@gaiada.test", "Gaiada Exec", "Group Executive"),
  };
  for (const u of [users.admin, users.pm, users.designer, users.copy, users.approver]) await addMembership(tenantId, u);
  await grantRole(users.admin, await createRole("company_admin"), "company", tenantId);
  await grantRole(users.pm, await createRole("manager"), "company", tenantId);
  await grantRole(users.designer, await createRole("member"), "company", tenantId);
  await grantRole(users.copy, await createRole("member"), "company", tenantId);
  await grantRole(users.approver, await createRole("member"), "company", tenantId);
  await grantRole(users.approver, await createRole("agency_approver"), "company", tenantId);
  await grantRole(users.exec, await createRole("group_executive"), "global", null);

  // Clients + client-linked projects.
  const clients = await withTenants([tenantId], async (c) => {
    const ids: string[] = [];
    for (const name of ["Bali Beach Resort", "Nusa Coffee Co"]) {
      const id = newId();
      await c.query(
        `INSERT INTO clients (id, tenant_id, name, contact, origin_site) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenantId, name, JSON.stringify({ email: `hello@${name.split(" ")[0].toLowerCase()}.test` }), site],
      );
      ids.push(id);
    }
    return ids;
  });
  const projects: string[] = [];
  for (let i = 0; i < clients.length; i++) {
    const pid = await createProject(tenantId, `${["Rebrand", "Launch"][i]} — ${["Bali Beach", "Nusa Coffee"][i]}`, users.pm);
    await withTenants([tenantId], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [pid, clients[i]]));
    projects.push(pid);
  }

  // A live campaign with briefs + creative assets (one already in review).
  const campaignId = newId();
  await withTenants([tenantId], async (c) => {
    await c.query(
      `INSERT INTO agency_campaigns (id, tenant_id, project_id, name, budget_minor, currency, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [campaignId, tenantId, projects[0], "Q3 Rebrand Launch", 50_000_000, "IDR", site],
    );
    await c.query(
      `INSERT INTO agency_briefs (id, tenant_id, campaign_id, title, body, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), tenantId, campaignId, "Hero campaign brief", "Coastal-luxury tone; launch by end of quarter.", site],
    );
    const assetInReview = newId();
    await c.query(
      `INSERT INTO agency_creative_assets (id, tenant_id, campaign_id, name, kind, review_status, origin_site)
       VALUES ($1, $2, $3, 'Hero banner v2', 'design', 'in_review', $4),
              ($5, $2, $3, 'Launch copy', 'copy', 'draft', $4)`,
      [assetInReview, tenantId, campaignId, site, newId()],
    );
    await c.query(
      `INSERT INTO agency_approvals (id, tenant_id, campaign_id, asset_id, subject, requested_by, origin_site)
       VALUES ($1, $2, $3, $4, 'Review: Hero banner v2', $5, $6)`,
      [newId(), tenantId, campaignId, assetInReview, users.designer, site],
    );
  });

  // Deliverables (one due within the week), assigned tasks, and billable time.
  await withTenants([tenantId], async (c) => {
    await c.query(
      `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, due_date, origin_site)
       VALUES ($1, $2, $3, $4, 'Brand guidelines', 'in_progress', current_date + 3, $5),
              ($6, $2, $3, $4, 'Social kit',       'pending',     current_date + 10, $5)`,
      [newId(), tenantId, projects[0], clients[0], site, newId()],
    );
  });
  const task1 = await createTask(tenantId, projects[0], "Design hero banner", "in_progress");
  const task2 = await createTask(tenantId, projects[0], "Write launch copy");
  await withTenants([tenantId], async (c) => {
    await c.query(`UPDATE tasks SET assignee_id = $2 WHERE id = $1`, [task1, users.designer]);
    await c.query(`UPDATE tasks SET assignee_id = $2 WHERE id = $1`, [task2, users.copy]);
    await c.query(
      `INSERT INTO time_entries (id, tenant_id, user_id, project_id, task_id, minutes, billable, entry_date, notes, origin_site)
       VALUES ($1, $2, $3, $4, $5, 180, true, current_date, 'Hero exploration', $6),
              ($7, $2, $8, $4, $9, 120, true, current_date, 'First copy draft', $6)`,
      [newId(), tenantId, users.designer, projects[0], task1, site, newId(), users.copy, task2],
    );
  });

  return { tenantId, users, clients, projects, campaignId };
}

if (require.main === module) {
  (async () => {
    await migrate();
    const r = await seedAgency();
    console.log(r.campaignId ? `seeded agency tenant ${r.tenantId}` : `agency tenant already present (${r.tenantId})`);
    await closePool();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

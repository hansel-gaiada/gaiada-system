// Showcase seed: a full "D & A Syrowatka" holding with member companies and rich data across
// EVERY app capability — org hierarchy, people/roles, PM (board/subtasks/deps/milestones/docs/
// time/AI-tracker), clients/deliverables/invoices, IT devices + events, files, identity links,
// notifications, compliance gates, custom fields. Idempotent: every step is create-or-skip, so
// re-running enriches an existing DB without duplicating. Direct DB inserts (no running server).
//
// Run: DATABASE_URL=... tsx src/seed/agency.ts   (NOBYPASSRLS app role in real envs)
import { newId, withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { migrate } from "../db/migrate";
import { createRole, grantRole, addMembership } from "../testing/fixtures";

const HOLDING_NAME = "D & A Syrowatka";
const AGENCY_NAME = "Gaiada Creative";
const RESORT_NAME = "Sanur Resort";
const site = () => config.originSite;

export interface SeededAgency {
  tenantId: string;
  holdingId: string;
  resortId: string;
  users: Record<string, string>;
  clients: string[];
  projects: string[];
  campaignId: string;
  intakeProjectId: string;
}

// ---- idempotent ensure-helpers ----
async function ensureCompany(name: string, modules: string[], type: string, parentId: string | null): Promise<string> {
  const found = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE name=$1 AND deleted_at IS NULL`, [name]));
  if (found.rows[0]) {
    const id = found.rows[0].id;
    await withGlobal((c) => c.query(`UPDATE companies SET type=$2, parent_company_id=$3, enabled_modules=$4 WHERE id=$1`, [id, type, parentId, modules]));
    return id;
  }
  const id = newId();
  await withGlobal((c) => c.query(
    `INSERT INTO companies (id, name, type, enabled_modules, parent_company_id, origin_site) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, name, type, modules, parentId, site()],
  ));
  return id;
}
async function ensureUser(email: string, name: string, title: string): Promise<string> {
  const found = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [email]));
  if (found.rows[0]) return found.rows[0].id;
  const id = newId();
  await withGlobal((c) => c.query(`INSERT INTO users (id, email, name, title, origin_site) VALUES ($1,$2,$3,$4,$5)`, [id, email, name, title, site()]));
  return id;
}
async function count(tenantId: string, table: string, extra = ""): Promise<number> {
  const { rows } = await withTenants([tenantId], (c) => c.query<{ n: string }>(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 ${extra}`, [tenantId]));
  return Number(rows[0].n);
}
async function ensureClient(tenantId: string, name: string, email: string): Promise<string> {
  const f = await withTenants([tenantId], (c) => c.query<{ id: string }>(`SELECT id FROM clients WHERE tenant_id=$1 AND name=$2`, [tenantId, name]));
  if (f.rows[0]) return f.rows[0].id;
  const id = newId();
  await withTenants([tenantId], (c) => c.query(`INSERT INTO clients (id, tenant_id, name, contact, origin_site) VALUES ($1,$2,$3,$4,$5)`, [id, tenantId, name, JSON.stringify({ email }), site()]));
  return id;
}
async function ensureProject(tenantId: string, name: string, ownerId: string, clientId: string | null): Promise<string> {
  const f = await withTenants([tenantId], (c) => c.query<{ id: string }>(`SELECT id FROM projects WHERE tenant_id=$1 AND name=$2`, [tenantId, name]));
  if (f.rows[0]) return f.rows[0].id;
  const id = newId();
  await withTenants([tenantId], (c) => c.query(`INSERT INTO projects (id, tenant_id, name, owner_id, client_id, origin_site) VALUES ($1,$2,$3,$4,$5,$6)`, [id, tenantId, name, ownerId, clientId, site()]));
  return id;
}

const person = (id: string, name: string) => ({ kind: "person", refId: id, refName: name, responsibleId: id, responsibleName: name });
const unit = (kind: string, refId: string, refName: string, respId: string, respName: string) => ({ kind, refId, refName, responsibleId: respId, responsibleName: respName });

export async function seedAgency(): Promise<SeededAgency> {
  // ---- Holding + member companies ----
  const holdingId = await ensureCompany(HOLDING_NAME, [], "holding", null);
  const tenantId = await ensureCompany(AGENCY_NAME, ["agency"], "agency", holdingId);
  const resortId = await ensureCompany(RESORT_NAME, [], "resort", holdingId);

  // ---- People ----
  const users = {
    admin: await ensureUser("owner@gaiada-creative.test", "Ayu (Owner)", "Managing Director"),
    pm: await ensureUser("pm@gaiada-creative.test", "Budi (PM)", "Project Manager"),
    designer: await ensureUser("design@gaiada-creative.test", "Citra (Design)", "Senior Designer"),
    copy: await ensureUser("copy@gaiada-creative.test", "Dewi (Copy)", "Copywriter"),
    approver: await ensureUser("approver@gaiada-creative.test", "Eka (Client Lead)", "Client Lead"),
    exec: await ensureUser("exec@gaiada.test", "Gaiada Exec", "Group Executive"),
    superadmin: await ensureUser("hansel@gaiada.com", "Clement Hansel", "AI Manager"),
    resortGm: await ensureUser("gm@sanur-resort.test", "Wayan (GM)", "General Manager"),
  };
  // Roles + memberships (all idempotent).
  const roleCompanyAdmin = await createRole("company_admin");
  const roleManager = await createRole("manager");
  const roleMember = await createRole("member");
  const roleApprover = await createRole("agency_approver");
  const roleExec = await createRole("group_executive");
  const rolePlatform = await createRole("platform_admin");
  const roleItAdmin = await createRole("it_admin");

  for (const u of [users.admin, users.pm, users.designer, users.copy, users.approver]) await addMembership(tenantId, u);
  await grantRole(users.admin, roleCompanyAdmin, "company", tenantId);
  await grantRole(users.pm, roleManager, "company", tenantId);
  await grantRole(users.designer, roleMember, "company", tenantId);
  await grantRole(users.copy, roleMember, "company", tenantId);
  await grantRole(users.approver, roleMember, "company", tenantId);
  await grantRole(users.approver, roleApprover, "company", tenantId);
  await grantRole(users.pm, roleItAdmin, "company", tenantId);
  // Exec: real member of both companies (so the app + switcher work) + global exec (rollups).
  await addMembership(tenantId, users.exec); await addMembership(resortId, users.exec);
  await grantRole(users.exec, roleExec, "global", null);
  // Super-user (Clement): platform_admin global + company_admin of both → sees everything + switcher.
  await addMembership(tenantId, users.superadmin); await addMembership(resortId, users.superadmin);
  await grantRole(users.superadmin, rolePlatform, "global", null);
  await grantRole(users.superadmin, roleCompanyAdmin, "company", tenantId);
  await grantRole(users.superadmin, roleCompanyAdmin, "company", resortId);
  // Owner also administers the resort → multi-company switcher for the owner.
  await addMembership(resortId, users.admin);
  await grantRole(users.admin, roleCompanyAdmin, "company", resortId);
  // Resort GM.
  await addMembership(resortId, users.resortGm);
  await grantRole(users.resortGm, roleManager, "company", resortId);

  // ---- Clients + client-linked projects (agency) ----
  const clients = [
    await ensureClient(tenantId, "Bali Beach Resort", "hello@balibeach.test"),
    await ensureClient(tenantId, "Nusa Coffee Co", "hello@nusacoffee.test"),
  ];
  const projects = [
    await ensureProject(tenantId, "Rebrand — Bali Beach", users.pm, clients[0]),
    await ensureProject(tenantId, "Launch — Nusa Coffee", users.pm, clients[1]),
  ];
  const intakeProjectId = await ensureProject(tenantId, "Lead Intake", users.pm, null);

  // ---- Campaign + brief + creative asset + pending approval (agency module) ----
  let campaignId = "";
  await withTenants([tenantId], async (c) => {
    const ex = await c.query<{ id: string }>(`SELECT id FROM agency_campaigns WHERE tenant_id=$1 AND name=$2`, [tenantId, "Q3 Rebrand Launch"]);
    if (ex.rows[0]) { campaignId = ex.rows[0].id; return; }
    campaignId = newId();
    await c.query(`INSERT INTO agency_campaigns (id,tenant_id,project_id,name,budget_minor,currency,origin_site) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [campaignId, tenantId, projects[0], "Q3 Rebrand Launch", 50_000_000, "IDR", site()]);
    await c.query(`INSERT INTO agency_briefs (id,tenant_id,campaign_id,title,body,origin_site) VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(), tenantId, campaignId, "Hero campaign brief", "Coastal-luxury tone; launch by end of quarter.", site()]);
    const asset = newId();
    await c.query(`INSERT INTO agency_creative_assets (id,tenant_id,campaign_id,name,kind,review_status,origin_site)
      VALUES ($1,$2,$3,'Hero banner v2','design','in_review',$4),($5,$2,$3,'Launch copy','copy','draft',$4)`, [asset, tenantId, campaignId, site(), newId()]);
    await c.query(`INSERT INTO agency_approvals (id,tenant_id,campaign_id,asset_id,subject,requested_by,origin_site)
      VALUES ($1,$2,$3,$4,'Review: Hero banner v2',$5,$6)`, [newId(), tenantId, campaignId, asset, users.designer, site()]);
  });

  // ---- Deliverables ----
  if (await count(tenantId, "deliverables") === 0) {
    await withTenants([tenantId], (c) => c.query(
      `INSERT INTO deliverables (id,tenant_id,project_id,client_id,name,status,due_date,origin_site)
       VALUES ($1,$2,$3,$4,'Brand guidelines','in_progress',current_date+3,$5),($6,$2,$3,$4,'Social kit','pending',current_date+10,$5)`,
      [newId(), tenantId, projects[0], clients[0], site(), newId()]));
  }

  await seedDecidedApprovals(tenantId, campaignId, users);
  await seedOrgStructures(tenantId, resortId, users);
  await seedPm(tenantId, projects[0], users);
  await seedIt(tenantId, resortId);
  await seedInvoices(tenantId, clients[0]);
  await seedFiles(tenantId, projects[0]);
  await seedIdentityAndNotifications(tenantId, users);
  await seedComplianceAndFields(tenantId);
  await seedResort(resortId, users);

  return { tenantId, holdingId, resortId, users, clients, projects, campaignId, intakeProjectId };
}

// ---- Org structures ----
async function seedOrgStructures(tenantId: string, resortId: string, u: Record<string, string>) {
  const agency = {
    root: { id: "root", name: AGENCY_NAME, kind: "company", children: [
      { id: "d-delivery", name: "Delivery", kind: "department", children: [
        { id: "v-projects", name: "Projects", kind: "division", children: [
          { id: "r-pm", name: "Project Manager", kind: "role", children: [
            { id: "p-pm", name: "Budi (PM)", kind: "person", assigneeId: u.pm, assigneeName: "Budi (PM)", children: [] }] }] },
        { id: "v-creative", name: "Creative", kind: "division", children: [
          { id: "r-design", name: "Senior Designer", kind: "role", children: [
            { id: "p-design", name: "Citra (Design)", kind: "person", assigneeId: u.designer, assigneeName: "Citra (Design)", children: [] }] },
          { id: "r-copy", name: "Copywriter", kind: "role", children: [
            { id: "p-copy", name: "Dewi (Copy)", kind: "person", assigneeId: u.copy, assigneeName: "Dewi (Copy)", children: [] }] }] }] },
      { id: "d-clients", name: "Client Services", kind: "department", children: [
        { id: "v-accounts", name: "Accounts", kind: "division", children: [
          { id: "r-lead", name: "Client Lead", kind: "role", children: [
            { id: "p-lead", name: "Eka (Client Lead)", kind: "person", assigneeId: u.approver, assigneeName: "Eka (Client Lead)", children: [] }] }] }] }] },
  };
  const resort = { root: { id: "root", name: RESORT_NAME, kind: "company", children: [
    { id: "d-ops", name: "Operations", kind: "department", children: [
      { id: "v-fo", name: "Front Office", kind: "division", children: [
        { id: "r-gm", name: "General Manager", kind: "role", children: [
          { id: "p-gm", name: "Wayan (GM)", kind: "person", assigneeId: u.resortGm, assigneeName: "Wayan (GM)", children: [] }] }] }] }] } };
  for (const [tid, struct] of [[tenantId, agency], [resortId, resort]] as const) {
    await withTenants([tid], (c) => c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id) DO UPDATE SET structure=EXCLUDED.structure, updated_at=now()`,
      [tid, JSON.stringify(struct), site()]));
  }
}

// ---- PM (board/subtasks/deps/milestones/docs/time/AI-tracker) ----
async function seedPm(tenantId: string, projectId: string, u: Record<string, string>) {
  if (await count(tenantId, "pm_tasks") > 0) return;
  await withTenants([tenantId], async (c) => {
    await c.query(`INSERT INTO pm_project_meta (tenant_id,project_id,owner,origin_site) VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id,project_id) DO NOTHING`, [tenantId, projectId, JSON.stringify(person(u.pm, "Budi (PM)")), site()]);
    const m1 = newId(), m2 = newId();
    await c.query(`INSERT INTO pm_milestones (id,tenant_id,project_id,name,due_date,status,origin_site)
      VALUES ($1,$2,$3,'Design sign-off',current_date+2,'open',$5),($4,$2,$3,'Launch',current_date+20,'open',$5)`, [m1, tenantId, projectId, m2, site()]);
    const sub = (t: string, d: boolean) => ({ id: newId(), title: t, done: d });
    const t1 = newId(), t2 = newId(), t3 = newId(), t4 = newId(), t5 = newId();
    const mk = (id: string, title: string, status: string, prio: string, prog: number, assignee: unknown, subs: unknown[], ms: string | null, deps: string[], desc: string) =>
      c.query(`INSERT INTO pm_tasks (id,tenant_id,project_id,title,description,status,priority,progress,assignee,subtasks,milestone_id,estimate_minutes,depends_on,origin_site)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, tenantId, projectId, title, desc, status, prio, prog, JSON.stringify(assignee), JSON.stringify(subs), ms, 480, deps, site()]);
    await mk(t4, "Kickoff & brief intake", "done", "normal", 100, person(u.pm, "Budi (PM)"), [sub("Agenda", true), sub("Notes", true)], m1, [], "Kickoff meeting + brief.");
    await mk(t1, "Design hero banner", "in_progress", "high", 67, person(u.designer, "Citra (Design)"), [sub("Layout", true), sub("Responsive", true), sub("Final art", false)], m1, [t4], "Hero from approved mockup.");
    await mk(t2, "Write launch copy", "todo", "normal", 0, person(u.copy, "Dewi (Copy)"), [], m2, [t1], "Landing + email copy.");
    await mk(t3, "QA microsite", "blocked", "urgent", 20, unit("division", "v-creative", "Creative", u.designer, "Citra (Design)"), [sub("Repro bug", true), sub("Fix + retest", false)], m2, [t1], "Cross-browser QA.");
    await mk(t5, "Analytics + consent", "todo", "low", 0, unit("department", "d-delivery", "Delivery", u.pm, "Budi (PM)"), [], m2, [], "Instrument + consent banner.");
    // Dates set via SQL current_date arithmetic.
    await c.query(`UPDATE pm_tasks SET start_date=current_date-7, due_date=current_date-5 WHERE id=$1`, [t4]);
    await c.query(`UPDATE pm_tasks SET start_date=current_date-2, due_date=current_date+2 WHERE id=$1`, [t1]);
    await c.query(`UPDATE pm_tasks SET start_date=current_date+1, due_date=current_date+6 WHERE id=$1`, [t2]);
    await c.query(`UPDATE pm_tasks SET start_date=current_date+3, due_date=current_date+9 WHERE id=$1`, [t3]);
    await c.query(`UPDATE pm_tasks SET start_date=current_date+5, due_date=current_date+12 WHERE id=$1`, [t5]);
    await c.query(`INSERT INTO pm_docs (id,tenant_id,project_id,title,body,author_id,origin_site)
      VALUES ($1,$2,$3,'Rebrand brief','# Rebrand\n\nGoal: modernise the brand and lift bookings.\n- New hero + CTAs\n- Microsite\n- Analytics',$4,$5)`, [newId(), tenantId, projectId, u.pm, site()]);
    await c.query(`INSERT INTO pm_suggestions (id,tenant_id,task_id,kind,proposed,rationale,docs,status,origin_site)
      VALUES ($1,$2,$3,'status','in_progress','2/3 subtasks complete → move to In progress.',$4,'pending',$5)`,
      [newId(), tenantId, t1, JSON.stringify([{ title: "Brand guidelines.pdf", ref: "gaiada://kb/brand" }]), site()]);
    // Time logged against PM tasks (loggedMinutes rolls up via pm_task_id).
    await c.query(`INSERT INTO time_entries (id,tenant_id,user_id,project_id,task_id,pm_task_id,minutes,billable,entry_date,notes,origin_site)
      VALUES ($1,$2,$3,$4,NULL,$5,180,true,current_date-1,'Hero layout',$6),($7,$2,$8,$4,NULL,$9,90,true,current_date,'Copy draft',$6)`,
      [newId(), tenantId, u.designer, projectId, t1, site(), newId(), u.copy, t2]);
    // Comments incl. an AI-Tracker (author_id NULL) comment.
    await c.query(`INSERT INTO comments (id,tenant_id,author_id,target_entity_type,target_entity_id,body,origin_site)
      VALUES ($1,$2,$3,'task',$4,'Hero looks great — needs final art before ship.',$5)`, [newId(), tenantId, u.pm, t1, site()]);
    await c.query(`INSERT INTO comments (id,tenant_id,author_id,target_entity_type,target_entity_id,body,origin_site)
      VALUES ($1,$2,NULL,'task',$3,'AI Tracker: 2/3 subtasks complete → 67%. Shared Brand guidelines.pdf with Citra.',$4)`, [newId(), tenantId, t1, site()]);
  });
}

// ---- IT devices + events ----
async function seedIt(tenantId: string, resortId: string) {
  if (await count(tenantId, "it_devices") === 0) {
    await withTenants([tenantId], async (c) => {
      const dev = (name: string, kind: string, status: string, net: string, ip: string, hb: string, extra = "") =>
        c.query(`INSERT INTO it_devices (id,tenant_id,name,kind,status,site,network,ip,vendor,heartbeats,last_heartbeat_at,uptime_sec,origin_site)
          VALUES ($1,$2,$3,$4,$5,'Bali Office',$6,$7,$8,$9,now(),$10,$11) RETURNING id`,
          [newId(), tenantId, name, kind, status, net, ip, extra || "Generic", `{${hb}}`, 90000, site()]);
      await dev("Edge Router", "network", "online", "Core / VLAN1", "10.0.0.1", "100,100,100,100,100", "MikroTik");
      await dev("Core Switch", "network", "online", "Core / VLAN1", "10.0.0.2", "100,100,100,100,100", "UniFi");
      await dev("NAS / File Server", "server", "online", "Core / VLAN1", "10.0.0.10", "100,100,90,100,100", "Synology");
      await dev("CCTV — Lobby", "cctv", "online", "CCTV / VLAN20", "10.0.20.11", "100,100,100,100,100", "Hikvision");
      const parking = await dev("CCTV — Parking", "cctv", "degraded", "CCTV / VLAN20", "10.0.20.12", "100,70,60,50,70", "Hikvision");
      await dev("Office Printer", "printer", "online", "Workstations / VLAN10", "10.0.10.30", "100,100,100,100,100", "Brother");
      await dev("WS — Design", "workstation", "offline", "Workstations / VLAN10", "10.0.10.42", "100,100,30,0,0", "Dell");
      await dev("Server Room Sensor", "sensor", "online", "Core / VLAN1", "10.0.0.60", "100,100,100,100,100", "Shelly");
      const pid = parking.rows[0].id;
      await c.query(`INSERT INTO it_device_events (id,tenant_id,device_id,type,severity,message,origin_site)
        VALUES ($1,$2,$3,'degraded','warn','Frame rate dropped; packet loss on VLAN20.',$4),($5,$2,$3,'alert','warn','Reconnect attempts elevated.',$4)`,
        [newId(), tenantId, pid, site(), newId()]);
    });
  }
  if (await count(resortId, "it_devices") === 0) {
    await withTenants([resortId], (c) => c.query(`INSERT INTO it_devices (id,tenant_id,name,kind,status,site,network,ip,vendor,origin_site)
      VALUES ($1,$2,'Lobby CCTV','cctv','online','Sanur Resort','CCTV','10.1.20.5','Hikvision',$3),($4,$2,'Front Desk PC','workstation','online','Sanur Resort','LAN','10.1.10.5','HP',$3)`,
      [newId(), resortId, site(), newId()]));
  }
}

// ---- Invoices ----
async function seedInvoices(tenantId: string, clientId: string) {
  if (await count(tenantId, "invoices") > 0) return;
  await withTenants([tenantId], (c) => c.query(
    `INSERT INTO invoices (id,tenant_id,client_id,period_start,period_end,status,currency,lines,total,origin_site)
     VALUES ($1,$2,$3,current_date-30,current_date,'sent','USD',$4,6300,$5),
            ($6,$2,$3,current_date,current_date+30,'draft','USD',$7,0,$5)`,
    [newId(), tenantId, clientId, JSON.stringify([{ description: "Billable time (last 30d)", hours: 42, rate: 150, amount: 6300 }]), site(), newId(), JSON.stringify([])]));
}

// ---- Files (references) ----
async function seedFiles(tenantId: string, projectId: string) {
  if (await count(tenantId, "files") > 0) return;
  await withTenants([tenantId], (c) => c.query(
    `INSERT INTO files (id,tenant_id,uploader_id,target_entity_type,target_entity_id,filename,content_type,byte_size,storage_key,url,scrubbed,origin_site)
     VALUES ($1,$2,NULL,'project',$3,'Rebrand SOW.pdf','application/pdf',184320,NULL,'https://drive.internal/sow',true,$4)`,
    [newId(), tenantId, projectId, site()]));
}

// ---- Decided-approval history (Approvals "Recently decided") ----
async function seedDecidedApprovals(tenantId: string, campaignId: string, u: Record<string, string>) {
  if (!campaignId) return;
  const has = await withTenants([tenantId], (c) => c.query<{ n: string }>(`SELECT count(*)::int n FROM agency_approvals WHERE tenant_id=$1 AND status<>'pending'`, [tenantId]));
  if (Number(has.rows[0].n) > 0) return;
  await withTenants([tenantId], (c) => c.query(
    `INSERT INTO agency_approvals (id,tenant_id,campaign_id,subject,requested_by,status,decided_by,decided_at,origin_site) VALUES
     ($1,$2,$3,'Homepage hero creative',$4,'approved',$5,now()-interval '2 days',$6),
     ($7,$2,$3,'Influencer budget — round 1',$4,'rejected',$5,now()-interval '5 days',$6)`,
    [newId(), tenantId, campaignId, u.designer, u.approver, site(), newId()]));
}

// ---- Identity links + notifications (for the users someone is likely to log in as) ----
async function seedIdentityAndNotifications(tenantId: string, u: Record<string, string>) {
  const has = await withGlobal((c) => c.query<{ n: string }>(`SELECT count(*)::int n FROM identity_links WHERE user_id=ANY($1)`, [[u.designer, u.copy]]));
  if (Number(has.rows[0].n) === 0) {
    await withGlobal((c) => c.query(`INSERT INTO identity_links (id,user_id,provider,external_id,verified_at)
      VALUES ($1,$2,'whatsapp','62811001@c.us',now()),($3,$4,'telegram','tg:55210',NULL) ON CONFLICT (provider,external_id) DO NOTHING`,
      [newId(), u.designer, newId(), u.copy]));
  }
  // A couple of notifications per key user (idempotent per user), so whoever logs in sees the bell.
  const notes: [string, string, Record<string, unknown>][] = [
    [u.superadmin, "approval.requested", { title: "Approval requested", message: "Review: Hero banner v2 awaits a decision.", href: "/approvals" }],
    [u.superadmin, "pm.tracker.update", { title: "AI Tracker — Design hero banner", message: "2/3 subtasks complete → 67%.", href: "/tasks" }],
    [u.admin, "approval.requested", { title: "Approval requested", message: "Review: Hero banner v2 awaits a decision.", href: "/approvals" }],
    [u.admin, "invoice.sent", { title: "Invoice sent", message: "Bali Beach Resort — $6,300.", href: "/billing" }],
    [u.exec, "rollup.ready", { title: "Rollups recomputed", message: "Group metrics refreshed.", href: "/rollups" }],
    [u.pm, "task.assigned", { title: "Task assigned", message: "QA microsite needs a plan.", href: "/tasks" }],
    [u.approver, "approval.requested", { title: "Approval requested", message: "Review: Hero banner v2 awaits your decision.", href: "/approvals" }],
    [u.designer, "task.assigned", { title: "Task assigned", message: "Design hero banner assigned to you.", href: "/tasks" }],
  ];
  for (const [uid, type, payload] of notes) {
    const seen = await withTenants([tenantId], (c) => c.query<{ n: string }>(`SELECT count(*)::int n FROM notifications WHERE tenant_id=$1 AND user_id=$2`, [tenantId, uid]));
    if (Number(seen.rows[0].n) === 0) {
      await withTenants([tenantId], (c) => c.query(`INSERT INTO notifications (id,tenant_id,user_id,type,payload,origin_site) VALUES ($1,$2,$3,$4,$5,$6)`, [newId(), tenantId, uid, type, JSON.stringify(payload), site()]));
    }
  }
}

// ---- Compliance gates + custom fields ----
async function seedComplianceAndFields(tenantId: string) {
  await withTenants([tenantId], async (c) => {
    for (const [key, status] of [["G.1", "passed"], ["G.4", "passed"], ["G.2", "in_progress"]] as const) {
      await c.query(`INSERT INTO compliance_gates (tenant_id,key,status,origin_site) VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id,key) DO UPDATE SET status=EXCLUDED.status, updated_at=now()`, [tenantId, key, status, site()]);
    }
    const cf = await c.query<{ n: string }>(`SELECT count(*)::int n FROM custom_field_definitions WHERE tenant_id=$1`, [tenantId]);
    if (Number(cf.rows[0].n) === 0) {
      await c.query(`INSERT INTO custom_field_definitions (id,tenant_id,entity_type,key,label,data_type,required,origin_site)
        VALUES ($1,$2,'project','phase','Phase','text',false,$3),($4,$2,'task','severity','Severity','text',false,$3)`, [newId(), tenantId, site(), newId()]);
    }
  });
}

// ---- Sanur Resort: light data so switching shows a distinct company ----
async function seedResort(resortId: string, u: Record<string, string>) {
  const clientId = await ensureClient(resortId, "Walk-in Guests", "front@sanur-resort.test");
  const projectId = await ensureProject(resortId, "Peak-season staffing", u.resortGm, clientId);
  if (await count(resortId, "pm_tasks") === 0) {
    await withTenants([resortId], (c) => c.query(
      `INSERT INTO pm_tasks (id,tenant_id,project_id,title,status,priority,progress,assignee,origin_site)
       VALUES ($1,$2,$3,'Hire seasonal front-desk','in_progress','high',40,$4,$5)`,
      [newId(), resortId, projectId, JSON.stringify(person(u.resortGm, "Wayan (GM)")), site()]));
  }
}

if (require.main === module) {
  (async () => {
    await migrate();
    const r = await seedAgency();
    console.log(`seeded holding ${r.holdingId}`);
    console.log(`  AGENCY_TENANT_ID=${r.tenantId}`);
    console.log(`  RESORT_TENANT_ID=${r.resortId}`);
    console.log(`  INTAKE_PROJECT_ID=${r.intakeProjectId}`);
    await closePool();
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}

// Department-grain showcase seed: one project portfolio PER DEPARTMENT (including GM), a task for
// EVERY placed employee, and an HR file for every one of them that matches the same roster.
//
// Why this exists as its own file rather than more lines in agency.ts: agency.ts seeds the SHAPE of
// the holding (companies, people, org tree, one client campaign). This file seeds the WORK — the
// per-department portfolio the department consoles read, and the HR record set the HR console reads.
// Both are driven off ONE source of truth, the org structure itself, so a person added to the tree
// automatically gets work and an HR file rather than needing a second list kept in sync by hand.
//
// What the app surfaces need, and how each is satisfied:
//  - Department console › Overview/Board  -> pm_tasks whose assignee resolves into the department
//    (kind=department|division refId, or a responsible person placed in it — see the `belongs()`
//    rule in platform-ui/src/lib/departments.ts).
//  - Department console › Timeline        -> projects.department_id = the department node id
//    (getOwnedProjectsPm), plus pm_milestones per project.
//  - My Work / Tasks                     -> assignee.responsibleId = the person.
//  - Reports / dept attribution           -> org_unit_memberships (time-aware), swept from the blob
//    exactly as the org-structure PUT hook does, and report_checkins per person.
//  - HR console                           -> hr_cases / hr_records / hr_leave_* / hr_attendance /
//    hr_checklist_templates, all written with the `hr` module scope declared (the third RLS wall).
//
// Idempotent throughout: every insert is guarded by an existence check, a UNIQUE + ON CONFLICT, or
// both, so re-running enriches an existing DB instead of duplicating. Nothing is ever deleted or
// moved — in particular the org-tree merge only ADDS missing nodes, so hand edits made in the org
// builder survive a re-seed.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { deriveBlobPlacements, diffMembershipSweep, isUuidShaped, todayIso, type BlobPlacement, type OpenPrimaryMembership } from "../core/dept-resolution";
import { allocateTaskSeq, deriveUniqueShortCode } from "../core/project-short-codes";
import { EMPLOYEES, AGENCY_DEPTS } from "./roster";
import { resolveSeedActor, assertNotRetired } from "./seed-actor";

const site = () => config.originSite;
const DAY_MINUTES = 480;

// ─────────────────────────── org-tree model (mirrors the app's OrgNode) ───────────────────────────
interface OrgNode {
  id: string;
  name: string;
  kind: string;
  assigneeId?: string | null;
  assigneeName?: string | null;
  children: OrgNode[];
}
interface OrgStructure { root: OrgNode }

interface Person { id: string; name: string; title: string; unitId: string; unitName: string; deptId: string; deptName: string }
interface Dept { id: string; name: string; people: Person[] }

// ─────────────────────────── 1. org-tree merge (additive only) ───────────────────────────

/** Ensure every seeded employee is PLACED in the tenant's org tree, adding only what is missing.
 *
 *  agency.ts writes the initial tree with `ON CONFLICT DO NOTHING`, which is right for protecting
 *  hand edits but means a tenant seeded BEFORE a person (or a whole department) was added to
 *  EMPLOYEES/AGENCY_DEPTS never gets them — the department console then renders an empty box for a
 *  department the seed claims to populate. This merge closes that gap without reintroducing the
 *  overwrite: a person already present ANYWHERE in the tree is left exactly where they are (a
 *  deliberate transfer in the org builder is never undone), and no node is ever removed. */
async function mergeOrgPlacements(tenantId: string): Promise<void> {
  const roster = await resolveRoster();

  await withTenants([tenantId], async (c) => {
    const cur = await c.query<{ structure: OrgStructure }>(
      `SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [tenantId]);
    const structure: OrgStructure = cur.rows[0]?.structure ?? { root: { id: "root", name: "Company", kind: "company", children: [] } };
    const root = structure.root;

    const placed = new Set<string>();
    const collectPlaced = (n: OrgNode) => {
      for (const ch of n.children ?? []) { if (ch.kind === "person" && ch.assigneeId) placed.add(ch.assigneeId); collectPlaced(ch); }
    };
    collectPlaced(root);

    let changed = false;
    const findNode = (n: OrgNode, id: string): OrgNode | null => {
      if (n.id === id) return n;
      for (const ch of n.children ?? []) { const hit = findNode(ch, id); if (hit) return hit; }
      return null;
    };
    // Departments + divisions first, so a person's target node always exists to attach to.
    for (const d of AGENCY_DEPTS) {
      let deptNode = findNode(root, d.id);
      if (!deptNode) {
        deptNode = { id: d.id, name: d.name, kind: "department", children: [] };
        root.children.push(deptNode); changed = true;
      }
      for (const [vid, vname] of d.divisions) {
        if (!findNode(root, vid)) { deptNode.children.push({ id: vid, name: vname, kind: "division", children: [] }); changed = true; }
      }
    }
    for (const [, name, , target] of EMPLOYEES) {
      const person = roster.get(name);
      if (!person || placed.has(person.id)) continue;
      const parent = findNode(root, target);
      if (!parent) continue; // unknown target node — never invent one
      parent.children.push({ id: "p-" + person.id.slice(0, 8), name: person.name, kind: "person", assigneeId: person.id, assigneeName: person.name, children: [] });
      placed.add(person.id); changed = true;
    }

    if (changed) {
      await c.query(
        `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure, updated_at = now()`,
        [tenantId, JSON.stringify(structure), site()]);
    }
    // Always sweep: a tree that was already complete can still predate org_unit_memberships.
    await sweepMemberships(c, tenantId, root);
  });
}

/** email/name -> user row for everyone in EMPLOYEES (agency.ts has already created them). */
async function resolveRoster(): Promise<Map<string, { id: string; name: string; title: string }>> {
  const emails = EMPLOYEES.map(([email]) => email);
  const { rows } = await withGlobal((c) => c.query<{ id: string; email: string; name: string; title: string | null }>(
    `SELECT id, email, name, title FROM users WHERE email = ANY($1::text[])`, [emails]));
  const byName = new Map<string, { id: string; name: string; title: string }>();
  for (const [email, name, title] of EMPLOYEES) {
    const row = rows.find((r) => r.email === email);
    if (row) byName.set(name, { id: row.id, name: row.name, title: row.title ?? title });
  }
  return byName;
}

/** The org-structure PUT hook's membership sweep (admin/company-admin.controller.ts
 *  `sweepMemberships`), re-run from the seed so a seeded tenant has the same time-aware
 *  org_unit_memberships rows an interactively-edited one does — otherwise every report that
 *  attributes work to a department resolves to "unknown" on seeded data. */
async function sweepMemberships(c: PoolClient, tenantId: string, root: OrgNode): Promise<void> {
  const candidates: BlobPlacement[] = deriveBlobPlacements(root).filter((p) => isUuidShaped(p.userId));
  if (candidates.length === 0) return;
  const known = new Set((await c.query<{ id: string }>(
    `SELECT id FROM users WHERE id = ANY($1::uuid[])`, [candidates.map((p) => p.userId)])).rows.map((r) => r.id));
  const placements = candidates.filter((p) => known.has(p.userId));
  const openRows = (await c.query<OpenPrimaryMembership>(
    `SELECT user_id AS "userId", unit_node_id AS "unitNodeId", valid_from::text AS "validFrom"
       FROM org_unit_memberships WHERE tenant_id = $1 AND is_primary AND valid_to IS NULL`, [tenantId])).rows;

  for (const op of diffMembershipSweep(placements, openRows, todayIso())) {
    if (op.kind === "add") {
      await c.query(
        `INSERT INTO org_unit_memberships (tenant_id,user_id,unit_node_id,is_primary,valid_from,valid_to,source,origin_site)
         VALUES ($1,$2,$3,true,$4,NULL,'org_blob',$5) ON CONFLICT DO NOTHING`,
        [tenantId, op.userId, op.unitNodeId, op.validFrom, site()]);
    } else if (op.kind === "amend") {
      await c.query(`UPDATE org_unit_memberships SET unit_node_id = $3 WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL`,
        [tenantId, op.userId, op.unitNodeId]);
    } else if (op.kind === "transfer") {
      await c.query(`UPDATE org_unit_memberships SET valid_to = $3 WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL`,
        [tenantId, op.userId, op.closeValidTo]);
      await c.query(
        `INSERT INTO org_unit_memberships (tenant_id,user_id,unit_node_id,is_primary,valid_from,valid_to,source,origin_site)
         VALUES ($1,$2,$3,true,$4,NULL,'org_blob',$5) ON CONFLICT DO NOTHING`,
        [tenantId, op.userId, op.openUnitNodeId, op.openValidFrom, site()]);
    } else {
      // 'remove' is intentionally NOT applied here. The sweep's remove op fires for anyone open in
      // memberships but absent from the blob — from a seed run that is almost always a person the
      // seed simply doesn't know about (created through the UI), not a departure, and closing their
      // membership would silently strip their department from every future report.
      continue;
    }
  }
}

/** Read the merged tree back as departments -> people (with each person's division), the shape the
 *  work + HR seeds below are driven from. */
async function readDepartments(tenantId: string): Promise<Dept[]> {
  const cur = await withTenants([tenantId], (c) => c.query<{ structure: OrgStructure }>(
    `SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [tenantId]));
  const root = cur.rows[0]?.structure?.root;
  if (!root) return [];
  const titles = new Map((await withGlobal((c) => c.query<{ id: string; title: string | null }>(
    `SELECT id, title FROM users`))).rows.map((r) => [r.id, r.title ?? ""]));

  const depts: Dept[] = [];
  for (const deptNode of (root.children ?? []).filter((n) => n.kind === "department")) {
    const people: Person[] = [];
    const walk = (n: OrgNode, unit: { id: string; name: string }) => {
      const here = n.kind === "division" ? { id: n.id, name: n.name } : unit;
      for (const ch of n.children ?? []) {
        if (ch.kind === "person" && ch.assigneeId && !people.some((p) => p.id === ch.assigneeId)) {
          people.push({
            id: ch.assigneeId, name: ch.assigneeName ?? ch.name, title: titles.get(ch.assigneeId) ?? "",
            unitId: here.id, unitName: here.name, deptId: deptNode.id, deptName: deptNode.name,
          });
        }
        walk(ch, here);
      }
    };
    walk(deptNode, { id: deptNode.id, name: deptNode.name });
    depts.push({ id: deptNode.id, name: deptNode.name, people });
  }
  return depts;
}

// ─────────────────────────── 2. per-department project portfolio ───────────────────────────

interface ProjectSpec { name: string; internal: boolean; clientKey: 0 | 1 | null; doc: { title: string; body: string }; milestones: [string, number][] }

// Two projects per department: one internal programme (the department's own book of work) and one
// delivery/oversight project. GM gets oversight projects rather than client delivery, which is what
// its people actually own.
const DEPT_PROJECTS: Record<string, ProjectSpec[]> = {
  "d-webdev": [
    { name: "Website Platform Revamp", internal: true, clientKey: null, doc: { title: "Revamp technical plan", body: "# Platform revamp\n\n- Next.js app router migration\n- Design-system tokens\n- Core Web Vitals budget (LCP < 2.0s)\n- Staged cutover behind a flag" }, milestones: [["Architecture sign-off", 6], ["Staged cutover", 27]] },
    { name: "Client Site Maintenance Retainer", internal: false, clientKey: 0, doc: { title: "Retainer scope", body: "# Maintenance retainer\n\nMonthly: security patching, uptime review, backup restore drill, 8h of change requests." }, milestones: [["July maintenance window", 9], ["Quarterly restore drill", 24]] },
  ],
  "d-creatives": [
    { name: "Brand Asset Library 2026", internal: true, clientKey: null, doc: { title: "Asset library standards", body: "# Asset library\n\nNaming, export presets, colour profiles, and the review gate every asset passes before it is published." }, milestones: [["Core kit complete", 8], ["Library published", 26]] },
    { name: "Video Content Series — Nusa Coffee", internal: false, clientKey: 1, doc: { title: "Series treatment", body: "# Video series\n\nSix 30s spots: origin, roast, brew, people, place, invitation. Vertical-first, captions burned in." }, milestones: [["Treatment approved", 5], ["All six delivered", 30]] },
  ],
  "d-seo": [
    { name: "Organic Growth Program", internal: true, clientKey: null, doc: { title: "Organic growth thesis", body: "# Organic growth\n\nTopical authority over volume: cluster pages, internal links, technical debt paydown, and a monthly backlink quota." }, milestones: [["Technical audit closed", 7], ["Cluster 1 live", 25]] },
    { name: "Paid Search — Nusa Coffee", internal: false, clientKey: 1, doc: { title: "Account structure", body: "# Paid search\n\nBrand / non-brand / competitor split, exact+phrase only, negatives reviewed weekly, CPA target IDR 45k." }, milestones: [["Account build", 4], ["First optimisation cycle", 21]] },
  ],
  "d-social": [
    { name: "Social Content Calendar Q3", internal: true, clientKey: null, doc: { title: "Q3 content calendar", body: "# Q3 calendar\n\nThree posts a week per channel, one long-form reel a fortnight, community replies within 4 working hours." }, milestones: [["Calendar approved", 3], ["Q3 fully scheduled", 22]] },
    { name: "Community Engagement Program", internal: true, clientKey: null, doc: { title: "Engagement playbook", body: "# Engagement\n\nTone of voice, escalation ladder for complaints, UGC permission flow, and the weekly listening digest." }, milestones: [["Playbook signed off", 10], ["First listening digest", 20]] },
  ],
  "d-gm": [
    { name: "Agency OKRs 2026", internal: true, clientKey: null, doc: { title: "2026 OKRs", body: "# OKRs\n\nO1 Profitable growth · O2 Delivery predictability · O3 Every department measurable · O4 One system of record." }, milestones: [["H1 review", 5], ["H2 planning", 28]] },
    { name: "Client Portfolio Review", internal: true, clientKey: null, doc: { title: "Portfolio review pack", body: "# Portfolio review\n\nPer client: margin, delivery health, relationship risk, renewal date, and the decision to grow / hold / exit." }, milestones: [["Data pack ready", 6], ["Board review", 18]] },
  ],
};

// Task templates per department, keyed loosely by what the department does. Each person gets the
// template at their index (wrapping), so titles stay plausible for the department even when the
// headcount does not match the template count.
const DEPT_TASKS: Record<string, [string, string][]> = {
  "d-webdev": [
    ["Migrate marketing pages to the app router", "Port the remaining pages-router routes, keeping URLs and redirects intact."],
    ["Harden the deploy pipeline", "Pin image tags, add the smoke check, and make a failed health check block promotion."],
    ["Patch + uptime review for client sites", "Apply pending security updates, review uptime for the month, log anything that needs a change request."],
    ["Wire the AI drafting assist into the console", "Gateway-backed drafts behind an approval gate; never auto-publish."],
    ["Design-system audit of the component library", "Find every one-off style, fold it into a token, and document the survivors."],
    ["Core Web Vitals budget enforcement", "Set the budget in CI and fix the two worst LCP offenders."],
  ],
  "d-creatives": [
    ["Rebuild the master brand kit", "Logo lockups, colour, type scale, and the do/don't sheet, all exported to the new presets."],
    ["Produce the social asset pack", "Twelve templated assets sized for every channel we publish to."],
    ["Cut the six-spot video series", "Assemble, grade, caption, and deliver in vertical + landscape."],
    ["Photo retouch pass on the venue shoot", "Cull, retouch the selects, and hand over with usage notes."],
    ["Motion pass on the hero animation", "Add the loop, keep it under 400KB, and provide a static fallback."],
  ],
  "d-seo": [
    ["Close the technical SEO audit", "Fix canonical duplication, thin pages, and the sitemap that still lists redirects."],
    ["Build the paid search account structure", "Brand / non-brand / competitor split with negatives applied from day one."],
    ["Write the cluster-one page set", "Pillar plus four supporting pages, briefed from the keyword map."],
    ["Earn the monthly backlink quota", "Five relevant, indexable links; log every outreach thread."],
    ["Monthly ranking + search-terms review", "Report movement, cannibalisation, and what we are changing next."],
  ],
  "d-social": [
    ["Schedule the Q3 calendar", "Three posts a week per channel, queued and approved a fortnight ahead."],
    ["Produce the fortnightly long-form reel", "Script, shoot, edit, caption, and publish with the engagement plan."],
    ["Clear the community inbox", "Reply within four working hours; escalate anything on the complaint ladder."],
    ["Collect + clear UGC permissions", "Written permission on file before anything is reposted."],
  ],
  "d-gm": [
    ["Set and publish the 2026 OKRs", "One page per objective, an owner per key result, and the measure it is read from."],
    ["Run the client portfolio review", "Margin, delivery health, and a grow / hold / exit call per client."],
    ["Review delivery predictability", "Compare committed against delivered dates by department; act on the worst gap."],
    ["Approve the quarter's creative budget", "Decide the split between brand, content, and paid."],
    ["Close the month-end reporting pack", "One pack: revenue, utilisation, pipeline, and the exceptions worth a conversation."],
  ],
};

const STATUS_CYCLE: [string, number][] = [["in_progress", 55], ["todo", 0], ["done", 100], ["in_progress", 30], ["blocked", 20], ["todo", 0]];
const PRIORITY_CYCLE = ["high", "normal", "normal", "urgent", "low", "high"];

const personAssignee = (p: Person) => ({ kind: "person", refId: p.id, refName: p.name, responsibleId: p.id, responsibleName: p.name });
const unitAssignee = (p: Person) => ({
  // A unit-owned task with a named responsible: the shape the department board reads as "the
  // division owns this, this person is accountable".
  kind: p.unitId.startsWith("v-") ? "division" : "department",
  refId: p.unitId, refName: p.unitName, responsibleId: p.id, responsibleName: p.name,
});

async function ensureDeptProject(
  c: PoolClient, tenantId: string, spec: ProjectSpec, deptId: string, ownerId: string, clientId: string | null,
): Promise<{ id: string; created: boolean }> {
  const found = await c.query<{ id: string }>(
    `SELECT id FROM projects WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`, [tenantId, spec.name]);
  if (found.rows[0]) {
    // Backfill the two fields that decide whether the department console can see it at all.
    await c.query(`UPDATE projects SET department_id = COALESCE(department_id, $2), owner_id = COALESCE(owner_id, $3) WHERE id = $1`,
      [found.rows[0].id, deptId, ownerId]);
    return { id: found.rows[0].id, created: false };
  }
  const id = newId();
  const shortCode = await deriveUniqueShortCode(c, tenantId, spec.name);
  await c.query(
    `INSERT INTO projects (id,tenant_id,client_id,is_internal,name,status,department_id,owner_id,start_date,due_date,short_code,origin_site)
     VALUES ($1,$2,$3,$4,$5,'active',$6,$7,current_date-14,current_date+30,$8,$9)`,
    [id, tenantId, clientId, spec.internal, spec.name, deptId, ownerId, shortCode, site()]);
  return { id, created: true };
}

/** pm_tasks insert + the pm_task_assignees dual-write (owner/responsible open intervals), mirroring
 *  pm.controller.ts's `syncTaskAssignees` — without these rows a seeded task is invisible to every
 *  reader that joins on the relational assignee axis (contributors, reports fact job). */
async function insertTask(c: PoolClient, tenantId: string, projectId: string, t: {
  title: string; description: string; status: string; priority: string; progress: number;
  assignee: { kind: string; refId: string; refName: string; responsibleId: string; responsibleName: string };
  subtasks: { id: string; title: string; done: boolean }[]; milestoneId: string | null;
  startOffset: number; dueOffset: number; estimateMinutes: number; createdBy: string;
}): Promise<string> {
  const id = newId();
  const seq = await allocateTaskSeq(c, projectId);
  await c.query(
    `INSERT INTO pm_tasks (id,tenant_id,project_id,title,description,status,priority,progress,assignee,subtasks,milestone_id,
       start_date,due_date,estimate_minutes,seq,origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,current_date+$12::int,current_date+$13::int,$14,$15,$16)`,
    [id, tenantId, projectId, t.title, t.description, t.status, t.priority, t.progress,
      JSON.stringify(t.assignee), JSON.stringify(t.subtasks), t.milestoneId,
      t.startOffset, t.dueOffset, t.estimateMinutes, seq, site()]);

  const today = todayIso();
  const owner = t.assignee.kind === "person"
    ? { kind: "person", ref: t.assignee.refId, userId: t.assignee.refId }
    : { kind: t.assignee.kind, ref: t.assignee.refId, userId: null as string | null };
  if (owner.kind === "person") {
    await c.query(
      `INSERT INTO pm_task_assignees (tenant_id,task_id,role,assignee_kind,assignee_ref,user_id,created_by,origin_site,valid_from,valid_to)
       VALUES ($1,$2,'owner','person',$3::uuid::text,$3::uuid,$4,$5,$6::date,NULL)
       ON CONFLICT ON CONSTRAINT ux_pm_task_assignees_row DO NOTHING`,
      [tenantId, id, owner.ref, t.createdBy, site(), today]);
  } else {
    await c.query(
      `INSERT INTO pm_task_assignees (tenant_id,task_id,role,assignee_kind,assignee_ref,user_id,created_by,origin_site,valid_from,valid_to)
       VALUES ($1,$2,'owner',$3,$4::text,NULL,$5,$6,$7::date,NULL)
       ON CONFLICT ON CONSTRAINT ux_pm_task_assignees_row DO NOTHING`,
      [tenantId, id, owner.kind, owner.ref, t.createdBy, site(), today]);
  }
  // The responsible row exists only when it is a DIFFERENT person from a person-owner (the 0054
  // backfill's same-self dedup rule).
  if (!(owner.kind === "person" && owner.ref === t.assignee.responsibleId)) {
    await c.query(
      `INSERT INTO pm_task_assignees (tenant_id,task_id,role,assignee_kind,assignee_ref,user_id,created_by,origin_site,valid_from,valid_to)
       VALUES ($1,$2,'responsible','person',$3::uuid::text,$3::uuid,$4,$5,$6::date,NULL)
       ON CONFLICT ON CONSTRAINT ux_pm_task_assignees_row DO NOTHING`,
      [tenantId, id, t.assignee.responsibleId, t.createdBy, site(), today]);
  }
  return id;
}

const sub = (title: string, done: boolean) => ({ id: newId(), title, done });

/** Seed the portfolio + one task per person for every department. */
async function seedDepartmentWork(tenantId: string, depts: Dept[], clients: string[], actorId: string): Promise<number> {
  let tasksCreated = 0;
  for (const dept of depts) {
    const specs = DEPT_PROJECTS[dept.id];
    const templates = DEPT_TASKS[dept.id];
    if (!specs || !templates || dept.people.length === 0) continue;
    const lead = dept.people[0];

    await withTenants([tenantId], async (c) => {
      for (const [pi, spec] of specs.entries()) {
        const clientId = spec.clientKey === null ? null : clients[spec.clientKey] ?? null;
        const { id: projectId, created } = await ensureDeptProject(c, tenantId, spec, dept.id, lead.id, clientId);

        await c.query(
          `INSERT INTO pm_project_meta (tenant_id,project_id,owner,origin_site) VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id,project_id) DO NOTHING`,
          [tenantId, projectId, JSON.stringify({ kind: "person", refId: lead.id, refName: lead.name, responsibleId: lead.id, responsibleName: lead.name }), site()]);

        // Milestones (idempotent by name within the project).
        const milestoneIds: string[] = [];
        for (const [name, dueIn] of spec.milestones) {
          const ex = await c.query<{ id: string }>(`SELECT id FROM pm_milestones WHERE tenant_id=$1 AND project_id=$2 AND name=$3`, [tenantId, projectId, name]);
          if (ex.rows[0]) { milestoneIds.push(ex.rows[0].id); continue; }
          const mid = newId();
          await c.query(
            `INSERT INTO pm_milestones (id,tenant_id,project_id,name,due_date,status,origin_site)
             VALUES ($1,$2,$3,$4,current_date+$5::int,'open',$6)`,
            [mid, tenantId, projectId, name, dueIn, site()]);
          milestoneIds.push(mid);
        }

        if (created) {
          await c.query(
            `INSERT INTO pm_docs (id,tenant_id,project_id,title,body,author_id,origin_site) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [newId(), tenantId, projectId, spec.doc.title, spec.doc.body, lead.id, site()]);
        }

        // ONE task per person per project — this is the "every employee has tasks" guarantee, and
        // because each department's people all sit inside it, it is also what fills the board.
        for (const [i, person] of dept.people.entries()) {
          const [templateTitle, templateDesc] = templates[(i + pi) % templates.length];
          const title = `${templateTitle} — ${person.name.split(" (")[0]}`;
          const ex = await c.query<{ id: string }>(
            `SELECT id FROM pm_tasks WHERE tenant_id=$1 AND project_id=$2 AND title=$3 AND deleted_at IS NULL`, [tenantId, projectId, title]);
          if (ex.rows[0]) continue;

          const cyc = (i + pi * 2) % STATUS_CYCLE.length;
          const [status, progress] = STATUS_CYCLE[cyc];
          const subtasks = status === "done"
            ? [sub("Plan", true), sub("Execute", true), sub("Hand over", true)]
            : status === "todo"
              ? [sub("Plan", false), sub("Execute", false)]
              : [sub("Plan", true), sub("Execute", progress >= 50), sub("Hand over", false)];
          const taskId = await insertTask(c, tenantId, projectId, {
            title, description: templateDesc, status, priority: PRIORITY_CYCLE[cyc], progress,
            // Alternate person-owned and unit-owned so both assignee shapes are represented on the
            // board (and so the poly-assignee UI has something to show for divisions).
            assignee: i % 3 === 2 && dept.people.length > 1 ? unitAssignee(person) : personAssignee(person),
            subtasks, milestoneId: milestoneIds[i % Math.max(milestoneIds.length, 1)] ?? null,
            startOffset: status === "done" ? -12 + i : -3 + i, dueOffset: status === "done" ? -4 + i : 4 + i * 2,
            estimateMinutes: 240 + (i % 4) * 240, createdBy: actorId,
          });
          tasksCreated += 1;

          // Logged time on anything already moving, so utilisation/timesheets are not empty.
          if (status !== "todo") {
            await c.query(
              `INSERT INTO time_entries (id,tenant_id,user_id,project_id,task_id,pm_task_id,minutes,billable,entry_date,notes,origin_site)
               VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,current_date-$8::int,$9,$10)`,
              [newId(), tenantId, person.id, projectId, taskId, 90 + (i % 4) * 60, !spec.internal, 1 + (i % 5), `Work on ${templateTitle.toLowerCase()}`, site()]);
          }
          if (status === "blocked") {
            await c.query(
              `INSERT INTO comments (id,tenant_id,author_id,target_entity_type,target_entity_id,body,origin_site) VALUES ($1,$2,$3,'task',$4,$5,$6)`,
              [newId(), tenantId, lead.id, taskId, `Blocked pending a decision from ${dept.name}. Raised at the weekly review.`, site()]);
          }
          if (status === "in_progress" && i === 0) {
            await c.query(
              `INSERT INTO pm_suggestions (id,tenant_id,task_id,kind,proposed,rationale,docs,status,origin_site)
               VALUES ($1,$2,$3,'progress',$4,$5,$6,'pending',$7)`,
              [newId(), tenantId, taskId, String(Math.min(progress + 20, 95)),
                "Two of three subtasks are complete and time is logged against it.", JSON.stringify([]), site()]);
          }
          // Append-only activity substrate the reports fact job reads.
          await c.query(
            `INSERT INTO work_activity (tenant_id,source,source_ref,actor_user_id,verb,object_kind,object_ref,title,payload,origin_site)
             VALUES ($1,'pm',$2,$3,$4,'pm_task',$5,$6,'{}',$7)
             ON CONFLICT (tenant_id,source,source_ref) DO NOTHING`,
            [tenantId, `pm-task-${taskId}-${status}`, person.id, status === "done" ? "completed" : "updated", taskId, title, site()]);
        }
      }
    });
  }
  return tasksCreated;
}

// ─────────────────────────── 3. check-ins (reports surfaces, whole roster) ───────────────────────────

async function seedCheckins(tenantId: string, depts: Dept[]): Promise<void> {
  const people = depts.flatMap((d) => d.people);
  if (people.length === 0) return;
  await withTenants([tenantId], async (c) => {
    for (const [i, p] of people.entries()) {
      for (let day = 4; day >= 0; day--) {
        // One weekday-ish gap per person so "auto_missed" is represented too, not a wall of green.
        const missed = (i + day) % 9 === 0;
        await c.query(
          `INSERT INTO report_checkins (tenant_id,user_id,checkin_date,status,summary,blockers,source,submitted_at,origin_site)
           VALUES ($1,$2,current_date-$3::int,$4,$5,$6,'ui',$7,$8)
           ON CONFLICT (tenant_id,user_id,checkin_date) DO NOTHING`,
          [tenantId, p.id, day,
            missed ? "auto_missed" : "submitted",
            missed ? "" : `Progressed assigned ${p.deptName} work, joined standup, cleared review comments.`,
            missed ? null : (i % 5 === 0 ? "Waiting on client feedback." : null),
            missed ? null : new Date(Date.now() - day * 86400_000).toISOString(),
            site()]);
      }
    }
  }, { modules: ["reports"] });
}

// ─────────────────────────── 4. HR: a file per employee ───────────────────────────

const ONBOARDING_ITEMS = ["Signed contract on file", "Company email + SSO account", "Laptop + peripherals issued", "Security & data-handling briefing", "Meet the department, first task assigned"];
const OFFBOARDING_ITEMS = ["Handover document complete", "Accounts disabled", "Equipment returned", "Final timesheet approved", "Exit conversation held"];

const VACATION_ALLOCATION = 12 * DAY_MINUTES; // 12 days
const SICK_ALLOCATION = 6 * DAY_MINUTES;

async function seedHr(tenantId: string, depts: Dept[], actorId: string): Promise<void> {
  const people = depts.flatMap((d) => d.people);
  if (people.length === 0) return;
  const year = new Date().getUTCFullYear();

  await withTenants([tenantId], async (c) => {
    // Templates — the source the onboarding board instantiates from.
    for (const [kind, name, items] of [["onboarding", "Standard onboarding", ONBOARDING_ITEMS], ["offboarding", "Standard offboarding", OFFBOARDING_ITEMS]] as const) {
      const ex = await c.query<{ id: string }>(`SELECT id FROM hr_checklist_templates WHERE tenant_id=$1 AND kind=$2 AND name=$3 AND deleted_at IS NULL`, [tenantId, kind, name]);
      if (!ex.rows[0]) {
        await c.query(`INSERT INTO hr_checklist_templates (id,tenant_id,kind,name,items,is_default) VALUES ($1,$2,$3,$4,$5,true)`,
          [newId(), tenantId, kind, name, JSON.stringify(items.map((label) => ({ label })))]);
      }
    }

    for (const [i, p] of people.entries()) {
      const tenured = i % 5 !== 0;             // most people are fully onboarded; a few are mid-onboarding
      const startedDaysAgo = 30 + i * 47;      // spread hire dates so tenure varies

      // ── contract + a note, per person (hr_records)
      await ensureRecord(c, tenantId, p.id, "contract", {
        title: "Employment contract", position: p.title || "Team member", department: p.deptName, division: p.unitName,
        employmentType: i % 7 === 0 ? "contract" : "permanent",
        startDate: isoDaysAgo(startedDaysAgo), probationMonths: 3, currency: "IDR", payCycle: "monthly",
      }, actorId);
      await ensureRecord(c, tenantId, p.id, "note", {
        title: "Probation review", outcome: tenured ? "passed" : "scheduled",
        body: tenured
          ? `Probation passed. Strong contribution to ${p.deptName}; owns their queue without chasing.`
          : `Probation review scheduled with the ${p.deptName} lead.`,
      }, actorId);
      if (i % 4 === 0) {
        await ensureRecord(c, tenantId, p.id, "document", {
          title: "NDA + data-handling acknowledgement", signedOn: isoDaysAgo(startedDaysAgo - 1), version: "2026.1",
        }, actorId);
      }

      // ── onboarding case (checklist), done for the tenured, in progress for the rest
      await ensureCase(c, tenantId, p.id, "onboarding", "Standard onboarding", tenured ? "done" : "in_progress",
        { items: ONBOARDING_ITEMS.map((label, k) => ({ label, done: tenured || k < 2, doneBy: tenured || k < 2 ? actorId : null, doneAt: tenured || k < 2 ? isoDaysAgo(startedDaysAgo) : null })) }, actorId);

      // ── a review case per person (the review-lite grain the HR console shows)
      await ensureCase(c, tenantId, p.id, "review", `${year} H1 performance review`, tenured ? "in_progress" : "open", {
        period: `${year}-H1`,
        goals: `Own the ${p.unitName} queue end to end; keep committed dates; raise blockers within a day.`,
        outcome: tenured ? "On track — meets expectations, exceeds on delivery predictability." : "",
      }, actorId);

      // ── leave: an approved past request, a pending future one, or neither (rotating)
      const bucket = i % 3;
      let usedVacation = 0;
      if (bucket === 0) {
        const created = await ensureLeave(c, tenantId, p.id, "vacation", isoDaysAgo(12), isoDaysAgo(10), 3 * DAY_MINUTES,
          "Family trip", "approved", actorId);
        if (created) usedVacation += 3 * DAY_MINUTES;
      } else if (bucket === 1) {
        await ensureLeave(c, tenantId, p.id, "vacation", isoDaysAhead(12), isoDaysAhead(14), 3 * DAY_MINUTES,
          "Planned leave — cover arranged with the department lead", "pending", actorId);
      }
      if (i % 6 === 0) {
        await ensureLeave(c, tenantId, p.id, "sick", isoDaysAgo(5), isoDaysAgo(5), DAY_MINUTES, "Fever", "approved", actorId);
      }
      if (i % 8 === 3) {
        await ensureLeave(c, tenantId, p.id, "unpaid", isoDaysAhead(20), isoDaysAhead(27), 6 * DAY_MINUTES,
          "Extended personal leave", "denied", actorId);
      }

      // ── balances (allocated for everyone; used reflects the APPROVED requests above)
      const usedSick = i % 6 === 0 ? DAY_MINUTES : 0;
      await c.query(
        `INSERT INTO hr_leave_balances (id,tenant_id,subject_user_id,year,leave_type,allocated_minutes,used_minutes)
         VALUES ($1,$2,$3,$4,'vacation',$5,$6)
         ON CONFLICT (tenant_id,subject_user_id,year,leave_type)
         DO UPDATE SET allocated_minutes = EXCLUDED.allocated_minutes, used_minutes = GREATEST(hr_leave_balances.used_minutes, EXCLUDED.used_minutes)`,
        [newId(), tenantId, p.id, year, VACATION_ALLOCATION, usedVacation]);
      await c.query(
        `INSERT INTO hr_leave_balances (id,tenant_id,subject_user_id,year,leave_type,allocated_minutes,used_minutes)
         VALUES ($1,$2,$3,$4,'sick',$5,$6)
         ON CONFLICT (tenant_id,subject_user_id,year,leave_type)
         DO UPDATE SET allocated_minutes = EXCLUDED.allocated_minutes, used_minutes = GREATEST(hr_leave_balances.used_minutes, EXCLUDED.used_minutes)`,
        [newId(), tenantId, p.id, year, SICK_ALLOCATION, usedSick]);

      // ── attendance for the last 14 days (the HR attendance page's own window), weekdays only
      for (let day = 13; day >= 0; day--) {
        const dow = new Date(Date.now() - day * 86400_000).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const onApprovedLeave = (bucket === 0 && day >= 10 && day <= 12) || (i % 6 === 0 && day === 5);
        const status = onApprovedLeave ? "leave" : (i + day) % 5 === 0 ? "remote" : (i + day) % 17 === 0 ? "absent" : "present";
        await c.query(
          `INSERT INTO hr_attendance (id,tenant_id,subject_user_id,day,status,note,recorded_by)
           VALUES ($1,$2,$3,current_date-$4::int,$5,$6,$7)
           ON CONFLICT (tenant_id,subject_user_id,day) DO NOTHING`,
          [newId(), tenantId, p.id, day, status,
            status === "remote" ? "Working from home" : status === "absent" ? "Unreported absence — followed up" : null, actorId]);
      }
    }

    // Two non-routine cases so the case board is not all onboarding + review.
    const grievanceSubject = people[people.length - 1];
    await ensureCase(c, tenantId, grievanceSubject.id, "grievance", "Workload escalation raised at the weekly review", "in_progress",
      { summary: "Sustained overtime across two consecutive sprints; capacity being rebalanced with the department lead.", raisedOn: isoDaysAgo(6) }, actorId);
    const otherSubject = people[Math.floor(people.length / 2)];
    await ensureCase(c, tenantId, otherSubject.id, "other", "Training budget request — advanced certification", "open",
      { summary: "Requesting the certification track; cost and cover plan attached.", requestedOn: isoDaysAgo(3) }, actorId);
  }, { modules: ["hr"] });
}

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const isoDaysAhead = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function ensureRecord(c: PoolClient, tenantId: string, subjectId: string, type: string, data: Record<string, unknown>, actorId: string): Promise<void> {
  const ex = await c.query<{ id: string }>(
    `SELECT id FROM hr_records WHERE tenant_id=$1 AND subject_user_id=$2 AND record_type=$3 AND data->>'title'=$4 AND deleted_at IS NULL`,
    [tenantId, subjectId, type, String(data.title)]);
  if (ex.rows[0]) return;
  await c.query(
    `INSERT INTO hr_records (id,tenant_id,subject_user_id,record_type,data,created_by,origin_site) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [newId(), tenantId, subjectId, type, JSON.stringify(data), actorId, site()]);
}

async function ensureCase(
  c: PoolClient, tenantId: string, subjectId: string, kind: string, title: string, status: string,
  details: Record<string, unknown>, actorId: string,
): Promise<void> {
  const ex = await c.query<{ id: string }>(
    `SELECT id FROM hr_cases WHERE tenant_id=$1 AND subject_user_id=$2 AND kind=$3 AND title=$4 AND deleted_at IS NULL`,
    [tenantId, subjectId, kind, title]);
  if (ex.rows[0]) return;
  await c.query(
    `INSERT INTO hr_cases (id,tenant_id,subject_user_id,kind,status,title,details,created_by,origin_site) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId(), tenantId, subjectId, kind, status, title, JSON.stringify(details), actorId, site()]);
}

/** A leave request plus the automation_approvals row it rides on — the same pair the fileLeave
 *  endpoint writes, so a pending seeded request is decidable from the real approvals inbox instead
 *  of being an orphan row that nothing can action. Returns true when it created one. */
async function ensureLeave(
  c: PoolClient, tenantId: string, subjectId: string, leaveType: string, startsOn: string, endsOn: string,
  minutes: number, note: string, status: "pending" | "approved" | "denied", actorId: string,
): Promise<boolean> {
  const ex = await c.query<{ id: string }>(
    `SELECT id FROM hr_leave_requests WHERE tenant_id=$1 AND subject_user_id=$2 AND leave_type=$3 AND starts_on=$4 AND deleted_at IS NULL`,
    [tenantId, subjectId, leaveType, startsOn]);
  if (ex.rows[0]) return false;

  const subject = await c.query<{ name: string }>(`SELECT name FROM users WHERE id=$1`, [subjectId]);
  const subjectName = subject.rows[0]?.name ?? subjectId;
  const leaveId = newId();
  const approvalId = newId();
  await c.query(
    `INSERT INTO hr_leave_requests (id,tenant_id,subject_user_id,leave_type,starts_on,ends_on,minutes,note,status,approval_id,decided_by,decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [leaveId, tenantId, subjectId, leaveType, startsOn, endsOn, minutes, note, status, approvalId,
      status === "pending" ? null : actorId, status === "pending" ? null : new Date().toISOString()]);
  await c.query(
    `INSERT INTO automation_approvals (id,tenant_id,workflow_id,tool_name,tool_args,impact,reason,requested_by,origin,status,decided_by,decided_at,origin_site)
     VALUES ($1,$2,'hr:leave','hr.fileLeave',$3,'medium',$4,$5,'hr',$6,$7,$8,$9)`,
    [approvalId, tenantId,
      JSON.stringify({ leaveRequestId: leaveId, subjectUserId: subjectId, subjectName, leaveType, range: { startsOn, endsOn }, minutes, href: `/hr/leave/${leaveId}` }),
      `${subjectName} requested ${leaveType} leave ${startsOn} to ${endsOn}`, subjectId,
      status === "denied" ? "rejected" : status,
      status === "pending" ? null : actorId, status === "pending" ? null : new Date().toISOString(), site()]);
  return true;
}

// ─────────────────────────── entry point ───────────────────────────

export interface SeededDepartments { departments: { id: string; name: string; people: number }[]; tasksCreated: number }

/** Called from seedAgency() after the org tree exists. `clients` is the agency's client id list
 *  (index 0/1 = the two seeded clients) — the department projects that represent client delivery
 *  attach to them so invoices/deliverables and the department views agree on who the work is for. */
export async function seedDepartmentsAndHr(tenantId: string, clients: string[], actorId: string): Promise<SeededDepartments> {
  await mergeOrgPlacements(tenantId);
  const depts = await readDepartments(tenantId);
  const tasksCreated = await seedDepartmentWork(tenantId, depts, clients, actorId);
  await seedCheckins(tenantId, depts);
  await seedHr(tenantId, depts, actorId);
  return { departments: depts.map((d) => ({ id: d.id, name: d.name, people: d.people.length })), tasksCreated };
}

// Standalone entry point (`npm run seed:departments`) so an EXISTING, already-seeded database can be
// filled in without re-running the whole holding seed — which is the normal case on a live
// environment, where agency.ts has run at deploy time and only the department/HR data is missing.
// Deliberately does NOT call migrate(): a data seed run against a live database must not also move
// its schema. It resolves the agency by name (the same constant agency.ts creates it under) and
// fails loudly rather than inventing a tenant.
if (require.main === module) {
  (async () => {
    const { closePool } = await import("../db");
    const t = await withGlobal((c) => c.query<{ id: string }>(
      `SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, ["Gaia Digital Agency"]));
    const tenantId = t.rows[0]?.id;
    if (!tenantId) throw new Error("agency company not found — run seed:agency first");
    // ⚠ The real employee first. This resolved `owner@gaiada-creative.test` directly and with no
    // `deleted_at` filter, so after the personas were retired it still found the soft-deleted row and
    // stamped every record this seed writes with a principal that no longer exists — invisibly, since
    // the ids are valid and nothing errors. `resolveSeedActor` returns the GM who does that job now,
    // and falls back to the fixture only on a database with no roster.
    const successorId = await resolveSeedActor("owner@gaiada-creative.test");
    const actor = await withGlobal((c) => c.query<{ id: string; deleted_at: Date | null }>(
      `SELECT id, deleted_at FROM users WHERE email = $1`, ["owner@gaiada-creative.test"]));
    if (!successorId && actor.rows[0]) assertNotRetired("owner@gaiada-creative.test", actor.rows[0].deleted_at);
    const actorId = successorId ?? actor.rows[0]?.id;
    if (!actorId) throw new Error("seed actor not found — run seed:agency first");
    const clients = (await withTenants([tenantId], (c) => c.query<{ id: string }>(
      `SELECT id FROM clients WHERE tenant_id = $1 AND name = ANY($2::text[]) ORDER BY name`,
      [tenantId, ["Bali Beach Resort", "Nusa Coffee Co"]]))).rows.map((r) => r.id);

    const r = await seedDepartmentsAndHr(tenantId, clients, actorId);
    console.log(`seeded departments for ${tenantId}`);
    console.log(`  ${r.departments.map((d) => `${d.name}(${d.people} people)`).join(", ")}`);
    console.log(`  tasks created: ${r.tasksCreated}`);
    await closePool();
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}

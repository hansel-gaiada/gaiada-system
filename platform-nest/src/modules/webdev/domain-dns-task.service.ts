// M6-P6p (WSK-D89 (4), answering O-12) — the DNS records of a delivered domain become ONE PM task a Web Dev person completes, and
// the ERP's own read-only DNS check (M6-P6i: domain-dns.ts / domain-dns.service.ts) closes it when the records point.
//
// ═══ WHAT THIS FILE IS, AND IS NOT ═══════════════════════════════════════════════════════════════════════════════════════
// A thin layer on P6i. It adds NO resolver call of its own (`readSiteDns` is the one path that asks), stores NO DNS credential and
// calls NO DNS API. The task is the PM module's own `pm_tasks` row, made through `createPmTaskInTx` and closed through
// `closePmTaskInTx`: there is no second task store. `webdev_site_dns_tasks` is only the link (site <-> task) and the record of why
// a task closed.
//
// ═══ WHEN A TASK IS MADE: `syncSiteDnsTask` ═══════════════════════════════════════════════════════════════════════════════
// The checklist "first exists" when a site has a real (claimed) domain AND a delivery binding whose host has a documented target
// (`dnsChecklistFor` is `ready`). That moment is reached by one of three writes, each of which calls this after its own commit:
// the domain claim, the delivery binding, and the production row's creation. The sync is also run by the check and the sweep, so
// it is idempotent by construction:
//   - no open task for the site            -> create ONE (a site with no project has nowhere to hang a PM task: `no_project`)
//   - an open task, same domain            -> the record list changed? UPDATE the task's description and the link; else nothing
//   - an open task, a different domain     -> close it (`domain_changed`) and create the replacement
//   - the row was archived (soft-deleted)  -> close the open task (`site_archived`)
//   - the checklist is no longer `ready` for a different domain than the task's -> close it (`domain_changed`)
// One open task per site is enforced twice: the site row is locked `FOR UPDATE` for the whole sync, and
// `ux_wsdt_one_open_per_site` is the backstop. Creating the task is a SIDE EFFECT of an action that was already authorized (the
// claim, the binding, the production command), so it carries no authorization of its own; the actor is that action's caller.
//
// ═══ THE ASSIGNEE RULE (documented choice; the ticket gave the order of preference) ═════════════════════════════════════
//   1. `project_owner`: the active owner of the site's project (`projects.owner_id`). A registry row has no person column of its
//      own, so "the person already responsible for the site" is its project's owner.
//   2. `web_dev_head`: otherwise the holder of the company's own LEAD SEAT on the project's department unit (`projects.department_id`),
//      read the way `modules/reports/person-scope.ts` reads lead seats (an active position carrying the `org_unit_lead` role row,
//      held through an open assignment). The longest-serving holder first; never an `org_unit_lead` GRANT (a grant carries no company).
//   3. `unassigned`: otherwise no assignee. The task sits on the site's project board, which is the Web Dev queue for that site.
// Assigning a department as the assignee is not done: PM's department assignee needs a responsible PERSON, which is exactly what
// is missing on this branch.
//
// ═══ HOW A TASK CLOSES: `checkSiteDnsTask` ═══════════════════════════════════════════════════════════════════════════════
// It runs the P6i read-only check for the site (`readSiteDns`, one resolver lookup) and then, under the link row's lock:
//   - every record `pointing`            -> complete the PM task (`closePmTaskInTx`) and record `erp_check`; the task's description
//                                           gets a note "closed by the ERP's DNS check";
//   - not pointing, but a person already completed the task by hand -> record `manual` with `erp_saw_pointing = false` and a note
//                                           that the ERP did NOT see the records point (and why);
//   - not pointing, task still open      -> stays open; `last_checked_at` and the pending reason are recorded.
// Completing by hand is therefore always allowed (it is the PM task's own rule), and never silently trusted.
// The sweep (`sweepSiteDnsTasks`) runs the check for every open link of every webdev-enabled company on an interval; the HTTP
// re-check route runs it for one site on demand.
import { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { isModuleEnabled } from "../registry";
import { LEAD_SEAT_FROM, LEAD_SEAT_LIVE } from "../reports/person-scope";
import { closePmTaskInTx, createPmTaskInTx, effectiveStatuses, normalizePmTaskInput } from "../pm/pm.controller";
import { dnsChecklistFor, type DnsCheck, type DnsRecord } from "./domain-dns";
import { documentedDnsTargets, readSiteDns } from "./domain-dns.service";

const logger = new Logger("WebdevDnsTask");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULES = ["webdev", "pm"];

export type AssigneeSource = "project_owner" | "web_dev_head" | "unassigned";
export type DnsTaskCloseReason = "erp_check" | "manual" | "domain_changed" | "site_archived";

export interface SiteDnsTaskDto {
  /** The link row. `null` when the site has never had a DNS task. */
  id: string | null;
  siteId: string;
  state: "none" | "open" | "closed";
  domain: string | null;
  taskId: string | null;
  records: DnsRecord[];
  assigneeSource: AssigneeSource | null;
  assigneeUserId: string | null;
  closedBy: DnsTaskCloseReason | null;
  closedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckReason: string | null;
  erpSawPointing: boolean;
}

export type DnsTaskSyncOutcome = "created" | "updated" | "unchanged" | "replaced" | "closed_stale" | "none";
export interface DnsTaskSyncResult {
  outcome: DnsTaskSyncOutcome;
  taskId: string | null;
  /** Why no task exists when `outcome` is `none`. */
  reason?: "not_ready" | "no_project" | "site_gone";
  assigneeSource?: AssigneeSource;
}

interface LinkRow {
  id: string; site_id: string; domain: string; task_id: string; records: DnsRecord[];
  assignee_source: AssigneeSource; assignee_user_id: string | null; state: "open" | "closed";
  closed_by: DnsTaskCloseReason | null; closed_at: Date | null; last_checked_at: Date | null;
  last_check_reason: string | null; erp_saw_pointing: boolean;
}
const LINK_COLS = `id, site_id, domain, task_id, records, assignee_source, assignee_user_id, state, closed_by, closed_at,
  last_checked_at, last_check_reason, erp_saw_pointing`;

interface SiteFacts {
  id: string; domain: string; environment: string; project_id: string | null;
  host_kind: string; host_ref: string | null; deleted_at: Date | null;
}

function toDto(siteId: string, l: LinkRow | undefined): SiteDnsTaskDto {
  if (!l) {
    return {
      id: null, siteId, state: "none", domain: null, taskId: null, records: [], assigneeSource: null, assigneeUserId: null,
      closedBy: null, closedAt: null, lastCheckedAt: null, lastCheckReason: null, erpSawPointing: false,
    };
  }
  return {
    id: l.id, siteId, state: l.state, domain: l.domain, taskId: l.task_id, records: l.records, assigneeSource: l.assignee_source,
    assigneeUserId: l.assignee_user_id, closedBy: l.closed_by, closedAt: l.closed_at ? l.closed_at.toISOString() : null,
    lastCheckedAt: l.last_checked_at ? l.last_checked_at.toISOString() : null, lastCheckReason: l.last_check_reason,
    erpSawPointing: l.erp_saw_pointing,
  };
}

const recordsKey = (rs: readonly DnsRecord[]): string =>
  JSON.stringify([...rs].map((r) => [r.type, r.name, r.target]).sort());

// ── the task text ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function dnsTaskTitle(domain: string): string {
  return `Create the DNS records for ${domain}`;
}

/** Pure. The task body: the domain, every record (type, name, target) and where the site's console page is. */
export function dnsTaskDescription(i: { domain: string; siteId: string; records: readonly DnsRecord[]; departmentId: string | null }): string {
  const lines = i.records.map((r) => `- ${r.type}  ${r.name}  ->  ${r.target}`);
  const consolePath = i.departmentId
    ? `/departments/${encodeURIComponent(i.departmentId)}/sites/portfolio/${i.siteId}`
    : null;
  return [
    `Domain: ${i.domain}`,
    "",
    "Records to create in the domain's DNS panel (type, name, target):",
    ...lines,
    "",
    consolePath ? `Site console: ${consolePath}` : `Site registry row: ${i.siteId}`,
    "",
    "The ERP stores no DNS credential and changes no record: a person creates them. The ERP then checks the domain itself, read-only, " +
      "and completes this task when every record points at its host. You may also complete it by hand; the task then records that the " +
      "ERP did not see the records point.",
  ].join("\n");
}

async function appendNote(c: PoolClient, taskId: string, note: string): Promise<void> {
  await c.query(`UPDATE pm_tasks SET description = description || $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, [taskId, `\n\n${note}`]);
}

// ── the assignee ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface ProjectFacts { owner_id: string | null; department_id: string | null }
interface Resolved { source: AssigneeSource; userId: string | null; name: string | null }

async function resolveAssignee(c: PoolClient, tenantId: string, p: ProjectFacts): Promise<Resolved> {
  if (p.owner_id) {
    const u = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [p.owner_id],
    );
    if (u.rows[0]) return { source: "project_owner", userId: u.rows[0].id, name: u.rows[0].name };
  }
  if (p.department_id) {
    const h = await c.query<{ id: string; name: string }>(
      `SELECT u.id, u.name
         FROM ${LEAD_SEAT_FROM}
         JOIN users u ON u.id = pa.user_id AND u.status = 'active' AND u.deleted_at IS NULL
        WHERE p.tenant_id = $1 AND ${LEAD_SEAT_LIVE} AND p.unit_node_id = $2
        ORDER BY pa.valid_from, pa.user_id
        LIMIT 1`,
      [tenantId, p.department_id],
    );
    if (h.rows[0]) return { source: "web_dev_head", userId: h.rows[0].id, name: h.rows[0].name };
  }
  return { source: "unassigned", userId: null, name: null };
}

// ── closing a link (shared by sync and check) ─────────────────────────────────────────────────────────────────────────

async function closeLink(
  c: PoolClient, tenantId: string, link: LinkRow, by: DnsTaskCloseReason,
  o: { note: string; completeTask: boolean; actorId: string | null; erpSawPointing: boolean; reason: string | null },
): Promise<void> {
  if (o.completeTask) await closePmTaskInTx(c, tenantId, o.actorId, link.task_id);
  await appendNote(c, link.task_id, o.note);
  await c.query(
    `UPDATE webdev_site_dns_tasks
        SET state = 'closed', closed_by = $2, closed_at = now(), erp_saw_pointing = $3, last_checked_at = now(),
            last_check_reason = $4, updated_at = now()
      WHERE id = $1`,
    [link.id, by, o.erpSawPointing, o.reason],
  );
}

// ── sync: make, update or retire the task ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the site has exactly the right DNS task. Never throws for an ordinary state (see the header table). A caller that must not
 * fail because of it (the claim, the binding, the production command) uses `syncSiteDnsTaskQuietly`.
 */
export async function syncSiteDnsTask(tenantId: string, siteId: string, actorId: string | null): Promise<DnsTaskSyncResult> {
  if (!UUID_RE.test(siteId)) return { outcome: "none", taskId: null, reason: "site_gone" };
  return withTenants(
    [tenantId],
    async (c) => {
      const s = await c.query<SiteFacts>(
        `SELECT id, domain, environment, project_id, host_kind, host_ref, deleted_at FROM webdev_sites WHERE id = $1 FOR UPDATE`, [siteId],
      );
      const site = s.rows[0];
      const open = (await c.query<LinkRow>(
        `SELECT ${LINK_COLS} FROM webdev_site_dns_tasks WHERE tenant_id = $1 AND site_id = $2 AND state = 'open' FOR UPDATE`, [tenantId, siteId],
      )).rows[0];
      if (!site || site.deleted_at) {
        if (!open) return { outcome: "none", taskId: null, reason: "site_gone" };
        await closeLink(c, tenantId, open, "site_archived", {
          note: "Closed: the site was archived, so these DNS records are no longer needed.",
          completeTask: true, actorId, erpSawPointing: false, reason: null,
        });
        return { outcome: "closed_stale", taskId: open.task_id };
      }
      const checklist = dnsChecklistFor({ domain: site.domain, hostKind: site.host_kind, hostRef: site.host_ref, targets: documentedDnsTargets() });
      if (checklist.state !== "ready") {
        // The records are not known (placeholder domain, no binding, unknown target). A task made for ANOTHER domain is stale.
        if (open && open.domain !== site.domain) {
          await closeLink(c, tenantId, open, "domain_changed", {
            note: `Closed: the site's domain is no longer ${open.domain}, so these records are no longer needed.`,
            completeTask: true, actorId, erpSawPointing: false, reason: null,
          });
          return { outcome: "closed_stale", taskId: open.task_id };
        }
        return { outcome: "none", taskId: open?.task_id ?? null, reason: "not_ready" };
      }
      const project = site.project_id
        ? (await c.query<ProjectFacts>(
            `SELECT owner_id, department_id FROM projects WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [site.project_id, tenantId],
          )).rows[0] ?? null
        : null;

      if (open && open.domain === site.domain) {
        if (recordsKey(open.records) === recordsKey(checklist.records)) return { outcome: "unchanged", taskId: open.task_id, assigneeSource: open.assignee_source };
        await c.query(`UPDATE pm_tasks SET description = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, [
          open.task_id,
          dnsTaskDescription({ domain: site.domain, siteId, records: checklist.records, departmentId: project?.department_id ?? null }),
        ]);
        await c.query(`UPDATE webdev_site_dns_tasks SET records = $2::jsonb, updated_at = now() WHERE id = $1`, [open.id, JSON.stringify(checklist.records)]);
        return { outcome: "updated", taskId: open.task_id, assigneeSource: open.assignee_source };
      }

      let replaced = false;
      if (open) {
        await closeLink(c, tenantId, open, "domain_changed", {
          note: `Closed: the site's domain changed from ${open.domain} to ${site.domain}; a new task lists the new records.`,
          completeTask: true, actorId, erpSawPointing: false, reason: null,
        });
        replaced = true;
      }
      if (!project) return { outcome: replaced ? "closed_stale" : "none", taskId: null, reason: "no_project" };

      const who = await resolveAssignee(c, tenantId, project);
      const task = await createPmTaskInTx(c, tenantId, actorId, normalizePmTaskInput({
        projectId: site.project_id as string,
        title: dnsTaskTitle(site.domain),
        description: dnsTaskDescription({ domain: site.domain, siteId, records: checklist.records, departmentId: project.department_id }),
        priority: "normal",
        assignee: who.userId
          ? { kind: "person", refId: who.userId, refName: who.name, responsibleId: who.userId, responsibleName: who.name }
          : undefined,
      }));
      await c.query(
        `INSERT INTO webdev_site_dns_tasks (tenant_id, site_id, domain, task_id, records, assignee_source, assignee_user_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [tenantId, siteId, site.domain, task.id, JSON.stringify(checklist.records), who.source, who.userId],
      );
      return { outcome: replaced ? "replaced" : "created", taskId: task.id, assigneeSource: who.source };
    },
    { modules: MODULES },
  );
}

/** For the write paths that call the sync as a side effect: a fault here is logged and never undoes or fails the committed write. */
export async function syncSiteDnsTaskQuietly(tenantId: string, siteId: string, actorId: string | null): Promise<DnsTaskSyncResult | null> {
  try {
    return await syncSiteDnsTask(tenantId, siteId, actorId);
  } catch (err) {
    logger.error(`DNS task sync for site ${siteId} failed: ${(err as Error).message}`);
    return null;
  }
}

// ── check: the ERP's read-only check closes the task ──────────────────────────────────────────────────────────────────

export interface DnsTaskCheckResult {
  task: SiteDnsTaskDto;
  /** What the check saw (`null` when there was no open task to check). */
  check: DnsCheck | null;
}

/** Read the link's state (the newest row for the site). */
export async function readSiteDnsTask(tenantId: string, siteId: string): Promise<SiteDnsTaskDto> {
  if (!UUID_RE.test(siteId)) return toDto(siteId, undefined);
  const r = await withTenants(
    [tenantId],
    (c) => c.query<LinkRow>(
      `SELECT ${LINK_COLS} FROM webdev_site_dns_tasks WHERE tenant_id = $1 AND site_id = $2 ORDER BY (state = 'open') DESC, created_at DESC LIMIT 1`,
      [tenantId, siteId],
    ),
    { modules: MODULES },
  );
  return toDto(siteId, r.rows[0]);
}

/**
 * Run the P6i read-only check for one site and close its open DNS task when the records point (see the header). `actorId` is the
 * caller of an on-demand re-check, `null` for the sweep: the task is then completed with no acting person, because the evidence is
 * the public DNS answer, not anybody's decision.
 */
export async function checkSiteDnsTask(tenantId: string, siteId: string, actorId: string | null = null): Promise<DnsTaskCheckResult> {
  // Retire a stale task first (archived row, changed domain) and make sure the records are current.
  await syncSiteDnsTask(tenantId, siteId, actorId);
  const before = await readSiteDnsTask(tenantId, siteId);
  if (before.state !== "open") return { task: before, check: null };

  // ONE resolver lookup, outside any transaction (it is the P6i path; the stub in the tests lands here).
  const dns = await readSiteDns(tenantId, siteId);
  const pointing = dns.check.state === "pointing";

  await withTenants(
    [tenantId],
    async (c) => {
      const link = (await c.query<LinkRow>(
        `SELECT ${LINK_COLS} FROM webdev_site_dns_tasks WHERE tenant_id = $1 AND site_id = $2 AND state = 'open' FOR UPDATE`, [tenantId, siteId],
      )).rows[0];
      // Lost a race (another check closed it) or the domain moved while the resolver was asked: nothing to record.
      if (!link || link.domain !== dns.domain) return;
      const reason = dns.check.reason ?? "pointing";
      const task = await c.query<{ project_id: string; status: string }>(
        `SELECT project_id, status FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`, [link.task_id],
      );
      const t = task.rows[0];
      const doneByHand = t ? ((await effectiveStatuses(c, t.project_id)).find((s) => s.id === t.status)?.isDone ?? false) : true;
      const stamp = new Date().toISOString();
      if (doneByHand) {
        await closeLink(c, tenantId, link, "manual", {
          note: pointing
            ? `Completed by hand. The ERP's DNS check (${stamp}) sees every record pointing.`
            : `Completed by hand. The ERP's DNS check (${stamp}) did NOT see the records point (${reason}).`,
          completeTask: false, actorId, erpSawPointing: pointing, reason,
        });
      } else if (pointing) {
        await closeLink(c, tenantId, link, "erp_check", {
          note: `Closed by the ERP's DNS check (${stamp}): every record points at its host.`,
          completeTask: true, actorId, erpSawPointing: true, reason: null,
        });
      } else {
        await c.query(
          `UPDATE webdev_site_dns_tasks SET last_checked_at = now(), last_check_reason = $2, erp_saw_pointing = false, updated_at = now() WHERE id = $1`,
          [link.id, reason],
        );
      }
    },
    { modules: MODULES },
  );
  return { task: await readSiteDnsTask(tenantId, siteId), check: dns.check };
}

// ── the sweep ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** At most this many open tasks are checked per company per pass; the rest are the next pass's. */
export const DNS_SWEEP_PER_COMPANY = 100;

export interface DnsSweepResult { considered: number; closed: number; stillOpen: number; failed: number }

export async function sweepSiteDnsTasksForCompany(tenantId: string): Promise<DnsSweepResult> {
  const out: DnsSweepResult = { considered: 0, closed: 0, stillOpen: 0, failed: 0 };
  const open = await withTenants(
    [tenantId],
    (c) => c.query<{ site_id: string }>(
      `SELECT site_id FROM webdev_site_dns_tasks WHERE tenant_id = $1 AND state = 'open' ORDER BY last_checked_at NULLS FIRST, id LIMIT $2`,
      [tenantId, DNS_SWEEP_PER_COMPANY],
    ),
    { modules: MODULES },
  );
  for (const row of open.rows) {
    out.considered += 1;
    try {
      const r = await checkSiteDnsTask(tenantId, row.site_id, null);
      if (r.task.state === "closed") out.closed += 1;
      else out.stillOpen += 1;
    } catch (err) {
      out.failed += 1;
      logger.error(`DNS task check for site ${row.site_id} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

/** One pass over every webdev-enabled company. */
export async function sweepSiteDnsTasks(): Promise<DnsSweepResult> {
  const total: DnsSweepResult = { considered: 0, closed: 0, stillOpen: 0, failed: 0 };
  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`));
  for (const co of companies.rows) {
    if (!(await isModuleEnabled(co.id, "webdev"))) continue;
    try {
      const r = await sweepSiteDnsTasksForCompany(co.id);
      total.considered += r.considered; total.closed += r.closed; total.stillOpen += r.stillOpen; total.failed += r.failed;
    } catch (err) {
      logger.error(`DNS task sweep for company ${co.id} failed: ${(err as Error).message}`);
    }
  }
  if (total.closed || total.failed) logger.log(`dns task sweep: ${JSON.stringify(total)}`);
  return total;
}

/** Chained setTimeout (a slow pass cannot overlap itself), the build poller's shape. Started from bootstrap() only. */
export function startSiteDnsTaskLoop(intervalMs: number): { stop: () => void } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    logger.error(`refusing to start the DNS task sweep: intervalMs=${intervalMs} is not positive`);
    return { stop: () => undefined };
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      await sweepSiteDnsTasks();
    } catch (err) {
      logger.error(`DNS task sweep failed: ${(err as Error).message}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function siteDnsTaskStartLine(): string {
  return `webdev DNS task sweep on: every ${config.webdevDns.sweepIntervalMs}ms (WEBDEV_DNS_SWEEP_INTERVAL_MS); read-only resolver lookups of open tasks' domains only`;
}

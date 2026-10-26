// M6-P6p (WSK-D89 (4)) — the DNS records of a delivered domain become ONE PM task a Web Dev person completes, and the ERP's own
// read-only DNS check closes it. Against REAL Postgres (RLS, FORCE, the third wall, the partial unique index) with a STUBBED resolver
// and operator targets installed through P6i's test seams, so no suite ever dials a resolver and no DNS API exists to be called.
//
// What it proves:
//   - the claim creates exactly ONE task, through the PM module's own task model, naming the domain and every record;
//   - a repeat does not duplicate it (also under concurrency); a changed target UPDATES the task in place;
//   - the assignee rule, each branch: project owner, else the company's own Web Dev lead seat, else unassigned (an inactive owner
//     falls through);
//   - every record `pointing` closes the task (swept), with the ERP's note; partial pointing leaves it open;
//   - a task a person completes by hand is recorded as manual and says the ERP did not see the records point;
//   - a domain change replaces the task; a site archive closes it; a site with no project makes none;
//   - the on-demand re-check route is gated (`webdev_site` update) and closes the task too.
// Needs DATABASE_URL_TEST (the route test also CERBOS_URL); skips otherwise.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, grantLeadSeat } from "../../testing/fixtures";
import { claimProvisionedSiteDomain, createWebdevSite } from "./site-registry.service";
import { setDnsLookupForTests } from "./domain-dns-lookup";
import { setDnsTargetsForTests } from "./domain-dns.service";
import { checkSiteDnsTask, readSiteDnsTask, syncSiteDnsTask, sweepSiteDnsTasksForCompany } from "./domain-dns-task.service";
import type { ObservedDns } from "./domain-dns";

const live = !!TEST_URL;
const routeLive = live && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const TARGETS = new Map([["hostinger-1", [{ type: "A" as const, value: "203.0.113.10" }]]]);
const POINTING: ObservedDns = { a: ["203.0.113.10"], aaaa: [], cname: [] };
const NOTHING: ObservedDns = { a: [], aaaa: [], cname: [] };

describe.skipIf(!live)("DNS records as a Web Dev task (M6-P6p)", () => {
  let app: NestFastifyApplication | null = null;
  let co: string;
  let other: string;
  let admin: string;
  let member: string;
  let owner: string;
  let head: string;
  let n = 0;
  let asked: string[];
  let answer: ObservedDns;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Dns Task Co", ["webdev", "search", "pm"]);
    other = await createCompany("Rival Dns Task Co", ["webdev", "search", "pm"]);
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    admin = await mk("admin@dnstask.test", "company_admin");
    member = await mk("member@dnstask.test", "member");
    owner = await createUser("owner@dnstask.test", "Project Owner");
    head = await createUser("head@dnstask.test", "Web Dev Head");
    await addMembership(co, owner);
    await addMembership(co, head);
    await grantLeadSeat(co, "d-web", head);
    if (routeLive) app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  afterEach(() => {
    setDnsLookupForTests(null);
    setDnsTargetsForTests(null);
  });

  const setup = (a: ObservedDns = NOTHING, targets = TARGETS) => {
    asked = [];
    answer = a;
    setDnsTargetsForTests(targets);
    setDnsLookupForTests(async (d) => (asked.push(d), answer));
  };
  const uniq = (p: string) => `${p}-${++n}-${Date.now().toString(36)}`;

  /** A project (optionally owned, optionally in the Web Dev unit) and a bound registry row under it. */
  async function site(o: { owner?: string; dept?: string | null; noProject?: boolean; hostRef?: string } = {}) {
    let projectId: string | null = null;
    if (!o.noProject) {
      projectId = await createProject(co, uniq("proj"), o.owner);
      if (o.dept !== null) await adminPool().query(`UPDATE projects SET department_id = $2 WHERE id = $1`, [projectId, o.dept ?? "d-web"]);
    }
    const domain = `${uniq("d")}.example.com`;
    const s = await createWebdevSite(co, { domain, projectId, hostKind: "shared-hosting", hostRef: o.hostRef ?? "hostinger-1", access: "ssh" } as never, null);
    return { id: s.id, domain, projectId };
  }
  const links = (siteId: string) =>
    adminPool().query(`SELECT * FROM webdev_site_dns_tasks WHERE site_id = $1 ORDER BY created_at`, [siteId]).then((r) => r.rows);
  const task = (id: string) =>
    adminPool().query(`SELECT * FROM pm_tasks WHERE id = $1`, [id]).then((r) => r.rows[0]);
  const tasksOf = (projectId: string) =>
    adminPool().query(`SELECT id FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`, [projectId]).then((r) => r.rows);

  it("the flow creates exactly ONE task naming the domain and every record, through pm_tasks", async () => {
    setup();
    const s = await site({ owner });
    const r = await syncSiteDnsTask(co, s.id, null);
    expect(r).toMatchObject({ outcome: "created", assigneeSource: "project_owner" });
    expect(await tasksOf(s.projectId as string)).toHaveLength(1);
    const t = await task(r.taskId as string);
    expect(t.title).toContain(s.domain);
    expect(t.description).toContain(`A  ${s.domain}  ->  203.0.113.10`);
    expect(t.status).not.toBe("done");
    const l = await links(s.id);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ state: "open", domain: s.domain, task_id: r.taskId, assignee_source: "project_owner" });
    expect(l[0].records).toEqual([{ type: "A", name: s.domain, target: "203.0.113.10" }]);
    expect(asked).toEqual([]); // creating the task asks no resolver
  });

  it("a repeat does not duplicate; a changed target UPDATES the same task and link in place", async () => {
    setup();
    const s = await site({ owner });
    const first = await syncSiteDnsTask(co, s.id, null);
    expect((await syncSiteDnsTask(co, s.id, null)).outcome).toBe("unchanged");
    expect((await syncSiteDnsTask(co, s.id, null)).taskId).toBe(first.taskId);
    setDnsTargetsForTests(new Map([["hostinger-1", [{ type: "A" as const, value: "203.0.113.77" }]]]));
    const again = await syncSiteDnsTask(co, s.id, null);
    expect(again).toMatchObject({ outcome: "updated", taskId: first.taskId });
    expect(await tasksOf(s.projectId as string)).toHaveLength(1);
    expect(await links(s.id)).toHaveLength(1);
    expect((await task(first.taskId as string)).description).toContain("203.0.113.77");
    expect((await task(first.taskId as string)).description).not.toContain("203.0.113.10");
  });

  it("concurrent flows still make ONE task", async () => {
    setup();
    const s = await site({ owner });
    const rs = await Promise.all([syncSiteDnsTask(co, s.id, null), syncSiteDnsTask(co, s.id, null), syncSiteDnsTask(co, s.id, null)]);
    expect(rs.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(await tasksOf(s.projectId as string)).toHaveLength(1);
    expect((await links(s.id)).filter((l) => l.state === "open")).toHaveLength(1);
  });

  it("the claim of a provisioned row's real domain creates the task", async () => {
    setup();
    const projectId = await createProject(co, uniq("proj"), owner);
    const placeholder = await createWebdevSite(co, {
      domain: `${uniq("claim")}.provisioned.invalid`, origin: "provisioned", adoption: "mandated", environment: "staging", projectId,
      hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ssh",
    } as never, null);
    expect(await links(placeholder.id)).toHaveLength(0); // placeholder: no records yet
    const real = `${uniq("claimed")}.example.com`;
    await claimProvisionedSiteDomain(co, placeholder.id, real, admin);
    const l = await links(placeholder.id);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ state: "open", domain: real });
    expect((await task(l[0].task_id)).title).toContain(real);
  });

  describe("the assignee rule", () => {
    it("1. the project's owner", async () => {
      setup();
      const s = await site({ owner });
      const r = await syncSiteDnsTask(co, s.id, null);
      expect(r.assigneeSource).toBe("project_owner");
      expect((await task(r.taskId as string)).assignee).toMatchObject({ kind: "person", refId: owner });
    });

    it("2. no owner: the company's own lead seat on the project's department", async () => {
      setup();
      const s = await site({});
      const r = await syncSiteDnsTask(co, s.id, null);
      expect(r.assigneeSource).toBe("web_dev_head");
      expect((await task(r.taskId as string)).assignee).toMatchObject({ kind: "person", refId: head });
      expect((await links(s.id))[0].assignee_user_id).toBe(head);
    });

    it("an INACTIVE owner falls through to the head", async () => {
      setup();
      const gone = await createUser(`${uniq("gone")}@dnstask.test`);
      await adminPool().query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [gone]);
      const s = await site({ owner: gone });
      expect((await syncSiteDnsTask(co, s.id, null)).assigneeSource).toBe("web_dev_head");
    });

    it("a lead seat on ANOTHER unit makes no head; 3. neither owner nor head: unassigned, on the project board", async () => {
      setup();
      const s = await site({ dept: "d-other" });
      const r = await syncSiteDnsTask(co, s.id, null);
      expect(r.assigneeSource).toBe("unassigned");
      expect((await task(r.taskId as string)).assignee).toBeNull();
      expect((await links(s.id))[0]).toMatchObject({ assignee_source: "unassigned", assignee_user_id: null });
      const noDept = await site({ dept: null });
      expect((await syncSiteDnsTask(co, noDept.id, null)).assigneeSource).toBe("unassigned");
    });
  });

  it("a site with no project makes no task, and a host with no documented target makes none", async () => {
    setup();
    const lone = await site({ noProject: true });
    expect(await syncSiteDnsTask(co, lone.id, null)).toMatchObject({ outcome: "none", reason: "no_project" });
    expect(await links(lone.id)).toHaveLength(0);
    const unknown = await site({ owner, hostRef: "unlisted-host" });
    expect(await syncSiteDnsTask(co, unknown.id, null)).toMatchObject({ outcome: "none", reason: "not_ready" });
    expect(await tasksOf(unknown.projectId as string)).toHaveLength(0);
  });

  it("a sweep with EVERY record pointing closes the task, with the ERP's note", async () => {
    setup(POINTING);
    const s = await site({ owner });
    const { taskId } = await syncSiteDnsTask(co, s.id, null);
    const r = await sweepSiteDnsTasksForCompany(co);
    expect(r.closed).toBeGreaterThanOrEqual(1);
    expect(asked).toContain(s.domain);
    const t = await task(taskId as string);
    expect(t.status).toBe("done");
    expect(t.description).toContain("Closed by the ERP's DNS check");
    const l = (await links(s.id))[0];
    expect(l).toMatchObject({ state: "closed", closed_by: "erp_check", erp_saw_pointing: true });
    expect(l.closed_at).not.toBeNull();
  });

  it("PARTIAL pointing leaves the task open and records why", async () => {
    setup({ a: ["203.0.113.10", "198.51.100.9"], aaaa: [], cname: [] });
    const s = await site({ owner });
    const { taskId } = await syncSiteDnsTask(co, s.id, null);
    const r = await checkSiteDnsTask(co, s.id, null);
    expect(r.check).toMatchObject({ state: "pending", reason: "mixed_with_other_hosts" });
    expect(r.task).toMatchObject({ state: "open", lastCheckReason: "mixed_with_other_hosts", erpSawPointing: false });
    expect((await task(taskId as string)).status).not.toBe("done");
    // a resolver failure: still open
    answer = { a: [], aaaa: [], cname: [], error: "ETIMEOUT" };
    expect((await checkSiteDnsTask(co, s.id, null)).task).toMatchObject({ state: "open", lastCheckReason: "lookup_failed" });
    // and once it points, the same call closes it
    answer = POINTING;
    expect((await checkSiteDnsTask(co, s.id, null)).task).toMatchObject({ state: "closed", closedBy: "erp_check" });
  });

  it("closing BY HAND is recorded as manual, and says the ERP did not see the records point", async () => {
    setup(NOTHING);
    const s = await site({ owner });
    const { taskId } = await syncSiteDnsTask(co, s.id, null);
    await adminPool().query(`UPDATE pm_tasks SET status = 'done', progress = 100 WHERE id = $1`, [taskId]);
    const r = await checkSiteDnsTask(co, s.id, null);
    expect(r.task).toMatchObject({ state: "closed", closedBy: "manual", erpSawPointing: false, lastCheckReason: "no_records" });
    expect((await task(taskId as string)).description).toContain("did NOT see the records point");
  });

  it("closing by hand while the records DO point is manual, but records that the ERP saw them point", async () => {
    setup(POINTING);
    const s = await site({ owner });
    const { taskId } = await syncSiteDnsTask(co, s.id, null);
    await adminPool().query(`UPDATE pm_tasks SET status = 'done', progress = 100 WHERE id = $1`, [taskId]);
    expect((await checkSiteDnsTask(co, s.id, null)).task).toMatchObject({ state: "closed", closedBy: "manual", erpSawPointing: true });
  });

  it("a DOMAIN CHANGE replaces the task: the old one is closed as stale, a new one lists the new domain", async () => {
    setup();
    const s = await site({ owner });
    const first = await syncSiteDnsTask(co, s.id, null);
    const moved = `${uniq("moved")}.example.com`;
    await adminPool().query(`UPDATE webdev_sites SET domain = $2 WHERE id = $1`, [s.id, moved]);
    const r = await syncSiteDnsTask(co, s.id, null);
    expect(r.outcome).toBe("replaced");
    expect(r.taskId).not.toBe(first.taskId);
    const l = await links(s.id);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ state: "closed", closed_by: "domain_changed", domain: s.domain });
    expect(l[1]).toMatchObject({ state: "open", domain: moved });
    expect((await task(first.taskId as string)).status).toBe("done");
    expect((await task(first.taskId as string)).description).toContain("domain changed");
    expect((await task(r.taskId as string)).title).toContain(moved);
  });

  it("a SITE ARCHIVE closes the open task", async () => {
    setup();
    const s = await site({ owner });
    const { taskId } = await syncSiteDnsTask(co, s.id, null);
    await adminPool().query(`UPDATE webdev_sites SET deleted_at = now() WHERE id = $1`, [s.id]);
    const r = await checkSiteDnsTask(co, s.id, null);
    expect(r.task).toMatchObject({ state: "closed", closedBy: "site_archived" });
    expect((await task(taskId as string)).status).toBe("done");
    expect(asked).toEqual([]); // an archived row is never looked up
  });

  it("the link table is walled: zero rows without the webdev module scope, and never across tenants", async () => {
    setup();
    const s = await site({ owner });
    await syncSiteDnsTask(co, s.id, null);
    const noScope = await withTenants([co], (c) => c.query(`SELECT 1 FROM webdev_site_dns_tasks WHERE site_id = $1`, [s.id]));
    expect(noScope.rows).toHaveLength(0);
    const rival = await withTenants([other], (c) => c.query(`SELECT 1 FROM webdev_site_dns_tasks WHERE site_id = $1`, [s.id]), { modules: ["webdev"] });
    expect(rival.rows).toHaveLength(0);
    expect((await readSiteDnsTask(co, s.id)).state).toBe("open");
    expect((await readSiteDnsTask(other, s.id)).state).toBe("none");
  });

  describe.skipIf(!routeLive)("POST sites/:id/dns/recheck", () => {
    const recheck = (id: string, who: string, tenant = co) =>
      app!.inject({ method: "POST", url: `/api/${tenant}/modules/webdev/sites/${id}/dns/recheck`, headers: asUser(who) });

    it("gated by webdev_site update (member 403, malformed id and another company's row 404); an admin's re-check closes the task", async () => {
      setup(POINTING);
      const s = await site({ owner });
      const { taskId } = await syncSiteDnsTask(co, s.id, null);
      expect((await recheck(s.id, member)).statusCode).toBe(403);
      expect((await task(taskId as string)).status).not.toBe("done");
      expect((await recheck("not-a-uuid", admin)).statusCode).toBe(404);
      const foreign = await createWebdevSite(other, { domain: `${uniq("foreign")}.example.com` }, null);
      expect((await recheck(foreign.id, admin)).statusCode).toBe(404);
      const ok = await recheck(s.id, admin);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ check: { state: "pointing" }, task: { state: "closed", closedBy: "erp_check" } });
      expect((await task(taskId as string)).status).toBe("done");
      const read = await app!.inject({ method: "GET", url: `/api/${co}/modules/webdev/sites/${s.id}/dns/task`, headers: asUser(admin) });
      expect(read.json()).toMatchObject({ state: "closed", closedBy: "erp_check" });
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMyWorkQueue, fromKpiAlert, projectQueueForCompany, getPmHomeData, getPmCounters, isoDaysAgo, homeWindowLabel, humanizeToolName } from "./queue";
import type { Me } from "./platform";
import type { QueueItem } from "./queueUrgency";
import type { Envelope } from "./envelope";
import type { PmTask } from "./pm";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
});

function me(companies: { id: string; name: string }[], roles: Me["roles"]): Me {
  return { userId: "u1", name: "U", email: "u@x.com", title: null, assurance: "high", companies: companies.map((c) => ({ ...c, type: null })), roles };
}

describe("getMyWorkQueue — the shared R-1 spine", () => {
  it("merges approvals + automation approvals + gates + tasks + mentions across companies, ranked by urgency", async () => {
    const companies = [{ id: "co-a", name: "Agency" }, { id: "co-b", name: "Resort" }];
    const m = me(companies, [{ role: "manager", scopeType: "company", scopeId: "co-a" }]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/co-a/modules/agency/approvals/pending")) {
          return new Response(
            JSON.stringify([{ id: "ap-1", subject: "Hero asset", campaign: "Launch", campaignId: "camp-1", created_at: "2026-07-01T00:00:00Z" }]),
            { status: 200 },
          );
        }
        if (u.includes("/co-a/automation-approvals")) {
          return new Response(
            JSON.stringify([{
              id: "aa-1", workflow_id: "wf", tool_name: "reassign", tool_args: {}, impact: "medium",
              reason: "flagged", status: "pending", origin: "automation", agent_name: null,
              requested_by: "system", decided_by: null, decided_at: null, created_at: "2026-07-02T00:00:00Z",
            }]),
            { status: 200 },
          );
        }
        if (u.includes("/co-a/pipeline/gates")) {
          return new Response(
            JSON.stringify([{ id: "gt-1", run_id: "run-1", stage_id: null, kind: "pm_review", actor_side: "internal", status: "pending", decision: null, note: null, created_at: "2026-07-03T00:00:00Z" }]),
            { status: 200 },
          );
        }
        if (u.includes("/co-a/tasks?assignee=me")) {
          return new Response(
            JSON.stringify([{ id: "t-1", title: "Ship SEO audit", status: "todo", priority: "high", due_date: "2020-01-01", project_name: "SEO" }]),
            { status: 200 },
          );
        }
        if (u.includes("/co-a/notifications")) {
          return new Response(
            JSON.stringify([{ id: "n-1", type: "task.mention", payload: { title: "Landing copy", href: "/tasks/t-1" }, read_at: null, created_at: "2026-07-04T00:00:00Z" }]),
            { status: 200 },
          );
        }
        // co-b: one source 500s (an unexpected failure, not a 404/403 degrade);
        // the leg must still surface what it can from the rest (UX-2 §1.5).
        if (u.includes("/co-b/pipeline/gates")) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        return new Response(JSON.stringify({ error: "not enabled" }), { status: 404 });
      }),
    );

    const queue = await getMyWorkQueue(m, "u1", companies);

    // ⚠ These three ids gained a `:${companyId}` segment on 2026-08-26, DELIBERATELY. `agency`,
    // `automation` and `pipeline` were the only builders not namespaced by company, and since
    // `getMyWorkQueue` fans out per company, any repeated origin id collided as a React key and
    // dropped a row. The other three were already namespaced; all six now match.
    expect(queue.items.map((i) => i.id).sort()).toEqual(
      ["agency:co-a:ap-1", "automation:co-a:aa-1", "pipeline:co-a:gt-1", "task:co-a:t-1", "mention:co-a:n-1"].sort(),
    );
    // ranked, urgency descending
    for (let i = 1; i < queue.items.length; i++) {
      expect(queue.items[i - 1].urgencyScore).toBeGreaterThanOrEqual(queue.items[i].urgencyScore);
    }
    const approval = queue.items.find((i) => i.id === "agency:co-a:ap-1")!;
    // IAM-02a-FIX-2: this used to assert `true` with the comment "manager grant on co-a ->
    // approvals.decide". That was the OLD, WRONG behaviour DR-1 (2026-08-10) corrected: `decidable`
    // is computed once per company (`can(me, "approvals.decide", c.id)`, queue.ts above) and applied
    // uniformly to every item origin in that leg, including this agency-origin one. Cerbos's
    // `resource_agency_approval.yaml` grants `approve` to `company_admin`/`module_approver` ONLY —
    // `manager` appears in neither — so a manager's agency-origin approval is correctly
    // non-decidable in the UI now, matching what the backend has always enforced (this manager
    // grant would 403 on `POST .../approve` if it tried). The fix is in rbac.ts (DR-1), not here;
    // this assertion is only catching up to it.
    expect(approval.decidable).toBe(false); // manager has NO approvals.decide grant (DR-1) — Cerbos denies agency_approval:approve to manager
    expect(approval.companyId).toBe("co-a");
    expect(approval.origin).toBe("agency");
    // one source 500ing on co-b never throws / never drops the leg entirely
    expect(queue.companies.find((c) => c.id === "co-b")?.included).toBe(true);
  });

  it("marks items non-decidable when the user has no approvals.decide grant for that company", async () => {
    const companies = [{ id: "co-c", name: "Other" }];
    const m = me(companies, [{ role: "member", scopeType: "company", scopeId: "co-c" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/co-c/modules/agency/approvals/pending")) {
          return new Response(JSON.stringify([{ id: "ap-2", subject: "X", campaign: "Y", created_at: "2026-07-01T00:00:00Z" }]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.items.find((i) => i.id === "agency:co-c:ap-2")?.decidable).toBe(false);
  });

  it("never throws when every source for a company fails outright", async () => {
    const companies = [{ id: "co-d", name: "Down" }];
    const m = me(companies, [{ role: "manager", scopeType: "company", scopeId: "co-d" }]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.items).toEqual([]);
  });
});

describe("getMyWorkQueue — every id is globally unique across companies", () => {
  it("does not collide when the SAME origin record id appears under two companies", async () => {
    // THE regression. `getMyWorkQueue` fans out per company, so an id built from the origin record
    // alone repeats across them — React then logs "Encountered two children with the same key" and
    // silently drops one row. MEASURED as `pipeline:gt-2-pmreview` colliding across the three demo
    // companies, which lost a pending gate from "Waiting on me". A dropped approval is a decision
    // nobody is told about, so this asserts uniqueness rather than merely counting rows.
    const companies = [{ id: "co-a", name: "Agency" }, { id: "co-b", name: "Resort" }];
    const m = me(companies, [
      { role: "manager", scopeType: "company", scopeId: "co-a" },
      { role: "manager", scopeType: "company", scopeId: "co-b" },
    ]);

    // Every source answers with the SAME record id for BOTH companies — the shape a shared fixture
    // or a tenant-blind endpoint produces, and the shape that used to break the keys.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (u.includes("/modules/agency/approvals/pending")) {
        return json([{ id: "ap-dup", subject: "Hero asset", campaign: null, campaignId: null, created_at: "2026-07-01T00:00:00Z" }]);
      }
      if (u.includes("/automation-approvals")) {
        return json([{
          id: "aa-dup", workflow_id: "wf", tool_name: "it.devices.disable", tool_args: {}, impact: "medium",
          reason: "flagged", status: "pending", origin: "automation", agent_name: null,
          requested_by: "system", decided_by: null, decided_at: null, created_at: "2026-07-02T00:00:00Z",
        }]);
      }
      if (u.includes("/pipeline/gates")) {
        return json([{ id: "gt-dup", run_id: "run-1", stage_id: null, kind: "pm_review", actor_side: "internal", status: "pending", decision: null, note: null, created_at: "2026-07-03T00:00:00Z" }]);
      }
      return json([]);
    }));

    const q = await getMyWorkQueue(m, "u-1", companies);
    const ids = q.items.map((i) => i.id);
    expect(new Set(ids).size, `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i).join(", ")}`).toBe(ids.length);

    // And both copies actually survive the merge — uniqueness must come from namespacing, never from
    // one of them being dropped.
    expect(ids.filter((i) => i.startsWith("pipeline:"))).toHaveLength(2);
    expect(ids).toContain("pipeline:co-a:gt-dup");
    expect(ids).toContain("pipeline:co-b:gt-dup");
    expect(ids).toContain("automation:co-a:aa-dup");
    expect(ids).toContain("agency:co-a:ap-dup");
  });
});

describe("projectQueueForCompany — rail projection ≡ filtered queue (WSUX-5 AC)", () => {
  const queue: Envelope<QueueItem> = {
    items: [
      { id: "1", type: "approval", companyId: "co-a", company: "A", title: "t1", createdAt: "2026-01-01", decidable: true, urgencyScore: 10 },
      { id: "2", type: "task", companyId: "co-a", company: "A", title: "t2", createdAt: "2026-01-01", decidable: true, urgencyScore: 5 },
      { id: "3", type: "approval", companyId: "co-b", company: "B", title: "t3", createdAt: "2026-01-01", decidable: true, urgencyScore: 9 },
      { id: "4", type: "gate", companyId: "co-a", company: "A", title: "t4", createdAt: "2026-01-01", decidable: true, urgencyScore: 8 },
    ],
    companies: [{ id: "co-a", name: "A", included: true }, { id: "co-b", name: "B", included: true }],
  };

  it("is exactly a manual filter of queue.items by companyId + type allowlist — no second implementation", () => {
    const projected = projectQueueForCompany(queue, "co-a", { types: ["approval", "gate"] });
    const manual = queue.items.filter((i) => i.companyId === "co-a" && (i.type === "approval" || i.type === "gate"));
    expect(projected).toEqual(manual);
    expect(projected.map((i) => i.id)).toEqual(["1", "4"]);
  });

  it("with no type filter, equals every item for that company", () => {
    const projected = projectQueueForCompany(queue, "co-a");
    const manual = queue.items.filter((i) => i.companyId === "co-a");
    expect(projected).toEqual(manual);
  });
});

// ---- P4-A8 (@all Home) / P4-A9 (top-bar counters) ----

function pmTask(overrides: Partial<PmTask> & { id: string }): PmTask {
  return {
    projectId: "p1",
    projectName: "Website Relaunch",
    title: "Untitled",
    description: "",
    status: "todo",
    priority: "normal",
    progress: 0,
    assignee: null,
    subtasks: [],
    milestoneId: null,
    startDate: null,
    dueDate: null,
    estimateMinutes: null,
    loggedMinutes: 0,
    dependsOn: [],
    tags: [],
    customFields: {},
    updatedAt: null,
    recurrence: null,
    projectShortCode: null,
    seq: null,
    displayCode: null,
    ...overrides,
  };
}

describe("isoDaysAgo / homeWindowLabel — pure calendar arithmetic, no Date.now()", () => {
  it("subtracts calendar days at UTC midnight", () => {
    expect(isoDaysAgo("2026-08-07", 7).slice(0, 10)).toBe("2026-07-31");
  });
  it("formats an explicit M/D – M/D window", () => {
    expect(homeWindowLabel("2026-08-07")).toBe("7/31 – 8/7");
  });
});

describe("getPmHomeData — P4-A8", () => {
  const today = "2026-08-07";

  function stubFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/co-a/pm/tasks") && !u.includes("assignee")) {
          return new Response(
            JSON.stringify([
              pmTask({ id: "t1", status: "todo", dueDate: today }), // due today -> Today's Todo
              pmTask({ id: "t2", status: "done", updatedAt: "2026-08-05T00:00:00Z" }), // done 2d ago -> Completed
              pmTask({ id: "t3", status: "in_progress", dueDate: "2026-08-10" }), // due in 3d -> Upcoming
              pmTask({
                id: "t4",
                status: "todo",
                assignee: { kind: "person", refId: "u1", refName: "Gede", responsibleId: "u1", responsibleName: "Gede" },
              }), // undated, but commented this week -> Tasks with Activity
            ]),
            { status: 200 },
          );
        }
        if (u.includes("/pm/projects/p1/statuses")) return new Response(JSON.stringify([]), { status: 200 });
        if (u.includes("/work-activity")) {
          return new Response(
            JSON.stringify([
              { id: "wa1", tenantId: "co-a", source: "pm", sourceRef: "r1", actorUserId: "u2", actorExternal: null,
                verb: "commented", objectKind: "pm_task", objectRef: "t4", title: null,
                payload: { commentId: "c1" }, occurredAt: "2026-08-06T10:00:00Z", originSite: "site", createdAt: "2026-08-06T10:00:00Z",
                links: [] },
            ]),
            { status: 200 },
          );
        }
        if (u.includes("/comments?entityType=task&entityId=t4")) {
          return new Response(
            JSON.stringify([{ id: "c1", author_id: "u2", author_name: "Alice", body: "Looks good, ship it", parent_comment_id: null, created_at: "2026-08-06T10:00:00Z" }]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
  }

  it("buckets tasks into the 4 columns and attaches a comment excerpt on the activity column", async () => {
    stubFetch();
    const home = await getPmHomeData("u1", "co-a", today);

    expect(home.today).toBe(today);
    expect(home.windowLabel).toBe("7/31 – 8/7");
    expect(home.todaysTodo.map((t) => t.id)).toEqual(["t1"]);
    expect(home.completedTasks.map((t) => t.id)).toEqual(["t2"]);

    const upcomingIds = home.upcomingSchedule.flatMap((g) => g.tasks.map((t) => t.id));
    expect(upcomingIds).toEqual(["t3"]);

    const activityTasks = home.tasksWithActivity.flatMap((g) => g.tasks);
    expect(activityTasks.map((t) => t.id)).toEqual(["t4"]);
    expect(activityTasks[0].commentExcerpt).toBe("Looks good, ship it");
    expect(activityTasks[0].commentAuthor).toBe("Alice");
    expect(activityTasks[0].assigneeName).toBe("Gede");
  });

  it("never throws when work-activity 404s (stale backend) — the other 3 columns still render", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/co-a/pm/tasks") && !u.includes("assignee")) {
          return new Response(JSON.stringify([pmTask({ id: "t1", status: "todo", dueDate: today })]), { status: 200 });
        }
        if (u.includes("/pm/projects/p1/statuses")) return new Response(JSON.stringify([]), { status: 200 });
        if (u.includes("/work-activity")) return new Response(JSON.stringify({ error: "not enabled" }), { status: 404 });
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const home = await getPmHomeData("u1", "co-a", today);
    expect(home.todaysTodo.map((t) => t.id)).toEqual(["t1"]);
    expect(home.tasksWithActivity).toEqual([]);
  });
});

describe("getPmCounters — P4-A9", () => {
  const today = "2026-08-07";

  it("counts ball / responsible / overdue off ONE assignee=me read; reactions is null (no BFF read exists)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/co-a/pm/tasks?assignee=me")) {
          return new Response(
            JSON.stringify([
              pmTask({ id: "a", status: "todo", assignee: { kind: "person", refId: "u1", refName: "Me", responsibleId: "u1", responsibleName: "Me" } }), // ball + responsible
              pmTask({ id: "b", status: "todo", assignee: { kind: "person", refId: "u9", refName: "Other", responsibleId: "u1", responsibleName: "Me" } }), // responsible only
              pmTask({ id: "c", status: "todo", dueDate: "2020-01-01", assignee: { kind: "person", refId: "u1", refName: "Me", responsibleId: "u9", responsibleName: "Other" } }), // ball + overdue
              pmTask({ id: "d", status: "done", dueDate: "2020-01-01", assignee: { kind: "person", refId: "u1", refName: "Me", responsibleId: "u1", responsibleName: "Me" } }), // done -> never overdue
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const counters = await getPmCounters("u1", "co-a", "u1", today);
    expect(counters).toEqual({ ball: 3, responsible: 3, reactions: null, overdue: 1 });
  });

  it("degrades to zeros (not a throw) when the mine-scoped read is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not enabled" }), { status: 404 })));
    const counters = await getPmCounters("u1", "co-a", "u1", today);
    expect(counters).toEqual({ ball: 0, responsible: 0, reactions: null, overdue: 0 });
  });
});

describe("humanizeToolName", () => {
  it("reads a dotted tool id as verb + object, dropping the domain", () => {
    // These were being printed as the approval's TITLE, so the queue asked people to decide on
    // things named like permission keys ("it.devices.disable").
    expect(humanizeToolName("it.devices.disable")).toBe("Disable devices");
    expect(humanizeToolName("pm.tasks.bulkUpdate")).toBe("Bulk update tasks");
    expect(humanizeToolName("hr.payroll.export_csv")).toBe("Export csv payroll");
  });

  it("handles a bare or two-part id without inventing an object", () => {
    expect(humanizeToolName("deploy")).toBe("Deploy");
    expect(humanizeToolName("devices.disable")).toBe("Disable devices");
  });

  it("returns an unparseable id untouched rather than mangling it", () => {
    // A name we cannot read is still better than a confident wrong sentence.
    expect(humanizeToolName("")).toBe("");
    expect(humanizeToolName("...")).toBe("...");
  });
});

describe("getMyWorkQueue: client conversations waiting for my reply (DW-5g)", () => {
  const companies = [{ id: "co-a", name: "Agency" }];
  const m = me(companies, [{ role: "manager", scopeType: "company", scopeId: "co-a" }]);
  const thread = {
    id: "th-1", clientId: "cl-1", clientName: "Acme", projectId: null, projectName: null, general: true, subject: null,
    status: "open", createdSide: "client", lastMessageAt: "2026-07-05T10:00:00Z", createdAt: "2026-07-05T09:00:00Z",
    unreadCount: 1, awaitingReply: true, pendingDrafts: 0,
  };

  it("asks for open, awaiting, mine threads and maps each to a conversation item that links to the thread", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/co-a/conversation")) { seen.push(u); return new Response(JSON.stringify({ threads: [thread] }), { status: 200 }); }
      // The KPI alerts source (DW-4j-2) answers its own shape: an empty list is `{alerts: []}`, and an array would be read as a failed read.
      if (u.includes("/co-a/dept-kpis/alerts")) return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
      // The pipeline's leg (SCP-1j) answers its own shape too: an empty one is `{items: [], partial: []}`, and an array would be read as a failed read.
      if (u.includes("/co-a/modules/social/needs-you")) return new Response(JSON.stringify({ items: [], partial: [] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(seen).toHaveLength(1);
    const qs = new URL(seen[0]).searchParams;
    expect(qs.get("awaitingReply")).toBe("true");
    expect(qs.get("mine")).toBe("true");
    expect(qs.get("status")).toBe("open");
    const item = queue.items.find((i) => i.id === "conversation:co-a:th-1")!;
    expect(item).toMatchObject({
      type: "conversation", title: "A client is waiting for your reply", meta: "Acme · General conversation",
      href: "/clients/cl-1/work/conversation/th-1", createdAt: "2026-07-05T10:00:00Z", companyId: "co-a",
    });
    expect(queue.companies[0].partialSources).toBeUndefined();
  });

  it("a failed conversation read is named in partialSources, never a silent empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/co-a/conversation")) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      if (String(url).includes("/co-a/dept-kpis/alerts")) return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.items.some((i) => i.type === "conversation")).toBe(false);
    const leg = queue.companies[0];
    expect(leg.included).toBe(true);
    expect(leg.partialSources).toContain("conversations");
  });
});

describe("getMyWorkQueue: department KPI alerts waiting for their head (DW-4j-2)", () => {
  const companies = [{ id: "co-a", name: "Agency" }];
  const m = me(companies, [{ role: "manager", scopeType: "company", scopeId: "co-a" }]);
  const alert = {
    id: "al-1", unit: { id: "dept-1", name: "Web Dev" }, kpiKey: "projects-on-time", kpiLabel: "Projects on time", kpiUnit: "percent",
    periodStart: "2026-10-01", openedAt: "2026-10-03T06:30:00.000Z", value: 0.72, target: 0.9,
    acknowledgedBy: null, acknowledgedByName: null, acknowledgedAt: null, ackNote: null, resolvedAt: null, resolvedCondition: null,
  };
  const stub = (alertsRes: () => Response) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/co-a/dept-kpis/alerts")) return alertsRes();
      if (String(url).includes("/co-a/modules/social/needs-you")) return new Response(JSON.stringify({ items: [], partial: [] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }));

  it("maps an alert to a decidable item: namespaced id, a title naming the KPI and the department, the value against the target, the unit's KPI page", () => {
    expect(fromKpiAlert(alert as never, companies[0])).toEqual({
      id: "alert:co-a:al-1", type: "alert", originId: "al-1", title: "Projects on time is off track · Web Dev", meta: "72% against 90%",
      companyId: "co-a", company: "Agency", href: "/appraisals/department?unit=dept-1", createdAt: "2026-10-03T06:30:00.000Z",
      decidable: true, urgencyScore: 0,
    });
    // a unit id is encoded into the href, and a KPI the workspace dropped has no reading (no scale to word it in)
    const odd = fromKpiAlert({ ...alert, unit: { id: "d 1/x", name: "Odd" }, kpiUnit: null } as never, companies[0]);
    expect(odd.href).toBe("/appraisals/department?unit=d%201%2Fx");
    expect(odd.meta).toBeUndefined();
  });

  it("adds the caller's alerts to the queue, ranked in the approval tier above an overdue task", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/co-a/dept-kpis/alerts")) return new Response(JSON.stringify({ alerts: [alert] }), { status: 200 });
      if (u.includes("/co-a/modules/social/needs-you")) return new Response(JSON.stringify({ items: [], partial: [] }), { status: 200 });
      if (u.includes("/co-a/tasks?assignee=me")) {
        return new Response(JSON.stringify([{ id: "t-1", title: "Ship SEO audit", status: "todo", priority: "high", due_date: "2020-01-01", project_name: "SEO" }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.items.map((i) => i.id)).toEqual(["alert:co-a:al-1", "task:co-a:t-1"]);
    expect(queue.items[0].urgencyScore).toBeGreaterThanOrEqual(30_000);
    expect(queue.companies[0].partialSources).toBeUndefined();
  });

  it("asks the unscoped alerts path (the caller's own), once per company", async () => {
    stub(() => new Response(JSON.stringify({ alerts: [] }), { status: 200 }));
    await getMyWorkQueue(m, "u1", companies);
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/dept-kpis/alerts"));
    expect(urls).toEqual(["http://p.test/api/co-a/dept-kpis/alerts"]);
  });

  it("a failed alerts read is named in partialSources, never a silent empty", async () => {
    stub(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.items.some((i) => i.type === "alert")).toBe(false);
    expect(queue.companies[0].included).toBe(true);
    expect(queue.companies[0].partialSources).toContain("KPI alerts");
  });

  it("an answer of the wrong shape is a failed read too", async () => {
    stub(() => new Response(JSON.stringify({ alerts: [{ id: "x" }] }), { status: 200 }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.companies[0].partialSources).toContain("KPI alerts");
  });

  it("a refusal or a company without the reports module is not a lost source: there are no alerts for this person there", async () => {
    stub(() => new Response(JSON.stringify({ error: "not authorized" }), { status: 403 }));
    expect((await getMyWorkQueue(m, "u1", companies)).companies[0].partialSources).toBeUndefined();
    stub(() => new Response(JSON.stringify({ error: "Not Found" }), { status: 404 }));
    expect((await getMyWorkQueue(m, "u1", companies)).companies[0].partialSources).toBeUndefined();
  });

  it("does not collide when the same alert id appears under two companies", async () => {
    const two = [{ id: "co-a", name: "Agency" }, { id: "co-b", name: "Resort" }];
    const mm = me(two, [{ role: "manager", scopeType: "company", scopeId: "co-a" }]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/dept-kpis/alerts")
        ? new Response(JSON.stringify({ alerts: [alert] }), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })));
    const ids = (await getMyWorkQueue(mm, "u1", two)).items.map((i) => i.id).sort();
    expect(ids).toEqual(["alert:co-a:al-1", "alert:co-b:al-1"]);
  });
});

describe("getMyWorkQueue: the Social pipeline's leg (SCP-1j, BFF §63.7)", () => {
  const companies = [{ id: "co-a", name: "Agency" }];
  const m = me(companies, [{ role: "member", scopeType: "company", scopeId: "co-a" }]);
  const item = (kind: string, post: string, over: Record<string, unknown> = {}) => ({
    id: `social:co-a:${post}:${kind}`, kind, role: "officer", title: `Post ${post}`, clientName: "Mock Bakery", since: "2026-10-20T08:00:00.000Z",
    href: `/departments/d-soc/posts/${post}`, ...over,
  });
  const stub = (res: () => Response) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/co-a/modules/social/needs-you")) return res();
      if (u.includes("/co-a/dept-kpis/alerts")) return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }));

  it("asks the company's own needs-you route once and maps each row to a work item that links to the post", async () => {
    stub(() => new Response(JSON.stringify({
      items: [item("draft_to_send", "p-1", { due: "2026-10-15" }), item("proofread", "p-2", { role: "copywriter" })], partial: [],
    }), { status: 200 }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/needs-you"));
    expect(urls).toEqual(["http://p.test/api/co-a/modules/social/needs-you"]);
    expect(queue.items.find((i) => i.id === "social:co-a:p-1:draft_to_send")).toMatchObject({
      type: "task", title: "Post p-1", meta: "Mock Bakery · A draft to send", href: "/departments/d-soc/posts/p-1", dueDate: "2026-10-15",
      createdAt: "2026-10-20T08:00:00.000Z", companyId: "co-a", company: "Agency", decidable: true,
    });
    expect(queue.items.find((i) => i.id === "social:co-a:p-2:proofread")).toMatchObject({ meta: "Mock Bakery · To proofread", dueDate: null });
    expect(queue.companies[0].partialSources).toBeUndefined();
  });

  it("a post past its ready-by ranks as an overdue task does, above one with no date", async () => {
    stub(() => new Response(JSON.stringify({ items: [item("proofread", "p-new"), item("draft_to_send", "p-late", { due: "2020-01-01" })], partial: [] }), { status: 200 }));
    const ids = (await getMyWorkQueue(m, "u1", companies)).items.map((i) => i.id);
    expect(ids.indexOf("social:co-a:p-late:draft_to_send")).toBeLessThan(ids.indexOf("social:co-a:p-new:proofread"));
  });

  it("a failed read is named in partialSources, never a silent empty", async () => {
    stub(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.items.some((i) => i.id.startsWith("social:"))).toBe(false);
    expect(queue.companies[0].included).toBe(true);
    expect(queue.companies[0].partialSources).toContain("Social pipeline");
  });

  it("an answer of the wrong shape is a failed read too", async () => {
    stub(() => new Response(JSON.stringify([]), { status: 200 }));
    expect((await getMyWorkQueue(m, "u1", companies)).companies[0].partialSources).toContain("Social pipeline");
  });

  it("a source the server could not read is named beside the rows it did read", async () => {
    stub(() => new Response(JSON.stringify({ items: [item("proofread", "p-3")], partial: ["post metrics"] }), { status: 200 }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.items.some((i) => i.id === "social:co-a:p-3:proofread")).toBe(true);
    expect(queue.companies[0].partialSources).toEqual(["Social post metrics"]);
  });

  it("a refusal or a company without the Social Media module is not a lost source: there is no pipeline leg for this person there", async () => {
    stub(() => new Response(JSON.stringify({ error: "not authorized" }), { status: 403 }));
    expect((await getMyWorkQueue(m, "u1", companies)).companies[0].partialSources).toBeUndefined();
    stub(() => new Response(JSON.stringify({ error: "Not Found" }), { status: 404 }));
    expect((await getMyWorkQueue(m, "u1", companies)).companies[0].partialSources).toBeUndefined();
  });

  it("does not collide when the same post id appears under two companies", async () => {
    const two = [{ id: "co-a", name: "Agency" }, { id: "co-b", name: "Resort" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      const t = u.includes("/co-b/") ? "co-b" : "co-a";
      if (u.includes("/modules/social/needs-you")) return new Response(JSON.stringify({ items: [item("proofread", "p-9", { id: `social:${t}:p-9:proofread` })], partial: [] }), { status: 200 });
      if (u.includes("/dept-kpis/alerts")) return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }));
    const ids = (await getMyWorkQueue(me(two, []), "u1", two)).items.map((i) => i.id).sort();
    expect(ids).toEqual(["social:co-a:p-9:proofread", "social:co-b:p-9:proofread"]);
  });
});

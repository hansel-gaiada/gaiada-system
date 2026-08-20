import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMyWorkQueue, projectQueueForCompany, getPmHomeData, getPmCounters, isoDaysAgo, homeWindowLabel, humanizeToolName } from "./queue";
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

    expect(queue.items.map((i) => i.id).sort()).toEqual(
      ["agency:ap-1", "automation:aa-1", "pipeline:gt-1", "task:co-a:t-1", "mention:co-a:n-1"].sort(),
    );
    // ranked, urgency descending
    for (let i = 1; i < queue.items.length; i++) {
      expect(queue.items[i - 1].urgencyScore).toBeGreaterThanOrEqual(queue.items[i].urgencyScore);
    }
    const approval = queue.items.find((i) => i.id === "agency:ap-1")!;
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
    expect(queue.items.find((i) => i.id === "agency:ap-2")?.decidable).toBe(false);
  });

  it("never throws when every source for a company fails outright", async () => {
    const companies = [{ id: "co-d", name: "Down" }];
    const m = me(companies, [{ role: "manager", scopeType: "company", scopeId: "co-d" }]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const queue = await getMyWorkQueue(m, "u1", companies);
    expect(queue.items).toEqual([]);
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

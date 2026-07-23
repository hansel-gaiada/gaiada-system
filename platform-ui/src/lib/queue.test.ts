import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMyWorkQueue, projectQueueForCompany } from "./queue";
import type { Me } from "./platform";
import type { QueueItem } from "./queueUrgency";
import type { Envelope } from "./envelope";

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
    expect(approval.decidable).toBe(true); // manager grant on co-a -> approvals.decide
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

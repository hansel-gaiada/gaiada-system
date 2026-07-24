import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatUptime,
  hasActiveGoal,
  agentOptions,
  triggerAgentGoal,
  getBotChats,
  getBotChatMessages,
  getBotSessionEvents,
  getBotActionAudit,
  type SystemStatus,
} from "./admin";
import type { Me } from "./platform";

function meWith(role: string, scopeType: "global" | "company" = "global"): Me {
  return {
    userId: "u1",
    name: "Test User",
    email: "u1@example.com",
    title: null,
    assurance: "basic",
    companies: [],
    roles: [{ role, scopeType, scopeId: scopeType === "company" ? "t1" : null }],
  };
}

describe("formatUptime", () => {
  it("0 seconds -> 0m", () => {
    expect(formatUptime(0)).toBe("0m");
  });

  it("61 seconds -> 1m", () => {
    expect(formatUptime(61)).toBe("1m");
  });

  it("3661 seconds -> 1h 1m", () => {
    expect(formatUptime(3661)).toBe("1h 1m");
  });

  it("90061 seconds -> 1d 1h 1m", () => {
    expect(formatUptime(90061)).toBe("1d 1h 1m");
  });
});

describe("hasActiveGoal", () => {
  it("true when any goal is queued or running", () => {
    expect(hasActiveGoal([{ status: "ok" }, { status: "queued" }])).toBe(true);
    expect(hasActiveGoal([{ status: "running" }])).toBe(true);
  });

  it("false for terminal statuses (and an empty list)", () => {
    expect(hasActiveGoal([])).toBe(false);
    expect(hasActiveGoal([{ status: "ok" }, { status: "failed" }, { status: "cancelled" }])).toBe(false);
  });
});

describe("agentOptions", () => {
  it("returns just supervisor when status is null or has no detail.agents", () => {
    expect(agentOptions(null)).toEqual(["supervisor"]);
    expect(agentOptions({ ok: true })).toEqual(["supervisor"]);
    expect(agentOptions({ ok: true, detail: {} })).toEqual(["supervisor"]);
  });

  it("ignores a non-array or non-string detail.agents", () => {
    expect(agentOptions({ ok: true, detail: { agents: "not-an-array" } } as unknown as SystemStatus)).toEqual([
      "supervisor",
    ]);
    expect(agentOptions({ ok: true, detail: { agents: [1, null, "status-reporter"] } } as unknown as SystemStatus)).toEqual([
      "supervisor",
      "status-reporter",
    ]);
  });

  it("supervisor always leads and is never duplicated", () => {
    expect(agentOptions({ ok: true, detail: { agents: ["status-reporter", "approvals-chaser"] } })).toEqual([
      "supervisor",
      "status-reporter",
      "approvals-chaser",
    ]);
    expect(agentOptions({ ok: true, detail: { agents: ["supervisor", "status-reporter"] } })).toEqual([
      "supervisor",
      "status-reporter",
    ]);
  });
});

describe("triggerAgentGoal", () => {
  beforeEach(() => {
    process.env.PLATFORM_URL = "http://p.test";
    process.env.PLATFORM_SERVICE_TOKEN = "t";
  });

  it("refuses a non-elevated caller without ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await triggerAgentGoal("u1", "t1", meWith("member"), { goal: "do something" });
    expect(result).toEqual({ ok: false, error: "You don't have permission to trigger agents." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a company-scoped company_admin — isElevated requires a GLOBAL grant", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await triggerAgentGoal("u1", "t1", meWith("company_admin", "company"), { goal: "do something" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty/whitespace-only goal before hitting the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await triggerAgentGoal("u1", "t1", meWith("platform_admin"), { goal: "   " });
    expect(result).toEqual({ ok: false, error: "Enter a goal." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to /api/:t/agents/goals and returns the id on success (elevated, agent omitted when absent)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("http://p.test/api/t1/agents/goals");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ goal: "check the pipeline" });
      return new Response(JSON.stringify({ id: "g1" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await triggerAgentGoal("u1", "t1", meWith("group_executive"), { goal: "check the pipeline" });
    expect(result).toEqual({ ok: true, id: "g1" });
  });

  it("forwards a specific agent when given", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ goal: "chase approvals", agent: "approvals-chaser" });
      return new Response(JSON.stringify({ id: "g2" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await triggerAgentGoal("u1", "t1", meWith("platform_admin"), {
      goal: "chase approvals",
      agent: "approvals-chaser",
    });
    expect(result).toEqual({ ok: true, id: "g2" });
  });

  it("maps a 404/503 (runner unconfigured/unreachable) to a friendly degrade message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 503 })));
    const result = await triggerAgentGoal("u1", "t1", meWith("platform_admin"), { goal: "x" });
    expect(result).toEqual({ ok: false, error: "Agent triggering isn't available yet — the runner isn't connected." });
  });

  it("passes through any other PlatformError message (e.g. 400 unknown agent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unknown agent: bogus" }), { status: 400 })),
    );
    const result = await triggerAgentGoal("u1", "t1", meWith("platform_admin"), { goal: "x", agent: "bogus" });
    expect(result).toEqual({ ok: false, error: "unknown agent: bogus" });
  });
});

describe("bot chats/logs readers", () => {
  beforeEach(() => {
    process.env.PLATFORM_URL = "http://p.test";
    process.env.PLATFORM_SERVICE_TOKEN = "t";
  });

  describe("getBotChats", () => {
    it("hits the frozen /chats?limit=100 path and returns the snapshot", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        expect(String(url)).toBe("http://p.test/api/admin/bot/chats?limit=100");
        return new Response(
          JSON.stringify({
            chats: [
              { chatId: "1@g.us", kind: "group", surface: "whatsapp", name: "Ops", messageCount: 3, lastActivityTs: 1, lastPreview: "hi" },
            ],
          }),
          { status: 200 },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = await getBotChats("u1");
      expect(result?.chats).toHaveLength(1);
      expect(result?.chats[0].chatId).toBe("1@g.us");
    });

    it("degrades to null on 404 (admin API not connected)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
      expect(await getBotChats("u1")).toBeNull();
    });

    it("degrades to null on 403 (not elevated)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })));
      expect(await getBotChats("u1")).toBeNull();
    });

    it("rethrows any other error (e.g. 500)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
      await expect(getBotChats("u1")).rejects.toThrow("boom");
    });
  });

  describe("getBotChatMessages", () => {
    it("URL-encodes a WhatsApp JID chatId (contains '@') in the outbound path", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        expect(String(url)).toBe(
          "http://p.test/api/admin/bot/chats/1234567890%40g.us/messages?limit=100",
        );
        return new Response(JSON.stringify({ chatId: "1234567890@g.us", messages: [] }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = await getBotChatMessages("u1", "1234567890@g.us");
      expect(result?.chatId).toBe("1234567890@g.us");
    });

    it("URL-encodes a Telegram chatId (contains ':') in the outbound path", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        expect(String(url)).toBe("http://p.test/api/admin/bot/chats/tg%3A12345/messages?limit=100");
        return new Response(JSON.stringify({ chatId: "tg:12345", messages: [] }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await getBotChatMessages("u1", "tg:12345");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("degrades to null when the chat isn't found", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
      expect(await getBotChatMessages("u1", "1@g.us")).toBeNull();
    });
  });

  describe("getBotSessionEvents", () => {
    it("returns the events array on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ events: [{ status: "WORKING", ts: 1 }] }), { status: 200 })),
      );
      const result = await getBotSessionEvents("u1");
      expect(result.events).toEqual([{ status: "WORKING", ts: 1 }]);
    });

    it("degrades to an empty events array when unavailable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 404 })));
      expect(await getBotSessionEvents("u1")).toEqual({ events: [] });
    });
  });

  describe("getBotActionAudit", () => {
    it("returns enabled + entries on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ enabled: true, entries: [{ action: "restart", by: "u1" }] }), {
              status: 200,
            }),
        ),
      );
      const result = await getBotActionAudit("u1");
      expect(result).toEqual({ enabled: true, entries: [{ action: "restart", by: "u1" }] });
    });

    it("degrades to null when unavailable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 })));
      expect(await getBotActionAudit("u1")).toBeNull();
    });
  });
});

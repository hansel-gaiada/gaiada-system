// D14 action safety, proven at the runner level: allow-list, impact taxonomy,
// approval suspension, typed budget exhaustion (never a committed placeholder).
import { describe, it, expect } from "vitest";
import {
  runAgent,
  ToolNotAllowedError,
  ApprovalRequiredError,
  BudgetExhaustedError,
  ModelProtocolError,
  type AgentDef,
  type AgentDeps,
} from "./agent";

const envelope = { provider: "telegram", externalId: "tg:555" };

function scripted(responses: string[], onTool?: (name: string, args: Record<string, unknown>) => string): AgentDeps {
  let i = 0;
  return {
    complete: async () => responses[Math.min(i++, responses.length - 1)],
    callTool: async (name, args) => (onTool ? onTool(name, args) : "[]"),
  };
}

const def: AgentDef = {
  name: "test-agent",
  systemPrompt: "You are a test agent.",
  tools: { "projects.list": "read", "tasks.create": "high_write" },
  maxSteps: 5,
  maxToolCalls: 3,
};

describe("agent runner (WS8 step 1 + D14)", () => {
  it("gathers via allowed read tools and finishes with a grounded answer", async () => {
    const toolCalls: string[] = [];
    const deps = scripted(
      [
        `{"tool": "projects.list", "args": {"tenantId": "t1"}}`,
        `{"final": "1 active project: Rebrand"}`,
      ],
      (name) => {
        toolCalls.push(name);
        return JSON.stringify([{ name: "Rebrand", status: "active" }]);
      },
    );
    const run = await runAgent(def, "status?", envelope, deps);
    expect(run.outcome).toContain("Rebrand");
    expect(toolCalls).toEqual(["projects.list"]);
  });

  it("refuses tools outside the allow-list (typed, run stops)", async () => {
    const deps = scripted([`{"tool": "users.delete", "args": {}}`]);
    await expect(runAgent(def, "x", envelope, deps)).rejects.toThrow(ToolNotAllowedError);
  });

  it("high-impact writes suspend for human approval — nothing executes", async () => {
    let executed = false;
    const deps = scripted([`{"tool": "tasks.create", "args": {"title": "t"}}`], () => {
      executed = true;
      return "created";
    });
    await expect(runAgent(def, "x", envelope, deps)).rejects.toThrow(ApprovalRequiredError);
    expect(executed).toBe(false);
  });

  it("budget exhaustion raises a TYPED error carrying the transcript — no placeholder outcome", async () => {
    const deps = scripted([`{"tool": "projects.list", "args": {}}`]); // loops forever
    const err = await runAgent(def, "x", envelope, deps).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).steps.length).toBeGreaterThan(0);
  });

  it("tool failures are surfaced to the model, not swallowed as facts", async () => {
    const deps: AgentDeps = {
      complete: (() => {
        let i = 0;
        return async (prompt: string) => {
          if (i++ === 0) return `{"tool": "projects.list", "args": {}}`;
          expect(prompt).toContain("FAILED: denied");
          return `{"final": "I could not access project data."}`;
        };
      })(),
      callTool: async () => {
        throw new Error("denied");
      },
    };
    const run = await runAgent(def, "x", envelope, deps);
    expect(run.outcome).toContain("could not access");
  });

  it("malformed model output gets one nudge, then a typed protocol error", async () => {
    const deps = scripted(["sure! here's what I think...", "still not json"]);
    await expect(runAgent(def, "x", envelope, deps)).rejects.toThrow(ModelProtocolError);
  });
});

// AIP-14 — `fetchRoster` normalises each agent's `departments` (display metadata: the workspace keys an agent is shown in).
// Pure: the runner is a stub `fetch`, no DB, no Cerbos, so it always runs.
import { describe, it, expect } from "vitest";
import { fetchRoster } from "./handoffs";

const agent = (over: Record<string, unknown> = {}) => ({
  name: "a", tools: ["t.read"], maxSteps: 4, maxToolCalls: 2, writeCapable: false, evaledProviders: [], ...over,
});

function roster(agents: unknown[]) {
  const fetchImpl = (async () => new Response(JSON.stringify({ agents, supervisor: { name: "supervisor" } }), { status: 200 })) as typeof fetch;
  return fetchRoster({ fetchImpl, runnerUrl: "http://runner.test", runnerToken: "t" });
}

describe("fetchRoster departments (AIP-14)", () => {
  it("passes a list of workspace keys through", async () => {
    const r = await roster([agent({ departments: ["social-media", "creatives"] })]);
    expect(r.runnerConfigured).toBe(true);
    expect(r.agents[0].departments).toEqual(["social-media", "creatives"]);
  });

  it("an older runner with no `departments` field still yields a valid roster: []", async () => {
    const r = await roster([agent()]);
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0].departments).toEqual([]);
    expect(r.agents[0].name).toBe("a"); // the rest of the agent is untouched
  });

  it("anything that is not an array of strings reads as [] (non-array) or drops the non-string entries", async () => {
    const r = await roster([
      agent({ name: "s", departments: "seo" }),
      agent({ name: "n", departments: null }),
      agent({ name: "o", departments: { seo: true } }),
      agent({ name: "m", departments: ["seo", 7, null, "hr"] }),
    ]);
    expect(r.agents.map((a) => [a.name, a.departments])).toEqual([["s", []], ["n", []], ["o", []], ["m", ["seo", "hr"]]]);
  });
});

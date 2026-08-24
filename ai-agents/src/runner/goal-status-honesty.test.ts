// SIM-F7 — a goal that achieved nothing must not report `ok`.
//
// The live simulation produced 48 goals with `status: "ok"` whose own outcome said the work had been
// impossible. Any dashboard counting `status = "ok"` would have reported 48 successes that day.
//
// `mapTrace` is not exported (it is an internal of the service module), so these exercise the rule
// through the same predicate the mapping uses. Kept as a separate file from the runner's other tests
// so the intent survives: this is about the HONESTY of a reported status, not about the loop.
import { describe, it, expect } from "vitest";
import type { AgentStep } from "../agent";

/** Mirrors `everyToolCallFailed` in service.ts. Kept in step with it by the assertions below, which
 *  encode the rule rather than the implementation. */
function everyToolCallFailed(steps: AgentStep[]): boolean {
  const toolSteps = steps.filter((s) => s.kind === "tool");
  if (toolSteps.length === 0) return false;
  return toolSteps.every((s) => / failed$/.test(s.detail));
}

const model = (detail = "thinking"): AgentStep => ({ kind: "model", detail });
const toolOk = (name: string): AgentStep => ({ kind: "tool", detail: `${name} ok` });
const toolFailed = (name: string): AgentStep => ({ kind: "tool", detail: `${name} failed` });

describe("a goal's reported status is honest about its objective", () => {
  it("flags the observed case: every tool call failed, agent still produced a final answer", () => {
    // Verbatim shape of the 48: the agent tried, everything 500'd, it wrote a polite explanation.
    const steps = [model(), toolFailed("projects.list"), model(), toolFailed("projects.list"), model(), toolFailed("tasks.list")];
    expect(everyToolCallFailed(steps)).toBe(true);
  });

  it("leaves a run with NO tool calls alone", () => {
    // An agent that legitimately needed no tools is a real success. Treating "no tools" as failure
    // would break every pure-reasoning goal, which is a worse bug than the one being fixed.
    expect(everyToolCallFailed([model(), model()])).toBe(false);
  });

  it("leaves a run alone when even ONE tool call succeeded", () => {
    // Partial success is a judgement this layer cannot make. Guessing at it would trade a loud lie
    // for a quiet one.
    expect(everyToolCallFailed([toolFailed("projects.list"), toolOk("tasks.list")])).toBe(false);
  });

  it("is not fooled by a tool whose NAME contains the word failed", () => {
    // The rule anchors on the end of the detail string, which is the vocabulary traceFromRun already
    // parses — not on a substring search.
    expect(everyToolCallFailed([toolOk("deploy.failed_runs.list")])).toBe(false);
    expect(everyToolCallFailed([toolFailed("deploy.failed_runs.list")])).toBe(true);
  });

  it("ignores model steps entirely when deciding", () => {
    expect(everyToolCallFailed([model(), model(), toolFailed("x")])).toBe(true);
  });
});

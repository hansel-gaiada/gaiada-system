// SCP-1b — the UI mirror of the stage machine, run against the SAME fixture as the backend
// (`platform-nest/src/modules/social/scp-stage-machine.json`, BFF §63.3). Pure; runs anywhere.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "./scpStageMachine.json";
import {
  PROSE, SCP_STATUSES, scpActionsFromStatus, scpEngineStatusOf, scpHolderOf, scpPhaseOf, scpPrimaryActionOf, type ScpPostView,
} from "./scpStageMachine";

// Same trick as clientHealthRules.test.ts: route the path through a variable so Vite leaves it a real file:// read.
function readFileAt(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

interface Step { action: string; actor: string; params?: Record<string, unknown>; expect?: Record<string, unknown>; refusal?: string; expectedStatus?: string }
interface Scenario { name: string; start?: Record<string, unknown>; steps: Step[] }
const F = fixture as unknown as {
  scenarios: Scenario[];
  actions: Array<{ action: string; kind?: string }>;
  changeCases: Array<{ key: string }>;
  phaseOf: Record<string, string>;
  holders: Record<string, string | null>;
  primaryAction: Record<string, unknown>;
};

/** The scenarios of other machines, as the backend's machine.test.ts lists them. */
const OWNED_ELSEWHERE = new Set([
  "monthly boost budget: committed, lowering and the stopped boost's spend",
  "the monthly report: Draft, HoD check, Ready, Sent",
]);
const POST_ACTIONS = new Set(F.actions.map((a) => a.action));

describe("SCP stage machine · the twin", () => {
  it("scpStageMachine.json is byte-identical to the backend's scp-stage-machine.json", () => {
    const nestRaw = readFileAt("../../../platform-nest/src/modules/social/scp-stage-machine.json");
    const uiRaw = readFileAt("./scpStageMachine.json");
    expect(uiRaw).toBe(nestRaw);
  });

  it("the prose the mirror interprets is the fixture's, verbatim", () => {
    expect(F.phaseOf.changes).toBe(PROSE.phaseOfChanges);
    expect(F.holders.changes).toBe(PROSE.holderChanges);
    expect(F.holders.scheduled).toBe(PROSE.holderScheduled);
    expect(F.holders.blocked).toBe(PROSE.holderBlocked);
    expect(F.primaryAction.design).toBe(PROSE.primaryDesign);
  });
});

describe("SCP stage machine · the mappings", () => {
  const PHASE: Record<string, string> = {
    planned: "brief", drafting: "brief", blocked: "brief", proofread: "in_production", hod: "in_production", design: "in_production",
    final: "in_production", client: "with_client", approved: "client_approved", scheduled: "client_approved", live: "posted",
  };
  const CASE_PHASE: Record<string, string> = {
    copywriter_copy: "brief", hod_copy: "brief", final_copy: "in_production", final_design: "in_production", client_copy: "client_changes", client_design: "client_changes",
  };

  it("every status and change case has its phase", () => {
    for (const s of SCP_STATUSES) {
      if (s === "changes") continue;
      expect(scpPhaseOf({ pipelineStatus: s, blockWaitingOn: "client", scheduleVia: "manual" }), s).toBe(PHASE[s]);
    }
    for (const c of F.changeCases) expect(scpPhaseOf({ pipelineStatus: "changes", changeCase: c.key }), c.key).toBe(CASE_PHASE[c.key]);
  });

  it("holders, engine status and primary action read the prose as the backend does", () => {
    expect(scpHolderOf({ pipelineStatus: "scheduled", scheduleVia: "publisher" })).toBe("publisher");
    expect(scpHolderOf({ pipelineStatus: "scheduled", scheduleVia: "manual" })).toBe("officer");
    expect(scpHolderOf({ pipelineStatus: "blocked", blockWaitingOn: "external" })).toBe("external");
    expect(scpHolderOf({ pipelineStatus: "changes", changeCase: "client_design" })).toBe("designer");
    expect(scpHolderOf({ pipelineStatus: "live" })).toBeNull();
    expect(scpEngineStatusOf({ pipelineStatus: "client" })).toBe("in_review");
    expect(scpEngineStatusOf({ pipelineStatus: "scheduled" }, ["failed"])).toBe("failed");
    expect(scpEngineStatusOf({ pipelineStatus: "live" }, ["failed"])).toBe("partially_published");
    expect(scpEngineStatusOf({ pipelineStatus: "approved" }, [], true)).toBe("archived");
    expect(scpPrimaryActionOf({ pipelineStatus: "design", creativeState: "not_started" })).toBe("start_design");
    expect(scpPrimaryActionOf({ pipelineStatus: "design", creativeState: "revision" })).toBe("submit_design");
    expect(scpPrimaryActionOf({ pipelineStatus: "changes", changeCase: "hod_copy" })).toBe("resend");
    expect(scpActionsFromStatus({ pipelineStatus: "live" })).toEqual([]);
    expect(scpActionsFromStatus({ pipelineStatus: "planned" }).sort()).toEqual(["archive", "block", "discard", "edit", "start_draft"]);
  });
});

/** Walk one scenario at the status and phase level: each applied step must be an action the status offers, and the
 *  expected phase and engine status must be the mirror's. */
function walk(sc: Scenario): void {
  let post: ScpPostView | null = null;
  if (sc.start?.status !== undefined) {
    const status = String(sc.start.status);
    post = {
      pipelineStatus: status,
      changeCase: typeof sc.start.changeCase === "string" ? sc.start.changeCase : null,
      scheduleVia: status === "scheduled" ? "manual" : null,
      creativeState: typeof sc.start.creativeState === "string" ? sc.start.creativeState : status === "design" ? "not_started" : null,
    };
  }
  for (const [i, step] of sc.steps.entries()) {
    const label = `${sc.name} · step ${i + 1} ${step.action}`;
    const isCreate = F.actions.find((a) => a.action === step.action)?.kind === "create";
    if (step.refusal !== undefined) {
      if (step.refusal === "invalid_transition") expect(scpActionsFromStatus(post!), label).not.toContain(step.action);
      continue;
    }
    if (isCreate) {
      post = { pipelineStatus: "planned", changeCase: null };
    } else {
      expect(post, label).not.toBeNull();
      expect(scpActionsFromStatus(post!), label).toContain(step.action);
      const e = step.expect ?? {};
      const status = typeof e.status === "string" ? e.status : post!.pipelineStatus!;
      const keepsCase = status === "changes" || status === "blocked";
      const changeCase = typeof e.changeCase === "string" ? e.changeCase : keepsCase ? post!.changeCase ?? null : null;
      if (status === "changes" && !changeCase) throw new Error(`${label}: enters changes without a change case`);
      post = {
        pipelineStatus: status,
        changeCase,
        scheduleVia: e.scheduleVia !== undefined ? (e.scheduleVia as string | null) : status === "scheduled" || status === "live" ? post!.scheduleVia ?? "manual" : null,
        blockWaitingOn: status === "blocked" ? String(step.params?.waitingOn ?? "officer") : null,
        creativeState: typeof e.creativeState === "string" ? e.creativeState : post!.creativeState ?? null,
      };
    }
    const e = step.expect ?? {};
    if (typeof e.status === "string") expect(post!.pipelineStatus, label).toBe(e.status);
    if (typeof e.phase === "string") expect(scpPhaseOf(post!), label).toBe(e.phase);
    if (typeof e.engineStatus === "string") expect(scpEngineStatusOf(post!), label).toBe(e.engineStatus);
    // Every state the walk reaches has a holder answer and a primary action answer (neither throws).
    scpHolderOf(post!);
    scpPrimaryActionOf(post!);
  }
}

describe("SCP stage machine · the post scenarios at the status and phase level", () => {
  it("each scenario is the post machine's or named as owned elsewhere", () => {
    for (const sc of F.scenarios) {
      const isPost = sc.steps.every((s) => POST_ACTIONS.has(s.action));
      expect(isPost, sc.name).toBe(!OWNED_ELSEWHERE.has(sc.name));
    }
    expect(F.scenarios.filter((s) => OWNED_ELSEWHERE.has(s.name)).length).toBe(OWNED_ELSEWHERE.size);
  });

  const post = F.scenarios.filter((s) => !OWNED_ELSEWHERE.has(s.name));
  it("walks at least eighteen scenarios", () => expect(post.length).toBeGreaterThanOrEqual(18));
  it.each(post.map((sc) => [sc.name, sc] as const))("%s", (_n, sc) => walk(sc));
});

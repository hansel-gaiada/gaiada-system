// M5-G5c — run-level proof: a goal that calls `agency_privacy.*` with a real-looking email + phone leaves NEITHER
// in the run store (goal row, run rows, step events), the SSE bus, the episodic memory, the observability
// collector, the eval trace, the HTTP read surface, the logs captured during the run, or the transcript the
// model is shown on its next turn, in ANY of their forms. The LIVE call to the hub still carries the real values.
// No DB, no services: an in-memory GoalStore and scripted deps drive the real runner / orchestrator / agent.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildRunnerApp, type AgentRegistry } from "./runner/service";
import type {
  GoalStore, GoalInput, GoalRunContext, FinishGoalPatch, GoalListItem, GoalDetail, RunInput, RunRow, CancelResult,
  RunEventInput, RunEventRow,
} from "./runner/store";
import { subscribeTenant } from "./runner/events-bus";
import { EpisodicStore } from "./memory/episodic";
import { ObservabilityCollector } from "./obs/collector";
import { supervisor as realSupervisor } from "./specialists";
import { traceRun, traceLines } from "./evals/trace";
import { subjectHash, registerSensitiveToolPolicy, unregisterSensitiveToolPolicy } from "./sensitive-tools";
import type { AgentDef, AgentDeps } from "./agent";
import type { OrchestratorDef } from "./orchestrator";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const TOKEN = "runner-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const EMAIL = "Jane.Doe@Example.com";
const PHONE = "+62 812-3456-7890";
// Every form a leak could take. The hint keeps the domain and the last two digits on purpose (`***@example.com`,
// `***90`), so those are not in the list; the person-identifying parts are.
const FORMS = [
  EMAIL, EMAIL.toLowerCase(), EMAIL.toUpperCase(), "jane.doe", "Jane.Doe",
  PHONE, "6281234567890", "+6281234567890", "81234567890", "812-3456-7890", "812 3456 7890", "3456-7890", "3456 7890",
];
const EMAIL_HASH = subjectHash("jane.doe@example.com");
const PHONE_HASH = subjectHash("6281234567890");

function leaks(label: string, haystack: string): string[] {
  const lower = haystack.toLowerCase();
  return FORMS.filter((f) => lower.includes(f.toLowerCase())).map((f) => `${label}: ${f}`);
}

// ---- in-memory GoalStore ------------------------------------------------------------------------
interface Rec extends GoalInput {
  id: string; status: GoalListItem["status"]; outcome: string | null; errorKind: string | null; approvalId: string | null;
  modelCalls: number; toolCalls: number; fanOut: number; blackboard: GoalDetail["blackboard"]; seq: number;
  createdAt: string; startedAt: string | null; endedAt: string | null;
}
class MemGoalStore implements GoalStore {
  goals = new Map<string, Rec>();
  runs: RunInput[] = [];
  events: RunEventRow[] = [];
  private n = 0;
  async init(): Promise<void> {}
  async insertGoal(input: GoalInput): Promise<string> {
    const id = randomUUID();
    this.goals.set(id, {
      ...input, id, status: "queued", outcome: null, errorKind: null, approvalId: null, modelCalls: 0, toolCalls: 0, fanOut: 0,
      blackboard: null, seq: this.n++, createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
    });
    return id;
  }
  async claimForRun(id: string): Promise<GoalRunContext | null> {
    const g = this.goals.get(id);
    if (!g || g.status !== "queued") return null;
    g.status = "running";
    return { id: g.id, tenantId: g.tenantId, goal: g.goal, agent: g.agent, envelopeProvider: g.envelopeProvider, envelopeExternalId: g.envelopeExternalId, budget: g.budget };
  }
  async finishGoal(id: string, patch: FinishGoalPatch): Promise<void> {
    const g = this.goals.get(id);
    if (!g) return;
    g.status = patch.status;
    g.outcome = patch.outcome ?? null;
    g.errorKind = patch.errorKind ?? null;
    g.approvalId = patch.approvalId ?? null;
    g.blackboard = patch.blackboard ?? null;
    g.endedAt = new Date().toISOString();
    if (patch.goal !== undefined) g.goal = patch.goal; // M5-G5c: the same COALESCE(patch.goal, goal) the Pg store runs
  }
  async insertRun(run: RunInput): Promise<void> { this.runs.push(run); }
  private list(g: Rec): GoalListItem {
    return {
      id: g.id, tenantId: g.tenantId, goal: g.goal, agent: g.agent, status: g.status, outcome: g.outcome, errorKind: g.errorKind,
      approvalId: g.approvalId, modelCalls: g.modelCalls, toolCalls: g.toolCalls, fanOut: g.fanOut, budget: g.budget,
      createdAt: g.createdAt, startedAt: g.startedAt, endedAt: g.endedAt,
    };
  }
  async listGoals(tenantId: string, limit: number): Promise<GoalListItem[]> {
    return [...this.goals.values()].filter((g) => g.tenantId === tenantId).slice(0, limit).map((g) => this.list(g));
  }
  async getGoal(id: string, tenantId: string): Promise<GoalDetail | null> {
    const g = this.goals.get(id);
    if (!g || g.tenantId !== tenantId) return null;
    const runs = this.runs.filter((r) => r.goalId === id).map((r) => ({
      runId: r.runId, agent: r.agent, status: r.status, outcome: r.outcome, modelCalls: r.modelCalls, toolCalls: r.toolCalls,
      provider: r.provider, startedAt: r.startedAt, endedAt: r.endedAt, parentRunId: r.parentRunId ?? null,
    }));
    return { ...this.list(g), blackboard: g.blackboard, runs };
  }
  async getRun(runId: string, tenantId: string): Promise<RunRow | null> {
    const r = this.runs.find((x) => x.runId === runId && x.tenantId === tenantId);
    return r ? { ...r, parentRunId: r.parentRunId ?? null } : null;
  }
  async cancel(): Promise<CancelResult> { return "not_found"; }
  async sweepInterrupted(): Promise<number> { return 0; }
  async insertEvent(e: RunEventInput): Promise<RunEventRow> {
    const row: RunEventRow = { eventId: randomUUID(), ts: new Date().toISOString(), ...e, durationMs: e.durationMs ?? null, parentRunId: e.parentRunId ?? null };
    this.events.push(row);
    return row;
  }
  async listEvents(runId: string, tenantId: string, sinceSeq: number): Promise<RunEventRow[]> {
    return this.events.filter((e) => e.runId === runId && e.tenantId === tenantId && e.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }
}

// ---- scripted deps ------------------------------------------------------------------------------
interface Scripted extends AgentDeps {
  prompts: string[];
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}
function scripted(responses: string[], tools: Record<string, string | Error> = {}): Scripted {
  let i = 0;
  const prompts: string[] = [];
  const calls: Scripted["calls"] = [];
  return {
    prompts, calls,
    complete: async (p) => { prompts.push(p); return responses[Math.min(i++, responses.length - 1)]; },
    callTool: async (name, args) => {
      calls.push({ name, args });
      const r = tools[name] ?? "ok";
      if (r instanceof Error) throw r;
      return r;
    },
    lastProvider: () => undefined,
  };
}

const ERASE_ARGS = { tenantId: TENANT, email: EMAIL, phone: PHONE };
const erase = (args: Record<string, unknown> = ERASE_ARGS) => `Sure, running it now. {"tool":"agency_privacy.erase","args":${JSON.stringify(args)}}`;
// A route response that is adversarially chatty: the contact fields and free text a lazy handler might echo.
const ERASE_RESULT = JSON.stringify({
  kind: "erase", erasedAt: "2026-10-12T10:00:00.000Z", leadCount: 2, submissionCount: 1, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 2,
  debug: `erased ${EMAIL} / ${PHONE}`, contactEmail: EMAIL.toLowerCase(), contactName: "Jane Doe",
});
const FIND_RESULT = JSON.stringify({
  kind: "find", counts: { leadCount: 1, submissionCount: 0, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 0 },
  leads: [{ leadId: "11111111-1111-4111-8111-111111111111", status: "new", stage: "intake", contactEmail: EMAIL, contactName: "Jane Doe" }],
});

const clerk: AgentDef = { name: "privacy-clerk", systemPrompt: "privacy", tools: { "agency_privacy.erase": "low_write" }, maxSteps: 5, maxToolCalls: 3, evaledProviders: ["echo"] };
const gated: AgentDef = { name: "privacy-gated", systemPrompt: "privacy", tools: { "agency_privacy.erase": "high_write" }, maxSteps: 5, maxToolCalls: 3, evaledProviders: ["echo"] };
const reader: AgentDef = { name: "reader", systemPrompt: "read", tools: { "x.read": "read", "contacts.lookup": "read" }, maxSteps: 5, maxToolCalls: 5 };
const privacyReader: AgentDef = { name: "privacy-reader", systemPrompt: "Find a person's intake records. Use the tool.", tools: { "agency_privacy.find": "read" }, maxSteps: 5, maxToolCalls: 3 };
const privacySupervisor: OrchestratorDef = {
  name: "supervisor", systemPrompt: "coordinate", specialists: { "privacy-reader": privacyReader },
  maxPlannerSteps: 6, maxSubRuns: 3, goalBudget: { modelCalls: 20, toolCalls: 10 },
};

function registry(over: Partial<AgentRegistry> = {}): AgentRegistry {
  return {
    supervisor: realSupervisor,
    specialists: { reader },
    writeSpecialists: { "privacy-clerk": clerk, "privacy-gated": gated },
    ...over,
  };
}

// ---- the harness: everything the run could write to, captured --------------------------------------
let apps: FastifyInstance[] = [];
let logged: string[] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
const bus: RunEventRow[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
  }
  bus.length = 0;
  unsubscribe = subscribeTenant(TENANT, (row) => bus.push(row));
});
afterEach(async () => {
  unsubscribe();
  spies.splice(0).forEach((s) => s.mockRestore());
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

function build(deps: AgentDeps, reg: AgentRegistry = registry()) {
  const store = new MemGoalStore();
  const episodic = new EpisodicStore();
  const collector = new ObservabilityCollector();
  const app = buildRunnerApp({ store, agentDeps: deps, registry: reg, episodic, collector, config: { token: TOKEN, maxConcurrent: 1, maxQueue: 10 } });
  apps.push(app);
  return { app, store, episodic, collector };
}
async function runGoal(app: FastifyInstance, goal: string, agent: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/goals", headers: AUTH, payload: { tenantId: TENANT, envelope: { provider: "platform", externalId: "u1" }, goal, agent, ...extra } });
  expect(res.statusCode).toBe(202);
  const { id } = res.json() as { id: string };
  await (app as unknown as { goalQueue: { idle(): Promise<void> } }).goalQueue.idle();
  return id;
}
/** Every byte a reader of the runner could get: the store, the bus, memory, metrics, the HTTP reads, the logs. */
async function everything(h: ReturnType<typeof build>, goalId: string): Promise<Record<string, string>> {
  const get = async (url: string) => (await h.app.inject({ method: "GET", url, headers: AUTH })).body;
  const runIds = [...new Set(h.store.runs.map((r) => r.runId).concat(h.store.events.map((e) => e.runId)))];
  const http: string[] = [await get(`/goals/${goalId}?tenant=${TENANT}`), await get(`/goals?tenant=${TENANT}`), await get("/metrics/agents")];
  for (const r of runIds) http.push(await get(`/runs/${r}?tenant=${TENANT}`), await get(`/runs/${r}/events?tenant=${TENANT}`));
  http.push(await get(`/episodes?tenant=${TENANT}&runIds=${runIds.join(",")}`));
  return {
    "goal rows": JSON.stringify([...h.store.goals.values()]),
    "run rows": JSON.stringify(h.store.runs),
    "run events": JSON.stringify(h.store.events),
    "sse bus": JSON.stringify(bus),
    "episodic memory": JSON.stringify(h.episodic.query([TENANT])),
    "obs collector": JSON.stringify([h.collector.all(), h.collector.summary(), h.collector.alerts()]),
    "http reads": http.join("\n"),
    logs: logged.join("\n"),
  };
}
function expectClean(dump: Record<string, string>): void {
  const all = Object.entries(dump).flatMap(([label, text]) => leaks(label, text));
  expect(all).toEqual([]);
}

describe("M5-G5c: an agent run that calls agency_privacy.erase holds no email or phone anywhere", () => {
  it("write specialist: goal, runs, events, bus, memory, metrics, HTTP, logs and the model's next prompt are all clean; the hub call is real", async () => {
    const deps = scripted([erase(), `{"final":"Erased the records of ${EMAIL} (${PHONE}): 2 leads, 1 submission."}`], { "agency_privacy.erase": ERASE_RESULT });
    const h = build(deps);
    const id = await runGoal(h.app, `Please erase ${EMAIL}, phone ${PHONE}, from the agency intake`, "privacy-clerk");

    // LIVE call unchanged: the hub received the real identifiers (it needs them to run).
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].name).toBe("agency_privacy.erase");
    expect(deps.calls[0].args).toMatchObject({ email: EMAIL, phone: PHONE });
    // The first prompt is the live model call and carries the human's goal as written (the model needs it to act).
    expect(deps.prompts[0]).toContain(EMAIL);

    // The model's NEXT prompt (the transcript, which reaches the Gateway) holds the minimised call + result only.
    expect(deps.prompts).toHaveLength(2);
    const transcript = deps.prompts[1].split("TRANSCRIPT SO FAR:")[1];
    expect(leaks("transcript", transcript)).toEqual([]);
    expect(transcript).toContain('TOOL agency_privacy.erase({"minimised":"agency-privacy.v1"');
    expect(transcript).toContain(EMAIL_HASH);
    expect(transcript).toContain(PHONE_HASH);
    expect(transcript).toContain('"counts":{"leadCount":2,"submissionCount":1,"tokenCount":0,"outOfScopeCount":0,"suppressionCount":2}');
    expect(transcript).not.toContain("Jane");
    expect(transcript).not.toContain("debug");

    const goal = h.store.goals.get(id)!;
    expect(goal.status).toBe("ok");
    expect(goal.goal).toBe("Please erase ***@example.com, phone ***90, from the agency intake");
    expect(goal.outcome).toBe("Erased the records of ***@example.com (***90): 2 leads, 1 submission.");

    // the persisted model step is {tool, minimised args}, not the model's prose + raw args
    const run = h.store.runs[0];
    expect(JSON.parse(run.steps[0].detail)).toEqual({
      tool: "agency_privacy.erase",
      args: {
        minimised: "agency-privacy.v1",
        hashes: { emailHash: EMAIL_HASH, phoneHash: PHONE_HASH },
        hints: { emailHint: "***@example.com", phoneHint: "***90" },
      },
    });
    expect(run.steps.map((s) => s.detail)).toContain("agency_privacy.erase ok");
    expect(h.store.events.map((e) => e.kind)).toEqual(["model", "tool", "model"]);

    expectClean(await everything(h, id));
  });

  it("the approval path: a high_write suspension files the REAL args with the hub (live), stores nothing", async () => {
    const deps = scripted([erase()], { "approvals.request": '{"id":"appr-1"}' });
    const h = build(deps);
    const id = await runGoal(h.app, `erase ${EMAIL} ${PHONE}`, "privacy-gated");
    const goal = h.store.goals.get(id)!;
    expect(goal.status).toBe("suspended");
    expect(goal.approvalId).toBe("appr-1");
    // fileApproval is a live hub call: the ERP minimiser (G5b) is what keeps it out of the approval row
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].name).toBe("approvals.request");
    expect((deps.calls[0].args.toolArgs as Record<string, unknown>).email).toBe(EMAIL);
    expect(goal.goal).toBe("erase ***@example.com ***90");
    expect(h.store.events.some((e) => e.kind === "approval_wait")).toBe(true);
    expectClean(await everything(h, id));
  });

  it("an agent that does NOT hold the tool but is asked for it: refused, never executed, and still nothing persisted", async () => {
    const deps = scripted([erase()]);
    const h = build(deps);
    const id = await runGoal(h.app, `erase ${EMAIL}`, "reader"); // reader's allow-list has no agency_privacy.*
    expect(deps.calls).toHaveLength(0);
    expect(h.store.goals.get(id)!.status).toBe("failed");
    expect(h.store.goals.get(id)!.errorKind).toBe("tool_not_allowed");
    // the reader holds no policy tool, so its goal is not seeded; the off-list call still NAMES a policy tool, so
    // its args are learned and the replies, events and goal row are scrubbed all the same.
    expectClean(await everything(h, id));
  });

  it("supervisor: the planner's reply, the delegate event, the blackboard and the specialist run are clean", async () => {
    const deps = scripted(
      [
        `{"assign":{"specialist":"privacy-reader","task":"find the records of ${EMAIL}"}}`, // planner
        `{"tool":"agency_privacy.find","args":{"tenantId":"${TENANT}","email":"${EMAIL}"}}`, // specialist
        `{"final":"Found 1 lead for ${EMAIL}."}`, // specialist
        `{"final":"Done: ${EMAIL} has 1 lead."}`, // planner
      ],
      { "agency_privacy.find": FIND_RESULT },
    );
    const h = build(deps, registry({ supervisor: privacySupervisor }));
    const id = await runGoal(h.app, `Check whether ${EMAIL} is in the intake`, "supervisor");

    expect(deps.calls[0].args).toMatchObject({ email: EMAIL });
    const goal = h.store.goals.get(id)!;
    expect(goal.status).toBe("ok");
    expect(goal.goal).toBe("Check whether ***@example.com is in the intake");
    expect(goal.outcome).toBe("Done: ***@example.com has 1 lead.");
    expect(goal.blackboard).toEqual([{ specialist: "privacy-reader", task: "find the records of ***@example.com", status: "ok", summary: "Found 1 lead for ***@example.com." }]);
    expect(h.store.events.find((e) => e.kind === "delegate")!.detail).toMatch(/^assign privacy-reader: find the records of \*\*\*@example\.com -> run /);
    expect(h.store.runs[0].parentRunId).toBeTruthy();
    expectClean(await everything(h, id));
  });

  it("a failing tool whose error text echoes the person: the transcript the model sees is scrubbed too", async () => {
    const deps = scripted([erase(), '{"final":"it failed"}'], { "agency_privacy.erase": new Error(`no lead for ${EMAIL} (${PHONE})`) });
    const h = build(deps);
    const id = await runGoal(h.app, `erase ${EMAIL}`, "privacy-clerk");
    expect(leaks("failure transcript", deps.prompts[1].split("TRANSCRIPT SO FAR:")[1])).toEqual([]);
    expect(deps.prompts[1]).toContain("TOOL agency_privacy.erase FAILED: no lead for ***@example.com (***90)");
    expectClean(await everything(h, id));
  });

  it("an export result (the person's data itself) never reaches the transcript, memory or store", async () => {
    const exportResult = JSON.stringify({
      kind: "export", counts: { leadCount: 1, submissionCount: 1, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 0 },
      leads: [{ leadId: "11111111-1111-4111-8111-111111111111", status: "new", contactEmail: EMAIL, contactPhone: PHONE, contactName: "Jane Doe", declinedReason: "Jane said no" }],
    });
    const exporter: AgentDef = { name: "exporter", systemPrompt: "x", tools: { "agency_privacy.export": "low_write" }, maxSteps: 4, maxToolCalls: 2, evaledProviders: ["echo"] };
    const deps = scripted([`{"tool":"agency_privacy.export","args":{"email":"${EMAIL}"}}`, '{"final":"exported 1 lead"}'], { "agency_privacy.export": exportResult });
    const h = build(deps, registry({ writeSpecialists: { exporter } }));
    const id = await runGoal(h.app, `export ${EMAIL}`, "exporter");
    const transcript = deps.prompts[1].split("TRANSCRIPT SO FAR:")[1];
    expect(transcript).not.toContain("Jane");
    expect(transcript).not.toContain("declinedReason");
    expect(transcript).toContain('"leads":[{"leadId":"11111111-1111-4111-8111-111111111111","status":"new"}]');
    expectClean(await everything(h, id));
  });

  it("the eval trace (traceRun, JSONL) is clean without the runner: goal, steps, outcome and the error text", async () => {
    const deps = scripted([erase(), `{"final":"done for ${EMAIL}"}`], { "agency_privacy.erase": ERASE_RESULT });
    const trace = await traceRun("run-1", clerk, `erase ${EMAIL} / ${PHONE}`, { provider: "platform", externalId: "u1" }, deps);
    expect(trace.status).toBe("ok");
    expect(trace.goal).toBe("erase ***@example.com / ***90");
    expect(trace.outcome).toBe("done for ***@example.com");
    expect(trace.toolsCalled).toEqual(["agency_privacy.erase"]);
    expect(leaks("trace jsonl", traceLines(trace).join("\n"))).toEqual([]);
    expect(deps.calls[0].args).toMatchObject({ email: EMAIL }); // live call real
  });

  it("the episodic memory takes the goal scope as a last gate even if handed an unscrubbed trace", async () => {
    // (runner path covered above; this asserts the memory-writer hook itself)
    const { episodeFromTrace } = await import("./memory/episodic");
    const { SensitiveScope, runWithSensitiveScope } = await import("./sensitive-tools");
    const scope = new SensitiveScope();
    scope.observeCall("agency_privacy.erase", ERASE_ARGS);
    const dirty = {
      v: 1 as const, runId: "r", agent: "a", envelope: { provider: "p", externalId: "e" }, goal: `erase ${EMAIL}`, status: "ok" as const,
      outcome: `done ${PHONE}`, steps: [], modelCalls: 1, toolCalls: 1, toolsCalled: [], startedAt: 1, endedAt: 2,
    };
    const ep = runWithSensitiveScope(scope, () => episodeFromTrace(dirty, TENANT));
    expect(ep.goal).toBe("erase ***@example.com");
    expect(ep.outcome).toBe("done ***90");
    // outside any scope the trace is taken as given (nothing to scrub with)
    expect(episodeFromTrace(dirty, TENANT).goal).toBe(`erase ${EMAIL}`);
  });

  it("M5-G5d (the G5c known gap, closed): a fileOnSuspend:false intent hands over the ERP's minimised shape, never the identifier", async () => {
    const deps = scripted([erase()]);
    const h = build(deps);
    const id = await runGoal(h.app, `erase ${EMAIL}`, "privacy-gated", { fileOnSuspend: false });
    const detail = (await h.app.inject({ method: "GET", url: `/goals/${id}?tenant=${TENANT}`, headers: AUTH })).json() as { suspendedIntent?: { tool: string; impact: string; args: Record<string, unknown> } };
    // The shape platform-nest's `agency_privacy.*` args policy takes as ALREADY minimised: the confirm chip can
    // file the approval from it, and the hub path re-derives the subject from the ledger's hashes.
    expect(detail.suspendedIntent).toEqual({
      tool: "agency_privacy.erase",
      impact: "high",
      args: {
        minimised: "agency-privacy.v1", kind: "erase", identifiers: ["email", "phone"], tenantId: TENANT,
        subject: { emailHash: EMAIL_HASH, emailHint: "***@example.com", phoneHash: PHONE_HASH, phoneHint: "***90" },
      },
    });
    // Nothing was run and nothing was filed: the live hub was never called.
    expect(deps.calls).toHaveLength(0);
    // Every store AND the HTTP read the ERP assistant polls: no identifier in any form.
    expectClean(await everything(h, id));
  });

  it("M5-G5d: a malformed identifier is not narrowed away; the intent is an empty shape the ERP refuses", async () => {
    const deps = scripted([erase({ tenantId: TENANT, email: EMAIL, phone: "call me" })]);
    const h = build(deps);
    const id = await runGoal(h.app, "erase her", "privacy-gated", { fileOnSuspend: false });
    const detail = (await h.app.inject({ method: "GET", url: `/goals/${id}?tenant=${TENANT}`, headers: AUTH })).json() as { suspendedIntent?: { args: Record<string, unknown> } };
    expect(detail.suspendedIntent?.args).toEqual({ minimised: "agency-privacy.v1", kind: "erase", identifiers: [] });
    expectClean(await everything(h, id));
  });

  it("M5-G5d: with fileOnSuspend:true (the default) the HUB still receives the real args, exactly as before", async () => {
    const deps = scripted([erase()], { "approvals.request": JSON.stringify({ id: "44444444-4444-4444-8444-444444444444" }) });
    const h = build(deps);
    await runGoal(h.app, "erase her", "privacy-gated");
    const filing = deps.calls.find((c) => c.name === "approvals.request");
    expect(filing?.args).toMatchObject({ toolName: "agency_privacy.erase", toolArgs: { email: EMAIL, phone: PHONE } });
  });
});

describe("M5-G5c: a tool with no policy is stored exactly as before (regression)", () => {
  it("contacts.lookup with an email in its args and result: raw reply, raw goal, raw transcript, no goal patch", async () => {
    const reply1 = `{"tool":"contacts.lookup","args":{"email":"${EMAIL}"}}`;
    const reply2 = `{"final":"Found ${EMAIL}."}`;
    const deps = scripted([reply1, reply2], { "contacts.lookup": `{"name":"Jane Doe","email":"${EMAIL}"}` });
    const h = build(deps);
    const goalText = `look up ${EMAIL} please`;
    const id = await runGoal(h.app, goalText, "reader");

    const goal = h.store.goals.get(id)!;
    expect(goal.status).toBe("ok");
    expect(goal.goal).toBe(goalText); // no rewrite
    expect(goal.outcome).toBe(`Found ${EMAIL}.`);
    expect(h.store.runs[0].steps[0].detail).toBe(reply1.slice(0, 200)); // byte-identical to pre-G5c
    expect(h.store.events[0].detail).toBe(reply1.slice(0, 200));
    expect(deps.prompts[1]).toContain(`TOOL contacts.lookup({"email":"${EMAIL}"}) => {"name":"Jane Doe","email":"${EMAIL}"}`);
    expect(h.episodic.query([TENANT])[0].goal).toBe(goalText);
  });

  it("a fixture policy registered by another tool opts in; the same call under a different name is untouched", async () => {
    registerSensitiveToolPolicy({
      toolName: "contacts.lookup",
      minimiseArgs: () => ({ minimised: "fixture.v1" }),
      minimiseIntentArgs: () => ({ minimised: "fixture.v1" }),
      minimiseResult: (r) => JSON.stringify({ minimised: "fixture.v1", bytes: r.length }),
      secretsOf: (a) => (typeof a.email === "string" ? [{ kind: "email" as const, value: a.email }] : []),
    });
    try {
      const deps = scripted([`{"tool":"contacts.lookup","args":{"email":"${EMAIL}"}}`, `{"final":"ok for ${EMAIL}"}`], { "contacts.lookup": `{"email":"${EMAIL}"}` });
      const h = build(deps);
      const id = await runGoal(h.app, `look up ${EMAIL}`, "reader");
      expect(h.store.runs[0].steps[0].detail).toBe('{"tool":"contacts.lookup","args":{"minimised":"fixture.v1"}}');
      expect(h.store.goals.get(id)!.outcome).toBe("ok for ***@example.com");
      expectClean(await everything(h, id));
    } finally {
      unregisterSensitiveToolPolicy("contacts.lookup");
    }
  });
});

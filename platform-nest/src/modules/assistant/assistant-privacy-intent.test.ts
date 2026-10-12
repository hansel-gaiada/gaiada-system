// M5-G5d — a suspended `agency_privacy.*` call is held by the assistant as its MINIMISED form only (hashes + hints),
// and the confirm chip still files the approval from it. No services: the runner is a scripted `fetch`, the database
// a recording client. The same flow against real Postgres and Cerbos (confirm -> a second admin approves -> the erase
// runs against the right lead) is assistant-privacy-intent.db.test.ts (needs the Linux gate / CI).
//
// What this pins:
//   * the broker reduces the runner's intent args to the ERP minimised shape BEFORE it stores, streams or returns
//     them, whether the runner already minimised them (ai-agents >= M5-G5d) or still sends the raw email/phone (an
//     older runner during a rolling deploy);
//   * the shape ai-agents hands over is a fixed point of the ERP's own minimiser (so confirm files it unchanged);
//   * `confirmWriteIntent` files hashes only and the privacy ledger's `filed` row binds those hashes;
//   * a tool with NO args policy is stored and filed exactly as before.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { runToolTurn, type BrokerEmit } from "./broker";
import { storableIntentArgs, confirmWriteIntent } from "./write-intents";
import { getExecutable, registerPmExecutableApprovals } from "../../core/approval-executables";
import { minimiseFilingInput } from "../../core/approval-arg-minimisers";
import { subjectHash } from "../../core/agency-privacy.subject";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const EMAIL = "Jane.Doe@Example.com";
const PHONE = "+62 812-3456-7890";
// Every form a leak could take. The hints keep the domain and the last two digits on purpose, so those are not here.
const FORMS = [
  EMAIL, EMAIL.toLowerCase(), EMAIL.toUpperCase(), "jane.doe", PHONE, "6281234567890", "+6281234567890", "81234567890",
  "812-3456-7890", "812 3456 7890", "3456-7890",
];
const EMAIL_HASH = subjectHash("jane.doe@example.com");
const PHONE_HASH = subjectHash("6281234567890");
const MINIMISED = {
  minimised: "agency-privacy.v1", kind: "erase", identifiers: ["email", "phone"], tenantId: TENANT,
  subject: { emailHash: EMAIL_HASH, emailHint: "***@example.com", phoneHash: PHONE_HASH, phoneHint: "***90" },
};
/** Byte-for-byte what ai-agents `intentArgsFor("agency_privacy.erase", {tenantId, email, phone})` emits (its own test pins it). */
const FROM_AI_AGENTS = JSON.parse(JSON.stringify(MINIMISED)) as Record<string, unknown>;
const RAW = { tenantId: TENANT, email: EMAIL, phone: PHONE };

function leaks(label: string, text: string): string[] {
  const lower = text.toLowerCase();
  return FORMS.filter((f) => lower.includes(f.toLowerCase())).map((f) => `${label}: ${f}`);
}

beforeAll(() => { if (!getExecutable("pm.createTask")) registerPmExecutableApprovals(); });

describe("storableIntentArgs: the args a draft may hold", () => {
  it("raw email/phone become the minimised shape; the identifier is in no form in the result", () => {
    const out = storableIntentArgs("agency_privacy.erase", { ...RAW, query: EMAIL, reason: "because" });
    expect(out).toEqual(MINIMISED);
    expect(leaks("stored", JSON.stringify(out))).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("because");
  });

  it("the shape ai-agents hands over is a FIXED POINT of the ERP's minimiser (idempotent): confirm files it unchanged", () => {
    expect(storableIntentArgs("agency_privacy.erase", FROM_AI_AGENTS)).toEqual(FROM_AI_AGENTS);
    const filed = minimiseFilingInput({ toolName: "agency_privacy.erase", toolArgs: FROM_AI_AGENTS, reason: "x" });
    expect(filed.toolArgs).toEqual(FROM_AI_AGENTS);
    // and the filed reason is the generated sentence, never the caller's text
    expect(filed.reason).toMatch(/^Privacy request: ERASE the personal data of one data subject/);
  });

  it("find/export and an approvalId-only call keep their kind; a call naming nobody is refused with the policy's own 400", () => {
    const approvalId = "33333333-3333-4333-8333-333333333333";
    expect(storableIntentArgs("agency_privacy.find", { phone: PHONE })).toMatchObject({ kind: "find", identifiers: ["phone"] });
    expect(storableIntentArgs("agency_privacy.export", { approvalId })).toEqual({
      minimised: "agency-privacy.v1", kind: "export", identifiers: [], approvalId,
    });
    expect(() => storableIntentArgs("agency_privacy.erase", { minimised: "agency-privacy.v1", kind: "erase", identifiers: [] })).toThrow(BadRequestException);
    expect(() => storableIntentArgs("agency_privacy.erase", { email: "not an email" })).toThrow(BadRequestException);
    try {
      storableIntentArgs("agency_privacy.erase", { email: "not an email", phone: PHONE });
    } catch (e) {
      expect(leaks("error", JSON.stringify((e as BadRequestException).getResponse()))).toEqual([]);
    }
  });

  it("a tool with NO args policy gets the SAME object back (regression)", () => {
    const args = { title: "Plan the launch", email: EMAIL };
    expect(storableIntentArgs("pm.createTask", args)).toBe(args);
    expect(storableIntentArgs("pm.createTask", null)).toEqual({});
  });
});

// ── the broker: runToolTurn against a scripted runner ───────────────────────────────────────────────
interface Emitted { confirm: Array<{ args: Record<string, unknown> }>; calls: unknown[]; results: unknown[]; all: unknown[] }
function emitter(): { emit: BrokerEmit; seen: Emitted } {
  const seen: Emitted = { confirm: [], calls: [], results: [], all: [] };
  const rec = <T,>(bucket: unknown[]) => (a: T) => { bucket.push(a); seen.all.push(a); };
  const emit = {
    toolCall: rec(seen.calls),
    toolResult: rec(seen.results),
    confirmRequired: (a: { args: Record<string, unknown> }) => { seen.confirm.push(a); seen.all.push(a); },
    approvalRequired: rec([]),
  } as unknown as BrokerEmit;
  return { emit, seen };
}

function runnerFetch(intent: { tool: string; impact: string; args: Record<string, unknown> }, requests: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    requests.push(`${init?.method ?? "GET"} ${u} ${typeof init?.body === "string" ? init.body : ""}`);
    const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
    if ((init?.method ?? "GET") === "POST" && u.endsWith("/goals")) return json(202, { id: "goal-1", status: "queued" });
    if (u.includes("/goals/goal-1")) {
      return json(200, {
        id: "goal-1", status: "suspended", outcome: `suspended awaiting confirmation for ${intent.tool} (${intent.impact}) — not yet filed`,
        errorKind: "approval_required", approvalId: null, suspendedIntent: intent, runs: [],
      });
    }
    return json(404, {});
  }) as typeof fetch;
}

async function turn(intent: { tool: string; impact: string; args: Record<string, unknown> }) {
  const { emit, seen } = emitter();
  const requests: string[] = [];
  const result = await runToolTurn({
    user: { userId: "11111111-2222-4333-8444-555555555555", tenantId: TENANT },
    prompt: "please handle the request",
    agent: "task-filer",
    emit,
    fetchImpl: runnerFetch(intent, requests),
    runnerUrl: "http://runner.test",
    runnerToken: "t",
    pollIntervalMs: 1,
    timeoutMs: 5000,
    visibleTools: async () => new Set(["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"]),
    ensureLink: async () => undefined,
  });
  return { result, seen, requests };
}

describe("runToolTurn: the suspended privacy intent the assistant holds, streams and returns", () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  let logged: string[] = [];
  const capture = () => {
    logged = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
    }
  };
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  for (const [label, handedOver] of [["a runner that already minimised (ai-agents >= M5-G5d)", FROM_AI_AGENTS], ["an older runner that still sends the RAW email and phone", RAW]] as const) {
    it(`${label}: the draft args, the ledger args, the chip frame and the returned text hold hashes and hints only`, async () => {
      capture();
      const { result, seen } = await turn({ tool: "agency_privacy.erase", impact: "high", args: handedOver as Record<string, unknown> });

      expect(result.outcome).toBe("suspended");
      expect(result.errorKind).toBe("confirm_required");
      // what the caller persists into assistant_write_intents.tool_args
      expect(result.intent?.args).toEqual(MINIMISED);
      expect(leaks("intent", JSON.stringify(result.intent))).toEqual([]);
      // what goes into assistant_tool_calls.args (redacted shape of the minimised args) and the SSE frames
      expect(leaks("tool calls", JSON.stringify(result.toolCalls))).toEqual([]);
      expect(leaks("stream frames", JSON.stringify(seen.all))).toEqual([]);
      expect(leaks("text", result.text)).toEqual([]);
      expect(leaks("logs", logged.join("\n"))).toEqual([]);
      // the chip is still produced, and carries the intent's id
      expect(seen.confirm).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({ toolName: "agency_privacy.erase", status: "pending" });
    });
  }

  it("args the tool would refuse (a malformed identifier) draft nothing: a typed error, no intent, no chip, no value in it", async () => {
    const { result, seen } = await turn({ tool: "agency_privacy.erase", impact: "high", args: { tenantId: TENANT, email: "not an email" } });
    expect(result.outcome).toBe("error");
    expect(result.errorKind).toBe("intent_invalid");
    expect(result.intent).toBeUndefined();
    expect(seen.confirm).toHaveLength(0);
    expect(leaks("text", result.text + JSON.stringify(seen.all))).toEqual([]);
  });

  it("REGRESSION: a tool with no args policy keeps its args VERBATIM in the draft and a redacted shape in the ledger", async () => {
    const args = { tenantId: TENANT, projectId: "p1", title: "Plan the launch", note: EMAIL };
    const { result, seen } = await turn({ tool: "pm.createTask", impact: "high", args });
    expect(result.outcome).toBe("suspended");
    expect(result.intent?.args).toEqual(args); // unchanged
    expect(result.toolCalls[0].args).toEqual({
      tenantId: "[redacted:string]", projectId: "[redacted:string]", title: "[redacted:string]", note: "[redacted:string]",
    });
    expect(seen.confirm[0].args).toEqual(result.toolCalls[0].args);
  });
});

// ── confirm: the minimised draft still files, with the ledger's filed row bound to the hashes ────────
describe("confirmWriteIntent: files from the minimised draft", () => {
  interface Q { sql: string; params: unknown[] }
  function recordingClient(toolName: string, toolArgs: Record<string, unknown>) {
    const queries: Q[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (/^\s*UPDATE assistant_write_intents\s+SET status = 'filed'/i.test(sql)) {
          return { rowCount: 1, rows: [{ id: "intent-1", toolArgs, toolName, impact: "high", agent: "privacy-clerk" }] };
        }
        if (/SELECT status, execution_status/i.test(sql)) return { rowCount: 1, rows: [{ status: "pending", execution_status: "not_applicable", execution_error: null }] };
        return { rowCount: 1, rows: [] };
      },
    };
    return { client, queries };
  }

  it("agency_privacy.erase: the approval row holds the minimised args, the ledger `filed` row the hashes, and nothing holds the identifier", async () => {
    const { client, queries } = recordingClient("agency_privacy.erase", FROM_AI_AGENTS);
    const out = await confirmWriteIntent(client as never, { tenantId: TENANT, threadId: "th-1", toolCallId: "tc-1", requestedBy: "user-1" });
    expect(out.outcome).toBe("ok");
    if (out.outcome !== "ok") return;
    expect(out.justFiled).toBe(true);

    const insert = queries.find((q) => /INSERT INTO automation_approvals/i.test(q.sql))!;
    expect(JSON.parse(insert.params[4] as string)).toEqual(MINIMISED);
    expect(insert.params[3]).toBe("agency_privacy.erase");
    expect(insert.params[7]).toBe("user-1"); // requested_by: the chatting user, as before
    const ledger = queries.find((q) => /INSERT INTO agency_dsr_requests/i.test(q.sql))!;
    expect(ledger.params).toEqual(expect.arrayContaining([TENANT, "erase", "filed", EMAIL_HASH, PHONE_HASH, "user-1"]));
    expect(leaks("every query", JSON.stringify(queries))).toEqual([]);
    // the post-commit notify input is minimised too
    expect(leaks("notifyInput", JSON.stringify(out.notifyInput))).toEqual([]);
    // the intent's own copy is scrubbed in the same transaction, as before
    expect(queries.some((q) => /SET tool_args = NULL/i.test(q.sql))).toBe(true);
  });

  it("REGRESSION: a tool with no policy is filed with its draft args byte-for-byte and the caller's reason", async () => {
    const args = { tenantId: TENANT, projectId: "p1", title: "Plan the launch" };
    const { client, queries } = recordingClient("pm.createTask", args);
    const out = await confirmWriteIntent(client as never, { tenantId: TENANT, threadId: "th-1", toolCallId: "tc-1", requestedBy: "user-1" });
    expect(out.outcome).toBe("ok");
    const insert = queries.find((q) => /INSERT INTO automation_approvals/i.test(q.sql))!;
    expect(JSON.parse(insert.params[4] as string)).toEqual(args);
    expect(insert.params[6]).toBe("assistant write proposal (pm.createTask), confirmed by the requesting user");
    expect(queries.some((q) => /agency_dsr_requests/i.test(q.sql))).toBe(false);
  });
});

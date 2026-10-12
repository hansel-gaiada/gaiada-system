// M5-G5b — an UNATTENDED `agency_privacy.erase` call, followed through the real filing core and the real decide
// handler with the database and Cerbos replaced by a recording fake. Proves, without any service:
//   * the approval INSERT, the ledger row, the activity row, the notification, the decided-event payload and every
//     line written to the console/stdout hold NEITHER identifier (nor its lower-cased or normalised form);
//   * a tool with no args policy is filed EXACTLY as before (the regression the ticket asks for);
//   * the privacy tools need `agency_lead:convert` to be filed through the generic create, and a denial files nothing.
// The same flow against real Postgres, Cerbos, the outbox, the notifications table and the BFF read shapes is
// agency-privacy-unattended.db.test.ts (needs the Linux gate / CI).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

interface Q { sql: string; params: unknown[] }
const queries: Q[] = [];
let scripted: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number } = () => ({ rows: [], rowCount: 0 });
const client = { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return scripted(sql, params); } };
let seq = 0;
vi.mock("../db", () => ({
  newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  withTenants: async (_ids: string[], fn: (c: unknown) => unknown) => fn(client),
  withGlobal: async (fn: (c: unknown) => unknown) => fn(client),
}));

const authorize = vi.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const activities: unknown[][] = [];
vi.mock("./http", () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  writeActivity: async (...a: unknown[]) => { activities.push(a); },
  notify: async () => undefined,
}));
const notifications: unknown[][] = [];
vi.mock("./client-notify", () => ({ notifyBestEffort: async (...a: unknown[]) => { notifications.push(a); } }));
vi.mock("./approval-deciders", () => ({ resolveAutomationApprovalDeciders: async () => ["decider-1"] }));
const events: unknown[][] = [];
vi.mock("../events/outbox.service", () => ({ emitEvent: async (...a: unknown[]) => { events.push(a); return "ev-1"; } }));
vi.mock("../rbac/cerbos", () => ({ check: async () => ({ allow: true }) }));

import { AutomationApprovalsController } from "./automation-approvals.controller";
import { subjectHash } from "./agency-privacy.subject";

const T = "11111111-1111-4111-8111-111111111111";
const EMAIL = "Ayu.Sari@Leak-Check.Example";
const PHONE = "+62 812 3456 7890";
const FORMS = [EMAIL, EMAIL.toLowerCase(), EMAIL.toUpperCase(), "ayu.sari", PHONE, "6281234567890", "812 3456 7890", "81234567890"];
const req = { principal: { userId: "u-1", id: "u-1" } } as never;
const ctl = new AutomationApprovalsController();

/** Everything an observer could see: the recorded queries, activity rows, notifications and events. */
function everythingRecorded(): string {
  return JSON.stringify({ queries, activities, notifications, events }).toLowerCase();
}

let logged: string[] = [];
const restore: Array<() => void> = [];
function captureLogs() {
  logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
    restore.push(() => spy.mockRestore());
  }
  for (const s of [process.stdout, process.stderr]) {
    const spy = vi.spyOn(s, "write").mockImplementation(((chunk: unknown) => { logged.push(String(chunk)); return true; }) as never);
    restore.push(() => spy.mockRestore());
  }
}

beforeEach(() => {
  queries.length = 0; activities.length = 0; notifications.length = 0; events.length = 0; seq = 0;
  scripted = () => ({ rows: [], rowCount: 0 });
  authorize.mockReset();
  authorize.mockImplementation(async () => undefined);
  captureLogs();
});
afterEach(() => { while (restore.length) restore.pop()!(); });

const insertOf = (toolName: string) =>
  queries.find((q) => q.sql.includes("INSERT INTO automation_approvals") && q.params[3] === toolName);

describe("an unattended agency_privacy.erase, filed through POST /automation-approvals", () => {
  it("stores hashes only: no identifier in the approval row, the ledger row, the activity, the notification or any log", async () => {
    const r = await ctl.create(req, T, {
      workflowId: "agent-intake", toolName: "agency_privacy.erase", toolArgs: { tenantId: T, email: EMAIL, phone: PHONE },
      impact: "high", reason: `suspend: erase ${EMAIL} (${PHONE}) needs approval`, origin: "agent", agentName: "intake-agent",
    });
    expect(r).toMatchObject({ status: "pending" });

    const ins = insertOf("agency_privacy.erase")!;
    expect(ins).toBeDefined();
    const [id, tenantId, workflowId, toolName, toolArgsJson, impact, reason, requestedBy, origin, agentName] = ins.params as string[];
    expect({ tenantId, workflowId, toolName, impact, requestedBy, origin, agentName }).toEqual({
      tenantId: T, workflowId: "agent-intake", toolName: "agency_privacy.erase", impact: "high", requestedBy: "u-1", origin: "agent", agentName: "intake-agent",
    });
    expect(JSON.parse(toolArgsJson)).toEqual({
      minimised: "agency-privacy.v1", kind: "erase", identifiers: ["email", "phone"], tenantId: T,
      subject: {
        emailHash: subjectHash("ayu.sari@leak-check.example"), emailHint: "***@leak-check.example",
        phoneHash: subjectHash("6281234567890"), phoneHint: "***90",
      },
    });
    expect(reason).toContain("Privacy request: ERASE");

    // The ledger's filed row was written on the SAME client, in the same transaction, with hashes.
    const led = queries.find((q) => q.sql.includes("INSERT INTO agency_dsr_requests"))!;
    expect(led).toBeDefined();
    expect(led.params).toEqual(expect.arrayContaining([T, "erase", "filed", subjectHash("ayu.sari@leak-check.example"), subjectHash("6281234567890"), id, "u-1"]));
    expect(queries.indexOf(led)).toBeGreaterThan(queries.indexOf(ins));

    // The notification carries ids and the generated sentence.
    expect(notifications).toHaveLength(1);
    expect((notifications[0][4] as { title: string }).title).toContain("Privacy request: ERASE");

    const all = everythingRecorded() + "\n" + logged.join("\n").toLowerCase();
    for (const f of FORMS) expect(all, `leaked form: ${f}`).not.toContain(f.toLowerCase());
  });

  it("the decided-event payload carries the hashes but neither the identifiers nor the approver's hints", async () => {
    await ctl.create(req, T, {
      workflowId: "agent-intake", toolName: "agency_privacy.erase", toolArgs: { tenantId: T, email: EMAIL, phone: PHONE }, impact: "high", origin: "agent",
    });
    const stored = JSON.parse(insertOf("agency_privacy.erase")!.params[4] as string) as Record<string, unknown>;
    queries.length = 0;
    scripted = (sql) => {
      if (sql.includes("SELECT origin, tool_name, workflow_id")) {
        return { rows: [{ origin: "agent", tool_name: "agency_privacy.erase", workflow_id: "agent-intake", requested_by: "u-1", tool_args: stored }], rowCount: 1 };
      }
      if (sql.includes("UPDATE automation_approvals")) {
        return { rows: [{ origin: "agent", tool_args: stored, workflow_id: "agent-intake", tool_name: "agency_privacy.erase" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const decider = { principal: { userId: "u-2", id: "u-2" } } as never;
    await expect(ctl.decide(decider, T, "00000000-0000-4000-8000-0000000000aa", { decision: "approved" })).resolves.toMatchObject({ status: "approved" });

    expect(events).toHaveLength(1);
    const [, tenant, entityType, , eventType, payload] = events[0] as [unknown, string, string, string, string, Record<string, unknown>];
    expect({ tenant, entityType, eventType }).toEqual({ tenant: T, entityType: "automation_approval", eventType: "automation_approval.decided" });
    expect(payload.toolArgs).toEqual({
      minimised: "agency-privacy.v1", kind: "erase", identifiers: ["email", "phone"], tenantId: T,
      subject: { emailHash: subjectHash("ayu.sari@leak-check.example"), phoneHash: subjectHash("6281234567890") },
    });
    const all = everythingRecorded() + "\n" + logged.join("\n").toLowerCase();
    for (const f of FORMS) expect(all, `leaked form: ${f}`).not.toContain(f.toLowerCase());
    expect(JSON.stringify(payload)).not.toContain("***");
    // The decide UPDATE decided the row; D14 has nothing to run (the tool is barred).
    expect(queries.some((q) => q.sql.includes("UPDATE automation_approvals") && q.params[3] === "not_applicable")).toBe(true);
  });

  it("is filed only by someone who holds `convert` on agency_lead (the route's own gate); a denial files nothing", async () => {
    authorize.mockImplementation(async (_p: unknown, resource: unknown) => {
      if ((resource as { kind: string }).kind === "agency_lead") throw new ForbiddenException("denied: convert");
    });
    await expect(ctl.create(req, T, {
      workflowId: "agent-intake", toolName: "agency_privacy.find", toolArgs: { email: EMAIL }, impact: "high", origin: "agent",
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorize.mock.calls.map((c) => [(c[1] as { kind: string }).kind, c[2]])).toEqual([["automation_approval", "create"], ["agency_lead", "convert"]]);
    expect(authorize.mock.calls[1][1]).toEqual({ kind: "agency_lead", tenantId: T, module: "agency" });
    expect(queries).toHaveLength(0);
    expect(activities).toHaveLength(0);
  });

  it("a malformed identifier is a clean 400 subject_invalid and NOTHING is stored", async () => {
    await expect(ctl.create(req, T, {
      workflowId: "agent-intake", toolName: "agency_privacy.erase", toolArgs: { email: "not an email", phone: PHONE }, impact: "high", origin: "agent",
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.create(req, T, {
      workflowId: "agent-intake", toolName: "agency_privacy.erase", toolArgs: {}, impact: "high", origin: "agent",
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(queries).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(logged.join("\n").toLowerCase()).not.toContain("leak-check");
  });

  it("an identifier that matches no lead files exactly the same (the no-op is decided at execution, never here)", async () => {
    await ctl.create(req, T, {
      workflowId: "agent-intake", toolName: "agency_privacy.erase", toolArgs: { email: "nobody-at-all@nowhere.example" }, impact: "high", origin: "agent",
    });
    expect(JSON.parse(insertOf("agency_privacy.erase")!.params[4] as string)).toMatchObject({
      kind: "erase", identifiers: ["email"], subject: { emailHash: subjectHash("nobody-at-all@nowhere.example") },
    });
    expect(queries.some((q) => q.sql.includes("INSERT INTO agency_dsr_requests"))).toBe(true);
    // and no lead table was read at filing time
    expect(queries.some((q) => /agency_leads|agency_discovery_submissions/.test(q.sql))).toBe(false);
  });
});

describe("a tool with NO args policy is stored exactly as before (regression)", () => {
  it("args and reason verbatim, no ledger write, one extra authorize call never made", async () => {
    const toolArgs = { amount: 100, to: "acct-9", note: `for ${EMAIL}`, nested: { phone: PHONE } };
    await ctl.create(req, T, {
      workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs, impact: "medium", reason: "suspend: medium-impact write", origin: "automation",
    });
    const ins = insertOf("money.transfer")!;
    expect(ins.params[4]).toBe(JSON.stringify(toolArgs));
    expect(ins.params[6]).toBe("suspend: medium-impact write");
    expect(queries.filter((q) => q.sql.includes("INSERT"))).toHaveLength(1);
    expect(authorize.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual(["automation_approval"]);
    expect((notifications[0][4] as { title: string }).title).toBe("suspend: medium-impact write");
  });

  it("the decided event carries the stored args byte for byte", async () => {
    const stored = { amount: 100, note: `for ${EMAIL}` };
    scripted = (sql) => {
      if (sql.includes("SELECT origin, tool_name, workflow_id")) {
        return { rows: [{ origin: "automation", tool_name: "money.transfer", workflow_id: "wf:x", requested_by: "u-1", tool_args: stored }], rowCount: 1 };
      }
      if (sql.includes("UPDATE automation_approvals")) {
        return { rows: [{ origin: "automation", tool_args: stored, workflow_id: "wf:x", tool_name: "money.transfer" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    await ctl.decide({ principal: { userId: "u-2", id: "u-2" } } as never, T, "00000000-0000-4000-8000-0000000000bb", { decision: "approved" });
    expect((events[0][5] as { toolArgs: unknown }).toolArgs).toBe(stored);
  });
});

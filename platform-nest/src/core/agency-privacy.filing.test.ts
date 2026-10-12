// M5-G5b — the args policy for `agency_privacy.*` approvals: PURE, no database. The path through the filing core
// (the INSERT, the notification, the logs) is driven in approval-filing-minimise.test.ts; the real flow against
// Postgres is agency-privacy-unattended.db.test.ts (Linux gate).
import { describe, expect, it, vi } from "vitest";
import { HttpException } from "@nestjs/common";

vi.mock("./http", () => ({ authorize: vi.fn(async () => undefined), writeActivity: vi.fn(async () => undefined) }));

import {
  AGENCY_PRIVACY_TOOL_NAMES, MINIMISED_MARKER, agencyPrivacyEventArgs, approvalReasonFor, emailHint, emptyPrivacyCounts,
  insertLedgerRow, minimiseAgencyPrivacyArgs, minimisedArgsForSubject, onAgencyPrivacyFiled, phoneHint,
} from "./agency-privacy.filing";
import { PRIVACY_TOOL, approvalReason } from "./agency-privacy.service";
import { parseSubject, pseudonymHash, subjectHash } from "./agency-privacy.subject";
import {
  getApprovalArgsPolicy, listApprovalArgsPolicyTools, minimiseFilingInput, minimiseToolArgs, registerApprovalArgsPolicy,
  unregisterApprovalArgsPolicy,
} from "./approval-arg-minimisers";
import { allCoreTools } from "./core-tools";
import { computeArgsSha256 } from "./hub-client";

const EMAIL = "Ayu.Sari@Leak-Check.Example";
const EMAIL_NORM = "ayu.sari@leak-check.example";
const PHONE = "+62 812 3456 7890";
const PHONE_DIGITS = "6281234567890";
const T = "11111111-1111-4111-8111-111111111111";
const APPROVAL = "33333333-3333-4333-8333-333333333333";

async function refusal(fn: () => unknown): Promise<{ status: number; reason: unknown }> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), reason: (e.getResponse() as { reason?: unknown }).reason };
    throw e;
  }
  throw new Error("expected a refusal");
}

/** Every form of the identifiers a leak could take. */
const FORMS = [EMAIL, EMAIL_NORM, EMAIL.toUpperCase(), "ayu.sari", PHONE, PHONE_DIGITS, "812 3456 7890", "81234567890"];

describe("minimiseAgencyPrivacyArgs", () => {
  it("replaces the email and phone with the G5 subject hashes plus a domain / last-two-digits hint, and nothing else", () => {
    const { toolArgs } = minimiseAgencyPrivacyArgs("agency_privacy.erase", { tenantId: T, email: EMAIL, phone: PHONE });
    const subject = parseSubject({ email: EMAIL, phone: PHONE });
    if (!subject.ok) throw new Error("fixture");
    expect(toolArgs).toEqual({
      minimised: MINIMISED_MARKER,
      kind: "erase",
      identifiers: ["email", "phone"],
      tenantId: T,
      // THE SAME helper the ledger and suppression list use: not a second hash.
      subject: {
        emailHash: subject.subject.emailHash, emailHint: "***@leak-check.example",
        phoneHash: subject.subject.phoneHash, phoneHint: "***90",
      },
    });
    expect(toolArgs.subject).toMatchObject({ emailHash: subjectHash(EMAIL_NORM), phoneHash: subjectHash(PHONE_DIGITS) });
    const text = JSON.stringify(toolArgs);
    for (const f of FORMS) expect(text.toLowerCase()).not.toContain(f.toLowerCase());
  });

  it("works for one key alone, and the kind comes from the tool name, never from the caller", () => {
    const e = minimiseAgencyPrivacyArgs("agency_privacy.find", { email: EMAIL, kind: "erase" }).toolArgs;
    expect(e).toMatchObject({ kind: "find", identifiers: ["email"] });
    expect((e.subject as Record<string, unknown>).phoneHash).toBeUndefined();
    const p = minimiseAgencyPrivacyArgs("agency_privacy.export", { phone: PHONE }).toolArgs;
    expect(p).toMatchObject({ kind: "export", identifiers: ["phone"] });
    expect((p.subject as Record<string, unknown>).emailHash).toBeUndefined();
  });

  it("is an ALLOW-LIST: an unknown key, even one that holds an identifier, never survives", () => {
    const { toolArgs } = minimiseAgencyPrivacyArgs("agency_privacy.find", {
      email: EMAIL, Email: EMAIL, query: EMAIL, contact: { phone: PHONE }, notes: `call ${PHONE}`, requestId: APPROVAL, approvalId: "not-a-uuid", tenantId: "../../etc",
    });
    expect(Object.keys(toolArgs).sort()).toEqual(["identifiers", "kind", "minimised", "subject"]);
    const text = JSON.stringify(toolArgs).toLowerCase();
    for (const f of FORMS) expect(text).not.toContain(f.toLowerCase());
  });

  it("keeps a well-formed approvalId and tenantId, so an approvalId-only call can still be filed", () => {
    const { toolArgs } = minimiseAgencyPrivacyArgs("agency_privacy.erase", { tenantId: T, approvalId: APPROVAL });
    expect(toolArgs).toEqual({ minimised: MINIMISED_MARKER, kind: "erase", identifiers: [], tenantId: T, approvalId: APPROVAL });
  });

  it("refuses what the route would refuse (400 subject_invalid), with nothing of the value in the error", async () => {
    for (const args of [{}, { email: "not-an-email" }, { phone: "12" }, { email: EMAIL, phone: "abc" }, { email: 42 }, { email: "" }]) {
      expect(await refusal(() => minimiseAgencyPrivacyArgs("agency_privacy.erase", args))).toEqual({ status: 400, reason: "subject_invalid" });
    }
    try {
      minimiseAgencyPrivacyArgs("agency_privacy.erase", { email: EMAIL, phone: "nope" });
    } catch (e) {
      expect(JSON.stringify((e as HttpException).getResponse()).toLowerCase()).not.toContain("leak-check");
    }
  });

  it("is IDEMPOTENT: minimising its own output returns the same args and reason (every layer may apply it)", () => {
    const first = minimiseAgencyPrivacyArgs("agency_privacy.erase", { tenantId: T, email: EMAIL, phone: PHONE });
    const second = minimiseAgencyPrivacyArgs("agency_privacy.erase", first.toolArgs);
    expect(second).toEqual(first);
  });

  it("the filed reason is generated: the caller's own free text is replaced and names no identifier", () => {
    const filed = minimiseFilingInput({
      toolName: "agency_privacy.erase", toolArgs: { email: EMAIL }, reason: `please erase ${EMAIL} urgently`,
    });
    expect(filed.reason).toBe(approvalReasonFor("erase", ["email"]));
    expect(filed.reason).toContain("identified by email");
    expect(filed.reason!.toLowerCase()).not.toContain("leak-check");
  });

  it("an unknown tool name is a programming error, not a silent pass-through", () => {
    expect(() => minimiseAgencyPrivacyArgs("agency_privacy.nope", { email: EMAIL })).toThrow(/no agency-privacy minimiser/);
  });

  it("hints carry the domain and the last two digits only", () => {
    expect(emailHint("a@b.example")).toBe("***@b.example");
    expect(phoneHint("6281234567890")).toBe("***90");
  });
});

describe("the route's own call 1 shape (minimisedArgsForSubject)", () => {
  it("is a fixed point of the policy and carries the requestId the ledger row will use", () => {
    const parsed = parseSubject({ email: EMAIL, phone: PHONE });
    if (!parsed.ok) throw new Error("fixture");
    const args = minimisedArgsForSubject("erase", APPROVAL, parsed.subject);
    const m = minimiseAgencyPrivacyArgs("agency_privacy.erase", args);
    expect(m.toolArgs).toEqual(args);
    expect(m.toolArgs.requestId).toBe(APPROVAL);
    expect(approvalReason("erase", parsed.subject)).toBe(m.reason);
  });

  it("a RAW caller cannot choose the ledger's requestId", () => {
    const { toolArgs } = minimiseAgencyPrivacyArgs("agency_privacy.erase", { email: EMAIL, requestId: APPROVAL });
    expect(toolArgs.requestId).toBeUndefined();
  });
});

describe("event args", () => {
  it("keeps the hashes and drops the approver's display hints", () => {
    const stored = minimiseAgencyPrivacyArgs("agency_privacy.erase", { tenantId: T, email: EMAIL, phone: PHONE }).toolArgs;
    const ev = agencyPrivacyEventArgs(stored);
    expect(ev.subject).toEqual({ emailHash: subjectHash(EMAIL_NORM), phoneHash: subjectHash(PHONE_DIGITS) });
    const text = JSON.stringify(ev).toLowerCase();
    for (const f of FORMS) expect(text).not.toContain(f.toLowerCase());
    expect(text).not.toContain("***");
    // the stored row keeps its hints (the approver's view)
    expect((stored.subject as Record<string, unknown>).emailHint).toBe("***@leak-check.example");
  });
});

describe("the policy registry", () => {
  it("every agency_privacy.* tool in the core tool registry has a policy, and every policy name is a registered tool", () => {
    const coreNames = allCoreTools().map((t) => t.name).filter((n) => n.startsWith("agency_privacy."));
    expect(coreNames.sort()).toEqual([...AGENCY_PRIVACY_TOOL_NAMES].sort());
    for (const n of coreNames) {
      const p = getApprovalArgsPolicy(n);
      expect(p, n).toBeDefined();
      expect([typeof p!.minimise, typeof p!.eventArgs, typeof p!.authorizeFiling, typeof p!.onFiled]).toEqual(["function", "function", "function", "function"]);
    }
    // and the service's own name map agrees with the filing leaf's
    expect(Object.values(PRIVACY_TOOL).sort()).toEqual([...AGENCY_PRIVACY_TOOL_NAMES].sort());
  });

  it("a tool with NO policy is untouched: the same object back, args and reason exactly as given", () => {
    const input = { toolName: "money.transfer", toolArgs: { amount: 100, note: `for ${EMAIL}` }, reason: `suspend: ${EMAIL}` };
    expect(minimiseFilingInput(input)).toBe(input);
    expect(minimiseToolArgs("money.transfer", input.toolArgs)).toBe(input.toolArgs);
  });

  it("another tool can opt in without touching the others; a duplicate is refused; built-ins cannot be removed", () => {
    registerApprovalArgsPolicy({
      toolName: "fixture.sensitive",
      minimise: (a) => ({ toolArgs: { ref: String(a.ref).length }, reason: "generated" }),
    });
    try {
      expect(minimiseFilingInput({ toolName: "fixture.sensitive", toolArgs: { ref: "secret" }, reason: "free text" }))
        .toEqual({ toolName: "fixture.sensitive", toolArgs: { ref: 6 }, reason: "generated" });
      expect(() => registerApprovalArgsPolicy({ toolName: "fixture.sensitive", minimise: () => ({ toolArgs: {}, reason: "" }) })).toThrow(/already registered/);
      expect(listApprovalArgsPolicyTools()).toContain("fixture.sensitive");
      expect(minimiseFilingInput({ toolName: "money.transfer", toolArgs: { ref: "secret" } }).toolArgs).toEqual({ ref: "secret" });
    } finally {
      unregisterApprovalArgsPolicy("fixture.sensitive");
    }
    expect(getApprovalArgsPolicy("fixture.sensitive")).toBeUndefined();
    expect(() => unregisterApprovalArgsPolicy("agency_privacy.erase")).toThrow(/built-in/);
  });

  it("resolve-and-execute's digest: the raw re-run args and the stored (minimised) args hash identically", () => {
    const raw = { tenantId: T, email: EMAIL, phone: PHONE };
    const stored = minimiseFilingInput({ toolName: "agency_privacy.erase", toolArgs: raw }).toolArgs;
    expect(computeArgsSha256(minimiseToolArgs("agency_privacy.erase", raw))).toBe(computeArgsSha256(stored));
    // a differently-cased / spaced spelling of the SAME person is the same call
    const same = { tenantId: T, email: EMAIL_NORM.toUpperCase(), phone: "+62-812-3456-7890" };
    expect(computeArgsSha256(minimiseToolArgs("agency_privacy.erase", same))).toBe(computeArgsSha256(stored));
    // another person, or another command, is not
    expect(computeArgsSha256(minimiseToolArgs("agency_privacy.erase", { ...raw, email: "other@x.example" }))).not.toBe(computeArgsSha256(stored));
    expect(computeArgsSha256(minimiseToolArgs("agency_privacy.find", raw))).not.toBe(computeArgsSha256(stored));
  });
});

describe("onAgencyPrivacyFiled (the ledger's filed row, same transaction)", () => {
  function fakeClient() {
    const calls: { sql: string; params: unknown[] }[] = [];
    return { calls, c: { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; } } };
  }

  it("writes one filed row binding (approval, kind, hashes, requester); hashes only", async () => {
    const { calls, c } = fakeClient();
    const toolArgs = minimiseAgencyPrivacyArgs("agency_privacy.erase", { email: EMAIL, phone: PHONE }).toolArgs;
    await onAgencyPrivacyFiled(c as never, { approvalId: APPROVAL, tenantId: T, toolName: "agency_privacy.erase", requestedBy: "u-1", toolArgs });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO agency_dsr_requests");
    const p = calls[0].params;
    expect(p).toEqual(expect.arrayContaining([T, "erase", "filed", subjectHash(EMAIL_NORM), subjectHash(PHONE_DIGITS), APPROVAL, "u-1"]));
    const text = JSON.stringify(p).toLowerCase();
    for (const f of FORMS) expect(text).not.toContain(f.toLowerCase());
  });

  it("uses the route's requestId when the args carry one; otherwise generates one", async () => {
    const a = fakeClient();
    const parsed = parseSubject({ email: EMAIL });
    if (!parsed.ok) throw new Error("fixture");
    await onAgencyPrivacyFiled(a.c as never, {
      approvalId: APPROVAL, tenantId: T, toolName: "agency_privacy.find", requestedBy: "u-1",
      toolArgs: minimisedArgsForSubject("find", "44444444-4444-4444-8444-444444444444", parsed.subject),
    });
    expect(a.calls[0].params).toContain("44444444-4444-4444-8444-444444444444");
    const b = fakeClient();
    await onAgencyPrivacyFiled(b.c as never, {
      approvalId: APPROVAL, tenantId: T, toolName: "agency_privacy.find", requestedBy: "u-1",
      toolArgs: minimiseAgencyPrivacyArgs("agency_privacy.find", { email: EMAIL }).toolArgs,
    });
    expect(String(b.calls[0].params[2])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an approvalId-only call has no subject to bind: nothing is written", async () => {
    const { calls, c } = fakeClient();
    await onAgencyPrivacyFiled(c as never, {
      approvalId: APPROVAL, tenantId: T, toolName: "agency_privacy.erase", requestedBy: "u-1",
      toolArgs: minimiseAgencyPrivacyArgs("agency_privacy.erase", { approvalId: APPROVAL }).toolArgs,
    });
    expect(calls).toHaveLength(0);
  });
});

// M5-V3-h — the visitor keys under the same minimiser rules.
describe("M5-V3-h: visitorId / consentId are minimised to their hashes", () => {
  const V = "AAAAAAAA-1111-4111-8111-111111111111";
  const K = "bbbbbbbb-2222-4222-8222-222222222222";
  const VFORMS = [V, V.toLowerCase(), K, K.toUpperCase()];

  it("stores only pseudonymHash() of each, says which keys were given, and no hint", () => {
    const { toolArgs, reason } = minimiseAgencyPrivacyArgs("agency_privacy.erase", { tenantId: T, email: EMAIL, visitorId: V, consentId: K });
    expect(toolArgs).toEqual({
      minimised: MINIMISED_MARKER, kind: "erase", identifiers: ["email", "visitor_id", "consent_id"], tenantId: T,
      subject: { emailHash: subjectHash(EMAIL_NORM), emailHint: "***@leak-check.example", visitorIdHash: pseudonymHash(V), consentIdHash: pseudonymHash(K) },
    });
    const text = JSON.stringify({ toolArgs, reason }).toLowerCase();
    for (const f of VFORMS) expect(text).not.toContain(f.toLowerCase());
    expect(reason).toContain("website visitor id");
    expect(reason).toContain("website-visitor profiles");
  });

  it("a visitor key alone files; it is idempotent; a malformed one is 400 with nothing of the value", async () => {
    const one = minimiseAgencyPrivacyArgs("agency_privacy.find", { consentId: K });
    expect(one.toolArgs).toMatchObject({ identifiers: ["consent_id"], subject: { consentIdHash: pseudonymHash(K) } });
    expect(minimiseAgencyPrivacyArgs("agency_privacy.find", one.toolArgs)).toEqual(one);
    expect(await refusal(() => minimiseAgencyPrivacyArgs("agency_privacy.erase", { visitorId: "not-a-uuid" }))).toEqual({ status: 400, reason: "subject_invalid" });
    try {
      minimiseAgencyPrivacyArgs("agency_privacy.erase", { visitorId: `${V}-tail` });
    } catch (e) {
      expect(JSON.stringify((e as HttpException).getResponse()).toLowerCase()).not.toContain(V.toLowerCase());
    }
    // a forged minimised shape cannot smuggle a plaintext id in place of a hash
    const forged = minimiseAgencyPrivacyArgs("agency_privacy.find", { minimised: MINIMISED_MARKER, subject: { visitorIdHash: V, consentIdHash: pseudonymHash(K) } });
    expect(forged.toolArgs.subject).toEqual({ consentIdHash: pseudonymHash(K) });
  });

  it("the route's call 1 shape is a fixed point; event args keep the hashes", () => {
    const parsed = parseSubject({ phone: PHONE, visitorId: V });
    if (!parsed.ok) throw new Error("fixture");
    const args = minimisedArgsForSubject("erase", APPROVAL, parsed.subject);
    expect(minimiseAgencyPrivacyArgs("agency_privacy.erase", args).toolArgs).toEqual(args);
    expect(agencyPrivacyEventArgs(args).subject).toEqual({ phoneHash: subjectHash(PHONE_DIGITS), visitorIdHash: pseudonymHash(V) });
  });

  it("onAgencyPrivacyFiled binds a visitor-only request in the ledger (hashes only, no collector status on a filed row)", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const c = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
    const toolArgs = minimiseAgencyPrivacyArgs("agency_privacy.erase", { visitorId: V }).toolArgs;
    await onAgencyPrivacyFiled(c as never, { approvalId: APPROVAL, tenantId: T, toolName: "agency_privacy.erase", requestedBy: "u-1", toolArgs });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("visitor_id_hash");
    const p = calls[0].params;
    // email_hash, phone_hash null; visitor hash set; consent hash null; collector_forget (index 19) null on a filed row
    expect([p[5], p[6], p[7], p[8]]).toEqual([null, null, pseudonymHash(V), null]);
    expect(p[19]).toBeNull();
    expect(JSON.stringify(p).toLowerCase()).not.toContain(V.toLowerCase());
  });

  it("insertLedgerRow writes the collector status on an executed erase only (the CHECK's rule), defaulting to not_needed", async () => {
    const calls: unknown[][] = [];
    const c = { query: async (_sql: string, params: unknown[]) => { calls.push(params); return { rows: [], rowCount: 1 }; } };
    const base = { tenantId: T, requestId: APPROVAL, emailHash: null, phoneHash: null, visitorIdHash: pseudonymHash(V), approvalId: APPROVAL, actorId: "u-1" };
    await insertLedgerRow(c as never, { ...base, kind: "erase", phase: "executed", counts: { ...emptyPrivacyCounts(), profileCount: 1, collectorForget: "queued" } });
    await insertLedgerRow(c as never, { ...base, kind: "erase", phase: "executed", counts: emptyPrivacyCounts() });
    await insertLedgerRow(c as never, { ...base, kind: "find", phase: "executed", counts: { ...emptyPrivacyCounts(), collectorForget: "delivered" } });
    await insertLedgerRow(c as never, { ...base, kind: "erase", phase: "filed" });
    expect(calls.map((p) => p[19])).toEqual(["queued", "not_needed", null, null]);
    expect(calls[0][16]).toBe(1); // profile_count
  });
});

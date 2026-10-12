// M5-G5 — the privacy routes' wiring, NO database: authorization comes first (a denial is a 403 even for a
// malformed body), the first call files and reads nothing, every service outcome maps to its typed status, and
// no identifier reaches an activity row. The real flow (Postgres + Cerbos, WS4 decide, the ledger) is driven in
// agency-privacy.db.test.ts on the Linux gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";

const authorize = vi.fn<(...a: unknown[]) => unknown>();
const writeActivity = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock("./http", () => ({ authorize: (...a: unknown[]) => authorize(...a), writeActivity: (...a: unknown[]) => writeActivity(...a) }));

const fileAgencyPrivacyRequest = vi.fn<(...a: unknown[]) => unknown>();
const executeAgencyPrivacyRequest = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("./agency-privacy.service", async (orig) => ({
  ...(await orig<typeof import("./agency-privacy.service")>()),
  fileAgencyPrivacyRequest: (...a: unknown[]) => fileAgencyPrivacyRequest(...a),
  executeAgencyPrivacyRequest: (...a: unknown[]) => executeAgencyPrivacyRequest(...a),
}));

import { AgencyPrivacyController } from "./agency-privacy.controller";

const T = "11111111-1111-4111-8111-111111111111";
const APPROVAL = "33333333-3333-4333-8333-333333333333";
const EMAIL = "ayu.sari@leak-check.example";
const PHONE = "+62 812 3456 7890";
const req = { principal: { userId: "u-1" } } as never;

function reply() {
  const r = { code: 0, status(n: number) { r.code = n; return r; } };
  return r;
}
const ctl = new AgencyPrivacyController();

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), reason: (e.getResponse() as { reason?: unknown }).reason };
    throw e;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockImplementation(async () => undefined);
  fileAgencyPrivacyRequest.mockImplementation(async () => { throw new BadRequestException("SERVICE REACHED"); });
  executeAgencyPrivacyRequest.mockImplementation(async () => { throw new BadRequestException("SERVICE REACHED"); });
});

describe("authorization first", () => {
  it.each(["find", "export", "erase"])("%s asks Cerbos `convert` on agency_lead BEFORE reading the body", async (kind) => {
    authorize.mockImplementation(async () => { throw new ForbiddenException("denied: convert"); });
    // A MALFORMED body: if validation ran first this would be a 400.
    await expect(ctl.command(req, reply() as never, T, kind, { email: "not-an-email" })).rejects.toBeInstanceOf(ForbiddenException);
    // And a VALID body is refused the same way, without reaching a service.
    await expect(ctl.command(req, reply() as never, T, kind, { email: EMAIL })).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorize.mock.calls[0][1]).toEqual({ kind: "agency_lead", tenantId: T, module: "agency" });
    expect(authorize.mock.calls[0][2]).toBe("convert");
    expect(fileAgencyPrivacyRequest).not.toHaveBeenCalled();
    expect(executeAgencyPrivacyRequest).not.toHaveBeenCalled();
  });

  it("an unknown command is a 404 and asks nothing", async () => {
    await expect(ctl.command(req, reply() as never, T, "delete", { email: EMAIL })).rejects.toBeInstanceOf(NotFoundException);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("a principal without a user id is refused before anything is filed", async () => {
    const r = await refusal(ctl.command({ principal: { userId: null } } as never, reply() as never, T, "find", { email: EMAIL }));
    expect(r).toEqual({ status: 403, reason: "user_required" });
    expect(fileAgencyPrivacyRequest).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  it("a missing or bad identifier is 400 subject_invalid; a non-uuid approvalId is 400 approval_id_invalid", async () => {
    expect(await refusal(ctl.command(req, reply() as never, T, "erase", {}))).toEqual({ status: 400, reason: "subject_invalid" });
    expect(await refusal(ctl.command(req, reply() as never, T, "erase", { phone: "12" }))).toEqual({ status: 400, reason: "subject_invalid" });
    expect(await refusal(ctl.command(req, reply() as never, T, "erase", { email: EMAIL, approvalId: "x" })))
      .toEqual({ status: 400, reason: "approval_id_invalid" });
  });
});

describe("call 1 — files the WS4 approval, reads nothing", () => {
  it("202 suspended, with the request and approval ids; the activity row holds ids only", async () => {
    fileAgencyPrivacyRequest.mockResolvedValue({ requestId: "req-1", approvalId: APPROVAL });
    const rep = reply();
    const out = await ctl.command(req, rep as never, T, "erase", { email: EMAIL, phone: PHONE });
    expect(rep.code).toBe(202);
    expect(out).toMatchObject({ outcome: "suspended", kind: "erase", requestId: "req-1", approvalId: APPROVAL });
    const arg = fileAgencyPrivacyRequest.mock.calls[0][0] as { kind: string; requestedBy: string; subject: { email: string; phone: string } };
    expect(arg).toMatchObject({ tenantId: T, kind: "erase", requestedBy: "u-1" });
    expect(arg.subject).toMatchObject({ email: EMAIL, phone: "6281234567890" });
    expect(executeAgencyPrivacyRequest).not.toHaveBeenCalled();
    expect(writeActivity).toHaveBeenCalledWith(T, "u-1", "privacy_erase_requested", "agency_privacy_request", "req-1", { approvalId: APPROVAL });
    expect(JSON.stringify(writeActivity.mock.calls)).not.toContain("ayu");
    expect(JSON.stringify(writeActivity.mock.calls)).not.toContain("3456");
  });
});

describe("call 2 — every service outcome maps to its typed answer", () => {
  const body = { email: EMAIL, approvalId: APPROVAL };
  it.each([
    [{ outcome: "not_found" }, 404, "privacy_request_not_found"],
    [{ outcome: "mismatch" }, 400, "privacy_request_mismatch"],
    [{ outcome: "not_requester" }, 403, "privacy_request_not_requester"],
    [{ outcome: "rejected", requestId: "r" }, 409, "approval_rejected"],
    [{ outcome: "self_approved", requestId: "r" }, 403, "self_approved"],
    [{ outcome: "already_used", requestId: "r" }, 409, "approval_already_used"],
  ])("%j -> %i %s", async (outcome, status, reason) => {
    executeAgencyPrivacyRequest.mockResolvedValue(outcome);
    expect(await refusal(ctl.command(req, reply() as never, T, "export", body))).toEqual({ status, reason });
    expect(writeActivity).not.toHaveBeenCalled();
  });

  it("pending is a 202 awaiting_approval", async () => {
    executeAgencyPrivacyRequest.mockResolvedValue({ outcome: "awaiting_approval", requestId: "r" });
    const rep = reply();
    expect(await ctl.command(req, rep as never, T, "find", body)).toMatchObject({ outcome: "awaiting_approval", approvalId: APPROVAL });
    expect(rep.code).toBe(202);
  });

  it("an executed erase answers counts + outOfScope and audits counts only", async () => {
    const counts = { leadCount: 2, submissionCount: 1, tokenCount: 1, outOfScopeCount: 1, suppressionCount: 2 };
    const outOfScope = [{ leadId: "l-1", convertedClientId: "c-1", reason: "client_record_retention" }];
    executeAgencyPrivacyRequest.mockResolvedValue({
      outcome: "executed", requestId: "r", result: { kind: "erase", erasedAt: "2026-10-12T00:00:00.000Z", outOfScope, counts },
    });
    const rep = reply();
    const out = await ctl.command(req, rep as never, T, "erase", body);
    expect(rep.code).toBe(200);
    expect(out).toEqual({
      outcome: "executed", kind: "erase", replayed: false, requestId: "r", erasedAt: "2026-10-12T00:00:00.000Z", counts, outOfScope,
    });
    expect(writeActivity).toHaveBeenCalledWith(T, "u-1", "privacy_erase_executed", "agency_privacy_request", "r", { approvalId: APPROVAL, ...counts });
  });

  it("an erase replay returns the stored counts with replayed:true", async () => {
    const counts = { leadCount: 1, submissionCount: 0, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 1 };
    executeAgencyPrivacyRequest.mockResolvedValue({ outcome: "replayed", requestId: "r", counts });
    expect(await ctl.command(req, reply() as never, T, "erase", body)).toEqual({ outcome: "executed", kind: "erase", replayed: true, requestId: "r", counts });
  });

  it("an executed export returns the leads; the activity row carries no field of them", async () => {
    const counts = { leadCount: 1, submissionCount: 0, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 0 };
    executeAgencyPrivacyRequest.mockResolvedValue({
      outcome: "executed", requestId: "r",
      result: { kind: "export", outOfScope: [], counts, leads: [{ leadId: "l-1", contactEmail: EMAIL }] },
    });
    const out = (await ctl.command(req, reply() as never, T, "export", body)) as { leads: unknown[] };
    expect(out.leads).toEqual([{ leadId: "l-1", contactEmail: EMAIL }]);
    expect(JSON.stringify(writeActivity.mock.calls)).not.toContain(EMAIL);
  });
});


// M5-G5b — run-by-approval: an approval filed through the agent hub holds only hashes, so the requester runs it
// with just the approvalId and the service rebuilds the subject from the ledger.
describe("call 2 without identifiers (M5-G5b)", () => {
  const counts = { leadCount: 1, submissionCount: 0, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 1 };

  it("an approvalId and NO email/phone runs the service with subject:null (no identifier is needed or asked for)", async () => {
    executeAgencyPrivacyRequest.mockResolvedValue({ outcome: "replayed", requestId: "r", counts });
    for (const body of [{ approvalId: APPROVAL }, { approvalId: APPROVAL, email: null, phone: undefined }]) {
      executeAgencyPrivacyRequest.mockClear();
      const out = await ctl.command(req, reply() as never, T, "erase", body);
      expect(out).toMatchObject({ outcome: "executed", replayed: true });
      expect(executeAgencyPrivacyRequest).toHaveBeenCalledWith({ tenantId: T, kind: "erase", subject: null, approvalId: APPROVAL, actorId: "u-1" });
    }
  });

  it("identifiers given next to an approvalId are still parsed, bound and refused exactly as before", async () => {
    expect(await refusal(ctl.command(req, reply() as never, T, "erase", { approvalId: APPROVAL, email: "not-an-email" })))
      .toEqual({ status: 400, reason: "subject_invalid" });
    expect(await refusal(ctl.command(req, reply() as never, T, "erase", { approvalId: APPROVAL, phone: "12" })))
      .toEqual({ status: 400, reason: "subject_invalid" });
    expect(executeAgencyPrivacyRequest).not.toHaveBeenCalled();
    executeAgencyPrivacyRequest.mockResolvedValue({ outcome: "mismatch" });
    expect(await refusal(ctl.command(req, reply() as never, T, "erase", { approvalId: APPROVAL, email: EMAIL })))
      .toEqual({ status: 400, reason: "privacy_request_mismatch" });
    expect((executeAgencyPrivacyRequest.mock.calls[0][0] as { subject: { email: string } }).subject.email).toBe(EMAIL);
  });

  it("a bad approvalId with no identifiers is 400 approval_id_invalid; no approvalId and no identifiers is 400 subject_invalid", async () => {
    expect(await refusal(ctl.command(req, reply() as never, T, "erase", { approvalId: "x" }))).toEqual({ status: 400, reason: "approval_id_invalid" });
    expect(await refusal(ctl.command(req, reply() as never, T, "erase", { approvalId: "" }))).toEqual({ status: 400, reason: "subject_invalid" });
    expect(executeAgencyPrivacyRequest).not.toHaveBeenCalled();
    expect(fileAgencyPrivacyRequest).not.toHaveBeenCalled();
  });
});

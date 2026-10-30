import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-5g (BFF §63.28): the audit writes. Each action is one request to the contract's own route with the contract's own body; a refusal comes back as data with its words, and a 403 says who may;
// "Draft with AI" makes the ai-summary request and NO write.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), getMe: vi.fn(async () => ({ userId: "u-1" })), platformFetch: vi.fn() }));

import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { platformFetch, PlatformError } from "./platform";
import { REFUSAL_WORDS } from "./socialPipeline";
import { ATTACH_REASON, PROSPECT_WRITE_REASON } from "./socialAudit";
import { attachAudit, deleteAudit, finalizeAudit, proposeAuditSummary, saveAudit, startClientAudit, startProspectAudit } from "./socialAuditActions";

const B = "/api/co-a/modules/social";
const NEW = "11111111-1111-4111-8111-111111111111";
const audit = { id: "a1", subject: "client", status: "draft", name: "Northwind Traders", dimensions: [], canWrite: true, canFinalize: true };
const calls = () => vi.mocked(platformFetch).mock.calls.map((c) => [String((c[2] as { method?: string } | undefined)?.method ?? "GET"), c[0]]);
const body = (i = 0) => JSON.parse(String((vi.mocked(platformFetch).mock.calls[i][2] as { body: string }).body));

beforeEach(() => {
  vi.mocked(platformFetch).mockReset().mockResolvedValue({ audit, created: true });
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-a");
});

describe("the writes", () => {
  it("start: POST audits for a client with the click's id and no month (the server's last full month), and for a prospect with its own body", async () => {
    const r = await startClientAudit("e1", NEW);
    expect(calls()).toEqual([["POST", `${B}/audits`]]);
    expect(body()).toEqual({ id: NEW, subject: "client", engagementId: "e1" });
    expect(r).toMatchObject({ ok: true, created: true, audit: { id: "a1" } });
    const pb = { id: NEW, subject: "prospect", prospectName: "Quay Coffee" };
    await startProspectAudit(pb);
    expect(body(1)).toEqual(pb);
  });
  it("save: PATCH audits/:id with exactly the body, and a null score entry is passed through as Use automatic", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ audit });
    await saveAudit("a 1", { scores: { stories: null }, summary: "S", summaryVia: "typed" });
    expect(calls()).toEqual([["PATCH", `${B}/audits/a%201`]]);
    expect(body()).toEqual({ scores: { stories: null }, summary: "S", summaryVia: "typed" });
  });
  it("finalize and attach are POSTs to their own routes; a replay says alreadyApplied", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ alreadyApplied: true, audit });
    expect(await finalizeAudit("a1")).toMatchObject({ ok: true, alreadyApplied: true });
    await attachAudit("a1", "e2");
    expect(calls()).toEqual([["POST", `${B}/audits/a1/finalize`], ["POST", `${B}/audits/a1/attach`]]);
    expect(body(1)).toEqual({ engagementId: "e2" });
  });
  it("delete: DELETE audits/:id", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ deleted: true, id: "a1" });
    expect(await deleteAudit("a1")).toEqual({ ok: true });
    expect(calls()).toEqual([["DELETE", `${B}/audits/a1`]]);
  });
  it("Draft with AI asks for a proposal and WRITES NOTHING: one POST to ai-summary, no PATCH", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ summary: "Northwind scores 62 out of 100.", draftedVia: "template" });
    const r = await proposeAuditSummary("a1");
    expect(calls()).toEqual([["POST", `${B}/audits/a1/ai-summary`]]);
    expect(r).toEqual({ ok: true, proposal: { summary: "Northwind scores 62 out of 100.", draftedVia: "template" } });
  });
});

describe("refusals come back as data, in words", () => {
  it("a 403 says who may", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "not_a_social_approver"));
    expect(await startProspectAudit({})).toMatchObject({ ok: false, refusal: { status: 403 }, message: REFUSAL_WORDS.not_a_social_approver });
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "not_officer_or_approver"));
    expect(await saveAudit("a1", {})).toMatchObject({ ok: false, message: REFUSAL_WORDS.not_officer_or_approver });
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "forbidden"));
    expect(await attachAudit("a1", "e2")).toMatchObject({ ok: false, message: expect.stringContaining(ATTACH_REASON) });
    expect(await startProspectAudit({})).toMatchObject({ ok: false, message: expect.stringContaining(PROSPECT_WRITE_REASON) });
  });
  it("a final audit, an attached prospect and a missing audit are the contract's words, each in a sentence", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "audit_final"));
    expect(await saveAudit("a1", {})).toMatchObject({ ok: false, message: REFUSAL_WORDS.audit_final });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "audit_final"));
    expect(await deleteAudit("a1")).toMatchObject({ ok: false, message: REFUSAL_WORDS.audit_final });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "audit_attached"));
    expect(await attachAudit("a1", "e2")).toMatchObject({ ok: false, message: REFUSAL_WORDS.audit_attached });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "not_a_prospect_audit"));
    expect(await attachAudit("a1", "e2")).toMatchObject({ ok: false, message: REFUSAL_WORDS.not_a_prospect_audit });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "audit_not_found"));
    expect(await finalizeAudit("a1")).toMatchObject({ ok: false, message: REFUSAL_WORDS.audit_not_found });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "audit_final"));
    expect(await proposeAuditSummary("a1")).toMatchObject({ ok: false, refusal: { status: 409 } });
  });
  it("a 400 names the dimension or the field", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "missing_field", "scores.stories.note"));
    expect(await saveAudit("a1", {})).toMatchObject({ ok: false, refusal: { field: "scores.stories.note" }, message: expect.stringMatching(/needs a note saying why/) });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "invalid_field", "prospectName"));
    expect(await startProspectAudit({})).toMatchObject({ ok: false, message: expect.stringMatching(/name/) });
  });
  it("a signed-out person or a person with no company gets a refusal, not a request", async () => {
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null as never);
    expect(await finalizeAudit("a1")).toMatchObject({ ok: false, refusal: { error: "session_expired" } });
    vi.mocked(getActiveTenant).mockResolvedValueOnce(null as never);
    expect(await finalizeAudit("a1")).toMatchObject({ ok: false, refusal: { error: "no_company" } });
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

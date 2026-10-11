// M5-P1-c — the pipeline routes' authorization wiring, NO database. `authorize` is mocked so each test can
// say exactly which Cerbos action a caller lacks; the services are mocked so a test can prove they were NEVER
// reached after a refusal. The real Cerbos matrix (viewer / member / manager / company_admin, cross-company)
// is driven in agency-pipeline-routes.db.test.ts on the Linux gate.
//
// Every denial below sends a VALID body (including a valid `deal`), so a validation 400 can never stand in
// for the 403 under test: the services are mocked to throw a 400 if they are ever called, and the assertion
// is that the refusal is the 403 and the service was not called.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";

const authorize = vi.fn<(...a: unknown[]) => unknown>();
const writeActivity = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock("./http", () => ({ authorize: (...a: unknown[]) => authorize(...a), writeActivity: (...a: unknown[]) => writeActivity(...a) }));

const moveLeadStage = vi.fn<(...a: unknown[]) => unknown>();
const setLeadDeal = vi.fn<(...a: unknown[]) => unknown>();
const listStageHistory = vi.fn<(...a: unknown[]) => unknown>();
const readPipelineReference = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("./agency-lead-pipeline.service", async (orig) => ({
  ...(await orig<typeof import("./agency-lead-pipeline.service")>()),
  moveLeadStage: (...a: unknown[]) => moveLeadStage(...a),
  setLeadDeal: (...a: unknown[]) => setLeadDeal(...a),
  listStageHistory: (...a: unknown[]) => listStageHistory(...a),
  readPipelineReference: (...a: unknown[]) => readPipelineReference(...a),
}));

const convertAgencyLead = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("./agency-lead-convert.service", async (orig) => ({
  ...(await orig<typeof import("./agency-lead-convert.service")>()),
  convertAgencyLead: (...a: unknown[]) => convertAgencyLead(...a),
}));
vi.mock("./client-notify", () => ({ notifyBestEffort: vi.fn(async () => undefined) }));

import { AgencyLeadsController } from "./agency-leads.controller";
import { AgencyLeadConvertController } from "./agency-lead-convert.controller";

const T = "11111111-1111-4111-8111-111111111111";
const L = "22222222-2222-4222-8222-222222222222";
const req = { principal: { userId: "u-1" } } as never;
const DEAL = { value: "15000000", currency: "IDR" };

/** Makes `authorize` refuse exactly the named actions (a 403, like the real one). */
function denyActions(...denied: string[]) {
  authorize.mockImplementation(async (_p: unknown, _r: unknown, action: unknown) => {
    if (denied.includes(String(action))) throw new ForbiddenException(`denied: ${action}`);
  });
}
const actionsAsked = () => authorize.mock.calls.map((c) => c[2]);

const leads = new AgencyLeadsController();
const convert = new AgencyLeadConvertController();

beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockImplementation(async () => undefined);
  // If a refused request ever reaches a service, the test would otherwise pass on whatever the mock returns.
  moveLeadStage.mockImplementation(async () => { throw new BadRequestException("SERVICE REACHED"); });
  setLeadDeal.mockImplementation(async () => { throw new BadRequestException("SERVICE REACHED"); });
  convertAgencyLead.mockImplementation(async () => { throw new BadRequestException("SERVICE REACHED"); });
});

describe("POST …/stage — triage, plus update when a deal rides along", () => {
  it("asks `triage` only for a plain move, with the lead id in the resource", async () => {
    moveLeadStage.mockResolvedValue({ outcome: "ok", id: L, stage: "contacted", changed: true, stageEventId: "ev-1", dealValue: null, dealCurrency: null });
    const r = await leads.moveStage(req, T, L, { stage: "contacted" });
    expect(actionsAsked()).toEqual(["triage"]);
    expect(authorize.mock.calls[0][1]).toMatchObject({ kind: "agency_lead", tenantId: T, id: L, module: "agency" });
    expect(r).toEqual({ id: L, stage: "contacted", changed: true, stageEventId: "ev-1" });
    expect(writeActivity).toHaveBeenCalledWith(T, "u-1", "stage_moved", "agency_lead", L, { stage: "contacted", stageEventId: "ev-1" });
  });

  it("a caller WITHOUT triage is refused (403) with a valid body, and the service is never reached", async () => {
    denyActions("triage");
    await expect(leads.moveStage(req, T, L, { stage: "contacted" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(moveLeadStage).not.toHaveBeenCalled();
  });

  it("a deal on the move ALSO asks `update`, after `triage`", async () => {
    moveLeadStage.mockResolvedValue({ outcome: "ok", id: L, stage: "proposal", changed: true, stageEventId: "ev-2", dealValue: "15000000.0000", dealCurrency: "IDR" });
    await leads.moveStage(req, T, L, { stage: "proposal", deal: DEAL });
    expect(actionsAsked()).toEqual(["triage", "update"]);
  });

  it("HAND-OFF 1: triage without update is refused for the deal part (403, valid body, valid deal), service never reached", async () => {
    denyActions("update");
    await expect(leads.moveStage(req, T, L, { stage: "proposal", deal: DEAL })).rejects.toBeInstanceOf(ForbiddenException);
    expect(actionsAsked()).toEqual(["triage", "update"]);
    expect(moveLeadStage).not.toHaveBeenCalled();
    // and the same caller may still move WITHOUT a deal
    moveLeadStage.mockResolvedValue({ outcome: "ok", id: L, stage: "proposal", changed: false, dealValue: null, dealCurrency: null });
    await expect(leads.moveStage(req, T, L, { stage: "proposal" })).resolves.toEqual({ id: L, stage: "proposal", changed: false });
  });

  it("an explicit `deal: null` is not a deal, so it asks triage only", async () => {
    moveLeadStage.mockResolvedValue({ outcome: "ok", id: L, stage: "qualified", changed: true, stageEventId: "e", dealValue: null, dealCurrency: null });
    await leads.moveStage(req, T, L, { stage: "qualified", deal: null });
    expect(actionsAsked()).toEqual(["triage"]);
  });

  it("an unchanged move writes no activity and returns no stageEventId", async () => {
    moveLeadStage.mockResolvedValue({ outcome: "ok", id: L, stage: "qualified", changed: false, dealValue: null, dealCurrency: null });
    const r = await leads.moveStage(req, T, L, { stage: "qualified" });
    expect(r).toEqual({ id: L, stage: "qualified", changed: false });
    expect(r).not.toHaveProperty("stageEventId");
    expect(writeActivity).not.toHaveBeenCalled();
  });

  it("an unknown lead is a 404 (distinct from the 403 above); typed service refusals pass through untouched", async () => {
    moveLeadStage.mockResolvedValue({ outcome: "not_found" });
    await expect(leads.moveStage(req, T, L, { stage: "contacted" })).rejects.toBeInstanceOf(NotFoundException);
    const typed = new BadRequestException({ message: "x", reason: "stage_terminal" });
    moveLeadStage.mockRejectedValue(typed);
    await expect(leads.moveStage(req, T, L, { stage: "won" })).rejects.toBe(typed);
  });
});

describe("POST …/deal — update", () => {
  it("asks `update` (not triage) and returns the value as a decimal string", async () => {
    setLeadDeal.mockResolvedValue({ outcome: "ok", id: L, changed: true, dealValue: "10.2500", dealCurrency: "USD" });
    const r = await leads.setDeal(req, T, L, { value: "10.25", currency: "USD" });
    expect(actionsAsked()).toEqual(["update"]);
    expect(r).toEqual({ id: L, changed: true, dealValue: "10.2500", dealCurrency: "USD" });
  });

  it("HAND-OFF 2: a change is audited with writeActivity (set vs cleared); an unchanged write is not", async () => {
    setLeadDeal.mockResolvedValueOnce({ outcome: "ok", id: L, changed: true, dealValue: "10.2500", dealCurrency: "USD" });
    await leads.setDeal(req, T, L, { value: "10.25", currency: "USD" });
    expect(writeActivity).toHaveBeenLastCalledWith(T, "u-1", "deal_set", "agency_lead", L, { dealValue: "10.2500", dealCurrency: "USD" });

    setLeadDeal.mockResolvedValueOnce({ outcome: "ok", id: L, changed: true, dealValue: null, dealCurrency: null });
    await leads.setDeal(req, T, L, { value: null, currency: null });
    expect(writeActivity).toHaveBeenLastCalledWith(T, "u-1", "deal_cleared", "agency_lead", L, { dealValue: null, dealCurrency: null });

    writeActivity.mockClear();
    setLeadDeal.mockResolvedValueOnce({ outcome: "ok", id: L, changed: false, dealValue: "10.2500", dealCurrency: "USD" });
    await leads.setDeal(req, T, L, { value: "10.25", currency: "USD" });
    expect(writeActivity).not.toHaveBeenCalled();
  });

  it("a caller WITHOUT update is refused (403) with a valid body, service never reached", async () => {
    denyActions("update");
    await expect(leads.setDeal(req, T, L, { value: "10.25", currency: "USD" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(setLeadDeal).not.toHaveBeenCalled();
  });

  it("a denied caller with an INVALID body still gets the 403, never the validation 400 (authorize first)", async () => {
    denyActions("update");
    await expect(leads.setDeal(req, T, L, { value: "-5", currency: "??" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(setLeadDeal).not.toHaveBeenCalled();
  });

  it("an unknown lead is a 404", async () => {
    setLeadDeal.mockResolvedValue({ outcome: "not_found" });
    await expect(leads.setDeal(req, T, L, { value: "1", currency: "USD" })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("reads — `read`, 403 and 404 stay distinct", () => {
  it("stage-history asks `read` with the lead id and returns the rows as given (newest first is the service's order)", async () => {
    const rows = [{ id: "b", toStage: "proposal" }, { id: "a", toStage: "contacted" }];
    listStageHistory.mockResolvedValue(rows);
    expect(await leads.stageHistory(req, T, L)).toBe(rows);
    expect(actionsAsked()).toEqual(["read"]);
    expect(authorize.mock.calls[0][1]).toMatchObject({ id: L });
  });

  it("stage-history: an invisible lead is 404; a caller who cannot read is 403 and the history is never read", async () => {
    listStageHistory.mockResolvedValue(null);
    await expect(leads.stageHistory(req, T, L)).rejects.toBeInstanceOf(NotFoundException);
    listStageHistory.mockClear();
    denyActions("read");
    await expect(leads.stageHistory(req, T, L)).rejects.toBeInstanceOf(ForbiddenException);
    expect(listStageHistory).not.toHaveBeenCalled();
  });

  it("reference asks tenant-wide `read` (no id) and a denial never becomes empty lists", async () => {
    const ref = { stages: [], currencies: [] };
    readPipelineReference.mockResolvedValue(ref);
    expect(await leads.pipelineReference(req, T)).toBe(ref);
    expect(authorize.mock.calls[0][1]).not.toHaveProperty("id");
    readPipelineReference.mockClear();
    denyActions("read");
    await expect(leads.pipelineReference(req, T)).rejects.toBeInstanceOf(ForbiddenException);
    expect(readPipelineReference).not.toHaveBeenCalled();
  });
});

describe("POST …/convert — convert, plus update when a deal rides along", () => {
  const CONVERTED = {
    outcome: "converted", clientId: "c", projectId: "p", runId: "r", ownerId: null, contactUserId: null, orgName: "Org",
    delegations: [], stageEventId: "ev", dealValue: "15000000.0000", dealCurrency: "IDR",
  };

  it("a deal asks `convert` then `update`, passes the NORMALIZED deal to the service, and returns the value", async () => {
    convertAgencyLead.mockResolvedValue(CONVERTED);
    const r = await convert.convert(req, T, L, { deal: { value: 15000000, currency: "idr" } });
    expect(actionsAsked()).toEqual(["convert", "update"]);
    expect(convertAgencyLead.mock.calls[0][0]).toMatchObject({ tenantId: T, leadId: L, deal: { value: "15000000", currency: "IDR" } });
    expect(r).toMatchObject({ status: "converted", dealValue: "15000000.0000", dealCurrency: "IDR" });
  });

  it("no deal asks `convert` only, and passes deal undefined (leave the value alone)", async () => {
    convertAgencyLead.mockResolvedValue({ ...CONVERTED, dealValue: null, dealCurrency: null });
    await convert.convert(req, T, L, {});
    expect(actionsAsked()).toEqual(["convert"]);
    expect((convertAgencyLead.mock.calls[0][0] as { deal?: unknown }).deal).toBeUndefined();
  });

  it("HAND-OFF 1: convert without update is refused for the deal part (403, valid body), service never reached", async () => {
    denyActions("update");
    await expect(convert.convert(req, T, L, { deal: DEAL })).rejects.toBeInstanceOf(ForbiddenException);
    expect(convertAgencyLead).not.toHaveBeenCalled();
  });

  it("a caller without convert is refused (403) whatever the body; an invalid deal for a caller who may convert is a typed 400", async () => {
    denyActions("convert");
    await expect(convert.convert(req, T, L, { deal: DEAL })).rejects.toBeInstanceOf(ForbiddenException);
    expect(actionsAsked()).toEqual(["convert"]); // update was never even asked
    authorize.mockImplementation(async () => undefined);
    await expect(convert.convert(req, T, L, { deal: { value: "1500.5x", currency: "IDR" } })).rejects.toMatchObject({
      response: { reason: "deal_value_invalid" },
    });
    expect(convertAgencyLead).not.toHaveBeenCalled();
  });
});

describe("hand-off 4: the staff-create activity carries no personal data", () => {
  it("writeActivity for a staff-created lead names the source only (no orgName)", async () => {
    const svc = await import("./agency-leads.service");
    vi.spyOn(svc, "createStaffLead").mockResolvedValue({ id: L });
    await leads.create(req, T, { orgName: "Sole Trader Bali", contactEmail: "a@b.test" });
    expect(writeActivity).toHaveBeenCalledWith(T, "u-1", "created", "agency_lead", L, { source: "staff" });
    expect(JSON.stringify(writeActivity.mock.calls)).not.toContain("Sole Trader");
  });
});

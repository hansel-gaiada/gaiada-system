// GH-12 — origin 'github' (a repo-creation request) must be known to BOTH approvals surfaces. No DB: the façade's routing is
// checked against a mocked automation-approvals controller, the union and weight against the urgency module. The DB/Cerbos
// behaviour (inbox listing, real gates, the executor) lives in approvals.test.ts / approvals-decide.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("./automation-approvals.controller", () => ({
  AutomationApprovalsController: class { decide = decideMock; },
}));
vi.mock("../modules/agency/agency.controller", () => ({ AgencyController: class { decide = vi.fn(); } }));
vi.mock("./pipeline.controller", () => ({ PipelineController: class { decideGate = vi.fn(); } }));
vi.mock("../modules/registry", () => ({ isModuleEnabled: vi.fn(async () => true) }));

import { ApprovalsDecideController } from "./approvals-decide.controller";
import { ORIGIN_BASE_WEIGHT, urgencyScore } from "./approvals-urgency";

const req = { principal: { userId: "u1" } } as never;

describe("origin github: the decide façade", () => {
  const ctl = new ApprovalsDecideController();
  beforeEach(() => { decideMock.mockReset(); });

  it("routes github to the automation-approvals controller with the decision (which re-derives the real origin and runs the executor)", async () => {
    decideMock.mockResolvedValue({ id: "a1", status: "approved", github: { fullName: "o/r" } });
    const out = await ctl.decide(req, "t1", "a1", { origin: "github", decision: "approved", note: "n" });
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(decideMock).toHaveBeenCalledWith(req, "t1", "a1", { decision: "approved" });
    expect(out).toEqual({ ok: true });
  });

  it("a reject is routed the same way", async () => {
    decideMock.mockResolvedValue({ id: "a1", status: "rejected" });
    expect(await ctl.decide(req, "t1", "a1", { origin: "github", decision: "rejected" })).toEqual({ ok: true });
    expect(decideMock).toHaveBeenCalledWith(req, "t1", "a1", { decision: "rejected" });
  });

  it("an authorization denial from the origin controller propagates (the façade adds no softer path)", async () => {
    decideMock.mockImplementation(async () => { throw new ForbiddenException("not authorized"); });
    let caught: unknown;
    try { await ctl.decide(req, "t1", "a1", { origin: "github", decision: "approved" }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ForbiddenException);
  });

  it("an unknown origin is still a 400 and reaches no controller", async () => {
    await expect(ctl.decide(req, "t1", "a1", { origin: "gitlab", decision: "approved" })).rejects.toBeInstanceOf(BadRequestException);
    expect(decideMock).not.toHaveBeenCalled();
  });
});

describe("origin github: urgency", () => {
  it("has a base weight alongside automation/agent/webdesk, below pipeline, and a high-impact row outranks a routine one", () => {
    expect(ORIGIN_BASE_WEIGHT.github).toBe(80);
    expect(ORIGIN_BASE_WEIGHT.github).toBe(ORIGIN_BASE_WEIGHT.webdesk);
    expect(ORIGIN_BASE_WEIGHT.github).toBeLessThan(ORIGIN_BASE_WEIGHT.pipeline);
    expect(urgencyScore("github", 0, "high")).toBeGreaterThan(urgencyScore("github", 0, "unclassified"));
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./experiments", () => ({ expCtx: vi.fn(), expCall: vi.fn() }));
import { expCall, expCtx } from "./experiments";
import { abortExperimentAction, decideExperimentAction, registerExperimentAction, stopExperimentAction, syncExperimentAction } from "./experimentsActions";
import { EMPTY_FORM } from "./experimentsModel";

const P = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const call = vi.mocked(expCall);
const form = { ...EMPTY_FORM, key: "hero", hypothesis: "h", itemId: E, sectionId: "hero" };
const scope = { tenantSlug: "g", siteId: "s" };
beforeEach(() => { call.mockReset(); vi.mocked(expCtx).mockResolvedValue({ userId: "u", company: "co" }); });

describe("experiments actions: a refusal is words, never a token", () => {
  it("register: underpowered shows days against the cap", async () => {
    call.mockResolvedValue({ ok: false, status: 422, token: "underpowered", existing: { projectedDays: 90, maxDays: 56, nPerArm: 4000, dailyUnits: 30 } });
    const r = await registerExperimentAction(P, scope, form);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/90 days/);
    expect(r.message).toMatch(/56 days/);
    expect(r.message).not.toMatch(/underpowered|422/);
  });
  it("register: a bad form never reaches the API", async () => {
    const r = await registerExperimentAction(P, scope, { ...form, key: "" });
    expect(r.ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
  it("register: ok says the plan size", async () => {
    call.mockResolvedValue({ ok: true, data: { experiment: {
      id: E, propertyId: P, key: "hero", status: "draft", hypothesis: "h", item: { tenantSlug: "g", siteId: "s", itemId: "i", collectionKey: "pages", locale: "en" }, sectionId: "hero",
      enrolment: "consented", goal: { event: "generate_lead" }, arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }], createdAt: "x", startedAt: null, stoppedAt: null,
      preRegistration: { baselineRate: 0.03, baselineSource: "supplied", relativeMde: 0.2, alpha: 0.05, power: 0.8, nPerArm: 800, dailyUnits: 100, projectedDays: 16, locked: false },
    } } });
    const r = await registerExperimentAction(P, scope, form);
    expect(r).toMatchObject({ ok: true, id: E });
    expect(r.message).toContain("800 visitors per variant");
  });
  it.each([
    ["stop", () => stopExperimentAction(P, E), 409, "horizon_not_reached", /not reached its planned size/],
    ["decide", () => decideExperimentAction(P, E, ""), 409, "experiment_still_live", /still live/],
    ["abort", () => abortExperimentAction(P, E), 409, "already_decided", /already been decided/],
    ["sync", () => syncExperimentAction(P, E), 409, "experiment_closed", /closed/],
    ["register", () => registerExperimentAction(P, scope, form), 409, "too_many_running", /10 tests/],
    ["register", () => registerExperimentAction(P, scope, form), 409, "pre_registration_locked", /cannot change/],
    ["decide", () => decideExperimentAction(P, E, ""), 409, "not_stopped", /stopped test/],
  ])("%s: %s %s", async (_n, run, status, token, words) => {
    call.mockResolvedValue({ ok: false, status, token });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(words);
    expect(r.message).not.toContain(token);
  });
  it("sync: plan_mismatch says what differs and does not count as started", async () => {
    call.mockResolvedValue({ ok: true, data: { state: "plan_mismatch", differences: ["goal", "arms"] } });
    const r = await syncExperimentAction(P, E);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/does not match the registered plan/);
    expect(r.message).toMatch(/the goal, the shares/);
  });
  it("sync: started and not_live are sentences", async () => {
    call.mockResolvedValue({ ok: true, data: { state: "started" } });
    expect(await syncExperimentAction(P, E)).toMatchObject({ ok: true });
    call.mockResolvedValue({ ok: true, data: { state: "not_live" } });
    expect((await syncExperimentAction(P, E)).message).toMatch(/not live on the page yet/);
  });
  it("ids that are not ids never reach the API", async () => {
    expect((await stopExperimentAction("x", E)).ok).toBe(false);
    expect((await stopExperimentAction(P, "../../x")).ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
  it("a note over 500 characters is refused in words", async () => {
    expect((await decideExperimentAction(P, E, "x".repeat(501))).message).toMatch(/500/);
    expect(call).not.toHaveBeenCalled();
  });
  it("the note is sent trimmed, and only when present", async () => {
    call.mockResolvedValue({ ok: true, data: {} });
    await decideExperimentAction(P, E, "  ship it ");
    expect(call).toHaveBeenLastCalledWith(expect.anything(), P, `/${E}/decide`, { note: "ship it" });
    await decideExperimentAction(P, E, " ");
    expect(call).toHaveBeenLastCalledWith(expect.anything(), P, `/${E}/decide`, {});
  });
  it("no session is a sentence", async () => {
    vi.mocked(expCtx).mockResolvedValue(null);
    expect((await stopExperimentAction(P, E)).message).toMatch(/session/);
  });
});

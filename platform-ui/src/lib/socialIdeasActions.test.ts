import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-5 W5-A4 (BFF §63.25.3): the ideas' writes. Each action is one request to the contract's own route with the contract's own body; a refusal comes back as data with its words.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), getMe: vi.fn(async () => ({ userId: "u-1" })), platformFetch: vi.fn() }));

import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { platformFetch, PlatformError } from "./platform";
import { IDEA_WRITE_REASON } from "./socialIdeas";
import { REFUSAL_WORDS } from "./socialPipeline";
import { addIdea, deleteIdea, planIdea, shareIdea } from "./socialIdeasActions";

const B = "/api/co-a/modules/social";
const idea = (over: Record<string, unknown> = {}) => ({ id: "i1", engagementId: "e1", saw: "S", metric: "M", suggestion: "G", status: "proposed", reportId: "r1", post: null, sharedAt: null, sharedBy: null, createdBy: { id: "u-1", name: "Dewi" }, createdAt: "2026-10-02T04:00:00Z", ...over });
const calls = () => vi.mocked(platformFetch).mock.calls.map((c) => [String((c[2] as { method?: string } | undefined)?.method ?? "GET"), c[0]]);
const body = (i = 0) => JSON.parse(String((vi.mocked(platformFetch).mock.calls[i][2] as { body: string }).body));

beforeEach(() => {
  vi.mocked(platformFetch).mockReset().mockResolvedValue({});
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-a");
});

describe("the ideas' writes", () => {
  it("add: POST engagements/:id/ideas with the click's id, the three texts and the report's id", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ idea: idea(), created: true });
    const r = await addIdea("e 1", { saw: "S", metric: "M", suggestion: "G", reportId: "r1" }, "11111111-1111-4111-8111-111111111111");
    expect(calls()).toEqual([["POST", `${B}/engagements/e%201/ideas`]]);
    expect(body()).toEqual({ id: "11111111-1111-4111-8111-111111111111", saw: "S", metric: "M", suggestion: "G", reportId: "r1" });
    expect(r).toMatchObject({ ok: true, idea: { id: "i1", saw: "S" } });
  });
  it("share and delete: the idea's own routes", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ idea: idea({ status: "shared" }) });
    expect(await shareIdea("i 1")).toMatchObject({ ok: true, idea: { status: "shared" } });
    expect(await deleteIdea("i 1")).toEqual({ ok: true });
    expect(calls()).toEqual([["POST", `${B}/ideas/i%201/share`], ["DELETE", `${B}/ideas/i%201`]]);
  });
  it("plan: POST ideas/:id/plan with the picked cycle, answering the idea and its new post", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ idea: idea({ status: "planned", post: { id: "p1", title: "G", pipelineStatus: "planned", cycleMonth: "2026-11" } }), post: { id: "p1", title: "G", cycleId: "c1", cycleMonth: "2026-11" } });
    const r = await planIdea("i1", "c1");
    expect(calls()).toEqual([["POST", `${B}/ideas/i1/plan`]]);
    expect(body()).toEqual({ cycleId: "c1" });
    expect(r).toMatchObject({ ok: true, idea: { status: "planned" }, post: { id: "p1", cycleId: "c1", cycleMonth: "2026-11" } });
  });
  it("a replayed plan (200 alreadyApplied) is the same answer", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ alreadyApplied: true, idea: idea({ status: "planned" }), post: { id: "p1", title: "G", cycleId: "c1", cycleMonth: "2026-11" } });
    expect(await planIdea("i1", "c1")).toMatchObject({ ok: true, post: { id: "p1" } });
  });
});

describe("refusals come back as data, in words", () => {
  it("a 403 says who may write ideas", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "not_officer_or_approver"));
    for (const r of [await addIdea("e1", { saw: "S", metric: "M", suggestion: "G" }, "id"), await shareIdea("i1"), await planIdea("i1", "c1"), await deleteIdea("i1")]) {
      expect(r).toMatchObject({ ok: false, refusal: { status: 403 }, message: `You cannot do this. ${IDEA_WRITE_REASON}` });
    }
  });
  it("a planned idea cannot change, a closed cycle is refused, and a missing idea is gone: each its own sentence", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "idea_planned"));
    expect(await deleteIdea("i1")).toMatchObject({ ok: false, refusal: { status: 409, error: "idea_planned" }, message: REFUSAL_WORDS.idea_planned });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "cycle_closed"));
    expect(await planIdea("i1", "c1")).toMatchObject({ ok: false, message: REFUSAL_WORDS.cycle_closed });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "idea_not_found"));
    expect(await shareIdea("i1")).toMatchObject({ ok: false, message: REFUSAL_WORDS.idea_not_found });
  });
  it("a 400 names the field, and a signed-out person gets a refusal, not a request", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "missing_field", "metric"));
    expect(await addIdea("e1", { saw: "S", metric: null, suggestion: "G" }, "id")).toMatchObject({ ok: false, refusal: { field: "metric" }, message: expect.stringMatching(/metric is required/) });
    vi.mocked(platformFetch).mockReset();
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null as never);
    expect(await shareIdea("i1")).toMatchObject({ ok: false, refusal: { error: "session_expired" } });
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

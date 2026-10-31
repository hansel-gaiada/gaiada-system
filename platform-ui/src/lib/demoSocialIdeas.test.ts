import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-5 W5-A4 (BFF §63.25): DEMO_MODE's twin of the ideas routes, in the server's order of checks (404, 403, 400, 409). The clock is pinned to Friday 16 October 2026 before the stores seed.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { PIPE_ENGAGEMENTS, PIPE_POSTS } from "./demoSocialPipeline";
import { asIdeaList, asIdeaAnswer, actionsFor } from "./socialIdeas";
import { asReportList } from "./socialReports";
import { asPipelinePost } from "./socialPipeline";

const USER = { officer: "u-social", officer2: "u-social-2", hod: "u-pm", client: "demo-client", dev: "u-dev" };
const [NORTH, SPA] = PIPE_ENGAGEMENTS.map((e) => e.id);
const call = (method: string, tail: string, user: string, body?: unknown) =>
  socialDemo(method, `/api/co/modules/social/${tail}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), user)!;
const code = (r: { json: unknown }) => (r.json as { error: string }).error;
const list = (user = USER.officer, eng = NORTH) => asIdeaList(call("GET", `engagements/${eng}/ideas`, user).json);
const north = () => asReportList(call("GET", "reports", USER.hod).json).find((r) => r.clientName === "Northwind Traders" && r.kind === "monthly" && r.period === "2026-09")!;
const NEXT_CYCLE = `soc-cyc-${NORTH}-2026-11`;
const mine = { saw: "Stories drew replies", metric: "Reply rate", suggestion: "Plan two stories" };

describe("the read", () => {
  it("lists Northwind's three seeded ideas, one in each state, newest first, and says who may write", () => {
    const l = list();
    expect(l.items.map((i) => i.status).sort()).toEqual(["planned", "proposed", "shared"]);
    expect(l.canWrite).toBe(true);
    expect(l.items.find((i) => i.status === "planned")!.post).toMatchObject({ pipelineStatus: "planned", cycleMonth: "2026-11" });
    expect(l.items.find((i) => i.status === "shared")!.sharedBy?.name).toBeTruthy();
    expect(l.items.every((i) => i.reportId === north().id)).toBe(true);
    expect(list(USER.hod).canWrite).toBe(true);
    expect(list(USER.officer2).canWrite).toBe(false); // another client's officer reads, never writes
    expect(list(USER.dev).canWrite).toBe(false); // a company admin is not one of the four
    expect(call("GET", `engagements/${NORTH}/ideas`, USER.client).status).toBe(403);
    expect(code(call("GET", "engagements/nope/ideas", USER.officer))).toBe("engagement_not_found");
  });
  it("a post planned from an idea reads its idea, and any other post reads null", () => {
    const planned = list().items.find((i) => i.status === "planned")!;
    const post = asPipelinePost(call("GET", `posts/${planned.post!.id}/pipeline`, USER.officer).json);
    expect(post.idea).toMatchObject({ id: planned.id, saw: planned.saw, suggestion: planned.suggestion });
    expect(asPipelinePost(call("GET", `posts/${PIPE_POSTS.find((p) => !list().items.some((i) => i.post?.id === p.id))!.id}/pipeline`, USER.officer).json).idea).toBeNull();
  });
});

describe("add", () => {
  it("is the client's officer's and the four's: 403 for anyone else, in the server's order (the gate before the body)", () => {
    expect(code(call("POST", `engagements/${NORTH}/ideas`, USER.officer2, mine))).toBe("not_officer_or_approver");
    expect(code(call("POST", `engagements/${NORTH}/ideas`, USER.officer2, {}))).toBe("not_officer_or_approver");
    expect(call("POST", `engagements/${NORTH}/ideas`, USER.client, mine).status).toBe(403);
    expect(call("POST", `engagements/${NORTH}/ideas`, USER.officer, mine).status).toBe(201);
    expect(call("POST", `engagements/${SPA}/ideas`, USER.hod, mine).status).toBe(201);
  });
  it("carries the report's id, answers created, and a replayed id is the same idea", () => {
    const body = { ...mine, id: "demo-idea-1", reportId: north().id };
    const first = call("POST", `engagements/${NORTH}/ideas`, USER.officer, body);
    expect(first.json).toMatchObject({ created: true, idea: { id: "demo-idea-1", status: "proposed", reportId: north().id, metric: "Reply rate" } });
    const again = call("POST", `engagements/${NORTH}/ideas`, USER.officer, body);
    expect(again.json).toMatchObject({ created: false, idea: { id: "demo-idea-1" } });
    expect(asIdeaAnswer({ idea: (again.json as { idea: unknown }).idea }).saw).toBe("Stories drew replies");
    expect(list().items.filter((i) => i.id === "demo-idea-1")).toHaveLength(1);
    expect(code(call("POST", `engagements/${SPA}/ideas`, USER.hod, body))).toBe("invalid_field"); // that id is another client's
  });
  it("checks the body: what we saw and what we suggest are required, the metric is required by the seed's rule, lengths hold, the report must be the client's monthly", () => {
    const bad = (b: Record<string, unknown>) => call("POST", `engagements/${NORTH}/ideas`, USER.officer, b).json as { error: string; field: string };
    expect(bad({ ...mine, saw: " " })).toMatchObject({ error: "missing_field", field: "saw" });
    expect(bad({ ...mine, metric: undefined })).toMatchObject({ error: "missing_field", field: "metric" });
    expect(bad({ ...mine, suggestion: undefined })).toMatchObject({ error: "missing_field", field: "suggestion" });
    expect(bad({ ...mine, saw: "x".repeat(501) })).toMatchObject({ error: "invalid_field", field: "saw" });
    expect(bad({ ...mine, metric: "x".repeat(301) })).toMatchObject({ field: "metric" });
    expect(bad({ ...mine, reportId: "soc-rep-nope" })).toMatchObject({ error: "invalid_field", field: "reportId" });
  });
});

describe("share, plan and delete", () => {
  const fresh = (): string => (call("POST", `engagements/${NORTH}/ideas`, USER.officer, mine).json as { idea: { id: string } }).idea.id;

  it("share moves a proposed idea to shared, answers alreadyApplied on a shared one, and refuses a planned one", () => {
    const id = fresh();
    expect(call("POST", `ideas/${id}/share`, USER.officer).json).toMatchObject({ idea: { status: "shared", sharedBy: { id: USER.officer } } });
    expect(call("POST", `ideas/${id}/share`, USER.officer).json).toMatchObject({ alreadyApplied: true });
    const planned = list().items.find((i) => i.status === "planned")!;
    expect(code(call("POST", `ideas/${planned.id}/share`, USER.officer))).toBe("idea_planned");
  });
  it("is 404 for an idea that is not there, but only after the gate on a would-be post with no officer (the four pass it; an officer does not, so an id is never a free probe), and 403 for another client's officer", () => {
    expect(code(call("POST", "ideas/nope/share", USER.hod))).toBe("idea_not_found");
    expect(code(call("POST", "ideas/nope/share", USER.officer))).toBe("not_officer_or_approver");
    expect(code(call("POST", "ideas/nope/share", USER.officer2))).toBe("not_officer_or_approver");
    expect(code(call("POST", `ideas/${fresh()}/share`, USER.officer2))).toBe("not_officer_or_approver");
  });
  it("plan makes a planned post of the picked cycle, links both ways, and a replay answers alreadyApplied with the same post", () => {
    const id = fresh();
    const made = call("POST", `ideas/${id}/plan`, USER.officer, { cycleId: NEXT_CYCLE });
    expect(made.status).toBe(201);
    const j = made.json as { idea: { status: string; post: { id: string } }; post: { id: string; cycleMonth: string } };
    expect(j.idea.status).toBe("planned");
    expect(j.post).toMatchObject({ cycleMonth: "2026-11", title: "Plan two stories" });
    expect(j.idea.post.id).toBe(j.post.id);
    // the post is a real planned post of the pipeline, and reads its idea
    const post = asPipelinePost(call("GET", `posts/${j.post.id}/pipeline`, USER.officer).json);
    expect(post).toMatchObject({ pipelineStatus: "planned", cycleMonth: "2026-11", angle: "From an idea: Stories drew replies (Reply rate)" });
    expect(post.idea?.id).toBe(id);
    const replay = call("POST", `ideas/${id}/plan`, USER.officer, { cycleId: NEXT_CYCLE });
    expect([replay.status, (replay.json as { alreadyApplied: boolean }).alreadyApplied, (replay.json as { post: { id: string } }).post.id]).toEqual([200, true, j.post.id]);
    expect(code(call("POST", `ideas/${id}/plan`, USER.officer, { cycleId: `soc-cyc-${NORTH}-2026-10` }))).toBe("idea_planned"); // planned in another cycle
  });
  it("plan refuses a missing or another client's cycle, and a cycle whose month is over", () => {
    const id = fresh();
    expect(call("POST", `ideas/${id}/plan`, USER.officer, {}).json).toMatchObject({ error: "invalid_field", field: "cycleId" });
    expect(code(call("POST", `ideas/${id}/plan`, USER.officer, { cycleId: "soc-cyc-nope" }))).toBe("cycle_not_found");
    expect(code(call("POST", `ideas/${id}/plan`, USER.officer, { cycleId: `soc-cyc-${SPA}-2026-11` }))).toBe("cycle_not_found");
    expect(code(call("POST", `ideas/${id}/plan`, USER.officer, { cycleId: `soc-cyc-${NORTH}-2026-09` }))).toBe("cycle_closed");
    expect(list().items.find((i) => i.id === id)!.status).toBe("proposed"); // a refused plan leaves the idea as it was
  });
  it("delete removes a proposed or shared idea, and refuses a planned one", () => {
    const id = fresh();
    expect(call("DELETE", `ideas/${id}`, USER.officer).json).toEqual({ deleted: true, id });
    expect(list().items.map((i) => i.id)).not.toContain(id);
    expect(code(call("DELETE", `ideas/${id}`, USER.hod))).toBe("idea_not_found");
    const planned = list().items.find((i) => i.status === "planned")!;
    expect(code(call("DELETE", `ideas/${planned.id}`, USER.officer))).toBe("idea_planned");
  });
  it("what the page draws follows the state and the read's canWrite", () => {
    const l = list();
    const by = (s: string) => l.items.find((i) => i.status === s)!;
    expect(actionsFor(by("proposed"), l.canWrite)).toEqual({ plan: true, share: true, remove: true });
    expect(actionsFor(by("planned"), l.canWrite)).toEqual({ plan: false, share: false, remove: false });
    expect(actionsFor(by("proposed"), list(USER.officer2).canWrite).remove).toBe(false);
  });
});

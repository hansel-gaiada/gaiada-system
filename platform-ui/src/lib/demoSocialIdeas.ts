import "server-only";
// SCP-5 W5-A4 (BFF §63.25) — what DEMO_MODE answers for "Ideas for next month", in the server's order of checks (`pipeline/ideas.service.ts`):
//
//   GET     engagements/:engagementId/ideas   {items, canWrite}        POST  engagements/:engagementId/ideas   201 {idea, created}
//   POST    ideas/:ideaId/share               proposed -> shared        POST  ideas/:ideaId/plan {cycleId}      201 {idea, post}, a replay 200 {alreadyApplied}
//   DELETE  ideas/:ideaId                     {deleted, id}
//
// THE GATE is the client's would-be post (63.25.2): the client's officer and the four approvers write; anyone else is 403 `not_officer_or_approver`, a client contact the plain 403. Reading is any staff
// member. THE ORDER of every write: the idea or client (404), the gate (403), the body (400 `missing_field` / `invalid_field` + `field`), then the idea's state (409 `idea_planned`). "Add to next plan" makes a
// real `planned` post of the picked cycle through the pipeline store's own create (so the next read of the pipeline shows it), links it both ways, and a post made so reads its idea (`idea`). The company's
// metric rule is the seed's: required. An idea has no `simulated` mark (it is typed text). Discarding the planned post frees its idea (`releaseIdeaOfPost`, hooked into the pipeline's `release_idea` effect); archiving does not.
//
// THE DATA is invented: Northwind's report for last month has an idea in each state, the planned one in next month's cycle.
import { PIPE_ENGAGEMENTS, PIPE_POSTS, allocStore, cyclesStore, demoCreatePost, demoMonthShift, isClientContact, isDemoSocialApprover, setDemoIdeaReader, who, type DemoResult } from "./demoSocialPipeline";
import { setDemoPostDiscardHook } from "./demoSocialPipelineRun";
import { demoReports } from "./demoSocialReports";
import { todayIsoInDisplayZone } from "./format";
import { METRIC_MAX, SAW_MAX, SUGGESTION_MAX } from "./socialIdeas";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const ID = /^[\w-]{1,64}$/;
const charLen = (s: string): number => [...s].length;

export interface IdeaRec {
  id: string; engagementId: string; saw: string; metric: string | null; suggestion: string; status: "proposed" | "shared" | "planned"; reportId: string | null;
  postId: string | null; cycleId: string | null; sharedAt: string | null; sharedBy: string | null; createdBy: string; createdAt: string; deleted: boolean;
}
export interface IdeaStore { ideas: IdeaRec[]; seq: number }

const KEY = Symbol.for("gaiada.demoSocial.ideas");
const store: IdeaStore = ((globalThis as Record<symbol, unknown>)[KEY] ??= { ideas: [], seq: 0 }) as IdeaStore;
export const demoIdeaStore = store;

const officerOf = (engagementId: string): string | null => allocStore.byEngagement[engagementId]?.officerId ?? null;
const engagementOf = (id: string) => PIPE_ENGAGEMENTS.find((e) => e.id === id && e.status !== "closed");
const mayWrite = (userId: string, engagementId: string): boolean => !isClientContact(userId) && (isDemoSocialApprover(userId) || officerOf(engagementId) === userId);
const denied = (userId: string): DemoResult => (isClientContact(userId) ? err(403, "not authorized: cerbos denied create on social_post") : err(403, "not_officer_or_approver"));

function answer(i: IdeaRec) {
  const post = i.postId ? PIPE_POSTS.find((p) => p.id === i.postId) : undefined;
  return {
    id: i.id, engagementId: i.engagementId, saw: i.saw, metric: i.metric, suggestion: i.suggestion, status: i.status, reportId: i.reportId,
    post: post ? { id: post.id, title: post.title, pipelineStatus: post.pipelineStatus, cycleMonth: post.cycleMonth } : null,
    sharedAt: i.sharedAt, sharedBy: i.sharedBy ? who(i.sharedBy) : null, createdBy: who(i.createdBy), createdAt: i.createdAt,
  };
}
const live = (id: string): IdeaRec | undefined => store.ideas.find((i) => i.id === id && !i.deleted);
const parse = (body: string | undefined): Record<string, unknown> => { try { return body ? (JSON.parse(body) as Record<string, unknown>) : {}; } catch { return {}; } };

function text(v: unknown, field: string, max: number): DemoResult | string {
  if (v === undefined || v === null) return err(400, "missing_field", { field });
  if (typeof v !== "string") return err(400, "invalid_field", { field });
  const t = v.trim();
  if (t === "") return err(400, "missing_field", { field });
  return charLen(t) > max ? err(400, "invalid_field", { field }) : t;
}

function list(engagementId: string, userId: string): DemoResult {
  if (isClientContact(userId)) return err(403, "not authorized: cerbos denied read on social_post");
  if (!engagementOf(engagementId)) return err(404, "engagement_not_found");
  const items = store.ideas.filter((i) => i.engagementId === engagementId && !i.deleted).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(answer);
  return ok({ items, canWrite: mayWrite(userId, engagementId) });
}

function create(engagementId: string, body: string | undefined, userId: string): DemoResult {
  const e = engagementOf(engagementId);
  if (!e) return mayWrite(userId, "") ? err(404, "engagement_not_found") : denied(userId);
  if (!mayWrite(userId, engagementId)) return denied(userId);
  const b = parse(body);
  if (b.id !== undefined && b.id !== null && (typeof b.id !== "string" || !ID.test(b.id))) return err(400, "invalid_field", { field: "id" });
  const saw = text(b.saw, "saw", SAW_MAX);
  if (typeof saw !== "string") return saw;
  let metric: string | null = null;
  if (b.metric !== undefined && b.metric !== null) {
    if (typeof b.metric !== "string") return err(400, "invalid_field", { field: "metric" });
    const t = b.metric.trim();
    if (charLen(t) > METRIC_MAX) return err(400, "invalid_field", { field: "metric" });
    metric = t === "" ? null : t;
  }
  if (metric === null) return err(400, "missing_field", { field: "metric" }); // the seed's rule: the metric is required
  const suggestion = text(b.suggestion, "suggestion", SUGGESTION_MAX);
  if (typeof suggestion !== "string") return suggestion;
  let reportId: string | null = null;
  if (b.reportId !== undefined && b.reportId !== null) {
    const rep = typeof b.reportId === "string" ? demoReports.find(b.reportId) : undefined;
    if (!rep || rep.kind !== "monthly" || rep.engagementId !== engagementId) return err(400, "invalid_field", { field: "reportId" });
    reportId = rep.id;
  }
  const taken = typeof b.id === "string" ? store.ideas.find((i) => i.id === b.id) : undefined;
  if (taken) return taken.engagementId !== engagementId || taken.deleted ? err(400, "invalid_field", { field: "id" }) : ok({ idea: answer(taken), created: false }, 201);
  store.seq += 1;
  const rec: IdeaRec = {
    id: typeof b.id === "string" ? b.id : `soc-idea-${store.seq}`, engagementId, saw, metric, suggestion, status: "proposed", reportId, postId: null, cycleId: null,
    sharedAt: null, sharedBy: null, createdBy: userId, createdAt: new Date().toISOString(), deleted: false,
  };
  store.ideas.push(rec);
  return ok({ idea: answer(rec), created: true }, 201);
}

/** The idea, or the 404 after the gate on a would-be post with no officer (an id is never a free probe), and the gate on the idea's client. */
function guard(ideaId: string, userId: string): { idea: IdeaRec } | DemoResult {
  const idea = live(ideaId);
  if (!idea) return mayWrite(userId, "") ? err(404, "idea_not_found") : denied(userId);
  return mayWrite(userId, idea.engagementId) ? { idea } : denied(userId);
}

function share(ideaId: string, userId: string): DemoResult {
  const g = guard(ideaId, userId);
  if (!("idea" in g)) return g;
  if (g.idea.status === "planned") return err(409, "idea_planned");
  if (g.idea.status === "shared") return ok({ alreadyApplied: true, idea: answer(g.idea) });
  g.idea.status = "shared";
  g.idea.sharedAt = new Date().toISOString();
  g.idea.sharedBy = userId;
  return ok({ idea: answer(g.idea) });
}

function plan(ideaId: string, body: string | undefined, userId: string): DemoResult {
  const g = guard(ideaId, userId);
  if (!("idea" in g)) return g;
  const idea = g.idea;
  const b = parse(body);
  if (typeof b.cycleId !== "string" || !ID.test(b.cycleId) || Object.keys(b).some((k) => k !== "cycleId")) return err(400, "invalid_field", { field: "cycleId" });
  const cycle = cyclesStore.cycles.find((c) => c.id === b.cycleId);
  if (!cycle || cycle.engagementId !== idea.engagementId) return err(404, "cycle_not_found");
  if (cycle.month < todayIsoInDisplayZone().slice(0, 7)) return err(409, "cycle_closed");
  if (idea.status === "planned") {
    const post = idea.postId ? PIPE_POSTS.find((p) => p.id === idea.postId) : undefined;
    if (post && idea.cycleId === cycle.id) return ok({ alreadyApplied: true, idea: answer(idea), post: { id: post.id, title: post.title, cycleId: cycle.id, cycleMonth: cycle.month } });
    return err(409, "idea_planned");
  }
  // The post is the pipeline store's own create (title the suggestion cut at 200, the angle "From an idea: <saw> (<metric>)"), in the picked cycle.
  const made = demoCreatePost(cycle.id, { title: [...idea.suggestion].slice(0, 200).join("") }, userId);
  if (made.status >= 400) return made;
  const postId = String((made.json as { post: { id: string } }).post.id);
  const post = PIPE_POSTS.find((p) => p.id === postId);
  if (post) post.angle = [...`From an idea: ${idea.saw}${idea.metric ? ` (${idea.metric})` : ""}`].slice(0, 500).join("");
  idea.status = "planned";
  idea.postId = postId;
  idea.cycleId = cycle.id;
  return ok({ idea: answer(idea), post: { id: postId, title: post?.title ?? idea.suggestion, cycleId: cycle.id, cycleMonth: cycle.month } }, 201);
}

function remove(ideaId: string, userId: string): DemoResult {
  const g = guard(ideaId, userId);
  if (!("idea" in g)) return g;
  if (g.idea.status === "planned") return err(409, "idea_planned");
  g.idea.deleted = true;
  return ok({ deleted: true, id: g.idea.id });
}

/** The server's `release_idea`: the idea of a discarded post goes back to Shared if it had been shared, else Proposed, and loses its post. */
export function releaseIdeaOfPost(postId: string, s: IdeaStore = store): void {
  const i = s.ideas.find((x) => x.postId === postId && !x.deleted);
  if (!i) return;
  i.status = i.sharedAt ? "shared" : "proposed";
  i.postId = null;
  i.cycleId = null;
}
setDemoPostDiscardHook((postId) => releaseIdeaOfPost(postId));

/** The idea routes by `tail`; null for any other path or method (the caller falls through). */
export function demoIdeasRoute(method: string, tail: string, _params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();
  let x: RegExpExecArray | null;
  if ((x = /^engagements\/([^/]+)\/ideas$/.exec(tail))) {
    const id = decodeURIComponent(x[1]);
    return m === "GET" ? list(id, userId) : m === "POST" ? create(id, body, userId) : null;
  }
  if ((x = /^ideas\/([^/]+)$/.exec(tail))) return m === "DELETE" ? remove(decodeURIComponent(x[1]), userId) : null;
  if ((x = /^ideas\/([^/]+)\/(share|plan)$/.exec(tail))) {
    if (m !== "POST") return null;
    const id = decodeURIComponent(x[1]);
    return x[2] === "share" ? share(id, userId) : plan(id, body, userId);
  }
  return null;
}

/** The post read's `idea`: the idea a post was planned from, or null. */
setDemoIdeaReader((postId) => {
  const i = store.ideas.find((x) => x.postId === postId && !x.deleted);
  return i ? { id: i.id, saw: i.saw, metric: i.metric, suggestion: i.suggestion } : null;
});

/** Northwind's last-month report gets an idea in each state, the planned one in next month's cycle (a real planned post of the pipeline store). */
export function seedIdeaStore(s: IdeaStore): void {
  if (s.ideas.length > 0) return;
  const north = PIPE_ENGAGEMENTS[0];
  if (!north) return;
  const month = todayIsoInDisplayZone().slice(0, 7);
  const last = demoMonthShift(month, -1);
  const report = demoReports.store.reports.find((r) => r.engagementId === north.id && r.kind === "monthly" && r.period === last);
  if (!report) return;
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const rec = (n: number, o: Partial<IdeaRec> & Pick<IdeaRec, "saw" | "metric" | "suggestion" | "status">): IdeaRec => ({
    id: `soc-idea-seed-${n}`, engagementId: north.id, reportId: report.id, postId: null, cycleId: null, sharedAt: null, sharedBy: null, createdBy: "u-social", createdAt: ago(60 - n), deleted: false, ...o,
  });
  s.ideas.push(
    rec(1, { saw: "Reels drew the most replies of the month.", metric: "Reply rate", suggestion: "Plan two more reels next month, each ending with a question.", status: "proposed" }),
    rec(2, { saw: "Weekday evenings brought the most reach.", metric: "Reach by hour", suggestion: "Move one weekly post to the evening slot and compare.", status: "shared", sharedAt: ago(30), sharedBy: "u-pm" }),
    rec(3, { saw: "Behind-the-scenes posts earned the most saves.", metric: "Saves", suggestion: "Show the team preparing the harvest collection.", status: "planned" }),
  );
  s.seq = 3;
  const next = cyclesStore.cycles.find((c) => c.engagementId === north.id && c.month === demoMonthShift(month, 1));
  const made = next ? demoCreatePost(next.id, { title: "Show the team preparing the harvest collection." }, "u-social") : null;
  const idea = s.ideas[2];
  if (made && made.status < 400) {
    idea.postId = String((made.json as { post: { id: string } }).post.id);
    idea.cycleId = next!.id;
    const post = PIPE_POSTS.find((p) => p.id === idea.postId);
    if (post) post.angle = `From an idea: ${idea.saw} (${idea.metric})`;
  } else idea.status = "shared";
}
seedIdeaStore(store);

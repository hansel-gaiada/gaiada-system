import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-1o (plan §11.1, §11.2; BFF §63.16): the DEMO_MODE store of the Social Media pipeline. It seeds from the day it is first touched, so the clock is
// pinned to mid-month (Friday 16 October 2026, midday in Singapore) before it is imported (hence vi.hoisted), the `demoDeptCalendar.test.ts` way.
// Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import fixture from "./scpStageMachine.json";
import { scpEngineStatusOf, scpHolderOf, scpPhaseOf, scpPrimaryActionOf, SCP_STATUSES } from "./scpStageMachine";
import { PIPE_POSTS, cyclesStore, demoPipelineMetrics, demoPipelineRead, allocStore, type PipePost } from "./demoSocialPipeline";
import { socialDemo } from "./demoSocial";
import { getDemoResponse } from "./demoFixtures";
import { canLeadSocial } from "./rbac";
import { validateBrandBook, type BrandBook } from "./socialBrandBook";
import type { Me } from "./platform";

const F = fixture as unknown as {
  statuses: string[]; blockableStatuses: string[];
  changeCases: Array<{ key: string; changeBy: string; changeKind: string; returnTo: string }>;
};
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const read = (id: string, user = "u-social"): Body => {
  const r = demoPipelineRead(id, user);
  expect(r.status).toBe(200);
  return r.json as Body;
};
const byStatus = (s: string) => PIPE_POSTS.filter((p) => p.pipelineStatus === s);
const action = (b: Body, name: string) => b.actions.find((a: { action: string }) => a.action === name);
const names = (b: Body): string[] => b.actions.map((a: { action: string }) => a.action);

// §63.1's CHECKs on `social_posts`, as a list of the rules a post breaks (empty: the server would accept the row).
function violations(p: PipePost): string[] {
  const out: string[] = [];
  const bad = (rule: string, cond: boolean) => { if (!cond) out.push(rule); };
  const s = p.pipelineStatus;
  bad("status is one of the twelve", F.statuses.includes(s));
  bad("cycle exists", cyclesStore.cycles.some((c) => c.id === p.cycleId));
  bad("status_since set", !!p.statusSince);
  bad("change_by/kind all or none", (p.changeBy === null) === (p.changeKind === null));
  bad("change_by/return_to all or none", (p.changeBy === null) === (p.returnTo === null));
  bad("change_by/note all or none", (p.changeBy === null) === (p.changeNote === null));
  bad("one of the six change cases", p.changeBy === null || F.changeCases.some((c) => c.changeBy === p.changeBy && c.changeKind === p.changeKind && c.returnTo === p.returnTo));
  bad("changes carries a change", s !== "changes" || p.changeBy !== null);
  bad("a change only in changes or blocked-from-changes", p.changeBy === null || s === "changes" || (s === "blocked" && p.blockedFrom === "changes"));
  bad("changed_only = copy_before present", p.changedOnly === (p.copyBefore !== null));
  bad("changed_only needs no change or a client one", !p.changedOnly || p.changeBy === null || p.changeBy === "client");
  const blocked = s === "blocked";
  bad("blocked_from iff blocked", blocked === (p.blockedFrom !== null));
  bad("block_reason iff blocked", blocked === (p.blockReason !== null));
  bad("block_waiting_on iff blocked", blocked === (p.blockWaitingOn !== null));
  bad("blocked_at iff blocked", blocked === (p.blockedAt !== null));
  bad("blocked_from is blockable", p.blockedFrom === null || F.blockableStatuses.includes(p.blockedFrom));
  bad("block_waiting_on is a known party", p.blockWaitingOn === null || ["client", "designer", "copywriter", "approver", "officer", "external"].includes(p.blockWaitingOn));
  bad("design has a creative state and source", s !== "design" || (p.creativeState !== null && p.creativeSource !== null));
  bad("creative request only for creatives", p.creativeRequestId === null || p.creativeSource === "creatives");
  bad("schedule_via exactly when scheduled or live", (s === "scheduled" || s === "live") === (p.scheduleVia !== null));
  bad("live has a url and a time", s !== "live" || (p.liveUrl !== null && /^https?:\/\//.test(p.liveUrl) && p.liveUrl.length <= 500 && p.wentLiveAt !== null));
  bad("not live: no url or time", s === "live" || (p.liveUrl === null && p.wentLiveAt === null));
  bad("caption length", p.caption.length <= 5000);
  bad("hashtags without #", p.hashtags.length <= 60 && p.hashtags.every((h) => !h.includes("#")));
  bad("raw assets", p.rawAssets.length <= 10 && p.rawAssets.every((a) => ["own", "client", "stock", "ai", "unknown"].includes(a.source)));
  bad("ai assets carry a note", p.rawAssets.every((a) => a.source !== "ai" || !!a.aiNote));
  bad("placement within the ten networks", p.placement.every((n) => ["instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "threads", "pinterest", "bluesky", "mastodon"].includes(n)));
  bad("format", ["feed", "carousel", "reel", "story"].includes(p.format));
  bad("text lengths", p.pillar.length <= 60 && p.angle.length <= 500 && p.objective.length <= 200 && p.keyMessage.length <= 500 && p.cta.length <= 120 && p.onAssetText.length <= 500);
  return out;
}

describe("the demo posts satisfy the server's CHECKs (§63.1), so the demo never shows a state the server refuses", () => {
  it("every post breaks no rule", () => {
    expect(PIPE_POSTS.length).toBeGreaterThanOrEqual(25);
    for (const p of PIPE_POSTS) expect(violations(p), `${p.id} (${p.pipelineStatus}, ${p.changeCase ?? "-"})`).toEqual([]);
  });

  it("the checker itself catches each kind of bad row", () => {
    const ok = byStatus("live")[0];
    expect(violations({ ...ok, liveUrl: null })).toContain("live has a url and a time");
    expect(violations({ ...ok, scheduleVia: null })).toContain("schedule_via exactly when scheduled or live");
    const ch = byStatus("changes")[0];
    expect(violations({ ...ch, changeNote: null })).toContain("change_by/note all or none");
    expect(violations({ ...ch, changeKind: "design", returnTo: "proofread" })).toContain("one of the six change cases");
    const bl = byStatus("blocked")[0];
    expect(violations({ ...bl, blockedFrom: null })).toContain("blocked_from iff blocked");
    const d = byStatus("design")[0];
    expect(violations({ ...d, creativeState: null })).toContain("design has a creative state and source");
    expect(violations({ ...d, creativeSource: "in_team", creativeRequestId: "x" })).toContain("creative request only for creatives");
    expect(violations({ ...ok, copyBefore: { caption: "x" } })).toContain("changed_only = copy_before present");
  });
});

describe("the store covers what §63.16 names", () => {
  it("all twelve statuses and all six change cases", () => {
    expect([...new Set(PIPE_POSTS.map((p) => p.pipelineStatus))].sort()).toEqual([...SCP_STATUSES].sort());
    expect([...new Set(PIPE_POSTS.map((p) => p.changeCase).filter(Boolean))].sort()).toEqual(F.changeCases.map((c) => c.key).sort());
  });

  it("a blocked post, a client copy change, a client design change, a rescheduled post back with the client, and one marked simulated", () => {
    expect(byStatus("blocked")[0]).toMatchObject({ blockedFrom: "design", blockWaitingOn: "client" });
    const copy = PIPE_POSTS.find((p) => p.changeCase === "client_copy")!;
    expect(copy).toMatchObject({ pipelineStatus: "changes", changedOnly: true });
    expect(copy.copyBefore).not.toBeNull();
    expect(PIPE_POSTS.find((p) => p.changeCase === "client_design")?.pipelineStatus).toBe("changes");
    const re = PIPE_POSTS.find((p) => p.rescheduled)!;
    expect(re.pipelineStatus).toBe("client");
    expect(re.history.map((h) => h.action)).toContain("reschedule");
    expect(read(re.id).approvedSchedule).toBeNull();
    const sim = PIPE_POSTS.filter((p) => p.simulated);
    expect(sim).toHaveLength(1);
    expect(sim[0].pipelineStatus).toBe("live");
  });

  it("a live post with metrics, stories and an extra post", () => {
    expect(byStatus("live").some((p) => p.metrics && demoPipelineMetrics(p.id)?.impressions)).toBe(true);
    expect(PIPE_POSTS.some((p) => p.format === "story")).toBe(true);
    expect(PIPE_POSTS.some((p) => p.isExtra)).toBe(true);
  });

  it("suggestions waiting on a proofread post, one of them stale; a returned copy keeps its suggestion", () => {
    const p = byStatus("proofread").find((x) => Object.keys(x.suggestions).length === 2)!;
    const body = read(p.id);
    expect(body.suggestions.caption.stale).toBe(false);
    expect(body.suggestions.cta.stale).toBe(true);
    expect(body.suggestions.caption.by).toEqual({ id: "u-copy", name: "Citra Maheswari" });
    const kept = PIPE_POSTS.find((x) => x.changeCase === "copywriter_copy")!;
    expect(Object.keys(read(kept.id).suggestions)).toContain("caption");
  });

  it("three invented clients: one on the in-team designer, two on Creatives, each with an allocation, a brand book and three cycles", () => {
    const sources = Object.values(allocStore.byEngagement).map((a) => a.creativeSource).sort();
    expect(sources).toEqual(["creatives", "creatives", "in_team"]);
    expect(Object.keys(allocStore.byEngagement)).toHaveLength(3);
    for (const [engId, a] of Object.entries(allocStore.byEngagement)) {
      expect(a.officerId && a.postsPerCycle && a.reportFormat && a.reportDueDay && a.defaultPostTime && a.platforms.length && a.formats.length, engId).toBeTruthy();
      expect(Object.keys(a.stepEstimates).length).toBeGreaterThan(0);
      expect(cyclesStore.cycles.filter((c) => c.engagementId === engId).map((c) => c.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    }
    for (const c of cyclesStore.cycles) expect(c.readyBy <= c.deadline, c.id).toBe(true);
    for (const [clientId, b] of Object.entries(allocStore.brands)) {
      const book: BrandBook = {
        toneSummary: String(b.tone.summary ?? ""), contentPillars: b.book.contentPillars, mustHaveNotes: b.book.mustHaveNotes, brandRules: b.book.brandRules,
        hashtagSets: b.hashtagStrategy.sets as BrandBook["hashtagSets"], channels: b.book.channels, keyDates: b.book.keyDates, links: b.book.links,
      };
      expect(validateBrandBook(book), clientId).toMatchObject({ ok: true });
      expect(book.keyDates.length && book.links.length && book.channels.length && book.hashtagSets.length && book.contentPillars.length, clientId).toBeTruthy();
    }
  });

  it("images are generated placeholders, never an http asset", () => {
    for (const p of PIPE_POSTS) for (const a of p.rawAssets) expect(a.url.startsWith("data:image/svg+xml"), p.id).toBe(true);
  });
});

describe("GET posts/:postId/pipeline", () => {
  const KEYS = [
    "id", "engagementId", "clientId", "clientName", "cycleId", "cycleMonth", "title", "format", "pillar", "angle", "objective", "keyMessage", "caption",
    "onAssetText", "cta", "hashtags", "visualDirection", "rawAssets", "placement", "scheduledAt", "isExtra", "isStory", "mustHaves", "pipelineStatus", "phase",
    "statusSince", "engineStatus", "change", "changedOnly", "copyBefore", "block", "creativeSource", "creativeState", "creativeRequest", "designs", "suggestions",
    "checks", "skippedChecks", "officer", "author", "holder", "health", "variants", "approvedSchedule", "scheduleVia", "reviewHash", "liveUrl", "wentLiveAt",
    "simulated", "archivedAt", "boost", "tasks", "copyLog", "history", "actions", "nextAction",
  ];
  it("answers the §63.6.2 shape for every demo post, with phase, holder, engine status and next action from the twin", () => {
    for (const p of PIPE_POSTS) {
      const b = read(p.id);
      expect(Object.keys(b).sort(), p.id).toEqual([...KEYS].sort());
      const v = { pipelineStatus: p.pipelineStatus, changeCase: p.changeCase, scheduleVia: p.scheduleVia, blockWaitingOn: p.blockWaitingOn, creativeState: p.creativeState };
      expect(b.phase, p.id).toBe(scpPhaseOf(v));
      expect(b.holder.role, p.id).toBe(scpHolderOf(v));
      expect(b.engineStatus, p.id).toBe(scpEngineStatusOf(v, b.variants.map((x: { status: string }) => x.status)));
      if (b.nextAction !== null) expect(b.nextAction, p.id).toBe(scpPrimaryActionOf(v));
      expect(b.change === null, p.id).toBe(p.changeBy === null);
      expect(b.block === null, p.id).toBe(p.blockedFrom === null);
      const sent = p.pipelineStatus === "client" || ["approved", "scheduled", "live"].includes(p.pipelineStatus) || p.changeBy === "client" || p.changedOnly;
      expect(b.reviewHash === null, p.id).toBe(!sent);
      expect(b.history.length, p.id).toBeGreaterThan(0);
      expect(b.history[b.history.length - 1].to, p.id).toBe(p.pipelineStatus === "client" && p.rescheduled ? "client" : p.pipelineStatus);
    }
  });

  it("404 post_not_found, 409 for a Composer post, 403 for a client contact", () => {
    expect(demoPipelineRead("nope", "u-social")).toMatchObject({ status: 404, json: { error: "post_not_found" } });
    const q = (id: string) => socialDemo("GET", `/api/co-agency/modules/social/posts/${id}/pipeline`, new URLSearchParams(), undefined, "u-social");
    expect(q("soc-post-1")).toMatchObject({ status: 409, json: { error: "not_a_pipeline_post" } });
    expect(q(PIPE_POSTS[0].id)?.status).toBe(200);
    expect(demoPipelineRead(PIPE_POSTS[0].id, "demo-client")).toMatchObject({ status: 403 });
  });

  const MAKER_CHECKER = ["approve_copy", "return_copy", "approve_for_design", "hod_changes", "final_approve", "final_changes", "schedule_publisher"];

  it("the officer and the author are never allowed proofread or approve actions, whatever the post", () => {
    let seen = 0;
    for (const p of PIPE_POSTS) {
      const officer = allocStore.byEngagement[p.engagementId].officerId!;
      for (const user of [officer, ...(p.authorId ? [p.authorId] : [])]) {
        for (const a of read(p.id, user).actions) {
          if (!MAKER_CHECKER.includes(a.action)) continue;
          seen += 1;
          expect(a, `${p.id} ${user} ${a.action}`).toEqual({ action: a.action, allowed: false, reason: "author_cannot_approve" });
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("each persona gets the actions its role allows, with the refusal code of the fixture", () => {
    const proof = byStatus("proofread").find((p) => Object.keys(p.suggestions).length === 2)!;
    expect(action(read(proof.id, "u-copy"), "approve_copy")).toEqual({ action: "approve_copy", allowed: true });
    expect(read(proof.id, "u-copy").nextAction).toBe("approve_copy");
    expect(action(read(proof.id, "u-social"), "approve_copy")).toMatchObject({ allowed: false, reason: "author_cannot_approve" });
    expect(action(read(proof.id, "u-pm"), "approve_copy")).toMatchObject({ allowed: false, reason: "not_a_copywriter" });
    expect(action(read(proof.id, "u-social"), "suggest")).toBeUndefined(); // the suggestion routes are not `actions` values

    const hod = byStatus("hod")[0];
    for (const approver of ["u-pm", "u-gm", "demo-owner", "demo-hansel"]) expect(action(read(hod.id, approver), "approve_for_design"), approver).toEqual({ action: "approve_for_design", allowed: true });
    expect(action(read(hod.id, "u-copy"), "approve_for_design")).toMatchObject({ allowed: false, reason: "not_an_approver" });
    expect(action(read(hod.id, "u-social"), "approve_for_design")).toMatchObject({ allowed: false, reason: "author_cannot_approve" });
    expect(read(hod.id, "u-gm").nextAction).toBe("approve_for_design");

    const planned = byStatus("planned").find((p) => allocStore.byEngagement[p.engagementId].officerId === "u-social")!;
    expect(action(read(planned.id, "u-social"), "start_draft")).toEqual({ action: "start_draft", allowed: true });
    expect(action(read(planned.id, "u-social-2"), "start_draft")).toMatchObject({ allowed: false, reason: "not_the_officer" });
    expect(action(read(planned.id, "demo-owner"), "block")).toMatchObject({ allowed: false, reason: "not_officer_or_approver" }); // the owner holds no team step
    expect(action(read(planned.id, "u-pm"), "block")).toEqual({ action: "block", allowed: true });

    const inTeam = PIPE_POSTS.find((p) => p.pipelineStatus === "design" && p.creativeSource === "in_team" && p.creativeState === "not_started")!;
    expect(action(read(inTeam.id, "u-social-design"), "start_design")).toEqual({ action: "start_design", allowed: true });
    expect(read(inTeam.id, "u-social-design").nextAction).toBe("start_design");
    expect(action(read(inTeam.id, "u-creative"), "start_design")).toMatchObject({ allowed: false, reason: "not_the_designer" });
    const creatives = PIPE_POSTS.find((p) => p.pipelineStatus === "design" && p.creativeSource === "creatives")!;
    expect(action(read(creatives.id, "u-creative"), "submit_design")).toEqual({ action: "submit_design", allowed: true });
    expect(action(read(creatives.id, "u-social-design"), "submit_design")).toMatchObject({ allowed: false });

    const approved = byStatus("approved")[0];
    expect(action(read(approved.id, "u-social"), "schedule")).toEqual({ action: "schedule", allowed: true });
    expect(action(read(approved.id, "u-pm"), "schedule_publisher")).toEqual({ action: "schedule_publisher", allowed: true });
    expect(action(read(approved.id, "u-social"), "client_approve")).toBeUndefined(); // the portal's actions are not staff actions
  });

  it("only the actions whose `from` matches the post are listed", () => {
    expect(read(byStatus("live")[0].id).actions).toEqual([]);
    expect(names(read(byStatus("client")[0].id))).toEqual(expect.arrayContaining(["record_client_approve", "record_client_change", "follow_up", "archive"]));
    const designChange = PIPE_POSTS.find((p) => p.changeCase === "client_design")!;
    expect(names(read(designChange.id))).toContain("submit_design");
    expect(names(read(designChange.id))).not.toContain("send_to_proofread");
  });

  it("the hand-off checks are a read, and the POST action route is the SCP-1e hook", () => {
    const planned = byStatus("planned")[0];
    expect(read(planned.id).checks.find((c: { code: string }) => c.code === "caption_missing")).toMatchObject({ ok: false, skippable: false });
    const r = socialDemo("POST", `/api/co-agency/modules/social/posts/${planned.id}/actions`, new URLSearchParams(), JSON.stringify({ action: "start_draft" }), "u-social");
    expect(r).toMatchObject({ status: 501, json: { error: "demo_action_runner_not_built" } });
  });
});

describe("planning follows the persona", () => {
  const as = (user: string, method: string, path: string, body?: unknown) =>
    socialDemo(method, `/api/co-agency/modules/social/${path}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), user);
  it("the four approvers may plan, nobody else, with 403 not_a_social_approver", () => {
    for (const u of ["u-pm", "u-gm", "demo-owner", "demo-hansel"]) expect((as(u, "GET", "settings")?.json as { canPlan: boolean }).canPlan, u).toBe(true);
    for (const u of ["u-social", "u-social-2", "u-copy", "u-social-design", "u-creative"]) {
      expect((as(u, "GET", "settings")?.json as { canPlan: boolean }).canPlan, u).toBe(false);
      expect(as(u, "PUT", "settings", { bufferWorkingDays: 2 }), u).toMatchObject({ status: 403, json: { error: "not_a_social_approver" } });
      expect(as(u, "PUT", "cycles", { month: "2026-12", rows: [] }), u).toMatchObject({ status: 403 });
      expect(as(u, "PATCH", "engagements/soc-eng-1/allocation", { postsPerCycle: 3 }), u).toMatchObject({ status: 403 });
    }
  });
});

describe("canLeadSocial over the demo personas (plan §11.1: the four approvers)", () => {
  const ALL = [
    "demo-hansel", "demo-owner", "u-social", "u-social-2", "u-copy", "u-social-design", "u-pm", "u-creative", "u-gm", "u-dev", "u-webhead", "u-seo",
    "gede-ic", "dept-manager", "seo-staff", "u-hr", "u-finance-staff", "u-it", "u-resort", "demo-client", "demo-client-admin", "demo-client-viewer",
  ];
  const units = { social: ["dept-4"], gm: ["dept-5"] };
  const meOf = (u: string) => getDemoResponse("GET", "/api/me", u).json as Me;

  it("is true for exactly the HoD, the GM, the owner and the superadmin", () => {
    const yes = ALL.filter((u) => canLeadSocial(meOf(u), "co-agency", units));
    expect(yes.sort()).toEqual(["demo-hansel", "demo-owner", "u-gm", "u-pm"]);
  });

  it("the Copywriter and the in-team designer hold their roles; the HoD and GM hold lead seats on their units", () => {
    expect(meOf("u-copy").roles.map((r) => r.role)).toContain("social_copywriter");
    expect(meOf("u-social-design").roles.map((r) => r.role)).toContain("social_designer");
    expect(meOf("u-pm").roles).toContainEqual(expect.objectContaining({ role: "org_unit_lead", scopeId: "dept-4", tenantIds: ["co-agency"] }));
    expect(meOf("u-gm").roles).toContainEqual(expect.objectContaining({ role: "org_unit_lead", scopeId: "dept-5", tenantIds: ["co-agency"] }));
  });
});

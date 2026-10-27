// TEST HELPER (SCP-1o, moved here by SCP-1e so the action runner's test shares it): the rules of §63.1's CHECKs on `social_posts`, as a list the post breaks.
// It reads the fixture twin and the store's cycles, nothing else. Not imported by the app.
import fixture from "./scpStageMachine.json";
import { cyclesStore, type PipePost } from "./demoSocialPipeline";

const F = fixture as unknown as {
  statuses: string[]; blockableStatuses: string[];
  changeCases: Array<{ key: string; changeBy: string; changeKind: string; returnTo: string }>;
};

// §63.1's CHECKs on `social_posts`, as a list of the rules a post breaks (empty: the server would accept the row).
export function violations(p: PipePost): string[] {
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

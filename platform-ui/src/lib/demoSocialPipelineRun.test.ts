import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

// SCP-1e (BFF §63.3.2, §63.6.3 to §63.6.7, §63.16): the DEMO_MODE writes of the Social Media pipeline. The store seeds from the day it is first touched, so the clock is
// pinned to mid-month (Friday 16 October 2026, midday in Singapore) before it is imported (hence vi.hoisted), the way demoSocialPipeline.test.ts does. Only Date is faked.
//
// What is proved here, in the server's own words:
//   - the fixture's post scenarios (the happy path, an in-team designer, loops a to e with the client's steps recorded by the officer, block and resolve, the maker refused,
//     rescheduling after the client, the publisher's gate), walked as the demo personas, asserting the status and the phase at every step;
//   - AFTER EVERY STEP, every post of the store satisfies §63.1's CHECKs (`violations`, the helper demoSocialPipeline.test.ts shares), so a write never leaves a row the
//     server would refuse;
//   - the order of checks (§63.3.2): unknown action, not found, Composer post, replay, archived, automation, maker/checker, the persona's refusal code, `status_changed`,
//     `invalid_transition`, the body (`missing_field`/`invalid_field` with `field`), then the action's own guards;
//   - the suggestions, edit, designs and bulk routes, and that every effect of the fixture is either handled or named as one the demo store has no row for.
// The store is shared mutable state and the tests run in order (the second leaves the HoD post where the third needs it): the file restores the store when it is done.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});

import fixture from "./scpStageMachine.json";
import { PIPE_POSTS, allocStore, demoCycleCounts, demoFeed, demoPipelineRead, demoPostActions, type PipePost } from "./demoSocialPipeline";
import { DEMO_ACTION_ROUTE, DEMO_ASSETS, DEMO_COLUMN_EFFECTS, demoAssetLibraryRead, isNoopEffect, runDemoPipelineAction, runDemoPipelineWrite } from "./demoSocialPipelineRun";
import { violations } from "./demoSocialPipelineViolations";
import { socialDemo } from "./demoSocial";
import { getDemoResponse } from "./demoFixtures";

const SNAPSHOT: PipePost[] = structuredClone(PIPE_POSTS);
const ALLOC_SNAPSHOT = structuredClone(allocStore.byEngagement);
afterAll(() => {
  PIPE_POSTS.splice(0, PIPE_POSTS.length, ...SNAPSHOT);
  for (const [k, v] of Object.entries(ALLOC_SNAPSHOT)) allocStore.byEngagement[k] = v;
  vi.useRealTimers();
});

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Res { status: number; json: Body }

const byTitle = (t: string): PipePost => {
  const p = PIPE_POSTS.find((x) => x.title === t);
  if (!p) throw new Error(`no demo post titled '${t}'`);
  return p;
};
const officerOf = (p: PipePost): string => allocStore.byEngagement[p.engagementId].officerId!;

/** The demo persona for each actor of the fixture's scenarios (plan §11.1). */
const WHO: Record<string, (p: PipePost) => string> = {
  officer: officerOf, recorder: officerOf, copywriter: () => "u-copy", approver: () => "u-pm", second_approver: () => "u-gm", owner: () => "demo-owner",
  platform_admin: () => "demo-hansel", company_admin: () => "u-dev", designer: (p) => (p.creativeSource === "in_team" ? "u-social-design" : "u-creative"),
  in_team_designer: () => "u-social-design", request_designer: () => "u-creative",
};
const persona = (p: PipePost, who: string): string => WHO[who]?.(p) ?? who;

function assertStoreIsLegal(): void {
  for (const q of PIPE_POSTS) expect(violations(q), `${q.id} (${q.pipelineStatus}, ${q.changeCase ?? "-"})`).toEqual([]);
}

/** One action of the action route, as `who` plays it, naming the step the post is at. Every call is followed by the store-wide rule check. */
function act(p: PipePost, who: string, action: string, params: Body = {}, extra: Body = {}): Res {
  const r = runDemoPipelineAction(p.id, { action, expectedStatus: p.pipelineStatus, actionId: randomUUID(), ...params, ...extra }, persona(p, who));
  assertStoreIsLegal();
  return r as Res;
}
const route = (p: PipePost, who: string, method: string, tail: string, body?: Body): Res => {
  const r = runDemoPipelineWrite(method, tail, body, persona(p, who));
  if (!r) throw new Error(`no demo route for ${method} ${tail}`);
  assertStoreIsLegal();
  return r as Res;
};
const edit = (p: PipePost, who: string, fields: Body): Res => route(p, who, "PATCH", `posts/${p.id}/pipeline`, { expectedStatus: p.pipelineStatus, fields });
const okRes = (r: Res): Body => { expect(r.status, JSON.stringify(r.json)).toBeLessThan(300); return r.json; };
const refused = (r: Res, code: string, extra: Body = {}): void => expect(r, JSON.stringify(r.json)).toMatchObject({ json: { error: code, ...extra } });
const at = (p: PipePost, status: string, phase: string): void => {
  const b = demoPipelineRead(p.id, "demo-hansel").json as Body;
  expect(b.pipelineStatus).toBe(status);
  expect(b.phase, `${p.title}: phase at ${status}`).toBe(phase);
};
const codes = (r: Res): string[] => (r.json.blockers as Array<{ code: string }>).map((b) => b.code);
const ALL_TEN = ["logo", "brand_colours", "brand_fonts", "contact_info", "handle_and_tags", "mandatory_words", "no_forbidden_claims", "price_terms_checked", "location_tag", "hashtag_set"];

describe("the fixture's scenarios, walked as the demo personas (the store stays legal after every step)", () => {
  it("the happy path, Creatives as the source: draft, hand-off checks, proofread with a suggestion, HoD, design, final check, client (recorded), scheduled by hand, live", () => {
    const p = byTitle("November kickoff");
    expect(p.pipelineStatus).toBe("planned");
    // a wrong actor, then the right one
    refused(act(p, "copywriter", "start_draft"), "not_the_officer");
    okRes(act(p, "officer", "start_draft"));
    at(p, "drafting", "brief");
    expect(p.authorId).toBe("u-social");

    // the hard requirements can never be skipped, even with "send anyway"
    const hard = act(p, "officer", "send_to_proofread", { sendAnyway: true, sendAnywayReason: "The client agreed to this by phone." });
    refused(hard, "incomplete_post");
    expect(codes(hard)).toEqual(expect.arrayContaining(["caption_missing", "placement_missing"]));
    refused(edit(p, "officer", { caption: "x".repeat(5001) }), "invalid_field", { field: "caption" });
    okRes(edit(p, "officer", { caption: "Autumn is here: the first cold-weather drop.", placement: ["instagram", "facebook"], onAssetText: "Autumn drop", cta: "Shop now", hashtags: ["northwind", "autumn"] }));

    // the soft checks: send anyway needs a reason of 10 to 500 characters
    const soft = act(p, "officer", "send_to_proofread");
    refused(soft, "checks_failed");
    expect(codes(soft)).toContain("must_haves_unticked");
    refused(act(p, "officer", "send_to_proofread", { sendAnyway: true }), "missing_field", { field: "sendAnywayReason" });
    refused(act(p, "officer", "send_to_proofread", { sendAnyway: true, sendAnywayReason: "short" }), "invalid_field", { field: "sendAnywayReason" });
    const sent = okRes(act(p, "officer", "send_to_proofread", { sendAnyway: true, sendAnywayReason: "The client confirmed the tagline by phone." }));
    expect(sent.post.pipelineStatus).toBe("proofread");
    expect(sent.post.skippedChecks[0]).toMatchObject({ codes: expect.arrayContaining(["must_haves_unticked"]), reason: "The client confirmed the tagline by phone." });
    at(p, "proofread", "in_production");

    // the Copywriter suggests (the officer may not: maker/checker), and "Approve copy" applies it and logs before and after
    refused(route(p, "officer", "PUT", `posts/${p.id}/suggestions/caption`, { expectedStatus: "proofread", value: "x" }), "author_cannot_approve");
    refused(route(p, "copywriter", "PUT", `posts/${p.id}/suggestions/nope`, { expectedStatus: "proofread", value: "x" }), "invalid_field", { field: "field" });
    refused(route(p, "copywriter", "PUT", `posts/${p.id}/suggestions/caption`, { expectedStatus: "proofread" }), "missing_field", { field: "value" });
    const sug = okRes(route(p, "copywriter", "PUT", `posts/${p.id}/suggestions/caption`, { expectedStatus: "proofread", value: "Autumn is here. The first cold-weather drop lands today." }));
    expect(sug.post.suggestions.caption).toMatchObject({ stale: false, by: { id: "u-copy" } });
    const copy = okRes(act(p, "copywriter", "approve_copy"));
    expect(copy.post).toMatchObject({ pipelineStatus: "hod", caption: "Autumn is here. The first cold-weather drop lands today.", suggestions: {} });
    expect(copy.post.copyLog.at(-1)).toMatchObject({ field: "caption", via: "suggestion", before: "Autumn is here: the first cold-weather drop.", suggestedBy: { id: "u-copy" } });
    at(p, "hod", "in_production");

    // the maker/checker, then the right people
    refused(act(p, "officer", "approve_for_design"), "author_cannot_approve");
    refused(act(p, "company_admin", "approve_for_design"), "not_an_approver");
    const design = okRes(act(p, "approver", "approve_for_design"));
    expect(design.post).toMatchObject({ pipelineStatus: "design", creativeSource: "creatives", creativeState: "not_started", creativeRequest: { id: expect.stringMatching(/^soc-req-/) } });
    at(p, "design", "in_production");

    refused(act(p, "in_team_designer", "start_design"), "not_the_designer");
    expect(okRes(act(p, "designer", "start_design")).post.creativeState).toBe("in_progress");
    expect(act(p, "designer", "start_design").json).toMatchObject({ alreadyApplied: true }); // in_progress replays
    refused(act(p, "designer", "submit_design"), "design_missing");
    refused(route(p, "designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "design", assetGroupId: "no-such-group" }), "asset_not_found");
    refused(route(p, "designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "design", linkUrl: "https://example.com/d", linkSource: "ai" }), "missing_field", { field: "linkAiNote" });
    refused(route(p, "designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "design", assetGroupId: DEMO_ASSETS[0].groupId, linkUrl: "https://example.com/d" }), "invalid_field", { field: "assetGroupId" });
    const added = okRes(route(p, "designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "design", assetGroupId: DEMO_ASSETS[0].groupId }));
    expect(added.designId).toBe(`${p.id}-d1`);
    expect(added.post.designs).toEqual([expect.objectContaining({ asset: expect.objectContaining({ groupId: DEMO_ASSETS[0].groupId, name: DEMO_ASSETS[0].name }), fileId: null })]);
    const submitted = okRes(act(p, "designer", "submit_design"));
    expect(submitted.post).toMatchObject({ pipelineStatus: "final", creativeState: "submitted" });
    at(p, "final", "in_production");

    // the final check sends it to the client, and each design is now a stored file a pin can sit on
    const toClient = okRes(act(p, "second_approver", "final_approve"));
    expect(toClient.post.pipelineStatus).toBe("client");
    expect(toClient.post.designs[0].fileId).toBe(`${p.id}-f1`);
    expect(toClient.post.variants.map((v: Body) => v.network)).toEqual(["instagram", "facebook"]);
    at(p, "client", "with_client");

    // the client's step, in recorded form
    refused(act(p, "officer", "record_client_approve", { note: "ok" }), "missing_field", { field: "channel" });
    refused(act(p, "officer", "record_client_approve", { channel: "carrier pigeon", note: "ok" }), "invalid_field", { field: "channel" });
    const approved = okRes(act(p, "officer", "record_client_approve", { channel: "whatsapp", note: "The client approved in the group chat." }));
    expect(approved.post).toMatchObject({ pipelineStatus: "approved", approvedSchedule: { scheduledAt: p.scheduledAt } });
    expect(approved.post.history.at(-1)).toMatchObject({ action: "record_client_approve", recorded: { channel: "whatsapp" }, viaPortal: false });
    at(p, "approved", "client_approved");

    const scheduled = okRes(act(p, "officer", "schedule"));
    expect(scheduled.post).toMatchObject({ pipelineStatus: "scheduled", scheduleVia: "manual", scheduledAt: p.scheduledAt });
    at(p, "scheduled", "client_approved");
    refused(act(p, "officer", "mark_live"), "missing_field", { field: "url" });
    refused(act(p, "officer", "mark_live", { url: "ftp://x" }), "invalid_field", { field: "url" });
    const live = okRes(act(p, "officer", "mark_live", { url: "https://example.com/northwindtraders/p/november-kickoff" }));
    expect(live.post).toMatchObject({ pipelineStatus: "live", liveUrl: "https://example.com/northwindtraders/p/november-kickoff", scheduleVia: "manual" });
    at(p, "live", "posted");
    expect(live.post.actions).toEqual([]);
    expect(live.post.history.map((h: Body) => h.action)).toEqual(expect.arrayContaining(["start_draft", "send_to_proofread", "approve_copy", "approve_for_design", "start_design", "submit_design", "final_approve", "record_client_approve", "schedule", "mark_live"]));
  });

  it("loop b: the HoD's fix goes straight back to the HoD, without a second proofread", () => {
    const p = byTitle("Our first cold-weather drop");
    expect(p.pipelineStatus).toBe("hod");
    refused(act(p, "approver", "hod_changes"), "missing_field", { field: "note" });
    const asked = okRes(act(p, "approver", "hod_changes", { note: "Use the new promo name." }));
    expect(asked.post).toMatchObject({ pipelineStatus: "changes", change: { case: "hod_copy", by: "hod", returnTo: "hod", note: "Use the new promo name." } });
    at(p, "changes", "brief");
    okRes(edit(p, "officer", { caption: "Use the new promo name: Winter Warmers." }));
    expect(p.copyLog.at(-1)).toMatchObject({ field: "caption", via: "fix", stage: "changes" });
    const back = okRes(act(p, "officer", "resend"));
    expect(back.post).toMatchObject({ pipelineStatus: "hod", change: null });
    at(p, "hod", "in_production");
  });

  it("the in-team designer: a Creatives designer is refused, the Social Media designer is not, and a link-only design cannot go to the client", () => {
    const p = byTitle("Our first cold-weather drop");
    const alloc = allocStore.byEngagement[p.engagementId];
    const saved = alloc.creativeSource;
    try {
      alloc.creativeSource = "in_team"; // the client's source is read at approve time (the twin's `copy_creative_source_from_engagement`)
      const design = okRes(act(p, "approver", "approve_for_design"));
      expect(design.post).toMatchObject({ pipelineStatus: "design", creativeSource: "in_team", creativeState: "not_started", creativeRequest: null });
      refused(act(p, "request_designer", "start_design"), "not_the_designer");
      okRes(act(p, "in_team_designer", "start_design"));
      okRes(route(p, "in_team_designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "design", linkUrl: "https://example.com/drive/d1", linkSource: "unknown" }));
      const sub = okRes(act(p, "in_team_designer", "submit_design"));
      expect(sub.warnings.join(" ")).toMatch(/no source set/); // an unknown source is a warning, not a refusal
      refused(act(p, "approver", "final_approve"), "design_not_stored", { detail: { designIds: [`${p.id}-d1`] } });
      expect(p.pipelineStatus).toBe("final");
    } finally {
      alloc.creativeSource = saved;
    }
  });

  it("loop a: the Copywriter returns the copy with suggestions; the officer accepts one and fixes the rest; a stale suggestion blocks Approve copy until it is dropped", () => {
    const p = byTitle("Wool care in three steps");
    expect(Object.keys(p.suggestions).sort()).toEqual(["caption", "cta"]);
    // the cta suggestion was made against text that has changed since
    refused(act(p, "copywriter", "approve_copy"), "suggestion_stale", { detail: { fields: ["cta"] } });
    okRes(route(p, "copywriter", "DELETE", `posts/${p.id}/suggestions/cta`));
    expect(Object.keys(p.suggestions)).toEqual(["caption"]);
    okRes(route(p, "copywriter", "DELETE", `posts/${p.id}/suggestions/cta`)); // dropping one that is gone is not a refusal
    const returned = okRes(act(p, "copywriter", "return_copy", { note: "Tighten the opening line." }));
    expect(returned.post).toMatchObject({ pipelineStatus: "changes", change: { case: "copywriter_copy", note: "Tighten the opening line." }, changedOnly: false });
    expect(Object.keys(returned.post.suggestions)).toEqual(["caption"]); // kept for the officer
    at(p, "changes", "brief");
    // the officer accepts the suggestion (logged via suggestion) and fixes the call to action by hand (logged via fix)
    const accepted = okRes(act(p, "officer", "accept_suggestion", { field: "caption" }));
    expect(accepted.post.suggestions).toEqual({});
    expect(accepted.post.copyLog.at(-1)).toMatchObject({ field: "caption", via: "suggestion" });
    refused(act(p, "officer", "accept_suggestion", { field: "caption" }), "suggestion_not_found");
    okRes(edit(p, "officer", { cta: "See the guide", mustHaves: ALL_TEN }));
    expect(p.copyLog.at(-1)).toMatchObject({ field: "cta", via: "fix", stage: "changes" });
    okRes(act(p, "officer", "send_to_proofread"));
    at(p, "proofread", "in_production");
    expect(p.changeCase).toBeNull();
    okRes(act(p, "copywriter", "approve_copy"));
    at(p, "hod", "in_production");
  });

  it("loops c, d and e on one post with an in-team designer: the final check asks the officer, then the designer; the client (recorded) asks the designer, then for a copy change that skips the HoD and Creative", () => {
    const p = byTitle("Meet our senior therapist");
    expect(p).toMatchObject({ pipelineStatus: "final", creativeSource: "in_team" });
    // c (copy): to the officer, back to the final check
    refused(act(p, "approver", "final_changes", { note: "Fix the price." }), "missing_field", { field: "changeKind" });
    const cCopy = okRes(act(p, "approver", "final_changes", { changeKind: "copy", note: "Fix the price." }));
    expect(cCopy.post).toMatchObject({ pipelineStatus: "changes", change: { case: "final_copy" } });
    at(p, "changes", "in_production");
    refused(act(p, "designer", "resend"), "not_the_officer");
    okRes(act(p, "officer", "resend"));
    at(p, "final", "in_production");
    // c (design): to the designer as a revision, back to the final check
    const cDesign = okRes(act(p, "approver", "final_changes", { changeKind: "design", note: "Logo too small." }));
    expect(cDesign.post).toMatchObject({ pipelineStatus: "changes", change: { case: "final_design" }, creativeState: "revision" });
    at(p, "changes", "in_production");
    expect(okRes(act(p, "designer", "start_design")).post.creativeState).toBe("revision");
    okRes(act(p, "designer", "submit_design"));
    expect(p).toMatchObject({ pipelineStatus: "final", creativeState: "submitted", changeCase: null });
    okRes(act(p, "second_approver", "final_approve"));
    at(p, "client", "with_client");

    // d: the client asks for a design change (recorded by the officer, with a pin on the stored design), and it comes back to the final check, not straight to the client
    const pin = { x: 0.4, y: 0.5, fileId: `${p.id}-f1` };
    refused(act(p, "officer", "record_client_change", { changeKind: "design", channel: "whatsapp", note: "Brighter photo, please.", anchor: { x: 2, y: 0.5 } }), "invalid_field", { field: "anchor" });
    const d = okRes(act(p, "officer", "record_client_change", { changeKind: "design", channel: "whatsapp", note: "Brighter photo, please.", anchor: pin }));
    expect(d.post).toMatchObject({ pipelineStatus: "changes", change: { case: "client_design", by: "client" }, creativeState: "revision", changedOnly: false });
    expect(d.post.history.at(-1)).toMatchObject({ action: "record_client_change", recorded: { channel: "whatsapp" } });
    at(p, "changes", "client_changes");
    okRes(act(p, "designer", "submit_design"));
    at(p, "final", "in_production");
    okRes(act(p, "owner", "final_approve"));
    at(p, "client", "with_client");

    // e: a copy change: only the changed text is checked, and the post goes straight back to the client
    const e = okRes(act(p, "officer", "record_client_change", { changeKind: "copy", channel: "email", note: "Say 'from Friday'." }));
    expect(e.post).toMatchObject({ pipelineStatus: "changes", change: { case: "client_copy" }, changedOnly: true, copyBefore: { caption: expect.any(String) } });
    at(p, "changes", "client_changes");
    // the client has seen the networks and the date: the placement and the date stay
    refused(edit(p, "officer", { scheduledAt: "2026-12-01T09:00:00.000Z" }), "field_locked", { detail: { field: "scheduledAt", status: "changes" } });
    refused(edit(p, "officer", { placement: ["instagram"] }), "field_locked", { detail: { field: "placement", status: "changes" } });
    okRes(edit(p, "officer", { caption: "Open from Friday." }));
    expect(p.copyLog.at(-1)).toMatchObject({ field: "caption", via: "fix", stage: "changes", after: "Open from Friday." });
    okRes(act(p, "officer", "send_to_proofread"));
    expect(p).toMatchObject({ pipelineStatus: "proofread", changedOnly: true, changeCase: null });
    at(p, "proofread", "in_production");
    const back = okRes(act(p, "copywriter", "approve_copy"));
    expect(back.post).toMatchObject({ pipelineStatus: "client", changedOnly: false, copyBefore: null });
    at(p, "client", "with_client");
  });

  it("blocked and resolved keeps the step and the change case; a blocked post's holder is who it waits on; follow up is once in 24 hours and only for someone else's post", () => {
    const c = byTitle("Candlelit couples room");
    expect(c).toMatchObject({ pipelineStatus: "changes", changeCase: "final_design" });
    refused(act(c, "officer", "block", { waitingOn: "client" }), "missing_field", { field: "reason" });
    refused(act(c, "officer", "block", { reason: "Waiting for the client's photos.", waitingOn: "nobody" }), "invalid_field", { field: "waitingOn" });
    const blocked = okRes(act(c, "officer", "block", { reason: "Waiting for the client's photos.", waitingOn: "client" }));
    expect(blocked.post).toMatchObject({ pipelineStatus: "blocked", block: { from: "changes", waitingOn: "client" }, change: { case: "final_design" } });
    at(c, "blocked", "brief");
    expect(blocked.post.holder.role).toBe("client");
    const resolved = okRes(act(c, "second_approver", "resolve"));
    expect(resolved.post).toMatchObject({ pipelineStatus: "changes", block: null, change: { case: "final_design" } });
    at(c, "changes", "in_production");

    const w = byTitle("Seasonal window display");
    expect(w).toMatchObject({ pipelineStatus: "blocked", blockedFrom: "design" });
    refused(act(w, "company_admin", "resolve"), "not_officer_or_approver");
    refused(act(w, "owner", "resolve"), "not_officer_or_approver"); // the owner holds no team step
    okRes(act(w, "approver", "resolve"));
    at(w, "design", "in_production");
    okRes(act(w, "officer", "block", { reason: "Waiting for the photos again.", waitingOn: "client" }));
    at(w, "blocked", "brief");
    const first = act(w, "approver", "follow_up", { note: "Any news on the photos?" });
    okRes(first);
    expect(w.history.at(-1)).toMatchObject({ action: "follow_up", from: "blocked", to: "blocked" });
    const again = act(w, "approver", "follow_up");
    refused(again, "follow_up_too_soon");
    expect(again.json.retryAfterSeconds).toBeGreaterThan(0);
    const mine = byTitle("The new lobby bar");
    refused(act(mine, "officer", "follow_up"), "nobody_to_follow_up"); // the officer holds it: nobody else to nudge
    okRes(act(mine, "approver", "follow_up"));
  });

  it("rescheduling an approved post asks the client again, and the approved time passing is its own refusal", () => {
    const p = byTitle("Behind the scenes at the studio");
    expect(p.pipelineStatus).toBe("approved");
    refused(act(p, "company_admin", "schedule"), "not_the_officer");
    refused(act(p, "officer", "reschedule"), "no_change");
    okRes(act(p, "officer", "schedule"));
    at(p, "scheduled", "client_approved");
    const later = "2026-10-30T09:30:00.000Z";
    refused(act(p, "officer", "reschedule", { at: "next week" }), "invalid_field", { field: "at" });
    const re = okRes(act(p, "officer", "reschedule", { at: later }));
    expect(re.post).toMatchObject({ pipelineStatus: "client", scheduleVia: null, scheduledAt: later, approvedSchedule: null });
    at(p, "client", "with_client");
    const again = okRes(act(p, "officer", "record_client_approve", { channel: "meeting", note: "Agreed at the Monday meeting." }));
    expect(again.post).toMatchObject({ pipelineStatus: "approved", approvedSchedule: { scheduledAt: later } });
    const newNetworks = okRes(act(p, "officer", "reschedule", { placement: ["tiktok"] }));
    expect(newNetworks.post).toMatchObject({ pipelineStatus: "client", placement: ["tiktok"] });
    expect(newNetworks.post.variants.map((v: Body) => v.network)).toEqual(["tiktok"]);
    refused(act(p, "officer", "reschedule", { placement: ["pinterest"] }), "invalid_transition"); // it is with the client now: nothing to reschedule

    const q = byTitle("Harbour view suite");
    q.scheduledAt = "2026-10-01T09:00:00.000Z"; // the approved time is in the past
    refused(act(q, "officer", "schedule"), "approved_time_passed");
    refused(act(q, "officer", "reschedule", { placement: ["x"] }), "no_account_for_network", { detail: { networks: ["x"] } }); // the client has no account on X
    expect(okRes(act(q, "officer", "reschedule", { at: "2026-11-02T09:00:00.000Z" })).post.pipelineStatus).toBe("client");
  });

  it("one of the four files through the publisher; the officer and a company admin cannot, and only the four unschedule it", () => {
    const p = byTitle("Meet the packing team");
    expect(p).toMatchObject({ pipelineStatus: "scheduled", scheduleVia: "publisher" });
    refused(act(p, "officer", "unschedule"), "not_an_approver");
    refused(act(p, "officer", "reschedule", { at: "2026-10-30T09:00:00.000Z" }), "cancel_required");
    okRes(act(p, "approver", "unschedule"));
    expect(p).toMatchObject({ pipelineStatus: "approved", scheduleVia: null });
    refused(act(p, "officer", "schedule_publisher"), "author_cannot_approve");
    refused(act(p, "company_admin", "schedule_publisher"), "not_an_approver");
    const filed = okRes(act(p, "approver", "schedule_publisher"));
    expect(filed.post).toMatchObject({ pipelineStatus: "scheduled", scheduleVia: "publisher" });
  });
});

describe("the order of checks (§63.3.2)", () => {
  it("1 and 2: an unknown action (a portal action included) before anything, then a missing post, then a Composer post", () => {
    const p = byTitle("Gift guide for the host");
    expect(runDemoPipelineAction("nope", { action: "nope", expectedStatus: "drafting" }, "u-social")).toMatchObject({ status: 400, json: { error: "unknown_action" } });
    expect(runDemoPipelineAction(p.id, { action: "client_approve", expectedStatus: "client" }, "u-social")).toMatchObject({ status: 400, json: { error: "unknown_action" } });
    expect(runDemoPipelineAction(p.id, { action: "edit", expectedStatus: "drafting" }, "u-social")).toMatchObject({ status: 400, json: { error: "unknown_action" } }); // edit has its own route
    expect(runDemoPipelineAction("nope", { action: "block", expectedStatus: "drafting" }, "u-social")).toMatchObject({ status: 404, json: { error: "post_not_found" } });
    expect(runDemoPipelineAction("soc-post-1", { action: "block", expectedStatus: "draft" }, "u-social", { composer: true })).toMatchObject({ status: 409, json: { error: "not_a_pipeline_post" } });
    const viaRoute = socialDemo("POST", "/api/co-agency/modules/social/posts/soc-post-1/actions", new URLSearchParams(), JSON.stringify({ action: "block" }), "u-social");
    expect(viaRoute).toMatchObject({ status: 409, json: { error: "not_a_pipeline_post" } });
    expect(socialDemo("POST", "/api/co-agency/modules/social/posts/nope/actions", new URLSearchParams(), JSON.stringify({ action: "block" }), "u-social")).toMatchObject({ status: 404, json: { error: "post_not_found" } });
  });

  it("3: the same actionId as the post's last applied action replays as 200 alreadyApplied, before the status is compared", () => {
    const p = byTitle("Gift guide for the host");
    expect(p.pipelineStatus).toBe("drafting");
    const id = randomUUID();
    const first = okRes(act(p, "officer", "block", { reason: "Waiting for the photos.", waitingOn: "client" }, { actionId: id }));
    expect(first.post.pipelineStatus).toBe("blocked");
    const replay = act(p, "officer", "block", { reason: "Waiting for the photos.", waitingOn: "client" }, { actionId: id, expectedStatus: "drafting" });
    expect(replay).toMatchObject({ status: 200, json: { alreadyApplied: true, post: { pipelineStatus: "blocked" } } });
    okRes(act(p, "officer", "resolve")); // back to drafting
    expect(p.pipelineStatus).toBe("drafting");
  });

  it("5, 6 and 7: an unattended automation, the maker/checker, then the persona's own refusal code", () => {
    const p = byTitle("Gift guide for the host");
    refused(act(p, "demo-bot", "block", { reason: "abc", waitingOn: "client" }), "automation_cannot_act");
    // the maker/checker answers before Cerbos: the officer is the author of this post
    const hod = byTitle("Our first cold-weather drop");
    expect(hod.authorId).toBe("u-social");
    refused(act(hod, "officer", "approve_for_design"), "author_cannot_approve");
    refused(act(p, "demo-client", "block", { reason: "abc", waitingOn: "client" }), "not_officer_or_approver");
    refused(act(p, "copywriter", "start_draft"), "not_the_officer");
  });

  it("8 and 9: expectedStatus (missing, unknown, stale) and then the action's `from`", () => {
    const p = byTitle("Gift guide for the host");
    const call = (body: Body) => runDemoPipelineAction(p.id, { action: "send_to_proofread", ...body }, "u-social") as Res;
    refused(call({}), "missing_field", { field: "expectedStatus" });
    refused(call({ expectedStatus: "sideways" }), "invalid_field", { field: "expectedStatus" });
    refused(call({ expectedStatus: "planned" }), "status_changed", { detail: { status: "drafting", phase: "brief" } });
    refused(call({ expectedStatus: "drafting", actionId: "not-a-uuid" }), "invalid_field", { field: "actionId" });
    // the approver, at a step that is not theirs: 409, after Cerbos let them through
    refused(act(p, "approver", "approve_for_design"), "invalid_transition", { detail: { status: "drafting", changeCase: null } });
    const ch = byTitle("Winter packages");
    refused(act(ch, "approver", "approve_for_design"), "invalid_transition", { detail: { status: "changes", changeCase: "hod_copy" } });
  });

  it("10 and 11: the body before the guards, and the guards in the fixture's order (hard requirements, then the soft checks)", () => {
    const p = byTitle("Gift guide for the host");
    refused(act(p, "officer", "send_to_proofread", { sendAnyway: "yes" }), "invalid_field", { field: "sendAnyway" });
    const r = act(p, "officer", "send_to_proofread");
    refused(r, "checks_failed");
    expect(r.json.blockers[0]).toMatchObject({ code: "must_haves_unticked", message: expect.any(String) });
    expect(p.pipelineStatus).toBe("drafting"); // a refusal changes nothing
  });

  it("archive: the post stops changing, leaves the cycle's counts, and its engine status reads archived; discard removes a planned post from every read", () => {
    const q = byTitle("Harbour view suite");
    const before = demoCycleCounts(q.cycleId).counted;
    refused(act(q, "officer", "archive"), "missing_field", { field: "reason" });
    const archived = okRes(act(q, "officer", "archive", { reason: "The client paused this campaign." }));
    expect(archived.post).toMatchObject({ pipelineStatus: q.pipelineStatus, engineStatus: "archived", archivedAt: expect.any(String) });
    expect(demoCycleCounts(q.cycleId).counted).toBe(before - 1);
    refused(act(q, "officer", "follow_up"), "post_archived");
    refused(act(q, "approver", "resolve"), "post_archived");

    const d = byTitle("December at the harbour");
    expect(d.pipelineStatus).toBe("planned");
    const gone = okRes(act(d, "officer", "discard"));
    expect(gone.post).toBeNull();
    expect(gone.applied).toEqual({ action: "discard", from: "planned", to: "deleted" });
    expect(PIPE_POSTS.some((x) => x.id === d.id)).toBe(false);
    expect(demoPipelineRead(d.id, "u-social")).toMatchObject({ status: 404, json: { error: "post_not_found" } });
  });
});

describe("the edit, suggestions, designs and bulk routes", () => {
  it("edit: only the fields the twin allows, `field_locked` with its detail, a copy fix logged, and no edit at a step with no edit rule", () => {
    const p = byTitle("Sunset terrace menu");
    expect(p).toMatchObject({ pipelineStatus: "changes", changeCase: "client_copy", changedOnly: true });
    refused(edit(p, "officer", { placement: ["instagram"] }), "field_locked", { detail: { field: "placement", status: "changes" } });
    refused(edit(p, "officer", { bogus: 1 }), "invalid_field", { field: "bogus" });
    refused(edit(p, "officer", {}), "invalid_field", { field: "fields" });
    refused(route(p, "copywriter", "PATCH", `posts/${p.id}/pipeline`, { expectedStatus: "changes", fields: { caption: "x" } }), "not_the_officer");
    refused(route(p, "officer", "PATCH", `posts/${p.id}/pipeline`, { expectedStatus: "client", fields: { caption: "x" } }), "status_changed");
    const saved = okRes(edit(p, "officer", { caption: "Open from five in the evening.", mustHaves: ALL_TEN }));
    expect(saved.post).toMatchObject({ caption: "Open from five in the evening.", pipelineStatus: "changes" });
    expect(saved.applied).toEqual({ action: "edit", from: "changes", to: "changes" });
    expect(p.copyLog.at(-1)).toMatchObject({ field: "caption", via: "fix", after: "Open from five in the evening." });
    const sched = byTitle("Autumn collection teaser");
    expect(sched.pipelineStatus).toBe("scheduled");
    refused(edit(sched, "officer", { caption: "x" }), "invalid_transition", { detail: { status: "scheduled", changeCase: null } });
  });

  it("suggestions: only in proofread, one per copy field, dropped with DELETE, and a stale one is flagged on the read", () => {
    const p = byTitle("Old harbour walk");
    expect(p.pipelineStatus).toBe("proofread");
    okRes(route(p, "copywriter", "PUT", `posts/${p.id}/suggestions/cta`, { expectedStatus: "proofread", value: "Book a walk" }));
    okRes(route(p, "copywriter", "PUT", `posts/${p.id}/suggestions/hashtags`, { expectedStatus: "proofread", value: ["harborlight", "walk"] }));
    refused(route(p, "copywriter", "PUT", `posts/${p.id}/suggestions/hashtags`, { expectedStatus: "proofread", value: ["#bad tag"] }), "invalid_field", { field: "value" });
    // the field changes under the suggestion: it is stale on the next read
    p.cta = "Walk with us";
    const read = demoPipelineRead(p.id, "u-social").json as Body;
    expect(read.suggestions.cta.stale).toBe(true);
    expect(read.suggestions.hashtags.stale).toBe(false);
    refused(route(p, "copywriter", "PUT", `posts/${p.id}/suggestions/cta`, { expectedStatus: "drafting", value: "x" }), "status_changed");
    okRes(route(p, "copywriter", "DELETE", `posts/${p.id}/suggestions/cta`));
    expect(Object.keys(p.suggestions)).toEqual(["hashtags"]);
    const planned = byTitle("Staff pick of the week");
    refused(route(planned, "copywriter", "PUT", `posts/${planned.id}/suggestions/caption`, { expectedStatus: "drafting", value: "x" }), "invalid_transition");
  });

  it("designs: add by link or asset, patch a position or source, remove, and the designer's gate", () => {
    const p = byTitle("Hot stone, step by step");
    expect(p).toMatchObject({ pipelineStatus: "design", creativeSource: "in_team" });
    const d1 = String((p.designs[0] as Body).id);
    refused(route(p, "request_designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "design", linkUrl: "https://example.com/x", linkSource: "own" }), "not_the_designer");
    const ai = okRes(route(p, "in_team_designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "design", linkUrl: "https://example.com/x", linkSource: "ai", linkAiNote: "Backdrop by an image model.", position: 2 }));
    expect(ai.post.designs).toHaveLength(2);
    expect(ai.post.designs.at(-1)).toMatchObject({ position: 2, link: { source: "ai", aiNote: "Backdrop by an image model." } });
    refused(route(p, "in_team_designer", "PATCH", `posts/${p.id}/designs/${d1}`, { linkSource: "ai" }), "missing_field", { field: "linkAiNote" });
    refused(route(p, "in_team_designer", "PATCH", `posts/${p.id}/designs/nope`, { position: 3 }), "design_not_found");
    refused(route(p, "in_team_designer", "PATCH", `posts/${p.id}/designs/${d1}`, { position: 0 }), "invalid_field", { field: "position" });
    okRes(route(p, "in_team_designer", "PATCH", `posts/${p.id}/designs/${d1}`, { linkSource: "ai", linkAiNote: "Made with a model.", position: 3 }));
    expect(p.designs.find((d) => d.id === d1)).toMatchObject({ position: 3, link: { source: "ai", aiNote: "Made with a model." } });
    okRes(route(p, "in_team_designer", "DELETE", `posts/${p.id}/designs/${d1}`));
    refused(route(p, "in_team_designer", "DELETE", `posts/${p.id}/designs/${d1}`), "design_not_found");
    expect(p.designs).toHaveLength(1);
    const final = byTitle("Meet our senior therapist");
    refused(route(final, "in_team_designer", "POST", `posts/${final.id}/designs`, { expectedStatus: final.pipelineStatus, linkUrl: "https://example.com/x", linkSource: "own" }), "invalid_transition");
  });

  it("bulk: each item runs the order of checks on its own, one refusal never undoes another, and send anyway is not offered", () => {
    const walk = byTitle("Old harbour walk");
    const drafting = byTitle("Gift guide for the host");
    okRes(route(walk, "copywriter", "DELETE", `posts/${walk.id}/suggestions/hashtags`));
    const res = okRes(runDemoPipelineWrite("POST", "posts/actions", {
      action: "approve_copy",
      items: [
        { postId: walk.id, expectedStatus: "proofread", actionId: randomUUID() },
        { postId: drafting.id, expectedStatus: "drafting" },
        { postId: "no-such-post", expectedStatus: "proofread" },
        { postId: walk.id },
      ],
    }, "u-copy") as Res);
    expect(res.results[0]).toMatchObject({ postId: walk.id, ok: true, post: { pipelineStatus: "client", changedOnly: false } });
    expect(res.results[1]).toMatchObject({ postId: drafting.id, ok: false, error: "invalid_transition", detail: { status: "drafting" } });
    expect(res.results[2]).toMatchObject({ postId: "no-such-post", ok: false, error: "post_not_found" });
    expect(res.results[3]).toMatchObject({ ok: false, error: "missing_field", field: "expectedStatus" });
    assertStoreIsLegal();

    const send = okRes(runDemoPipelineWrite("POST", "posts/actions", { action: "send_to_proofread", items: [{ postId: drafting.id, expectedStatus: "drafting" }] }, "u-social") as Res);
    expect(send.results[0]).toMatchObject({ ok: false, error: "checks_failed", blockers: [expect.objectContaining({ code: "must_haves_unticked" })] });
    expect(runDemoPipelineWrite("POST", "posts/actions", { items: [] }, "u-social")).toMatchObject({ status: 400, json: { error: "missing_field", field: "action" } });
    expect(runDemoPipelineWrite("POST", "posts/actions", { action: "block", items: [{ postId: "x" }] }, "u-social")).toMatchObject({ status: 400, json: { error: "invalid_field", field: "action" } });
    expect(runDemoPipelineWrite("POST", "posts/actions", { action: "approve_copy", items: [] }, "u-copy")).toMatchObject({ status: 400, json: { error: "invalid_field", field: "items" } });
    expect(runDemoPipelineWrite("GET", "posts/nope/unknown", {}, "u-social")).toBeNull();
  });
});

// SCP-1u: the demo answers the Asset Library the post page reads, an asset design is stored as the server stores it, and `actions[]` runs the server's body-free guards.
describe("SCP-1u: the Asset Library read, a stored asset design, and the guards of actions[]", () => {
  const LIBRARY = "/api/co-agency/creative/assets";
  const stateOf = (title: string, status: string): PipePost => {
    const c = structuredClone(byTitle(title));
    Object.assign(c, { pipelineStatus: status, changeCase: null, changeBy: null, changeKind: null, returnTo: null, scheduleVia: null, blockedFrom: null, blockWaitingOn: null, rescheduled: false, history: [] });
    return c;
  };
  const link = (id: string) => ({ id, position: 1, asset: null, link: { url: "https://example.com/d", source: "own", aiNote: null }, fileId: null });
  const stored = (id: string) => ({ id, position: 1, asset: { groupId: DEMO_ASSETS[0].groupId, versionId: DEMO_ASSETS[0].versionId, versionNo: 2, name: DEMO_ASSETS[0].name, source: "own", aiNote: null }, link: null, fileId: null });
  const one = (p: PipePost, who: string, name: string) => demoPostActions(p, persona(p, who)).find((a) => a.action === name);

  it("the library read is the invented assets, in the library's row shape, for the unfiltered read only", () => {
    const r = demoAssetLibraryRead("GET", LIBRARY, new URLSearchParams())!;
    expect(r.status).toBe(200);
    expect((r.json as Body[]).map((a) => ({ id: a.id, name: a.name, group: a.versionGroupId, no: a.versionNo }))).toEqual(
      DEMO_ASSETS.map((a) => ({ id: a.versionId, name: a.name, group: a.groupId, no: a.versionNo })),
    );
    expect(demoAssetLibraryRead("GET", LIBRARY, new URLSearchParams("departmentId=dept-2"))).toBeNull();
    expect(demoAssetLibraryRead("POST", LIBRARY, new URLSearchParams())).toBeNull();
    expect(demoAssetLibraryRead("GET", `${LIBRARY}/demo-asset-v1/versions`, new URLSearchParams())).toBeNull();
    // and it is what the whole demo answers on the path the post page reads
    const wired = getDemoResponse("GET", LIBRARY, "u-creative");
    expect(wired.status).toBe(200);
    expect((wired.json as Body[]).map((a) => a.versionGroupId)).toEqual(DEMO_ASSETS.map((a) => a.groupId));
  });

  it("an asset design is stored as the server stores it: the final check and the client send accept it, and a link-only design is still refused", () => {
    const p = byTitle("Winter warmth menu");
    expect(p).toMatchObject({ pipelineStatus: "design", creativeSource: "in_team", creativeState: "not_started" });
    okRes(act(p, "in_team_designer", "start_design"));
    // a link only: the design step may submit it, the final check may not send it (the server's `asset_group_id` NULL)
    const linkAdded = okRes(route(p, "in_team_designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "design", linkUrl: "https://example.com/drive/d1", linkSource: "own" }));
    expect(linkAdded.post.designs[0].asset).toBeNull();
    okRes(act(p, "in_team_designer", "submit_design"));
    refused(act(p, "approver", "final_approve"), "design_not_stored", { detail: { designIds: [`${p.id}-d1`] } });
    // changes back to the designer, who swaps the link for an asset of the library
    okRes(act(p, "approver", "final_changes", { changeKind: "design", note: "Please use a saved asset." }));
    okRes(route(p, "in_team_designer", "DELETE", `posts/${p.id}/designs/${p.id}-d1`));
    const added = okRes(route(p, "in_team_designer", "POST", `posts/${p.id}/designs`, { expectedStatus: "changes", assetGroupId: DEMO_ASSETS[1].groupId }));
    expect(added.post.designs).toEqual([expect.objectContaining({ asset: expect.objectContaining({ groupId: DEMO_ASSETS[1].groupId }), link: null })]);
    okRes(act(p, "in_team_designer", "submit_design"));
    expect(one(p, "approver", "final_approve")).toEqual({ action: "final_approve", allowed: true });
    const sent = okRes(act(p, "approver", "final_approve"));
    expect(sent.post.pipelineStatus).toBe("client");
    expect(sent.post.designs[0].fileId).toEqual(expect.any(String)); // the send materialized the file
  });

  it("submit_design is disabled with design_missing until the post has a design; the persona's refusal still comes first", () => {
    const p = stateOf("Winter warmth menu", "design");
    p.designs = [];
    expect(one(p, "in_team_designer", "submit_design")).toEqual({ action: "submit_design", allowed: false, reason: "design_missing" });
    expect(one(p, "request_designer", "submit_design")).toEqual({ action: "submit_design", allowed: false, reason: "not_the_designer" });
    p.designs = [link(`${p.id}-d1`)];
    expect(one(p, "in_team_designer", "submit_design")).toEqual({ action: "submit_design", allowed: true });
  });

  it("final_approve runs the server's guards in the fixture's order: design_missing, design_not_stored, then the client's accounts", () => {
    const p = stateOf("Winter warmth menu", "final");
    p.designs = [];
    expect(one(p, "approver", "final_approve")).toEqual({ action: "final_approve", allowed: false, reason: "design_missing" });
    p.designs = [link(`${p.id}-d1`)];
    expect(one(p, "approver", "final_approve")).toEqual({ action: "final_approve", allowed: false, reason: "design_not_stored" });
    p.designs = [link(`${p.id}-d1`), stored(`${p.id}-d2`)]; // one link among stored ones is still unstored
    expect(one(p, "approver", "final_approve")).toEqual({ action: "final_approve", allowed: false, reason: "design_not_stored" });
    p.designs = [stored(`${p.id}-d1`)];
    expect(one(p, "approver", "final_approve")).toEqual({ action: "final_approve", allowed: true });
    p.placement = ["x"]; // the client has no account on X
    expect(one(p, "approver", "final_approve")).toEqual({ action: "final_approve", allowed: false, reason: "no_account_for_network" });
    p.designs = [];
    expect(one(p, "approver", "final_approve")).toEqual({ action: "final_approve", allowed: false, reason: "design_missing" });
    // the maker/checker and the persona come before any guard, and an action with no guard of that kind is untouched
    p.designs = [link(`${p.id}-d1`)];
    expect(one(p, "officer", "final_approve")).toEqual({ action: "final_approve", allowed: false, reason: "author_cannot_approve" });
    expect(one(p, "approver", "final_changes")).toEqual({ action: "final_changes", allowed: true });
  });

  it("the other body-free guards the demo used to skip: a stale suggestion, an incomplete post, a passed approved time and a follow-up inside 24 hours", () => {
    const stale = stateOf("Old harbour walk", "proofread");
    stale.suggestions = { caption: { value: "A new caption", base: "an older caption", by: "u-copy", at: "2026-10-15T09:00:00.000Z" } };
    expect(one(stale, "copywriter", "approve_copy")).toEqual({ action: "approve_copy", allowed: false, reason: "suggestion_stale" });
    stale.suggestions = {};
    expect(one(stale, "copywriter", "approve_copy")).toEqual({ action: "approve_copy", allowed: true });

    const draft = stateOf("Gift guide for the host", "drafting");
    draft.caption = "";
    expect(one(draft, "officer", "send_to_proofread")).toEqual({ action: "send_to_proofread", allowed: false, reason: "incomplete_post" });
    draft.caption = "A caption.";
    draft.mustHaves = []; // a soft check: send anyway is always possible, so the button stays live
    expect(one(draft, "officer", "send_to_proofread")).toEqual({ action: "send_to_proofread", allowed: true });

    const approved = stateOf("Harbour view suite", "approved");
    approved.scheduledAt = "2026-10-01T09:00:00.000Z";
    expect(one(approved, "officer", "schedule")).toEqual({ action: "schedule", allowed: false, reason: "approved_time_passed" });
    approved.scheduledAt = "2026-10-23T09:00:00.000Z";
    expect(one(approved, "officer", "schedule")).toEqual({ action: "schedule", allowed: true });

    const withClient = stateOf("Five ways to style a scarf", "client");
    expect(one(withClient, "approver", "follow_up")).toEqual({ action: "follow_up", allowed: true });
    withClient.history = [{ action: "follow_up", from: "client", to: "client", by: { id: "u-pm", name: "x" }, agent: null, at: new Date().toISOString(), recorded: null, viaPortal: false, holder: "client" }];
    expect(one(withClient, "approver", "follow_up")).toEqual({ action: "follow_up", allowed: false, reason: "follow_up_too_soon" });
    withClient.history[0].holder = "approver"; // a follow-up that reached an earlier holder is not this holder's
    expect(one(withClient, "approver", "follow_up")).toEqual({ action: "follow_up", allowed: true });
  });

  it("the read's actions[] runs the guards, and the feed card does not (the server decides a card with no facts and a neutral post)", () => {
    const p = byTitle("Old harbour walk");
    const saved = structuredClone(p); // an earlier test moved this post: put it at proofread for this one, and back after
    try {
      Object.assign(p, { pipelineStatus: "proofread", changeCase: null, changeBy: null, changeKind: null, returnTo: null, blockedFrom: null, blockWaitingOn: null, history: [] });
      p.suggestions = { caption: { value: "A new caption", base: "an older caption", by: "u-copy", at: "2026-10-15T09:00:00.000Z" } };
      const read = demoPipelineRead(p.id, "u-copy").json as Body;
      expect(read.actions.find((a: Body) => a.action === "approve_copy")).toEqual({ action: "approve_copy", allowed: false, reason: "suggestion_stale" });
      expect(read.nextAction).toBeNull();
      const card = ((demoFeed(new URLSearchParams("view=all&limit=50"), "u-copy").json as Body).items as Body[]).find((c) => c.id === p.id)!;
      expect(card.nextAction).toEqual({ action: "approve_copy", allowed: true });
    } finally {
      Object.assign(p, saved);
    }
  });
});

describe("the runner and the fixture stay in step", () => {
  const FX = fixture as unknown as { actions: Array<{ action: string; effects: string[]; cerbosAction?: unknown }> };

  it("the action route's values are the fixture's, less the routes of their own and the portal's", () => {
    expect([...DEMO_ACTION_ROUTE].sort()).toEqual(
      FX.actions.filter((a) => !["create", "edit", "suggest", "add_design", "remove_design"].includes(a.action) && !(typeof a.cerbosAction === "string" && a.cerbosAction.startsWith("portal:"))).map((a) => a.action).sort(),
    );
    expect(DEMO_ACTION_ROUTE).toContain("accept_suggestion");
    expect(DEMO_ACTION_ROUTE).not.toContain("client_approve");
  });

  it("every effect of every action the runner runs is handled, or named as one the demo store has no row for", () => {
    const strip = (raw: string): string => (/^(when [a-zA-Z_]+|else|officer|publisher): (.+)$/.exec(raw)?.[2] ?? raw);
    const unhandled: string[] = [];
    for (const a of FX.actions) {
      if (!DEMO_ACTION_ROUTE.includes(a.action) && !["edit", "suggest", "add_design", "remove_design"].includes(a.action)) continue;
      for (const raw of a.effects) {
        const name = strip(raw);
        if (!DEMO_COLUMN_EFFECTS.includes(name) && !isNoopEffect(name)) unhandled.push(`${a.action}: ${name}`);
      }
    }
    expect(unhandled).toEqual([]);
    // and the other way: a handled effect the fixture no longer names is dead code
    const named = new Set(FX.actions.flatMap((a) => a.effects.map(strip)));
    expect(DEMO_COLUMN_EFFECTS.filter((e) => !named.has(e))).toEqual([]);
  });
});

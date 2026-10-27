import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-1e (BFF §63.3, §63.6): the post page's pure helpers. They read the fixture twin and add words, so each test pins the words against the fixture: a code, an action,
// a status or a field the twin gains and these helpers do not know fails here, not on a screen. The demo store seeds from the day it is first touched, so the clock is
// pinned to mid-month before it is imported (hence vi.hoisted). Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import fixture from "./scpStageMachine.json";
import { SCP_STATUSES } from "./scpStageMachine";
import { PIPE_POSTS, demoPipelineRead } from "./demoSocialPipeline";
import {
  ACTION_DIALOG, ACTION_LABEL, CHECK_CODES, FIELD_SPECS, PIPELINE_ACTIONS, RECORD_CLIENT_KEYS, REFUSAL_CODES, REFUSAL_WORDS, SIDE_STATUSES, STEPS, SUGGESTIBLE_FIELDS,
  activityWords, asPipelinePost, blockerLines, buildActionParams, canAuthorPost, canDesignPost, canSuggest, canWriteClientComment, cerbosKeyOf, editableFieldsOf, historyLine,
  isoToZoneInput, lockedWords, newActionId, postImage, reasonWords, refusalFromBody, refusalText, statusChipText, statusLabel, stepOf, zoneInputToIso,
  type ActionRow, type PipelinePost,
} from "./socialPipeline";

const FX = fixture as unknown as {
  statuses: string[]; refusals: Record<string, unknown>; fieldGroups: Record<string, string[]>;
  actions: Array<{ action: string; params: Record<string, string>; cerbosAction?: string | Record<string, string> }>;
  cerbosActions: Record<string, { actors: unknown }>;
};
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const read = (title: string, user = "u-social"): Body => {
  const p = PIPE_POSTS.find((x) => x.title === title)!;
  return demoPipelineRead(p.id, user).json as Body;
};
const post = (over: Partial<PipelinePost> = {}): PipelinePost => ({ ...asPipelinePost(read("Gift guide for the host")), ...over });

describe("the refusal words: one map, every code of the fixture", () => {
  it("has words for every refusal code of the fixture, and for nothing the fixture does not name", () => {
    expect(Object.keys(REFUSAL_WORDS).sort()).toEqual([...REFUSAL_CODES].sort());
    expect(REFUSAL_CODES.length).toBeGreaterThan(50);
    for (const code of REFUSAL_CODES) {
      expect(REFUSAL_WORDS[code], code).toBeTruthy();
      expect(REFUSAL_WORDS[code], code).toMatch(/[.]$/); // a sentence
      expect(REFUSAL_WORDS[code], code).not.toContain("_"); // never a bare token
    }
  });

  it("words a reason as the read carries it (a code alone), and any code the fixture does not know without leaking it raw", () => {
    expect(reasonWords("not_the_designer")).toBe(REFUSAL_WORDS.not_the_designer);
    expect(reasonWords(undefined)).toBe("You cannot take this step.");
    expect(reasonWords("not authorized: social_post author")).toBe("You are not allowed to do this.");
    expect(reasonWords("some_new_code")).toBe("Some new code.");
  });

  it("adds the figures a refusal carries: the step, the field, the fields, the networks, the wait", () => {
    const r = (error: string, extra: Partial<Parameters<typeof refusalText>[0]> = {}) => refusalText({ status: 409, error, ...extra });
    expect(r("status_changed", { detail: { status: "hod", phase: "in_production" } })).toBe("Someone moved this post while you were looking at it. It is now at HoD approval. The page has been refreshed.");
    expect(r("invalid_transition", { detail: { status: "client" } })).toContain("With the client");
    expect(r("field_locked", { detail: { field: "placement", status: "changes" } })).toBe("Networks cannot be changed at Changes asked.");
    expect(r("suggestion_stale", { detail: { fields: ["cta", "caption"] } })).toContain("Call to action, Caption");
    expect(r("no_account_for_network", { detail: { networks: ["tiktok", "x"] } })).toContain("TikTok, X");
    expect(r("follow_up_too_soon", { retryAfterSeconds: 7260 })).toContain("2 h 1 min");
    expect(r("follow_up_too_soon", { retryAfterSeconds: 90 })).toContain("2 min");
    expect(r("missing_field", { field: "sendAnywayReason" })).toBe("The reason is required.");
    expect(r("invalid_field", { field: "caption" })).toBe("Caption is not valid.");
    expect(r("missing_field")).toBe("A value is required.");
    expect(refusalText({ status: 403, error: "not_authorized", reason: "assurance_required" })).toContain("second factor");
    // a detail the server did not send leaves the plain sentence
    expect(r("status_changed")).toBe(REFUSAL_WORDS.status_changed);
  });

  it("reads a refusal's parts off the raw body, and words a 409's blockers one per line", () => {
    const r = refusalFromBody(409, "checks_failed", { error: "checks_failed", blockers: [{ code: "must_haves_unticked", message: "Tick all ten must-haves." }, { code: "x", message: "" }], detail: { a: 1 }, retryAfterSeconds: 5 }, undefined, "r");
    expect(r).toEqual({ status: 409, error: "checks_failed", blockers: [{ code: "must_haves_unticked", message: "Tick all ten must-haves." }, { code: "x", message: "" }], detail: { a: 1 }, retryAfterSeconds: 5, reason: "r" });
    expect(blockerLines(r)).toEqual(["Tick all ten must-haves.", "X."]);
    expect(refusalFromBody(400, "missing_field", undefined, "note")).toEqual({ status: 400, error: "missing_field", field: "note" });
  });
});

describe("actions: every value of the action route has a label and a dialog entry", () => {
  it("is the fixture's action route, and each of its values has words and a dialog (or none)", () => {
    expect(PIPELINE_ACTIONS).toContain("accept_suggestion");
    for (const own of ["create", "edit", "suggest", "add_design", "remove_design", "client_approve", "client_change", "client_undo"]) expect(PIPELINE_ACTIONS, own).not.toContain(own);
    for (const a of PIPELINE_ACTIONS) {
      expect(ACTION_LABEL[a], a).toBeTruthy();
      expect(a in ACTION_DIALOG, a).toBe(true);
    }
    expect(Object.keys(ACTION_LABEL).sort()).toEqual([...PIPELINE_ACTIONS].sort());
    expect(Object.keys(ACTION_DIALOG).sort()).toEqual([...PIPELINE_ACTIONS].sort());
  });

  it("an action's dialog collects exactly the params the fixture names, never one it does not, and every required one", () => {
    const full = {
      note: "A note.", reason: "A reason.", waitingOn: "client", channel: "email", changeKind: "copy", url: "https://example.com/p", at: "2026-10-30T09:00:00.000Z",
      placement: ["tiktok"], anchor: { x: 0.2, y: 0.3, fileId: "f1" }, sendAnyway: true, sendAnywayReason: "The client confirmed it by phone.",
    };
    for (const a of PIPELINE_ACTIONS) {
      if (ACTION_DIALOG[a] === null) continue;
      const named = Object.keys(FX.actions.find((x) => x.action === a)!.params);
      const r = buildActionParams(a, full, { approvedSchedule: { scheduledAt: "2026-10-23T09:30:00.000Z", placement: ["instagram"] } });
      expect(r.ok, `${a}: ${JSON.stringify(r)}`).toBe(true);
      if (!r.ok) continue;
      for (const k of Object.keys(r.params)) expect(named, `${a} sends ${k}`).toContain(k);
      const prose = FX.actions.find((x) => x.action === a)!.params;
      for (const k of named) if (/required/.test(prose[k]) && !/when/.test(prose[k])) expect(Object.keys(r.params), `${a} needs ${k}`).toContain(k);
    }
  });

  it("validates each dialog the way the fixture's prose says, naming the field", () => {
    const bad = (a: string, i: Parameters<typeof buildActionParams>[1], field: string) => expect(buildActionParams(a, i), `${a} ${field}`).toMatchObject({ ok: false, field });
    bad("return_copy", { note: "  " }, "note");
    bad("return_copy", { note: "x".repeat(2001) }, "note");
    bad("final_changes", { note: "Fix it." }, "changeKind");
    bad("final_changes", { changeKind: "copy" }, "note");
    bad("block", { reason: "ab", waitingOn: "client" }, "reason");
    bad("block", { reason: "Waiting.", waitingOn: "" }, "waitingOn");
    bad("block", { reason: "Waiting.", waitingOn: "the moon" }, "waitingOn");
    bad("archive", { reason: "no" }, "reason");
    bad("record_client_approve", { note: "ok", channel: "" }, "channel");
    bad("record_client_change", { note: "ok", channel: "email", changeKind: "" }, "changeKind");
    bad("send_to_proofread", { sendAnyway: true, sendAnywayReason: "too short" }, "sendAnywayReason");
    bad("send_to_proofread", { sendAnyway: true, sendAnywayReason: "x".repeat(501) }, "sendAnywayReason");
    bad("mark_live", { url: "" }, "url");
    bad("mark_live", { url: "javascript:alert(1)" }, "url");
    bad("mark_live", { url: "https://example.com", at: "soon" }, "at");
    bad("follow_up", { note: "x".repeat(501) }, "note");
    expect(buildActionParams("send_to_proofread", {})).toEqual({ ok: true, params: {} });
    expect(buildActionParams("follow_up", { note: "  " })).toEqual({ ok: true, params: {} });
    expect(buildActionParams("approve_copy", {})).toEqual({ ok: true, params: {} });
    expect(buildActionParams("record_client_change", { changeKind: "design", channel: "meeting", note: " Brighter. ", anchor: { x: 0.1, y: 0.2, fileId: "f" } }))
      .toEqual({ ok: true, params: { changeKind: "design", channel: "meeting", note: "Brighter.", anchor: { x: 0.1, y: 0.2, fileId: "f" } } });
  });

  it("reschedule needs a change from what the client approved, and sends only what differs", () => {
    const ap = { approvedSchedule: { scheduledAt: "2026-10-23T09:30:00.000Z", placement: ["instagram", "facebook"] } };
    expect(buildActionParams("reschedule", { at: "2026-10-23T09:30:00.000Z", placement: ["facebook", "instagram"] }, ap)).toMatchObject({ ok: false, field: "at" });
    expect(buildActionParams("reschedule", { at: "2026-10-24T09:30:00.000Z", placement: ["instagram", "facebook"] }, ap)).toEqual({ ok: true, params: { at: "2026-10-24T09:30:00.000Z" } });
    expect(buildActionParams("reschedule", { at: "2026-10-23T09:30:00.000Z", placement: ["tiktok"] }, ap)).toEqual({ ok: true, params: { placement: ["tiktok"] } });
    expect(buildActionParams("reschedule", { at: "tomorrow" }, ap)).toMatchObject({ ok: false, field: "at" });
  });

  it("a fresh uuid for every click", () => {
    const a = newActionId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newActionId()).not.toBe(a);
  });
});

describe("who may do what, read off the read's own actions[] and the twin", () => {
  const rows = (...a: Array<[string, boolean]>): ActionRow[] => a.map(([action, allowed]) => ({ action, allowed, ...(allowed ? {} : { reason: "not_the_officer" }) }));

  it("a client-visible comment needs record_client: the officer and the two seat approvers hold it, and the read lists a sibling action of the same actors", () => {
    expect([...RECORD_CLIENT_KEYS].sort()).toEqual(["boost", "manage", "record_client"]);
    for (const k of RECORD_CLIENT_KEYS) expect(FX.cerbosActions[k].actors).toEqual(FX.cerbosActions.record_client.actors);
    expect(canWriteClientComment({ scheduleVia: null, actions: rows(["record_client_approve", true]) })).toBe(true);
    expect(canWriteClientComment({ scheduleVia: null, actions: rows(["block", true], ["archive", true]) })).toBe(true); // manage: the same actors
    expect(canWriteClientComment({ scheduleVia: null, actions: rows(["record_client_approve", false]) })).toBe(false);
    expect(canWriteClientComment({ scheduleVia: null, actions: rows(["start_draft", true], ["send_to_proofread", true]) })).toBe(false); // author only
    expect(canWriteClientComment({ scheduleVia: null, actions: rows(["approve_copy", true]) })).toBe(false);
    expect(canWriteClientComment({ scheduleVia: null, actions: [] })).toBe(false);
  });

  it("the officer, the copywriter and the designer are recognised by the action each would be allowed", () => {
    expect(canAuthorPost({ scheduleVia: null, actions: rows(["send_to_proofread", true]) })).toBe(true);
    expect(canAuthorPost({ scheduleVia: null, actions: rows(["send_to_proofread", false]) })).toBe(false);
    expect(canSuggest({ scheduleVia: null, actions: rows(["approve_copy", true]) })).toBe(true);
    expect(canSuggest({ scheduleVia: null, actions: rows(["approve_copy", false]) })).toBe(false);
    expect(canDesignPost({ scheduleVia: null, actions: rows(["submit_design", true]) })).toBe(true);
    expect(canDesignPost({ scheduleVia: null, actions: rows(["submit_design", false]) })).toBe(false);
    // unschedule's Cerbos action depends on how the post was scheduled
    expect(cerbosKeyOf("unschedule", "publisher")).toBe("approve");
    expect(cerbosKeyOf("unschedule", "manual")).toBe("schedule");
    expect(cerbosKeyOf("unschedule", null)).toBe("schedule");
    expect(cerbosKeyOf("block", null)).toBe("manage");
    expect(cerbosKeyOf("nope", null)).toBeNull();
  });
});

describe("the stepper, from the twin", () => {
  it("shows every status of the twin but the two side branches, once each, in the twin's order", () => {
    expect([...SIDE_STATUSES].sort()).toEqual(["blocked", "changes"]);
    const shown = STEPS.flatMap((s) => [...s.statuses]);
    expect(shown).toEqual(FX.statuses.filter((s) => !SIDE_STATUSES.includes(s)));
    expect(STEPS).toHaveLength(8);
    for (const s of SCP_STATUSES) expect(statusLabel(s), s).not.toBe(s);
  });

  it("places a post at the step of whoever holds it, and a blocked post where it was blocked", () => {
    const at = (title: string) => { const b = asPipelinePost(read(title)); return { ...stepOf(b), label: STEPS[stepOf(b).index].label }; };
    expect(at("November kickoff")).toMatchObject({ label: "Draft", side: null });
    expect(at("Wool care in three steps").label).toBe("Proofread");
    expect(at("Our first cold-weather drop").label).toBe("HoD approval");
    expect(at("Hot stone, step by step").label).toBe("Creative");
    expect(at("Meet our senior therapist").label).toBe("Final check");
    expect(at("Five ways to style a scarf").label).toBe("Client");
    expect(at("Autumn collection teaser").label).toBe("Schedule");
    expect(at("Harvest collection arrives").label).toBe("Live");
    // changes: the officer's cases sit at Draft, the designer's at Creative
    expect(at("Ginger and clove tea")).toMatchObject({ label: "Draft", side: "changes" });
    expect(at("Launch day announcement")).toMatchObject({ label: "Creative", side: "changes" });
    expect(at("Candlelit couples room")).toMatchObject({ label: "Creative", side: "changes" });
    expect(at("The new lobby bar")).toMatchObject({ label: "Draft", side: "changes" });
    expect(at("Seasonal window display")).toMatchObject({ label: "Creative", side: "blocked" }); // blocked from design
  });

  it("says in words who asked for the change or what the post waits on", () => {
    expect(statusChipText(asPipelinePost(read("Launch day announcement")))).toBe("Changes asked by the client: design");
    expect(statusChipText(asPipelinePost(read("Ginger and clove tea")))).toBe("Changes asked by the copywriter: copy");
    expect(statusChipText(asPipelinePost(read("Seasonal window display")))).toBe("Blocked: waiting on the client");
    expect(statusChipText(asPipelinePost(read("November kickoff")))).toBe("Planned");
  });
});

describe("fields: the rows and which are editable, from the twin's editRules", () => {
  const editable = (status: string, kase: string | null) => editableFieldsOf({ pipelineStatus: status, change: kase ? { by: "", kind: "", returnTo: "", note: null, case: kase } : null }).fields.sort();
  const group = (...g: string[]) => g.flatMap((x) => FX.fieldGroups[x]);

  it("every editable field of the fixture has a row, and every row is a field the fixture names", () => {
    const named = new Set([...group("planning", "copy"), "mustHaves", "placement", "scheduledAt"]);
    expect(FIELD_SPECS.map((s) => s.key).sort()).toEqual([...named].sort());
    expect([...SUGGESTIBLE_FIELDS]).toEqual(FX.fieldGroups.suggestible);
    for (const s of FIELD_SPECS) expect(s.label).toBeTruthy();
  });

  it("allows the planning fields in planned, planning and copy in drafting, and in a copy change the copy plus what the rule adds", () => {
    expect(editable("planned", null)).toEqual([...group("planning")].sort());
    expect(editable("drafting", null)).toEqual([...new Set(group("planning", "copy"))].sort());
    expect(editable("changes", "copywriter_copy")).toEqual([...new Set([...group("copy"), "scheduledAt", "mustHaves", "placement"])].sort());
    expect(editable("changes", "hod_copy")).toEqual(editable("changes", "final_copy"));
    // after a client copy change the placement and the date stay
    expect(editable("changes", "client_copy")).toEqual([...new Set([...group("copy"), "mustHaves"])].sort());
    for (const s of ["proofread", "hod", "design", "final", "client", "approved", "scheduled", "live", "blocked"]) expect(editable(s, null), s).toEqual([]);
    expect(editable("changes", "final_design")).toEqual([]); // a design change is the designer's
    expect(editableFieldsOf({ pipelineStatus: "changes", change: { by: "", kind: "", returnTo: "", note: null, case: "hod_copy" } }).copyLog).toBe(true);
    expect(editableFieldsOf({ pipelineStatus: "drafting", change: null }).copyLog).toBe(false);
  });

  it("says why a row is locked: reschedule for an approved date, the live post, the client's look", () => {
    expect(lockedWords({ pipelineStatus: "approved", scheduleVia: null }, "scheduledAt")).toContain("Reschedule");
    expect(lockedWords({ pipelineStatus: "scheduled", scheduleVia: "manual" }, "placement")).toContain("client will be asked again");
    expect(lockedWords({ pipelineStatus: "live", scheduleVia: "manual" }, "caption")).toBe("The post is live.");
    expect(lockedWords({ pipelineStatus: "client", scheduleVia: null }, "caption")).toContain("client");
    expect(lockedWords({ pipelineStatus: "hod", scheduleVia: null }, "scheduledAt")).toContain("HoD approval");
  });

  it("the hand-off checks the page lists are the twin's, hard ones first, as the read answers them", () => {
    const b = asPipelinePost(read("Gift guide for the host"));
    expect(b.checks.map((c) => c.code)).toEqual([...CHECK_CODES]);
    expect(b.checks.filter((c) => !c.skippable).map((c) => c.code)).toEqual((fixture as unknown as { requiredToSend: Array<{ code: string }> }).requiredToSend.map((c) => c.code));
  });
});

describe("parsing the read", () => {
  it("parses every demo post, and a write's answer wrapped as {post, applied, warnings}", () => {
    for (const p of PIPE_POSTS) {
      const b = asPipelinePost(demoPipelineRead(p.id, "demo-hansel").json);
      expect(b.id).toBe(p.id);
      expect(b.pipelineStatus).toBe(p.pipelineStatus);
      expect(b.actions.length).toBeGreaterThanOrEqual(0);
      expect(b.health, p.id).not.toBeNull();
    }
    const raw = read("Wool care in three steps");
    const wrapped = asPipelinePost({ post: raw, applied: { action: "x", from: "a", to: "b" }, warnings: [] });
    expect(wrapped.id).toBe(raw.id);
    expect(wrapped.suggestions.caption).toMatchObject({ stale: false, by: { name: "Citra Maheswari" } });
    expect(wrapped.suggestions.cta.stale).toBe(true);
    expect(() => asPipelinePost({})).toThrow("not a PipelinePost");
    expect(() => asPipelinePost({ id: "x" })).toThrow();
    expect(() => asPipelinePost(null)).toThrow();
  });

  it("keeps the change, the block, the designs, the history and the next action as the read gave them", () => {
    const c = asPipelinePost(read("Launch day announcement"));
    expect(c.change).toMatchObject({ case: "client_design", by: "client" });
    expect(c.creativeState).toBe("revision");
    expect(c.designs[0].asset).toMatchObject({ name: expect.stringContaining("final.png") });
    expect(c.history.at(-1)).toMatchObject({ action: expect.stringMatching(/change/), to: "changes" });
    const b = asPipelinePost(read("Seasonal window display"));
    expect(b.block).toMatchObject({ from: "design", waitingOn: "client" });
    const hod = asPipelinePost(read("Our first cold-weather drop", "u-gm"));
    expect(hod.nextAction).toBe("approve_for_design");
  });
});

describe("the image, history and dates", () => {
  const base = { title: "T", designs: [], rawAssets: [] as PipelinePost["rawAssets"] };
  const design = (over: Partial<PipelinePost["designs"][number]>): PipelinePost["designs"][number] => ({ id: "d", position: 1, asset: null, link: null, fileId: null, ...over });
  const asset = { groupId: "g", versionId: "v9", versionNo: 2, name: "n", source: "own", aiNote: null };

  it("shows a stored design's file and pins to it; before that the latest design's asset or the reference image, with no pin", () => {
    expect(postImage({ ...base, designs: [design({ fileId: "f1" })] })).toMatchObject({ src: "/api/files/f1", fileId: "f1", from: "design" });
    expect(postImage({ ...base, designs: [design({ asset })] })).toMatchObject({ src: "/api/creative-assets/v9", fileId: null, from: "design" });
    const ref = { url: "https://example.com/a.jpg", label: "", source: "own", aiNote: null };
    expect(postImage({ ...base, rawAssets: [ref] })).toMatchObject({ src: "https://example.com/a.jpg", fileId: null, from: "reference" });
    expect(postImage({ ...base, rawAssets: [{ ...ref, url: "https://drive.example.com/view" }, { ...ref, url: "not a url" }] })?.from).toBe("reference");
    expect(postImage({ ...base, rawAssets: [{ ...ref, url: "not a url" }] })).toBeNull();
    expect(postImage(base)).toBeNull();
  });

  it("in DEMO_MODE (no bytes stored) shows the reference image and still pins to a stored design's file", () => {
    const ref = { url: "data:image/svg+xml;utf8,x", label: "", source: "own", aiNote: null };
    expect(postImage({ ...base, rawAssets: [ref], designs: [design({ fileId: "f1" })] }, { demo: true })).toMatchObject({ src: ref.url, fileId: "f1", from: "reference" });
    expect(postImage({ ...base, rawAssets: [ref], designs: [design({ asset })] }, { demo: true })).toMatchObject({ src: ref.url, fileId: null });
  });

  it("words a history line: who, what, the channel a recorded step came by, the portal, the agent, and the move", () => {
    const h = { action: "record_client_change", from: "client", to: "changes", by: { id: "u", name: "Komang" }, agent: null, at: "2026-10-16T01:00:00Z", recorded: { channel: "whatsapp" }, viaPortal: false };
    expect(historyLine(h)).toEqual({ who: "Komang", what: "recorded the client's change request (by WhatsApp)", move: "With the client to Changes asked" });
    expect(historyLine({ ...h, action: "client_approve", recorded: null, viaPortal: true, to: "approved", by: { id: "c", name: "Dana" } })).toMatchObject({ who: "The client", what: "approved it in the portal" });
    expect(historyLine({ ...h, action: "approve_for_design", recorded: null, agent: "Hermes", from: "hod", to: "design" }).what).toBe("approved it for design, with Hermes");
    expect(historyLine({ ...h, action: "follow_up", from: "hod", to: "hod", recorded: null }).move).toBeNull();
    expect(activityWords("something_new")).toBe("something new");
    for (const a of PIPELINE_ACTIONS) expect(activityWords(a), a).not.toContain("_");
  });

  it("converts a date and time in the display zone both ways, across a DST edge, and refuses what is not one", () => {
    expect(isoToZoneInput("2026-10-23T01:30:00.000Z", "Asia/Singapore")).toBe("2026-10-23T09:30");
    expect(zoneInputToIso("2026-10-23T09:30", "Asia/Singapore")).toBe("2026-10-23T01:30:00.000Z");
    expect(isoToZoneInput("2026-07-01T12:00:00.000Z", "America/New_York")).toBe("2026-07-01T08:00");
    expect(zoneInputToIso("2026-07-01T08:00", "America/New_York")).toBe("2026-07-01T12:00:00.000Z");
    expect(zoneInputToIso("2026-12-01T08:00", "America/New_York")).toBe("2026-12-01T13:00:00.000Z");
    expect(zoneInputToIso("2026-03-08T02:30", "America/New_York")).toBe(""); // the hour that does not exist
    for (const iso of ["2026-10-23T01:30:00.000Z", "2026-03-08T07:00:00.000Z", "2026-11-01T06:30:00.000Z", "2026-12-31T16:59:00.000Z"]) {
      expect(zoneInputToIso(isoToZoneInput(iso, "Asia/Singapore"), "Asia/Singapore")).toBe(iso);
    }
    expect(isoToZoneInput(null)).toBe("");
    expect(isoToZoneInput("garbage")).toBe("");
    expect(zoneInputToIso("")).toBe("");
    expect(zoneInputToIso("2026-10-23 09:30")).toBe("");
  });
});

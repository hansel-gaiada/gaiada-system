import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// SCP-5g (BFF §63.28): DEMO_MODE's twin of the audit routes, in the server's order of checks, with the gates of SCP-Q34. The store seeds from the day it is first touched, so the clock is pinned to
// mid-month (Friday 16 October 2026) before it is imported (hence vi.hoisted). Only Date is faked. Each test builds its own store from the seed.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { PIPE_ENGAGEMENTS } from "./demoSocialPipeline";
import { auditApi, seedAuditStore, type AuditStore } from "./demoSocialAudit";
import { socialDemo } from "./demoSocial";
import { asAuditDetail, asAuditList, asAuditWrite, asSummaryProposal } from "./socialAudit";

const USER = { officer: "u-social", officer2: "u-social-2", hod: "u-pm", gm: "u-gm", owner: "demo-owner", superadmin: "demo-hansel", companyAdmin: "u-dev", copywriter: "u-copy", client: "demo-client", bot: "demo-bot" };
const [NORTH, SPA, HOTEL] = PIPE_ENGAGEMENTS.map((e) => e.id);
const NEW = "11111111-1111-4111-8111-111111111111";

let store: AuditStore;
let api: ReturnType<typeof auditApi>;
beforeEach(() => { store = seedAuditStore(); api = auditApi(store); });

const call = (method: string, tail: string, user: string, body?: unknown, query = "") => {
  const r = api.staff(method, tail, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), user);
  expect(r, `${method} ${tail} is an audit route`).not.toBeNull();
  return r!;
};
const error = (r: { json: unknown }) => (r.json as { error: string }).error;
const refused = (r: { status: number; json: unknown }, status: number, code: string, field?: string) => {
  expect([r.status, error(r)]).toEqual([status, code]);
  if (field) expect((r.json as { field?: string }).field).toBe(field);
};
const list = (user = USER.hod, query = "") => asAuditList(call("GET", "audits", user, undefined, query).json);
const row = (name: string) => list().items.find((i) => i.name === name)!;
const detail = (id: string, user = USER.hod) => asAuditDetail(call("GET", `audits/${id}`, user).json);
const northDraft = () => row("Northwind Traders").auditId!;
const spaFinal = () => row("Saltmarsh Day Spa").auditId!;
const prospect = () => row("Fernhill Bakery").auditId!;

describe("the seed: a draft, a final and a prospect", () => {
  it("lists every open client and the prospect, worst first, in the shape the UI's parser accepts", () => {
    const l = list();
    expect(l.items.map((i) => i.name).sort()).toEqual(["Fernhill Bakery", "Harborlight Hotel", "Northwind Traders", "Saltmarsh Day Spa"]);
    expect(l.canAddProspect).toBe(true);
    const scored = l.items.filter((i) => i.overall !== null).map((i) => i.overall as number);
    expect([...scored]).toEqual([...scored].sort((a, b) => a - b));
    expect(l.items[l.items.length - 1]).toMatchObject({ name: "Harborlight Hotel", auditId: null, status: null, scored: 0, total: 12 });
  });
  it("Northwind's draft computes its automatic part from the pipeline and carries one override with its note", () => {
    const d = detail(northDraft());
    expect(d).toMatchObject({ subject: "client", status: "draft", month: "2026-09", total: 12, canWrite: true, canFinalize: true });
    const by = Object.fromEntries(d.dimensions.map((x) => [x.key, x]));
    expect(by.consistency.auto).toMatchObject({ evidence: { actual: 2, expected: 12, unit: "posts" } });
    expect(by.format_mix.auto?.score).toBe(5);
    expect(by.stories.auto?.score).not.toBeNull();
    expect(by.stories.typed).toMatchObject({ score: 4 });
    expect(by.stories.used).toBe(4);
    expect(by.stories.typed?.note).toMatch(/highlights/);
    expect(by.boosting.auto).toMatchObject({ score: null, reason: "no_agreed_budget" });
    expect(by.boosting.used).toBeNull();
    expect(by.profile.kind).toBe("typed");
    expect(d.scored).toBeLessThan(12);
    expect(d.overall).not.toBeNull();
    expect(d.fixes).toHaveLength(3);
    expect(d.fixes[0].score).toBeLessThanOrEqual(d.fixes[1].score);
    expect(d.simulated).toBe(false);
  });
  it("the overall is over the scored dimensions only, and the band follows it", () => {
    const d = detail(northDraft());
    const used = d.dimensions.map((x) => x.used).filter((x): x is number => x !== null);
    expect(d.overall).toBe(Math.round(100 * used.reduce((a, b) => a + b, 0) / used.length / 5));
    expect(d.bandLabel).toBe(d.overall! >= 75 ? "Strong" : d.overall! >= 50 ? "Fair" : "Needs work");
  });
  it("Saltmarsh's final audit is read-only and answers its frozen scorecard", () => {
    const d = detail(spaFinal());
    expect(d).toMatchObject({ status: "final", canWrite: false, canFinalize: false, finalizedBy: { id: "u-pm" } });
    expect(d.finalizedAt).not.toBeNull();
    expect(d.overall).not.toBeNull();
  });
  it("the prospect's twelve are typed (no automatic part) and its public numbers are kept as evidence", () => {
    const d = detail(prospect());
    expect(d).toMatchObject({ subject: "prospect", name: "Fernhill Bakery", businessType: "Bakery", engagementId: null, month: null });
    for (const x of d.dimensions) expect(x.auto, x.key).toBeNull();
    expect(d.publicNumbers).toMatchObject({ followers: 3100, postsLast30Days: 6, avgLikes: 54.5 });
    expect(d.scored).toBe(4);
  });
});

describe("reading", () => {
  it("a client contact is refused, an unknown audit is 404, and a bad filter is 400", () => {
    expect(call("GET", "audits", USER.client).status).toBe(403);
    expect(call("GET", `audits/${northDraft()}`, USER.client).status).toBe(403);
    refused(call("GET", "audits/nope", USER.hod), 404, "audit_not_found");
    refused(call("GET", "audits", USER.hod, undefined, "subject=both"), 400, "invalid_field", "subject");
    refused(call("GET", "audits", USER.hod, undefined, "x=1"), 400, "invalid_field", "x");
    expect(list(USER.hod, "subject=prospect").items.map((i) => i.name)).toEqual(["Fernhill Bakery"]);
    expect(list(USER.hod, "subject=client").items).toHaveLength(3);
  });
  it("canWrite follows the subject's gate", () => {
    expect(detail(northDraft(), USER.officer).canWrite).toBe(true);
    expect(detail(northDraft(), USER.officer2).canWrite).toBe(false);
    expect(detail(prospect(), USER.officer).canWrite).toBe(false);
    expect(detail(prospect(), USER.owner).canWrite).toBe(true);
    expect(list(USER.officer).canAddProspect).toBe(false);
  });
});

describe("starting an audit", () => {
  it("a client's officer or one of the four starts a client's audit; a client with a draft answers it (200, created false)", () => {
    const r = call("POST", "audits", USER.officer, { subject: "client", engagementId: HOTEL });
    expect(r.status).toBe(201);
    const w = asAuditWrite(r.json);
    expect(w).toMatchObject({ created: true, audit: { subject: "client", name: "Harborlight Hotel", month: "2026-09", status: "draft" } });
    const again = call("POST", "audits", USER.hod, { subject: "client", engagementId: HOTEL });
    expect(again.status).toBe(200);
    expect(asAuditWrite(again.json)).toMatchObject({ created: false, audit: { id: w.audit.id } });
    expect(call("POST", "audits", USER.hod, { subject: "client", engagementId: NORTH }).status).toBe(200);
  });
  it("is 404 for a client that is not there, then 403 for another member, then 400", () => {
    refused(call("POST", "audits", USER.officer, { subject: "client", engagementId: "nope" }), 404, "engagement_not_found");
    refused(call("POST", "audits", USER.copywriter, { subject: "client", engagementId: HOTEL }), 403, "not_officer_or_approver");
    refused(call("POST", "audits", USER.officer2, { subject: "client", engagementId: NORTH }), 403, "not_officer_or_approver");
    refused(call("POST", "audits", USER.bot, { subject: "client", engagementId: HOTEL }), 403, "automation_cannot_act");
    refused(call("POST", "audits", USER.hod, { subject: "client" }), 400, "missing_field", "engagementId");
    refused(call("POST", "audits", USER.hod, { subject: "client", engagementId: HOTEL, month: "2027-01" }), 400, "invalid_field", "month");
    refused(call("POST", "audits", USER.hod, { subject: "client", engagementId: HOTEL, month: "2026-09-15" }), 400, "invalid_field", "month");
    refused(call("POST", "audits", USER.hod, { subject: "client", engagementId: HOTEL, nope: 1 }), 400, "invalid_field", "nope");
  });
  it("a prospect's audit is the four's: the officer is 403 not_a_social_approver", () => {
    const body = { id: NEW, subject: "prospect", prospectName: "Quay Coffee", businessType: "Cafe", publicNumbers: { followers: 900, lastPostOn: "2026-10-01" } };
    refused(call("POST", "audits", USER.officer, body), 403, "not_a_social_approver");
    refused(call("POST", "audits", USER.copywriter, body), 403, "not_a_social_approver");
    const r = call("POST", "audits", USER.owner, body);
    expect(r.status).toBe(201);
    expect(asAuditWrite(r.json).audit).toMatchObject({ subject: "prospect", name: "Quay Coffee", status: "draft", scored: 0, overall: null });
    const replay = call("POST", "audits", USER.owner, body);
    expect([replay.status, asAuditWrite(replay.json).created]).toEqual([200, false]);
    refused(call("POST", "audits", USER.hod, { subject: "prospect" }), 400, "missing_field", "prospectName");
    refused(call("POST", "audits", USER.hod, { subject: "prospect", prospectName: "X", publicNumbers: { followers: -1 } }), 400, "invalid_field", "publicNumbers.followers");
    refused(call("POST", "audits", USER.hod, { subject: "prospect", prospectName: "X", publicNumbers: { lastPostOn: "2026-02-30" } }), 400, "invalid_field", "publicNumbers.lastPostOn");
    refused(call("POST", "audits", USER.hod, { subject: "prospect", prospectName: "X", engagementId: HOTEL }), 400, "invalid_field", "engagementId");
  });
});

describe("editing a draft", () => {
  it("saves typed scores and the summary, and the score counts at once", () => {
    const id = northDraft();
    const before = detail(id);
    const r = call("PATCH", `audits/${id}`, USER.officer, { scores: { profile: { score: 5, note: "" }, caption_cta: { score: 4, note: "Fixed in October." } }, summary: "Better.", summaryVia: "typed" });
    expect(r.status).toBe(200);
    const after = asAuditWrite(r.json).audit;
    expect(after.dimensions.find((x) => x.key === "profile")?.used).toBe(5);
    expect(after.overall).toBeGreaterThan(before.overall as number);
    expect(after.summary).toBe("Better.");
  });
  it("overriding an automatic score needs a note; a null entry is Use automatic and drops the override", () => {
    const id = northDraft();
    refused(call("PATCH", `audits/${id}`, USER.officer, { scores: { consistency: { score: 3 } } }), 400, "missing_field", "scores.consistency.note");
    expect(call("PATCH", `audits/${id}`, USER.officer, { scores: { consistency: { score: 3, note: "We also posted twice on the second account." } } }).status).toBe(200);
    expect(detail(id).dimensions.find((x) => x.key === "consistency")).toMatchObject({ used: 3, typed: { score: 3 } });
    const dropped = asAuditWrite(call("PATCH", `audits/${id}`, USER.officer, { scores: { stories: null } }).json).audit;
    expect(dropped.dimensions.find((x) => x.key === "stories")).toMatchObject({ typed: null });
    expect(dropped.dimensions.find((x) => x.key === "stories")?.used).toBe(dropped.dimensions.find((x) => x.key === "stories")?.auto?.score);
  });
  it("judges the body: a score by halves, a known key, the field's own subject, the lengths", () => {
    const id = northDraft();
    const patch = (b: unknown, u = USER.officer) => call("PATCH", `audits/${id}`, u, b);
    refused(patch({ scores: { profile: { score: 3.3, note: "" } } }), 400, "invalid_field", "scores.profile.score");
    refused(patch({ scores: { profile: { score: 6, note: "" } } }), 400, "invalid_field", "scores.profile.score");
    refused(patch({ scores: { bogus: { score: 3, note: "" } } }), 400, "invalid_field", "scores.bogus");
    refused(patch({ scores: { profile: { note: "x" } } }), 400, "missing_field", "scores.profile.score");
    refused(patch({ scores: { profile: { score: 3, note: "x".repeat(501) } } }), 400, "invalid_field", "scores.profile.note");
    refused(patch({ summary: "x".repeat(3001) }), 400, "invalid_field", "summary");
    refused(patch({ summaryVia: "ai" }), 400, "missing_field", "summary");
    refused(patch({ prospectName: "No" }), 400, "invalid_field", "prospectName");
    refused(patch({ month: "2999-01" }), 400, "invalid_field", "month");
    expect(patch({ month: "2026-08" }).status).toBe(200);
    expect(detail(id).month).toBe("2026-08");
    refused(call("PATCH", `audits/${prospect()}`, USER.hod, { month: "2026-08" }), 400, "invalid_field", "month");
  });
  it("is 403 for another member, by the audit's subject, before the body is read", () => {
    refused(call("PATCH", `audits/${northDraft()}`, USER.officer2, { bogus: 1 }), 403, "not_officer_or_approver");
    refused(call("PATCH", `audits/${prospect()}`, USER.officer, { bogus: 1 }), 403, "not_a_social_approver");
    refused(call("PATCH", `audits/${northDraft()}`, USER.bot, {}), 403, "automation_cannot_act");
    refused(call("PATCH", "audits/nope", USER.officer, {}), 404, "audit_not_found");
  });
  it("a prospect's own fields: name, business type and public numbers", () => {
    const r = call("PATCH", `audits/${prospect()}`, USER.hod, { prospectName: "Fernhill Bakehouse", businessType: null, publicNumbers: { followers: 3300 } });
    expect(asAuditWrite(r.json).audit).toMatchObject({ name: "Fernhill Bakehouse", businessType: null, publicNumbers: { followers: 3300 } });
  });
});

describe("Draft with AI", () => {
  it("is a proposal and saves nothing; a real client's is ai, a prospect's the plain template", () => {
    const id = northDraft();
    const before = JSON.stringify(detail(id));
    const ai = asSummaryProposal(call("POST", `audits/${id}/ai-summary`, USER.officer).json);
    expect(ai.draftedVia).toBe("ai");
    expect(ai.summary).toMatch(/out of 100/);
    expect(asSummaryProposal(call("POST", `audits/${prospect()}/ai-summary`, USER.hod).json).draftedVia).toBe("template");
    expect(JSON.stringify(detail(id))).toBe(before);
  });
  it("answers 404, then the gate, then 409 for a final audit", () => {
    refused(call("POST", "audits/nope/ai-summary", USER.hod), 404, "audit_not_found");
    refused(call("POST", `audits/${northDraft()}/ai-summary`, USER.officer2), 403, "not_officer_or_approver");
    refused(call("POST", `audits/${spaFinal()}/ai-summary`, USER.hod), 409, "audit_final");
  });
});

describe("finalize, attach and delete", () => {
  it("finalizing freezes the scorecard: the pipeline moving changes nothing, edits and deletes are 409, a replay is alreadyApplied", () => {
    const id = northDraft();
    const live = detail(id);
    const f = call("POST", `audits/${id}/finalize`, USER.officer);
    expect(f.status).toBe(200);
    const frozen = asAuditWrite(f.json).audit;
    expect(frozen).toMatchObject({ status: "final", canWrite: false, overall: live.overall, finalizedBy: { id: "u-social" } });
    store.audits.find((a) => a.id === id)!.month = "2026-08";
    expect(detail(id).overall).toBe(live.overall);
    expect(detail(id).dimensions.map((x) => x.used)).toEqual(live.dimensions.map((x) => x.used));
    refused(call("PATCH", `audits/${id}`, USER.officer, { summary: "x" }), 409, "audit_final");
    refused(call("DELETE", `audits/${id}`, USER.officer), 409, "audit_final");
    expect(call("POST", `audits/${id}/finalize`, USER.hod).json).toMatchObject({ alreadyApplied: true });
    expect(list().items.find((i) => i.auditId === id)).toMatchObject({ status: "final" });
  });
  it("a bad body on a final audit is 400 before 409 (the server reads the body first)", () => {
    refused(call("PATCH", `audits/${spaFinal()}`, USER.hod, { scores: { profile: { score: 7, note: "" } } }), 400, "invalid_field", "scores.profile.score");
  });
  it("finalize is gated by the subject; a delete of a draft removes it from the list", () => {
    refused(call("POST", `audits/${northDraft()}/finalize`, USER.officer2), 403, "not_officer_or_approver");
    refused(call("POST", `audits/${prospect()}/finalize`, USER.officer), 403, "not_a_social_approver");
    const id = northDraft();
    expect(call("DELETE", `audits/${id}`, USER.hod).json).toEqual({ deleted: true, id });
    refused(call("GET", `audits/${id}`, USER.hod), 404, "audit_not_found");
    expect(row("Northwind Traders")).toMatchObject({ auditId: null });
  });
  it("attaching a prospect to a client is the four's, once", () => {
    const id = prospect();
    refused(call("POST", `audits/${id}/attach`, USER.officer, { engagementId: HOTEL }), 403, "not_a_social_approver");
    refused(call("POST", `audits/${id}/attach`, USER.hod, {}), 400, "missing_field", "engagementId");
    refused(call("POST", `audits/${id}/attach`, USER.hod, { engagementId: "nope" }), 404, "engagement_not_found");
    refused(call("POST", `audits/${northDraft()}/attach`, USER.hod, { engagementId: HOTEL }), 409, "not_a_prospect_audit");
    const ok = call("POST", `audits/${id}/attach`, USER.hod, { engagementId: HOTEL });
    expect(asAuditWrite(ok.json).audit).toMatchObject({ engagementId: HOTEL, subject: "prospect" });
    expect(call("POST", `audits/${id}/attach`, USER.hod, { engagementId: HOTEL }).json).toMatchObject({ alreadyApplied: true });
    refused(call("POST", `audits/${id}/attach`, USER.hod, { engagementId: SPA }), 409, "audit_attached");
  });
});

describe("the simulated mark", () => {
  it("an audit whose automatic part read a simulated post says simulated: true", () => {
    const month = "2026-10";
    expect(asAuditWrite(call("POST", "audits", USER.hod, { subject: "client", engagementId: HOTEL, month }).json).audit.simulated).toBe(true);
    expect(detail(northDraft()).simulated).toBe(false);
  });
});

describe("through the DEMO_MODE router", () => {
  it("answers the audit routes from socialDemo", () => {
    const r = socialDemo("GET", "/api/co-agency/modules/social/audits", new URLSearchParams(), undefined, USER.hod)!;
    expect(r.status).toBe(200);
    expect(asAuditList(r.json).items.length).toBe(4);
  });
});

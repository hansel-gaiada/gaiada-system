// M5-W6 — AI assist, the SERVICE, locally. Runs without Postgres, Cerbos or a gateway: Cerbos is a stub that emulates the W1a
// decisions for four principals (as in webdesk-content-two-phase.unit.test.ts), Zone B is the strict in-process fake, the gateway is a
// recording function and the budget is the in-memory store with the ledger store's rules. What is proven here: the ORDER (authorization
// before the body, the budget and the gateway), that nothing is ever written to WebDesk, the typed 422/429/503/502, the budget's
// arithmetic, and that no content reaches a log line. The real ledger SQL, the HTTP route and the MCP shape are webdesk-assist.test.ts
// (the Linux gate).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, Logger } from "@nestjs/common";
import type { EditorialScope, Principal, RoleGrant } from "../../rbac/principal";

const T = "aaaaaaaa-1111-0000-0000-000000000001";
const OTHER_CO = "aaaaaaaa-1111-0000-0000-000000000002";

const h = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const asks: Array<{ resource: Res; action: string; who: string }> = [];
  const decide = (p: { userId: string | null; roles: Array<{ role: string; editorialScopes?: Array<{ siteId: string; allCollections: boolean; collections: string[]; allLocales: boolean; locales: string[] }> }> }, r: Res, a: string): boolean => {
    if (r.tenantId !== "aaaaaaaa-1111-0000-0000-000000000001") return false;
    if (p.roles.some((g) => g.role === "webdev_manager" || g.role === "webdev_staff")) return ["read", "create", "update"].includes(a);
    for (const g of p.roles) {
      if (g.role !== "webdesk_writer") continue;
      const covers = (g.editorialScopes ?? []).some((s) => s.siteId === r.siteId && (s.allCollections || s.collections.includes(r.collectionKey as string)) && (s.allLocales || s.locales.includes(r.locale as string)));
      const site = (g.editorialScopes ?? []).some((s) => s.siteId === r.siteId && r.siteId !== "");
      const own = r.ownerId !== undefined && r.ownerId === p.userId;
      if (r.kind === "webdesk_collection" && a === "read") return site;
      if (r.kind !== "webdesk_content_item" || !covers) return false;
      if (a === "read") return true;
      if (a === "update") return own && (r.reviewState === "draft" || r.reviewState === "changes_requested");
      return false;
    }
    return false;
  };
  return { asks, decide };
});

vi.mock("../../core/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/http")>();
  return {
    ...real,
    authorize: (async (principal: { userId: string }, resource: Record<string, unknown>, action: string) => {
      h.asks.push({ resource: { ...resource }, action, who: principal.userId });
      if (!h.decide(principal as never, resource, action)) throw new ForbiddenException(`not authorized: cerbos denied ${action} on ${String(resource.kind)}`);
    }) as unknown as typeof real.authorize,
    writeActivity: (async () => "activity-id") as typeof real.writeActivity,
  };
});

import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { ContentGate, WebdeskContentService, WebdeskProblem, WebdeskZoneB, type SiteRef } from "./webdesk-content.service";
import { WebdeskAssistService } from "./webdesk-assist.service";
import { InMemoryAssistBudget, limitsFor } from "./webdesk-assist-budget";
import { GatewayNotConfiguredError } from "../search/providers/gateway-client";

const WRITER = "u-writer";
const OTHER_AUTHOR = "u-other-author";
const scope = (siteId: string, collections: string[], locales: string[] | "all"): EditorialScope => ({
  siteId, allCollections: false, collections, allLocales: locales === "all", locales: locales === "all" ? [] : locales,
});
const principal = (userId: string, roles: RoleGrant[], extra: Partial<Principal> = {}): Principal =>
  ({ userId, assurance: "high", companies: [T], rootCompanies: [T], roles, sessionVersion: 1, ...extra });
const grant = (role: string, scopes?: EditorialScope[]): RoleGrant => ({ role, scopeType: "company", scopeId: T, ...(scopes ? { editorialScopes: scopes } : {}) });
const writer = () => principal(WRITER, [grant("webdesk_writer", [scope(GAIADA_SITE, ["post"], ["en"])])]);
const staff = (id = "u-staff") => principal(id, [grant("webdev_staff")]);
const nobody = () => principal("u-nobody", [grant("member")]);
const bot = () => principal("u-bot", [grant("webdev_staff")], { kind: "bot" });
const n8n = () => principal("u-n8n", [grant("webdev_staff")], { via: { provider: "n8n", externalId: "wf-1" } });

const site: SiteRef = { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE };
const CANARY = "CANARY-ZEBRA-4242";
const LONG = `Our team builds fast, accessible websites for clinics and schools across Indonesia. ${CANARY} We start with a short discovery call, agree a fixed scope, and ship in weeks, not months. `;
const goodDesc = "Fast, accessible websites for clinics and schools, shipped in weeks with a fixed scope and a plain-spoken team that stays after launch.";

const signer = makeTestSigner();
let zb: FakeZoneB;
let content: WebdeskContentService;
let assist: WebdeskAssistService;
let budget: InMemoryAssistBudget;
let prompts: string[];
let attributions: Array<{ tenantId: string; userId: string | null; surface: string; task?: string | null }>;
let reply: () => Promise<{ text: string; provider?: string }>;

const mkItem = (over: Partial<FakeItem> & { slug: string }): FakeItem => {
  const it = zb.seedItem({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en", ...over });
  it.versions[0].fields = { h1: "Web design for clinics", primary_keyword: "clinic web design", body: LONG.repeat(3) };
  it.versions[0].seo = { title: "Clinic web design" };
  return it;
};
const draftBy = (author: string | null, over: Partial<FakeItem> & { slug: string }): FakeItem =>
  mkItem({ editorial: { reviewRequired: false, state: "draft", approvedVersion: null, authorSub: author, submittedVersion: null }, ...over });
const open = (p: Principal) => ContentGate.openSite(p, T, GAIADA_SITE, "webdesk_content_item", "update");
const run = async (p: Principal, itemId: string, body: unknown = { kind: "meta_description" }) => assist.assist(await open(p), site, itemId, body);
const problemOf = async (fn: () => Promise<unknown>): Promise<WebdeskProblem> => {
  try { await fn(); } catch (e) { expect(e).toBeInstanceOf(WebdeskProblem); return e as WebdeskProblem; }
  throw new Error("expected a WebdeskProblem, got success");
};
const slugOf = (e: WebdeskProblem) => String(e.problem.type).split("/").pop();

beforeEach(() => {
  h.asks.length = 0;
  zb = new FakeZoneB(T, OTHER_CO);
  zb.compositions.set("post", { ui: { label: "Posts" } });
  signer.calls.length = 0;
  setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
  content = new WebdeskContentService(new WebdeskZoneB());
  assist = new WebdeskAssistService(content);
  budget = new InMemoryAssistBudget();
  prompts = [];
  attributions = [];
  reply = async () => ({ text: JSON.stringify({ description: goodDesc }), provider: "ollama" });
  assist.setDepsForTests({ gateway: async (p, attribution) => { prompts.push(p); attributions.push(attribution); return reply(); }, budget });
  for (const k of ["WEBDESK_ASSIST_DAILY_CALLS", "WEBDESK_ASSIST_DAILY_TOKENS", "WEBDESK_ASSIST_DAILY_CALLS_AUTOMATED", "WEBDESK_ASSIST_DAILY_TOKENS_AUTOMATED"]) delete process.env[k];
});

const READS = new Set(["item.get", "tenant.list"]);
const onlyReads = () => zb.calls.every((c) => READS.has(c.command));

describe("golden: a staff editor asks for a meta description", () => {
  it("200 {suggestions}, advisory, the version it read; the gateway was called once; WebDesk saw NO write (only reads)", async () => {
    const item = mkItem({ slug: "post.golden" });
    const r = await run(staff(), item.itemId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      kind: "meta_description", itemId: item.itemId, version: 1, headVersion: 1, locale: "en", advisory: true, provider: "ollama",
      suggestions: [{ id: "s1", kind: "meta_description", target: "/seo/description", text: goodDesc, length: goodDesc.length }],
      usage: { callsUsed: 1, callsLimit: 40, tokensLimit: 120_000, tokensAreEstimates: true, scope: "principal", automated: false },
    });
    expect(prompts).toHaveLength(1);
    // AIP-03a: the gateway seam is handed who is paying: the company, the person, the surface and the call-site label (the client writes the usage row).
    expect(attributions).toEqual([{ tenantId: T, userId: "u-staff", surface: "other", task: "webdev.assist" }]);
    expect(prompts[0]).toContain("Clinic web design"); // the title is in the prompt
    expect(zb.writes).toHaveLength(0);
    expect(onlyReads(), `WebDesk saw: ${zb.calls.map((c) => c.command).join(",")}`).toBe(true);
    expect(signer.calls).toHaveLength(0); // no editorial assertion was ever signed: nothing was sent that needs one
    // it was authorised as the item's `update`
    expect(h.asks.some((a) => a.resource.kind === "webdesk_content_item" && a.action === "update" && a.resource.id === item.itemId)).toBe(true);
  });

  it("each kind returns its own suggestion shape (outline, faq, translate_draft with the first-draft notice, alt_text)", async () => {
    const item = mkItem({ slug: "post.kinds" });
    item.versions[0].fields = { h1: "Web design for clinics", body: `${LONG.repeat(3)}\n\n![](/u/team-photo.jpg)` };
    const answers: Record<string, unknown> = {
      outline: { headings: [{ level: 2, text: "What does a clinic website need?" }, { level: 2, text: "How long does it take?" }, { level: 3, text: "Booking and forms" }] },
      faq: { items: [1, 2, 3].map((i) => ({ question: `How long does step ${i} take?`, answer: "Most clinic websites ship in four to six weeks after the scope is agreed." })) },
      translate_draft: { fields: { h1: "Desain web untuk klinik" } },
      alt_text: { items: [{ index: 0, alt: "Team photo in front of the clinic" }] },
    };
    for (const [kind, ans] of Object.entries(answers)) {
      reply = async () => ({ text: JSON.stringify(ans), provider: "ollama" });
      const r = await run(staff(), item.itemId, { kind });
      expect(r.status, kind).toBe(200);
      const b = r.body as { suggestions: Array<Record<string, unknown>>; notice?: string };
      expect(b.suggestions.length, kind).toBeGreaterThan(0);
      if (kind === "translate_draft") {
        expect(b.notice).toBe("First draft — needs a human");
        expect(b.suggestions[0]).toMatchObject({ status: "first_draft_needs_human", locale: "id", sourcePath: "/blocks/0/props/h1" });
      } else {
        expect(b.notice).toBeUndefined();
      }
    }
    expect(zb.writes).toHaveLength(0);
  });

  it("`version` reads that version's content; the answer names it and the head, so a UI can warn that the head moved", async () => {
    const item = mkItem({ slug: "post.versions" });
    item.versions.push({ version: 2, fields: { h1: "Second", body: "short" }, contentHash: "h2", createdBy: "x", createdAt: new Date().toISOString(), note: null, seo: { title: "Second title" } });
    item.headVersion = 2;
    const r = await run(staff(), item.itemId, { kind: "meta_description", version: 1 });
    expect(r.body).toMatchObject({ version: 1, headVersion: 2 });
    expect(prompts[0]).toContain("Clinic web design");
    expect(prompts[0]).not.toContain("Second title");
    await expect(run(staff(), item.itemId, { kind: "meta_description", version: 9 })).rejects.toBeDefined(); // version-not-found passes through
  });
});

describe("authorization: `update` on the item, BEFORE the body, the budget and the gateway", () => {
  it("a writer on ANOTHER author's item is 403 with a VALID body: no gateway call, no budget row, no WebDesk write; the same request on their OWN item succeeds (positive control)", async () => {
    const theirs = draftBy(OTHER_AUTHOR, { slug: "post.theirs" });
    const mine = draftBy(WRITER, { slug: "post.mine" });
    await expect(run(writer(), theirs.itemId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prompts).toHaveLength(0);
    expect(budget.rows).toHaveLength(0);
    expect(zb.writes).toHaveLength(0);
    expect(zb.calls.some((c) => c.command === "item.get")).toBe(true); // the attributes were READ from WebDesk
    const ok = await run(writer(), mine.itemId);
    expect(ok.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(budget.rows.filter((r) => r.phase === "reserved")).toHaveLength(1);
  });

  it("an item in review is not assistable by its own writer (reviewState comes from WebDesk); a legacy item with no author is nobody's", async () => {
    const inReview = mkItem({ slug: "post.review", editorial: { reviewRequired: true, state: "in_review", approvedVersion: null, authorSub: WRITER, submittedVersion: 1 } });
    const legacy = draftBy(null, { slug: "post.legacy" });
    await expect(run(writer(), inReview.itemId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run(writer(), legacy.itemId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prompts).toHaveLength(0);
    inReview.editorial = { reviewRequired: true, state: "changes_requested", approvedVersion: null, authorSub: WRITER, submittedVersion: 1 };
    expect((await run(writer(), inReview.itemId)).status).toBe(200);
  });

  it("a principal with no grant is refused at phase 1, before any WebDesk read", async () => {
    const item = mkItem({ slug: "post.nobody" });
    await expect(open(nobody())).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.calls).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    void item;
  });

  it("authorization precedes validation: a denied caller is 403 for an INVALID body, the owner gets 400 for the same body", async () => {
    const theirs = draftBy(OTHER_AUTHOR, { slug: "post.t2" });
    const mine = draftBy(WRITER, { slug: "post.m2" });
    for (const bad of [{ kind: "nonsense" }, { nonsense: true }, {}, { kind: "outline", siteId: "forged" }]) {
      await expect(run(writer(), theirs.itemId, bad)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(run(writer(), mine.itemId, bad)).rejects.toMatchObject({ status: 400 });
    }
    expect(prompts).toHaveLength(0);
    expect(budget.rows).toHaveLength(0);
  });

  it("a forged attribute in the body (siteId, ownerId, reviewState…) is a 400 AFTER the check and reaches nothing", async () => {
    const mine = draftBy(WRITER, { slug: "post.forge" });
    await expect(run(writer(), mine.itemId, { kind: "outline", ownerId: "someone", reviewState: "approved", collectionKey: "x" })).rejects.toMatchObject({ status: 400 });
    expect(prompts).toHaveLength(0);
    const last = h.asks.filter((a) => a.resource.kind === "webdesk_content_item" && a.action === "update").at(-1)!;
    expect(last.resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en", ownerId: WRITER, reviewState: "draft" });
  });

  it("another company's site is the uniform 404 wall: no gateway, no budget", async () => {
    zb.items.clear();
    const foreign = zb.seedItem({ siteId: OTHER_SITE, slug: "post.foreign" });
    const gate = await ContentGate.openSite(staff(), T, OTHER_SITE, "webdesk_content_item", "update");
    const e = await problemOf(() => assist.assist(gate, { tenantSlug: OTHER_SLUG, siteId: OTHER_SITE }, foreign.itemId, { kind: "outline" }));
    expect(e.getStatus()).toBe(404);
    expect(prompts).toHaveLength(0);
    expect(budget.rows).toHaveLength(0);
  });

  it("a deleted item is a typed 409 and costs nothing", async () => {
    const item = mkItem({ slug: "post.deleted" });
    item.deletedAt = new Date().toISOString();
    const e = await problemOf(() => run(staff(), item.itemId));
    expect(e.getStatus()).toBe(409);
    expect(slugOf(e)).toBe("item-deleted");
    expect(prompts).toHaveLength(0);
  });
});

describe("typed answers: nothing to suggest from, budget, gateway down, unusable output", () => {
  it("422 assist-not-applicable when the item has nothing for the kind: no gateway call, no budget use", async () => {
    const item = mkItem({ slug: "post.noimg" });
    const e = await problemOf(() => run(staff(), item.itemId, { kind: "alt_text" }));
    expect([e.getStatus(), slugOf(e), e.problem.reason]).toEqual([422, "assist-not-applicable", "no_image_without_alt"]);
    expect(prompts).toHaveLength(0);
    expect(budget.rows).toHaveLength(0);
  });

  it("503 assist-unavailable when the gateway is down: never an empty suggestion presented as success; the day's budget is NOT used up", async () => {
    const item = mkItem({ slug: "post.down" });
    reply = async () => { throw new Error("ai-gateway /complete returned HTTP 503"); };
    const e = await problemOf(() => run(staff(), item.itemId));
    expect([e.getStatus(), slugOf(e), e.problem.reason]).toEqual([503, "assist-unavailable", "gateway_unavailable"]);
    expect(e.problem).not.toHaveProperty("suggestions");
    // refunded: with a limit of ONE call, the next call still goes through
    process.env.WEBDESK_ASSIST_DAILY_CALLS = "1";
    reply = async () => ({ text: JSON.stringify({ description: goodDesc }), provider: "ollama" });
    expect((await run(staff(), item.itemId)).status).toBe(200);
    expect(zb.writes).toHaveLength(0);
  });

  it("503 for: gateway not configured, a timeout/network error, the gateway's own 429 (busy), and the keyless `echo` provider", async () => {
    const item = mkItem({ slug: "post.down2" });
    const cases: Array<[() => Promise<{ text: string; provider?: string }>, string]> = [
      [async () => { throw new GatewayNotConfiguredError(); }, "not_configured"],
      [async () => { throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); }, "gateway_unavailable"],
      [async () => { throw new Error("ai-gateway /complete returned HTTP 429"); }, "gateway_busy"],
      [async () => ({ text: "echo of the prompt", provider: "echo" }), "no_provider"],
    ];
    for (const [fn, reason] of cases) {
      reply = fn;
      const e = await problemOf(() => run(staff(), item.itemId));
      expect([e.getStatus(), slugOf(e), e.problem.reason], reason).toEqual([503, "assist-unavailable", reason]);
    }
  });

  it("502 assist-output-invalid when the answer breaks the kind's rules (a 90-character meta description); that call WAS spent", async () => {
    const item = mkItem({ slug: "post.invalid" });
    reply = async () => ({ text: JSON.stringify({ description: "Too short to be a meta description." }), provider: "ollama" });
    const e = await problemOf(() => run(staff(), item.itemId));
    expect([e.getStatus(), slugOf(e), e.problem.reason]).toEqual([502, "assist-output-invalid", "description_length"]);
    expect(budget.rows.filter((r) => r.phase === "reserved")).toHaveLength(1);
    expect(budget.rows.find((r) => r.phase === "completed")).toMatchObject({ outcome: "output_invalid" });
    expect(budget.rows.find((r) => r.phase === "completed")).not.toHaveProperty("refundCalls");
  });
});

describe("the per-principal daily budget", () => {
  it("the Nth+1 call is a typed 429 assist-budget-exceeded with the limits, the usage and a retry time; the gateway is NOT called for it", async () => {
    process.env.WEBDESK_ASSIST_DAILY_CALLS = "2";
    const item = mkItem({ slug: "post.budget" });
    await run(staff(), item.itemId);
    await run(staff(), item.itemId);
    const e = await problemOf(() => run(staff(), item.itemId));
    expect([e.getStatus(), slugOf(e)]).toEqual([429, "assist-budget-exceeded"]);
    expect(e.problem).toMatchObject({ scope: "principal", limits: { calls: 2 }, used: { calls: 2 } });
    expect(e.problem.retryAfterSeconds as number).toBeGreaterThan(0);
    expect(e.problem.retryAfterSeconds as number).toBeLessThanOrEqual(86_400);
    expect(prompts).toHaveLength(2);
  });

  it("it is per PRINCIPAL: another user is unaffected by the first one's exhaustion", async () => {
    process.env.WEBDESK_ASSIST_DAILY_CALLS = "1";
    const item = mkItem({ slug: "post.budget2" });
    await run(staff("u-a"), item.itemId);
    await expect(run(staff("u-a"), item.itemId)).rejects.toBeInstanceOf(WebdeskProblem);
    expect((await run(staff("u-b"), item.itemId)).status).toBe(200);
  });

  it("the token estimate is a budget too: a prompt that would pass the day's token limit is refused", async () => {
    process.env.WEBDESK_ASSIST_DAILY_TOKENS = "50"; // far below any real prompt
    const item = mkItem({ slug: "post.tokens" });
    const e = await problemOf(() => run(staff(), item.itemId));
    expect([e.getStatus(), slugOf(e)]).toEqual([429, "assist-budget-exceeded"]);
    expect(prompts).toHaveLength(0);
  });

  it("bots and automation get a SMALLER budget on the same rule (assist writes nothing, so it is allowed, but a loop is bounded)", async () => {
    expect(limitsFor(staff())).toEqual({ calls: 40, tokens: 120_000 });
    expect(limitsFor(bot())).toEqual({ calls: 15, tokens: 40_000 });
    expect(limitsFor(n8n())).toEqual({ calls: 15, tokens: 40_000 });
    expect(limitsFor(principal("u-agent", [grant("webdev_staff")], { via: { provider: "platform", externalId: "x", agent: "seo-agent" } }))).toEqual({ calls: 15, tokens: 40_000 });
    const item = mkItem({ slug: "post.bot" });
    const r = await run(bot(), item.itemId);
    expect((r.body as { usage: { automated: boolean; callsLimit: number } }).usage).toMatchObject({ automated: true, callsLimit: 15 });
  });

  it("an empty or junk env value falls back to the default (an empty `${VAR:-}` must not become 0 or unlimited)", () => {
    process.env.WEBDESK_ASSIST_DAILY_CALLS = "";
    process.env.WEBDESK_ASSIST_DAILY_TOKENS = "banana";
    expect(limitsFor(staff())).toEqual({ calls: 40, tokens: 120_000 });
    process.env.WEBDESK_ASSIST_DAILY_CALLS = "0";
    expect(limitsFor(staff()).calls).toBe(40);
    process.env.WEBDESK_ASSIST_DAILY_CALLS = "7";
    expect(limitsFor(staff()).calls).toBe(7);
  });

  it("the ledger rows carry ids, kind, counts and latency: never the prompt, the completion or the item's text", async () => {
    const item = mkItem({ slug: "post.rows" });
    reply = async () => ({ text: JSON.stringify({ description: goodDesc }), provider: "ollama" });
    await run(staff(), item.itemId);
    const all = JSON.stringify(budget.rows);
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain("Clinic web design");
    expect(all).not.toContain(goodDesc);
  });
});

describe("🔴 no content in logs", () => {
  it("success, unusable output, a gateway failure and a refusal leave no title, field text, prompt or completion in any log line", async () => {
    const seen: string[] = [];
    const grab = (...a: unknown[]) => { seen.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
    for (const m of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) vi.spyOn(Logger.prototype, m).mockImplementation(grab as never);
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(grab as never);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { seen.push(String(c)); return true; }) as never);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => { seen.push(String(c)); return true; }) as never);
    try {
      const item = mkItem({ slug: "post.logs" });
      const COMPLETION_CANARY = "COMPLETION-CANARY-777";
      const fail = (r: () => Promise<{ text: string; provider?: string }>, body: unknown = { kind: "meta_description" }) => { reply = r; return run(staff(), item.itemId, body).catch(() => undefined); };
      await fail(async () => ({ text: JSON.stringify({ description: goodDesc }), provider: "ollama" }));
      await fail(async () => ({ text: `{"description":"${COMPLETION_CANARY} too short"}`, provider: "ollama" }));
      await fail(async () => { throw new Error(`ai-gateway failed on ${CANARY}`); });
      await fail(async () => ({ text: JSON.stringify({ items: [] }) }), { kind: "alt_text" }); // not applicable: the prompt is never built into a call
      process.env.WEBDESK_ASSIST_DAILY_CALLS = "1";
      await fail(async () => ({ text: "x" })); // budget refusal
    } finally {
      out.mockRestore(); err.mockRestore();
    }
    const everything = seen.join("\n");
    expect(everything.length, "the call logged nothing at all: the test would prove nothing").toBeGreaterThan(0);
    expect(everything).toContain("assist kind=meta_description"); // ids, kind and outcome ARE logged
    for (const secret of [CANARY, "COMPLETION-CANARY-777", "Clinic web design", "Web design for clinics", goodDesc, "clinic web design", "discovery call"]) {
      expect(everything, `a log line carries: ${secret}`).not.toContain(secret);
    }
  });
});

describe("assist never writes", () => {
  it("across every kind and every outcome, WebDesk is sent no write command and no editorial assertion is signed", async () => {
    const item = mkItem({ slug: "post.nowrite" });
    item.versions[0].fields = { h1: "H", body: `${LONG.repeat(3)}\n\n![](/u/a.jpg)` };
    for (const kind of ["outline", "meta_description", "faq", "translate_draft", "alt_text"]) {
      for (const r of [async () => ({ text: "{}" }), async () => { throw new Error("down"); }, async () => ({ text: "x", provider: "echo" })]) {
        reply = r;
        await run(staff(), item.itemId, { kind }).catch(() => undefined);
      }
    }
    expect(zb.writes).toHaveLength(0);
    expect(onlyReads(), `WebDesk saw: ${[...new Set(zb.calls.map((c) => c.command))].join(",")}`).toBe(true);
    expect(signer.calls).toHaveLength(0);
  });
});

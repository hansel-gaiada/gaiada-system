// M5-W1c — the two-phase gate on the ERP content routes, the parts that need NO service (docs/plans/2026-10-11-m5-writers-room-design.md
// §2.3, PERMISSION-CONTRACT 27.2). Runs locally: Cerbos is a STUB that emulates the W1a decisions for the four principals
// below, so what is proven here is the TRANSPORT (which attributes reach the policy, and from where), the ORDER (authorization
// before any validation, before any write) and the SHAPE of `allowed` and of `GET sites`. That the real policies decide the same
// way is webdesk-content-two-phase.test.ts (real Cerbos + Postgres, the Linux gate) and cerbos/tests/webdesk_writers_room_test.yaml.
//
// Every denial sends a VALID body and sits beside a positive control (same request, an allowed principal, 2xx), so a denial is
// authorization and not validation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ForbiddenException } from "@nestjs/common";
import type { EditorialScope, Principal, RoleGrant } from "../../rbac/principal";

const T = "aaaaaaaa-1111-0000-0000-000000000001";
const OTHER_CO = "aaaaaaaa-1111-0000-0000-000000000002";
const S1 = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"; // GAIADA_SITE
const S2 = "7a7a7a7a-3d4a-4b5c-8d6e-7f8091a2b3c4"; // a second site of company A (tenant "second")

// ── the Cerbos stub: the W1a decisions the principals below need, over the ATTRIBUTES it is sent ──────────────────────
const h = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const asks: Array<{ resource: Res; action: string; who: string }> = [];
  const probes: Array<{ resource: Res; action: string; who: string }> = [];
  const batches: Array<{ resource: Res; actions: readonly string[]; who: string }> = [];
  const state = { failBatch: false };
  const filed: Array<{ itemResources?: Res[] }> = [];
  const STAFF_TIER = ["read", "create", "update", "request_publish", "submit", "comment"];
  const decide = (p: { userId: string | null; roles: Array<{ role: string; editorialScopes?: Array<{ siteId: string; allCollections: boolean; collections: string[]; allLocales: boolean; locales: string[] }> }> }, r: Res, a: string): boolean => {
    if (r.tenantId !== "aaaaaaaa-1111-0000-0000-000000000001") return false;
    if (p.roles.some((g) => g.role === "webdev_manager")) return !(a === "approve" && (r.creatorId === "" || r.creatorId === p.userId));
    if (p.roles.some((g) => g.role === "webdev_staff")) return STAFF_TIER.includes(a);
    for (const g of p.roles) {
      if (g.role !== "webdesk_writer" && g.role !== "webdesk_translator") continue;
      const covers = (g.editorialScopes ?? []).some(
        (s) => s.siteId === r.siteId && (s.allCollections || s.collections.includes(r.collectionKey as string)) && (s.allLocales || s.locales.includes(r.locale as string)),
      );
      const site = (g.editorialScopes ?? []).some((s) => s.siteId === r.siteId && r.siteId !== "");
      const inCollection = (g.editorialScopes ?? []).some((s) => s.siteId === r.siteId && (s.allCollections || s.collections.includes(r.collectionKey as string)));
      const own = r.ownerId !== undefined && r.ownerId === p.userId;
      if (r.kind === "webdesk_collection" && a === "read") return site;
      if (r.kind === "webdesk_media_asset" && a === "read") return site;
      if (r.kind !== "webdesk_content_item") return false;
      if (a === "read") return inCollection;
      if (!covers) return false;
      if (g.role === "webdesk_writer" && a === "create") return true;
      if (g.role === "webdesk_translator" && a === "create") return r.reviewState === "approved" || r.published === true;
      if (a === "update") return own && (r.reviewState === "draft" || r.reviewState === "changes_requested");
      if (a === "submit" || a === "comment") return own;
      return false;
    }
    return false;
  };
  return { asks, probes, batches, state, decide, filed };
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
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...real,
    check: async (principal: { userId: string }, resource: Record<string, unknown>, action: string) => {
      h.probes.push({ resource: { ...resource }, action, who: principal.userId });
      return h.decide(principal as never, resource, action) ? { allow: true } : { allow: false, reason: "stub" };
    },
    checkActions: async (principal: { userId: string }, resource: Record<string, unknown>, actions: readonly string[]) => {
      h.batches.push({ resource: { ...resource }, actions: [...actions], who: principal.userId });
      if (h.state.failBatch) throw new Error("cerbos 503");
      return Object.fromEntries(actions.map((a) => [a, h.decide(principal as never, resource, a)]));
    },
  };
});

// Filing a WS4 approval needs the database; the asks are what is under test, so the filer is a stub (its argument is recorded).
vi.mock("./webdesk-approved-command", async (importOriginal) => {
  const real = await importOriginal<typeof import("./webdesk-approved-command")>();
  return { ...real, fileWebdeskCommandApproval: (async (_p: unknown, _t: unknown, input: { itemResources?: Array<Record<string, unknown>> }) => { h.filed.push(input); return { approvalId: "approval-stub" }; }) as typeof real.fileWebdeskCommandApproval };
});

import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import {
  ContentGate, ItemGate, WebdeskContentService, WebdeskZoneB, holdsEditorialGrant, type SiteRef,
} from "./webdesk-content.service";
import { WebdeskMediaService, mediaCapabilities } from "./webdesk-media.service";

const WRITER = "u-writer";
const OTHER_AUTHOR = "u-other-author";
const TRANSLATOR = "u-translator";

const scope = (siteId: string, collections: string[] | "all", locales: string[] | "all"): EditorialScope => ({
  siteId, allCollections: collections === "all", collections: collections === "all" ? [] : collections,
  allLocales: locales === "all", locales: locales === "all" ? [] : locales,
});
const principal = (userId: string, roles: RoleGrant[], extra: Partial<Principal> = {}): Principal =>
  ({ userId, assurance: "high", companies: [T], rootCompanies: [T], roles, sessionVersion: 1, ...extra });
const grant = (role: string, scopes?: EditorialScope[]): RoleGrant => ({ role, scopeType: "company", scopeId: T, ...(scopes ? { editorialScopes: scopes } : {}) });
const writer = () => principal(WRITER, [grant("webdesk_writer", [scope(GAIADA_SITE, ["post"], ["en"])])]);
const translator = () => principal(TRANSLATOR, [grant("webdesk_translator", [scope(GAIADA_SITE, ["post"], ["id"])])]);
const staff = () => principal("u-staff", [grant("webdev_staff")]);
const manager = () => principal("u-manager", [grant("webdev_manager")]);
const nobody = () => principal("u-nobody", [grant("member")]);

const site: SiteRef = { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE };
const signer = makeTestSigner();
let zb: FakeZoneB;
let svc: WebdeskContentService;
let media: WebdeskMediaService;
let zone: WebdeskZoneB;

const mkItem = (over: Partial<FakeItem> & { slug: string }): FakeItem =>
  zb.seedItem({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en", ...over });
const draftBy = (author: string | null, over: Partial<FakeItem> & { slug: string }): FakeItem =>
  mkItem({ editorial: { reviewRequired: false, state: "draft", approvedVersion: null, authorSub: author, submittedVersion: null }, ...over });

const siteGate = (p: Principal, kind: Parameters<typeof ContentGate.openSite>[3], action: Parameters<typeof ContentGate.openSite>[4]) =>
  ContentGate.openSite(p, T, GAIADA_SITE, kind, action);
const asksOf = (kind: string, action?: string) => h.asks.filter((a) => a.resource.kind === kind && (action === undefined || a.action === action));
const validUpdate = (item: FakeItem, extra: Record<string, unknown> = {}) => ({ baseVersion: item.headVersion, fields: { h1: "edited" }, ...extra });

beforeEach(() => {
  h.asks.length = 0;
  h.probes.length = 0;
  h.batches.length = 0;
  h.state.failBatch = false;
  h.filed.length = 0;
  zb = new FakeZoneB(T, OTHER_CO);
  zb.compositions.set("post", { ui: { label: "Posts" } });
  zb.compositions.set("guide", { ui: { label: "Guides" } });
  signer.calls.length = 0;
  zone = new WebdeskZoneB();
  svc = new WebdeskContentService(zone);
  media = new WebdeskMediaService(zone);
  setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
});

// ═══════════════════════════════════════ phase 1 ══════════════════════════════════════════════════════
describe("phase 1: ContentGate.openSite asks webdesk_collection:read on {tenantId, module, siteId} first", () => {
  it("a scoped writer is asked ONLY that question; a staff tier is also asked the old attribute-free one (no egress before a denial)", async () => {
    await siteGate(writer(), "webdesk_content_item", "update");
    expect(h.asks.map((a) => `${String(a.resource.kind)}:${a.action}`)).toEqual(["webdesk_collection:read"]);
    expect(h.asks[0].resource).toEqual({ kind: "webdesk_collection", tenantId: T, module: "webdev", siteId: GAIADA_SITE });

    h.asks.length = 0;
    await siteGate(manager(), "webdesk_content_item", "update");
    expect(h.asks.map((a) => `${String(a.resource.kind)}:${a.action}`)).toEqual(["webdesk_collection:read", "webdesk_content_item:update"]);
    expect(h.asks[1].resource).toEqual({ kind: "webdesk_content_item", tenantId: T, module: "webdev" }); // the OLD first statement, verbatim
    expect(zb.calls).toHaveLength(0);
  });

  it("the old question is not repeated when it WAS phase 1, and is skipped for a delegated call (the acting human may hold a grant the caller does not)", async () => {
    await siteGate(manager(), "webdesk_collection", "read");
    expect(h.asks).toHaveLength(1);
    h.asks.length = 0;
    await siteGate(manager(), "webdesk_content_item", "update").catch(() => undefined);
    h.asks.length = 0;
    await siteGate(principal("u-agent", [grant("webdev_manager")], { actFor: { userId: "u-human" } } as Partial<Principal>), "webdesk_content_item", "update");
    expect(h.asks.map((a) => a.action)).toEqual(["read"]);
  });

  it("a denied caller gets 403 before ANY egress: another site, no role", async () => {
    await expect(ContentGate.openSite(writer(), T, S2, "webdesk_content_item", "read")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(siteGate(nobody(), "webdesk_content_item", "read")).rejects.toBeInstanceOf(ForbiddenException);
    // staff without unpublish: phase 1 passes, the old question denies, still no egress
    await expect(siteGate(staff(), "webdesk_content_item", "unpublish")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.calls).toHaveLength(0);
    // positive controls
    await expect(siteGate(writer(), "webdesk_content_item", "read")).resolves.toBeDefined();
    await expect(siteGate(manager(), "webdesk_content_item", "unpublish")).resolves.toBeDefined();
  });

  it("holdsEditorialGrant: the role name OR scope rows", () => {
    expect(holdsEditorialGrant(writer())).toBe(true);
    expect(holdsEditorialGrant(principal("u", [grant("webdesk_editor")]))).toBe(true);
    expect(holdsEditorialGrant(principal("u", [{ role: "x", scopeType: "company", scopeId: T, editorialScopes: [scope(S1, "all", "all")] }]))).toBe(true);
    expect(holdsEditorialGrant(manager())).toBe(false);
    expect(holdsEditorialGrant(nobody())).toBe(false);
  });
});

// ═══════════════════════════════════════ acceptance 1 ═════════════════════════════════════════════════
describe("phase 2 on a write: a writer's PUT on another author's item is 403 with a VALID body, and WebDesk receives no write", () => {
  it("update: the other author's item is refused; the writer's OWN item (same request) succeeds", async () => {
    const theirs = draftBy(OTHER_AUTHOR, { slug: "post.theirs" });
    const mine = draftBy(WRITER, { slug: "post.mine" });

    const gate1 = await siteGate(writer(), "webdesk_content_item", "update");
    await expect(svc.updateItem(gate1, site, theirs.itemId, validUpdate(theirs), "idem-denied-0001")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(0);
    expect(signer.calls).toHaveLength(0);
    expect(zb.calls.some((c) => c.command === "item.get")).toBe(true); // the attributes were READ from WebDesk, not assumed

    const gate2 = await siteGate(writer(), "webdesk_content_item", "update");
    const ok = await svc.updateItem(gate2, site, mine.itemId, validUpdate(mine), "idem-allowed-001");
    expect(ok.status).toBe(200);
    expect(zb.writes.map((w) => w.command)).toEqual(["content.update"]);
  });

  it("restore, preview and the item's other writes are refused the same way; the legacy/unowned item (no author) is nobody's", async () => {
    const theirs = draftBy(OTHER_AUTHOR, { slug: "post.theirs2" });
    const legacy = draftBy(null, { slug: "post.legacy" });
    const g = await siteGate(writer(), "webdesk_content_item", "update");
    await expect(svc.restoreVersion(g, site, theirs.itemId, { version: 1, baseVersion: 1 }, "idem-restore-0001")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.updateItem(g, site, legacy.itemId, validUpdate(legacy), "idem-legacy-00001")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.previewItem(g, site, theirs.itemId, {}, "idem-preview-0001")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(0);
    expect(zb.calls.filter((c) => c.command === "content.previewToken")).toHaveLength(0);
  });

  it("an item in review is not editable by the writer even when it is theirs (reviewState comes from WebDesk)", async () => {
    const inReview = mkItem({ slug: "post.review", editorial: { reviewRequired: true, state: "in_review", approvedVersion: null, authorSub: WRITER, submittedVersion: 1 } });
    const g = await siteGate(writer(), "webdesk_content_item", "update");
    await expect(svc.updateItem(g, site, inReview.itemId, validUpdate(inReview), "idem-review-00001")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(0);
    // control: the same item with changes requested
    inReview.editorial = { reviewRequired: true, state: "changes_requested", approvedVersion: null, authorSub: WRITER, submittedVersion: 1 };
    await expect(svc.updateItem(await siteGate(writer(), "webdesk_content_item", "update"), site, inReview.itemId, validUpdate(inReview), "idem-review-00002")).resolves.toMatchObject({ status: 200 });
  });

  it("a WebDesk older than M5-W2b (no `editorial` member) fails CLOSED for the writer and changes nothing for staff", async () => {
    const old = mkItem({ slug: "post.old" }); // no editorial member
    await expect(svc.updateItem(await siteGate(writer(), "webdesk_content_item", "update"), site, old.itemId, validUpdate(old), "idem-old-0000001")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(0);
    await expect(svc.updateItem(await siteGate(staff(), "webdesk_content_item", "update"), site, old.itemId, validUpdate(old), "idem-old-0000002")).resolves.toMatchObject({ status: 200 });
    expect(asksOf("webdesk_content_item", "update").at(-1)!.resource).toMatchObject({ reviewState: "", ownerId: "" });
  });

  it("authorization precedes validation: a writer on another's item with an INVALID body is 403, the same body as the owner is 400", async () => {
    const theirs = draftBy(OTHER_AUTHOR, { slug: "post.theirs3" });
    const mine = draftBy(WRITER, { slug: "post.mine3" });
    await expect(svc.updateItem(await siteGate(writer(), "webdesk_content_item", "update"), site, theirs.itemId, { nonsense: true }, "idem-inv-0000001")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.updateItem(await siteGate(writer(), "webdesk_content_item", "update"), site, mine.itemId, { nonsense: true }, "idem-inv-0000002")).rejects.toMatchObject({ status: 400 });
    expect(zb.writes).toHaveLength(0);
  });

  it("unpublish and delete are the publisher tier: the writer and the staff editor are refused with a valid body, the manager succeeds", async () => {
    const live = draftBy(WRITER, { slug: "post.live", publishedVersion: 1, publishState: "published" });
    const gone = draftBy(WRITER, { slug: "post.gone" });
    await expect(siteGate(writer(), "webdesk_content_item", "unpublish")).resolves.toBeDefined(); // phase 1 passes for a writer; phase 2 refuses
    await expect(svc.unpublish(await siteGate(writer(), "webdesk_content_item", "unpublish"), site, live.itemId, { expectedPublishedVersion: 1 }, "idem-unpub-000001")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.deleteItem(await siteGate(writer(), "webdesk_content_item", "delete"), site, gone.itemId, { baseVersion: 1 }, "idem-delete-00001")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(siteGate(staff(), "webdesk_content_item", "unpublish")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(0);
    await expect(svc.deleteItem(await siteGate(manager(), "webdesk_content_item", "delete"), site, gone.itemId, { baseVersion: 1 }, "idem-delete-00002")).resolves.toMatchObject({ status: 200 });
  });
});

// ═══════════════════════════════════════ acceptance 2 ═════════════════════════════════════════════════
describe("provenance: a body or a query cannot set siteId, collectionKey, locale, ownerId or reviewState", () => {
  const FORGED = { siteId: "forged-site", collectionKey: "forged-collection", locale: "forged-locale", ownerId: "forged-owner", reviewState: "approved", creatorId: "forged-creator" };
  const everyAsk = () => JSON.stringify([...h.asks, ...h.probes, ...h.batches].map((a) => a.resource));

  it("update/restore/preview/unpublish/delete: the Cerbos request carries WebDesk's and the wall's values, whatever the body says", async () => {
    const mine = draftBy(WRITER, { slug: "post.prov" });
    const live = draftBy(WRITER, { slug: "post.prov2", publishedVersion: 1, publishState: "published" });
    const g = (kind: Parameters<typeof siteGate>[1], action: Parameters<typeof siteGate>[2], p = manager()) => siteGate(p, kind, action);

    // The forged body is refused (unknown key, 400) AFTER the check: the check saw only WebDesk's values.
    await expect(svc.updateItem(await g("webdesk_content_item", "update"), site, mine.itemId, validUpdate(mine, FORGED), "idem-forge-000001")).rejects.toMatchObject({ status: 400 });
    await expect(svc.restoreVersion(await g("webdesk_content_item", "update"), site, mine.itemId, { version: 1, baseVersion: 1, ...FORGED }, "idem-forge-000002")).rejects.toMatchObject({ status: 400 });
    await expect(svc.unpublish(await g("webdesk_content_item", "unpublish"), site, live.itemId, { expectedPublishedVersion: 1, ...FORGED }, "idem-forge-000003")).rejects.toMatchObject({ status: 400 });
    await expect(svc.deleteItem(await g("webdesk_content_item", "delete"), site, mine.itemId, { baseVersion: 1, ...FORGED }, "idem-forge-000004")).rejects.toMatchObject({ status: 400 });
    expect(zb.writes).toHaveLength(0);

    const itemAsks = asksOf("webdesk_content_item").filter((a) => a.resource.id !== undefined);
    expect(itemAsks.length).toBeGreaterThanOrEqual(4);
    for (const a of itemAsks) {
      expect(a.resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en", ownerId: WRITER, reviewState: "draft", published: a.resource.id === live.itemId });
    }
    for (const forged of Object.values(FORGED)) expect(everyAsk()).not.toContain(forged);
  });

  it("the preview body's `version` selects a version only; a forged attribute beside it is a 400, after the check", async () => {
    const mine = draftBy(WRITER, { slug: "post.prov3" });
    await expect(svc.previewItem(await siteGate(manager(), "webdesk_content_item", "update"), site, mine.itemId, { version: 1, ...FORGED }, "idem-forge-000005")).rejects.toMatchObject({ status: 400 });
    expect(asksOf("webdesk_content_item", "update").at(-1)!.resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", ownerId: WRITER });
    expect(everyAsk()).not.toContain("forged-");
  });

  it("reads: a query cannot name another site/collection/owner; the check ran on WebDesk's item before the query was validated", async () => {
    const theirs = draftBy(OTHER_AUTHOR, { slug: "post.read" });
    const g = await siteGate(writer(), "webdesk_content_item", "read");
    await expect(svc.getItem(g, site, theirs.itemId, { ...FORGED })).rejects.toMatchObject({ status: 400 }); // writer MAY read it (in collection scope): then the query is refused
    await expect(svc.listVersions(g, site, theirs.itemId, { ...FORGED })).rejects.toMatchObject({ status: 400 });
    await expect(svc.getVersion(g, site, theirs.itemId, "1", { ...FORGED })).rejects.toMatchObject({ status: 400 });
    await expect(svc.listItems(g, site, "post", { ...FORGED })).rejects.toMatchObject({ status: 400 });
    const reads = asksOf("webdesk_content_item", "read");
    expect(reads).toHaveLength(4);
    for (const a of reads.slice(0, 3)) expect(a.resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en", ownerId: OTHER_AUTHOR });
    expect(reads[3].resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post" }); // the ROUTE's key, never the query's
    expect(everyAsk()).not.toContain("forged-");
    // a collection the writer has no scope row for: the route key is what is asked, and it is denied (positive control above)
    await expect(svc.listItems(g, site, "guide", {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.calls.filter((c) => c.command === "item.list")).toHaveLength(0);
  });

  it("M5-W2e: the item list takes `reviewState` as a filter: each state is forwarded under WebDesk's own name, an unknown one is a 400 after the check, and a denied caller is 403 for any value", async () => {
    draftBy(WRITER, { slug: "post.rs" });
    const g = await siteGate(writer(), "webdesk_content_item", "read");
    for (const st of ["draft", "in_review", "changes_requested", "approved"]) {
      zb.calls.length = 0;
      await svc.listItems(g, site, "post", { reviewState: st, limit: "5" });
      const call = zb.calls.find((c) => c.command === "item.list")!;
      expect(call.query).toEqual({ reviewState: st, limit: "5" });
    }
    // an unknown or oddly-cased value never reaches WebDesk
    for (const bad of ["", "Draft", "published", "in-review", "draft,approved"]) {
      zb.calls.length = 0;
      await expect(svc.listItems(g, site, "post", { reviewState: bad })).rejects.toMatchObject({ status: 400 });
      expect(zb.calls.filter((c) => c.command === "item.list")).toHaveLength(0);
    }
    // the phase-2 read check ran BEFORE the value was looked at, with the route's collection
    expect(asksOf("webdesk_content_item", "read").at(-1)!.resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post" });
    // authorization first: a collection the writer has no scope for is 403 for a VALID value and for an invalid one alike, and WebDesk is not asked
    zb.calls.length = 0;
    await expect(svc.listItems(g, site, "guide", { reviewState: "draft" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.listItems(g, site, "guide", { reviewState: "nonsense" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.calls.filter((c) => c.command === "item.list")).toHaveLength(0);
    // and a second, repeated value is the existing one-string rule
    await expect(svc.listItems(g, site, "post", { reviewState: ["draft", "approved"] })).rejects.toMatchObject({ status: 400 });
  });

  it("create: collectionKey is the ROUTE's (collection.get proves it), locale is the body's, and nothing else the body says reaches Cerbos", async () => {
    const g = () => siteGate(writer(), "webdesk_content_item", "create");
    const body = { locale: "en", slug: "post.new", fields: { h1: "a" } };
    // forged siteId/ownerId/reviewState/creatorId: 400 after the check; a body naming ANOTHER collection: 400; neither writes
    await expect(svc.createItem(await g(), site, "post", { ...body, ...FORGED, locale: "en", collectionKey: "post" }, "idem-create-00001")).rejects.toMatchObject({ status: 400 });
    await expect(svc.createItem(await g(), site, "post", { ...body, collectionKey: "guide" }, "idem-create-00002")).rejects.toMatchObject({ status: 400 });
    expect(zb.writes).toHaveLength(0);
    for (const a of asksOf("webdesk_content_item", "create")) {
      expect(a.resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en" });
      expect(a.resource).not.toHaveProperty("ownerId");
      expect(a.resource).not.toHaveProperty("reviewState");
      expect(a.resource).not.toHaveProperty("creatorId");
    }
    expect(everyAsk()).not.toContain("forged-");
    // the body's LOCALE is the one body value that is read (WebDesk validates it); a locale outside the grant is a 403 with no write
    await expect(svc.createItem(await g(), site, "post", { ...body, locale: "id" }, "idem-create-00003")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(0);
    // control: the identical request in the granted locale is created
    await expect(svc.createItem(await g(), site, "post", body, "idem-create-00004")).resolves.toMatchObject({ status: 201 });
    expect(zb.writes.map((w) => w.command)).toEqual(["content.create"]);
    expect(zb.writes[0].body).toMatchObject({ collectionKey: "post", locale: "en" });
    // a collection that does not exist is WebDesk's 404 before any check; one the writer has no scope for is 403 with no write
    await expect(svc.createItem(await g(), site, "nope", body, "idem-create-00005")).rejects.toMatchObject({ status: 404 });
    await expect(svc.createItem(await siteGate(writer(), "webdesk_content_item", "create"), site, "guide", body, "idem-create-00006")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(1);
  });

  it("a locale twin: the SOURCE item's review state and `published` (read from WebDesk) decide a translator's create; the body only names the source", async () => {
    const approved = mkItem({ slug: "post.src.ok", locale: "en", editorial: { reviewRequired: true, state: "approved", approvedVersion: 1, authorSub: OTHER_AUTHOR, submittedVersion: 1 } });
    const live = mkItem({ slug: "post.src.live", locale: "en", publishedVersion: 1, publishState: "published", editorial: { reviewRequired: false, state: "draft", approvedVersion: null, authorSub: OTHER_AUTHOR, submittedVersion: null } });
    const draft = mkItem({ slug: "post.src.draft", locale: "en", editorial: { reviewRequired: false, state: "draft", approvedVersion: null, authorSub: OTHER_AUTHOR, submittedVersion: null } });
    const g = () => siteGate(translator(), "webdesk_content_item", "create");
    const twinBody = (src: FakeItem, slug: string, extra: Record<string, unknown> = {}) => ({ locale: "id", slug, twinOf: src.itemId, fields: { h1: "x" }, ...extra });

    await expect(svc.createItem(await g(), site, "post", twinBody(draft, "post.t.draft"), "idem-twin-0000001")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.createItem(await g(), site, "post", { locale: "id", slug: "post.t.fresh", fields: {} }, "idem-twin-0000002")).rejects.toBeInstanceOf(ForbiddenException); // no source: never an original
    expect(zb.writes).toHaveLength(0);
    // the body CLAIMING the source is approved changes nothing (and is a 400 anyway: unknown key, after the check)
    await expect(svc.createItem(await g(), site, "post", twinBody(draft, "post.t.forge", { reviewState: "approved", published: true }), "idem-twin-0000003")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(0);

    await expect(svc.createItem(await g(), site, "post", twinBody(approved, "post.t.ok"), "idem-twin-0000004")).resolves.toMatchObject({ status: 201 });
    await expect(svc.createItem(await g(), site, "post", twinBody(live, "post.t.live"), "idem-twin-0000005")).resolves.toMatchObject({ status: 201 });
    expect(zb.writes).toHaveLength(2);
    const asks = asksOf("webdesk_content_item", "create");
    expect(asks.at(-2)!.resource).toMatchObject({ reviewState: "approved", published: false, locale: "id", collectionKey: "post" });
    expect(asks.at(-1)!.resource).toMatchObject({ reviewState: "draft", published: true });
    expect(zb.calls.filter((c) => c.command === "item.get").map((c) => c.params.itemId)).toContain(approved.itemId);
  });

  it("a twin source from ANOTHER collection contributes nothing (fail closed), and a staff principal never costs the source read", async () => {
    const other = mkItem({ slug: "guide.src", collectionKey: "guide", locale: "en", editorial: { reviewRequired: true, state: "approved", approvedVersion: 1, authorSub: OTHER_AUTHOR, submittedVersion: 1 } });
    await expect(svc.createItem(await siteGate(translator(), "webdesk_content_item", "create"), site, "post", { locale: "id", slug: "post.cross", twinOf: other.itemId, fields: {} }, "idem-twin-0000006")).rejects.toBeInstanceOf(ForbiddenException);
    zb.calls.length = 0;
    await svc.createItem(await siteGate(manager(), "webdesk_content_item", "create"), site, "post", { locale: "id", slug: "post.staff.twin", twinOf: other.itemId, fields: {} }, "idem-twin-0000007");
    expect(zb.calls.filter((c) => c.command === "item.get")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════ acceptance 3 · allowed ═══════════════════════════════════════
describe("allowed: one Cerbos batch, the same resource the real handlers ask with", () => {
  const ACTIONS = ["read", "update", "submit", "comment", "request_changes", "seo_signoff", "approve", "assign", "request_publish", "unpublish", "delete"];

  it("item.get carries `allowed` = the batch answer for the SAME attributes the read authorization used", async () => {
    const mine = draftBy(WRITER, { slug: "post.allowed" });
    const theirs = draftBy(OTHER_AUTHOR, { slug: "post.allowed2" });
    const r = await svc.getItem(await siteGate(writer(), "webdesk_content_item", "read"), site, mine.itemId, {});
    const body = r.body as { allowed: Record<string, boolean>; item: { itemId: string } };
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0].actions).toEqual(ACTIONS);
    // identical to a direct answer for the same principal and resource (the stub is the oracle here; the real Cerbos is the DB suite)
    const resource = h.batches[0].resource;
    expect(body.allowed).toEqual(Object.fromEntries(ACTIONS.map((a) => [a, h.decide(writer() as never, resource, a)])));
    expect(body.allowed).toMatchObject({ read: true, update: true, submit: true, comment: true, approve: false, unpublish: false, delete: false });
    // and the resource is the one the read check used (+ nothing else but creatorId)
    const read = asksOf("webdesk_content_item", "read").at(-1)!.resource;
    expect({ ...resource, creatorId: undefined }).toEqual({ ...read, creatorId: undefined });
    expect(resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en", ownerId: WRITER, reviewState: "draft", published: false });

    // another author's item: the writer reads it but may not update it
    const r2 = await svc.getItem(await siteGate(writer(), "webdesk_content_item", "read"), site, theirs.itemId, {});
    expect((r2.body as { allowed: Record<string, boolean> }).allowed).toMatchObject({ read: true, update: false, submit: false });
  });

  it("is one CheckResources per read, in the staff answer too, and never on the client portal or a delegated call", async () => {
    const it0 = draftBy(WRITER, { slug: "post.allowed3" });
    const staffRes = await svc.getItem(await siteGate(manager(), "webdesk_content_item", "read"), site, it0.itemId, {});
    expect((staffRes.body as { allowed: Record<string, boolean> }).allowed).toMatchObject({ read: true, update: true, unpublish: true, delete: true });

    // a client gate: its own contract, no `allowed`
    h.batches.length = 0;
    const cg = await ContentGate.openClient(manager(), T, "webdesk_content_item", "read", { clientId: "client-1", assertOwnsSite: async () => undefined });
    expect((await svc.getItem(cg, site, it0.itemId, {})).body).not.toHaveProperty("allowed");
    // a delegated call: a batch cannot intersect the acting human's rights, so it is unknown, never over-reported
    const delegated = await siteGate(principal("u-agent", [grant("webdev_manager")], { actFor: { userId: "u-human" } } as Partial<Principal>), "webdesk_content_item", "read");
    expect((await svc.getItem(delegated, site, it0.itemId, {})).body).not.toHaveProperty("allowed");
    expect(h.batches).toHaveLength(0);
  });

  it("when Cerbos cannot answer the batch the read still succeeds and `allowed` is ABSENT (unknown, never false)", async () => {
    const it0 = draftBy(WRITER, { slug: "post.allowed4" });
    h.state.failBatch = true;
    const r = await svc.getItem(await siteGate(manager(), "webdesk_content_item", "read"), site, it0.itemId, {});
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty("allowed");
  });

  it("approve's creatorId is the creator of the SUBMITTED version: from the answer in hand when it is the head, else from one more read", async () => {
    const inReview = mkItem({
      slug: "post.approve", editorial: { reviewRequired: true, state: "in_review", approvedVersion: null, authorSub: WRITER, submittedVersion: 1 },
    });
    // v1 by the writer, then a v2 by someone else: the submitted version is 1, the head is 2 (a rewrite during review follows the head in WebDesk;
    // here the fixture pins the "submitted is not the head" branch)
    inReview.versions.push({ version: 2, fields: { h1: "v2" }, contentHash: "h2", createdBy: "u-rewriter", createdAt: new Date().toISOString(), note: null });
    inReview.versions[0].createdBy = "u-v1-author";
    inReview.headVersion = 2;
    await svc.getItem(await siteGate(manager(), "webdesk_content_item", "read"), site, inReview.itemId, {});
    expect(h.batches.at(-1)!.resource).toMatchObject({ creatorId: "u-v1-author" });
    expect(zb.calls.filter((c) => c.command === "item.get" && c.query?.version === "1")).toHaveLength(1);

    // submitted == head: no extra read
    inReview.editorial = { reviewRequired: true, state: "in_review", approvedVersion: null, authorSub: WRITER, submittedVersion: 2 };
    zb.calls.length = 0;
    await svc.getItem(await siteGate(manager(), "webdesk_content_item", "read"), site, inReview.itemId, {});
    expect(h.batches.at(-1)!.resource).toMatchObject({ creatorId: "u-rewriter" });
    expect(zb.calls.filter((c) => c.command === "item.get")).toHaveLength(1);
    // not in review: no creator (approve can never be offered)
    inReview.editorial = { reviewRequired: true, state: "draft", approvedVersion: null, authorSub: WRITER, submittedVersion: null };
    await svc.getItem(await siteGate(manager(), "webdesk_content_item", "read"), site, inReview.itemId, {});
    expect(h.batches.at(-1)!.resource).toMatchObject({ creatorId: "" });
  });

  it("?version= is forwarded only AFTER the check, as a second read; the head read is the attribute source", async () => {
    const it0 = draftBy(WRITER, { slug: "post.allowed5", publishedVersion: 1, publishState: "published" });
    const r = await svc.getItem(await siteGate(manager(), "webdesk_content_item", "read"), site, it0.itemId, { version: "live" });
    expect(r.status).toBe(200);
    const gets = zb.calls.filter((c) => c.command === "item.get");
    expect(gets.map((c) => c.query)).toEqual([undefined, { version: "live" }]);
    expect(h.asks.some((a) => a.resource.id === it0.itemId && a.action === "read")).toBe(true);
  });
});

// ═══════════════════════════════════════ acceptance 6 · GET sites ═════════════════════════════════════
describe("GET sites returns only the sites the caller may read (Cerbos per site); staff unchanged", () => {
  beforeEach(() => {
    zb.tenants.push({ companyRef: T, slug: "second", status: "active", siteId: S2 });
  });
  const sitesOf = (r: { body: unknown }) => (r.body as { tenants: Array<{ slug: string; sites: Array<{ siteId: string }> }> }).tenants.map((t) => `${t.slug}/${t.sites.map((s) => s.siteId).join(",")}`);

  it("a scoped writer sees only its site; a manager sees both, byte-for-byte the WebDesk answer, with ONE company-level question", async () => {
    const w = await ContentGate.openSites(writer(), T);
    expect(h.asks).toHaveLength(0); // no company-level question for a scoped principal: no spurious denial row
    const wr = await svc.listSites(w);
    expect(sitesOf(wr)).toEqual([`${GAIADA_SLUG}/${GAIADA_SITE}`]);
    expect(h.asks.map((a) => `${String(a.resource.kind)}:${a.action}:${String(a.resource.siteId)}`)).toEqual([`webdesk_collection:read:${GAIADA_SITE}`]);
    expect(h.probes.map((a) => a.resource.siteId)).toEqual(expect.arrayContaining([GAIADA_SITE, S2]));

    h.asks.length = 0;
    h.probes.length = 0;
    const m = await ContentGate.openSites(manager(), T);
    const mr = await svc.listSites(m);
    expect(sitesOf(mr)).toEqual([`${GAIADA_SLUG}/${GAIADA_SITE}`, `second/${S2}`]);
    expect(h.asks.map((a) => `${String(a.resource.kind)}:${a.action}`)).toEqual(["webdesk_collection:read"]);
    expect(h.asks[0].resource).toEqual({ kind: "webdesk_collection", tenantId: T, module: "webdev" });
    expect(h.probes).toHaveLength(0);
  });

  it("no readable site is a 403, never an empty list; a principal with no role is 403 before any egress", async () => {
    const lost = principal("u-lost", [grant("webdesk_writer", [scope("some-other-site", "all", "all")])]);
    await expect(svc.listSites(await ContentGate.openSites(lost, T))).rejects.toBeInstanceOf(ForbiddenException);
    zb.calls.length = 0;
    await expect(ContentGate.openSites(nobody(), T)).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.calls).toHaveLength(0);
  });

  it("the wall's cache keeps the FULL answer: a filtered list does not make the other site 404 for someone who may read it", async () => {
    await svc.listSites(await ContentGate.openSites(writer(), T));
    await expect(zone.resolveEditableSite(T, "second", S2)).resolves.toMatchObject({ site: { siteId: S2 } });
  });
});

// ═══════════════════════════════════════ publish requests ═════════════════════════════════════════════
describe("publish-requests: phase 2 reads the named items before the body is validated", () => {
  it("a writer (no request_publish) is 403 with a VALID body; an invalid body from the writer is ALSO 403; the staff editor reaches validation", async () => {
    const it0 = draftBy(WRITER, { slug: "post.pub" });
    const valid = { items: [{ itemId: it0.itemId, version: 1 }] };
    const g = await siteGate(writer(), "webdesk_content_item", "request_publish").catch(() => null);
    // phase 1 passes for the writer? the stub's writer has no request_publish: the OLD question is skipped for an editorial principal, so the gate opens
    expect(g).not.toBeNull();
    await expect(svc.requestPublish(g!, site, valid)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.requestPublish(g!, site, { items: "nope" })).rejects.toBeInstanceOf(ForbiddenException); // site-level ask: 403 before the 400
    const asks = asksOf("webdesk_content_item", "request_publish");
    expect(asks[0].resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "post", locale: "en", ownerId: WRITER, reviewState: "draft", published: false });
    expect(asks[1].resource).toMatchObject({ siteId: GAIADA_SITE, collectionKey: "", locale: "" });
    expect(zb.writes).toHaveLength(0);
    // control: the staff tier is NOT refused by the gate; its malformed body is the 400
    const sg = await siteGate(staff(), "webdesk_content_item", "request_publish");
    await expect(svc.requestPublish(sg, site, { items: "nope" })).rejects.toMatchObject({ status: 400 });
  });

  it("each distinct attribute tuple is asked once (bounded), carrying WebDesk's author/state/live, never the body's", async () => {
    const a = draftBy(WRITER, { slug: "post.pubA" });
    const b = draftBy(WRITER, { slug: "post.pubB" });
    const c = draftBy(OTHER_AUTHOR, { slug: "post.pubC" });
    const sg = await siteGate(manager(), "webdesk_content_item", "request_publish");
    await expect(svc.requestPublish(sg, site, { items: [a, b, c].map((i) => ({ itemId: i.itemId, version: 1 })), note: "x" })).resolves.toMatchObject({ status: 202, body: { approvalId: "approval-stub", itemCount: 3 } });
    const asks = asksOf("webdesk_content_item", "request_publish").filter((x) => x.resource.id === undefined && x.resource.collectionKey === "post");
    expect(asks.map((x) => x.resource.ownerId).sort()).toEqual([OTHER_AUTHOR, WRITER].sort());
    // the filer re-asks on exactly those attribute-carrying resources (a scoped editor is matched by them)
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0].itemResources).toEqual(asks.map((x) => x.resource));
  });
});

// ═══════════════════════════════════════ media ════════════════════════════════════════════════════════
describe("media: phase 2 asks webdesk_media_asset:<action> with the wall's site id before the query/body is validated", () => {
  it("a writer reads the media of its site (list + capabilities carry the site) and may not upload; a forged siteId in the query is a 400 after the check", async () => {
    const g = await siteGate(writer(), "webdesk_media_asset", "read");
    const r = await media.list(g, site, {});
    expect(r.status).toBe(200);
    expect(asksOf("webdesk_media_asset", "read").at(-1)!.resource).toEqual({ kind: "webdesk_media_asset", tenantId: T, module: "webdev", siteId: GAIADA_SITE });
    expect(h.batches.at(-1)!.resource).toMatchObject({ kind: "webdesk_media_asset", siteId: GAIADA_SITE });
    expect((r.body as { capabilities: Record<string, boolean> }).capabilities).toMatchObject({ read: true, upload: false, update: false, delete: false });

    await expect(media.list(g, site, { siteId: "forged-site" })).rejects.toMatchObject({ status: 400 });
    expect(asksOf("webdesk_media_asset", "read").at(-1)!.resource.siteId).toBe(GAIADA_SITE);

    const up = await siteGate(writer(), "webdesk_media_asset", "upload");
    await expect(media.mintUploadToken(up, site, { bucket: "media" }, "idem-media-000001")).rejects.toBeInstanceOf(ForbiddenException);
    expect(zb.writes).toHaveLength(0);
    // control: the manager's identical request is not refused by authorization (it reaches WebDesk's mint or the public-url config 503)
    const mg = await siteGate(manager(), "webdesk_media_asset", "upload");
    await expect(media.mintUploadToken(mg, site, { bucket: "media" }, "idem-media-000002")).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it("mediaCapabilities without a site (a client gate, the existing callers) asks exactly what it asked before", async () => {
    await mediaCapabilities({ principal: manager(), tenantId: T } as never);
    expect(h.batches.at(-1)!.resource).toEqual({ kind: "webdesk_media_asset", tenantId: T, module: "webdev" });
  });
});

// ═══════════════════════════════════════ structure ════════════════════════════════════════════════════
describe("structure: the compile-time pattern and the controller's first statement", () => {
  it("an ItemGate cannot be built without a WebDesk read: the factories demand a brand this module does not export", () => {
    const forged = { collectionKey: "post", locale: "en", ownerId: WRITER, reviewState: "draft", published: false };
    // @ts-expect-error — a hand-built object is not an ItemAttrs (no brand): a write cannot be reached without the WebDesk read
    const viaForged = () => ItemGate.forItem(undefined as never, site, GAIADA_SITE, "x", "update", forged);
    // @ts-expect-error — the constructor is private
    const viaNew = () => new ItemGate(undefined as never, site, "update", "x", "post", "en", null);
    void [viaForged, viaNew]; // never called: the point is that this file only compiles with the two errors above
    expect(typeof ItemGate.forItem).toBe("function");
  });

  it("every handler of the content controller opens with authorizeSite(...) (authorizeSites for GET sites), before anything else", () => {
    const src = readFileSync(join(__dirname, "webdesk-content.controller.ts"), "utf8");
    const handlers = [...src.matchAll(/\n  async (\w+)\(([\s\S]*?)\) \{\n([^\n]*)\n/g)].filter((m) => m[1] !== "catch");
    expect(handlers.length).toBeGreaterThanOrEqual(21);
    for (const [, name, , first] of handlers) {
      expect(first, `${name}: first statement`).toMatch(/^\s+const gate = await authorizeSites?\(req\.principal, tenantId/);
    }
    expect(src).not.toMatch(/authorizeContent\(/);
  });
});

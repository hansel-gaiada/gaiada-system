// M5-W4 — the writers' room BRIEFS: content briefs drawn from `search`, linked to a WebDesk draft
// (docs/plans/2026-10-11-m5-writers-room-design.md §5 W4 row; FRONTEND-BFF-CONTRACT §27 "Briefs"; PERMISSION-CONTRACT §27.4).
//
// ── THE DECISION: NO NEW CERBOS KIND (option b of the ticket) ────────────────────────────────────
// A brief is a row of the existing `search_content_briefs` (0046 + the 202610122300 link columns). Who may do what is
// decided on the WebDesk ITEM and the brief's own (site, collection, locale), through the EXISTING
// `webdesk_content_item` policy; nothing in cerbos/policies, the catalog, the groups, the bundles or the pinned counts moves:
//
//   MANAGE a brief (create, edit, link, "create draft from brief", see every brief of a collection)
//        = `webdesk_content_item:assign` on {site, collectionKey, locale} of the BRIEF. Holders: the scoped editor (in scope),
//          webdev_manager, company_admin/owner, platform_admin. NOT the writer, translator or SEO reviewer, and not the
//          unscoped webdev_staff tier (staff keep the `search` routes for property briefs; they can still READ a linked brief).
//   READ a linked brief = `webdesk_content_item:comment` on the linked ITEM, with the item's `ownerId`, `reviewState` and
//          `collectionKey` / `locale` read from WebDesk (the two-phase gate), never from the brief row or the request.
//          `comment` is the action whose policy rules are "own items" for a writer or translator, "in scope" for an SEO
//          reviewer and an editor, and every item for the staff tiers: exactly the audience the design gives a brief
//          ("an assigned writer reads the brief"; a writer reads ONLY the briefs of items assigned to them). A writer
//          never gets `assign`, so an unlinked brief, or a brief of an item that is someone else's, is a 403.
//
// Why not a `webdesk_brief` kind (option a)? The access rules above are all expressible with the six actions W1a already
// shipped, and a new kind is six artifacts (policy, catalog, groups, seed migration, both bundle resolvers,
// scope-constrained-roles.json, four pinned counts) whose only gain would be a name. The cost of (b) is that "may read a
// brief" borrows `comment`; PERMISSION-CONTRACT §27.4 records that and the day it stops being true (a brief that
// outlives its item, or a reader who must not comment) is the day to promote it to its own kind.
//
// NEVER WIDENS `search`: the property link is optional and only accepted from a caller who ALSO holds
// `resource_search_property:read` on it; `fromBriefId` (copy a SEO brief) needs the same read on that brief's property. A writers' room
// principal reaches no search row except through a brief that an editor with search access copied for it.
//
// ── THE TWO-PHASE GATE (as webdesk-content.service.ts) ───────────────────────────────────────────
// 1. the controller's first statement: `authorizeSite` (phase 1: `webdesk_collection:read` on the route's site);
// 2. here, BEFORE any body or query is validated: the cross-company wall (`gate.resolveSite`), the brief is loaded for
//    THIS site (a brief of another site or company is a uniform 404), then the real Cerbos question with attributes from
//    the BRIEF's own link or from a WebDesk read of the item. A denied caller is 403 whatever it sent.
//
// ── LINK INTEGRITY ───────────────────────────────────────────────────────────────────────────────
// A writer's read of a brief needs BOTH halves of the link to agree: the brief row names the item (`webdesk_item_id`) and
// WebDesk's `editorial.briefRef` names the brief. The ERP writes the first, WebDesk's `editorial.assign` writes the
// second; either half missing (a cleared `briefRef`, a partial failure) means a non-manager reads 404, never the brief.
// Anyone able to set `briefRef` to an arbitrary id through the generic assign route therefore links nothing: the ERP side
// is written only by the brief routes below, after the brief's scope is shown to match the item's.
//
// ORDER of "create draft from brief": create the item (WebDesk, Idempotency-Key) -> `editorial.assign` {briefRef, ...}
// (derived key) -> link the row. A retry under the SAME Idempotency-Key replays the create and the assign and completes
// the link, so a failure between the steps converges; nothing is ever rolled back in WebDesk.
//
// Brief WRITES are ERP-database writes (low impact: nothing a production key sees changes). Audit rows name ids only,
// never a topic, a query or a body. A notification names ids and the brief's title only.
import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { config } from "../../config";
import { notifyBestEffort } from "../../core/client-notify";
import { authorize, writeActivity } from "../../core/http";
import {
  ItemGate,
  UUID_RE,
  WebdeskProblem,
  authorizeSite,
  invalidRequest,
  isPlainObject,
  mapPool,
  probeAllowed,
  strictBody,
  strictQuery,
  webdeskContent,
  webdeskZoneB,
  type ContentGate,
  type SiteRef,
  type WebdeskContentService,
  type WebdeskZoneB,
} from "./webdesk-content.service";
import { webdeskEditorial, type WebdeskEditorialService } from "./webdesk-editorial.service";
import {
  getBrief,
  getBriefByItem,
  getSearchBrief,
  insertBrief,
  linkBrief,
  listBriefs,
  searchPropertyExists,
  updateBrief,
  type BriefPatch,
  type BriefRecord,
} from "./webdesk-brief-store";

const logger = new Logger("WebdeskBriefs");

export const TOPIC_MAX = 300;
export const QUERY_MAX = 300;
export const FACT_MAX = 300;
export const FACT_LIST_MAX = 50;
export const OUTLINE_ITEM_MAX = 200;
export const BODY_MAX = 20_000;
export const NOTES_MAX = 4_000;
const SLUG_MAX = 2048;
const LIST_DEFAULT = 50;
const LIST_MAX = 100;
const PROBE_CONCURRENCY = 8;
const INTENTS = ["informational", "commercial", "transactional", "navigational"] as const;
const STATUSES = ["draft", "approved"] as const;

// ── body parsers (pure) ──────────────────────────────────────────────────────────────────────────

function text(b: Record<string, unknown>, key: string, max: number, required: boolean): string | undefined {
  const v = b[key];
  if (v === undefined) {
    if (required) throw invalidRequest(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max) throw invalidRequest(`${key} must be a non-empty string of at most ${max} characters`);
  return v.trim();
}

/** `null` clears (only where the caller allows it); otherwise `text`. */
function nullableText(b: Record<string, unknown>, key: string, max: number): string | null | undefined {
  if (b[key] === null) return null;
  return text(b, key, max, false);
}

function stringList(b: Record<string, unknown>, key: string, maxItems: number, maxLen: number): string[] | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > maxItems) throw invalidRequest(`${key} must be an array of at most ${maxItems} strings`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || x.trim().length === 0 || x.length > maxLen) throw invalidRequest(`every ${key} entry must be a non-empty string of at most ${maxLen} characters`);
    out.push(x.trim());
  }
  return out;
}

function intentOf(b: Record<string, unknown>): string | null | undefined {
  const v = b.searchIntent;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || !(INTENTS as readonly string[]).includes(v)) throw invalidRequest(`searchIntent must be one of ${INTENTS.join(", ")} (or null)`);
  return v;
}

function uuidOf(b: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = b[key];
  if (v === undefined) {
    if (required) throw invalidRequest(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || !UUID_RE.test(v)) throw invalidRequest(`${key} must be a uuid`);
  return v.toLowerCase();
}

function isoOrNull(b: Record<string, unknown>, key: string): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || v.length === 0 || v.length > 64) throw invalidRequest(`${key} must be an ISO-8601 date or date-time string, or null to clear it`);
  return v;
}

export interface CreateBriefInput {
  collectionKey: string;
  locale: string;
  topic?: string;
  targetQuery?: string;
  searchIntent?: string | null;
  aiQuestions?: string[];
  contentGaps?: string[];
  outline?: string[];
  body?: string;
  geoNotes?: string;
  propertyId?: string;
  fromBriefId?: string;
}

export function parseCreate(raw: unknown): CreateBriefInput {
  const b = strictBody(raw, ["collectionKey", "locale", "topic", "targetQuery", "searchIntent", "aiQuestions", "contentGaps", "outline", "body", "geoNotes", "propertyId", "fromBriefId"]);
  const out: CreateBriefInput = {
    collectionKey: text(b, "collectionKey", 200, true) as string,
    locale: text(b, "locale", 35, true) as string,
  };
  const set = <K extends keyof CreateBriefInput>(k: K, v: CreateBriefInput[K] | undefined): void => {
    if (v !== undefined) out[k] = v;
  };
  set("topic", text(b, "topic", TOPIC_MAX, false));
  set("targetQuery", text(b, "targetQuery", QUERY_MAX, false));
  set("searchIntent", intentOf(b));
  set("aiQuestions", stringList(b, "aiQuestions", FACT_LIST_MAX, FACT_MAX));
  set("contentGaps", stringList(b, "contentGaps", FACT_LIST_MAX, FACT_MAX));
  set("outline", stringList(b, "outline", FACT_LIST_MAX, OUTLINE_ITEM_MAX));
  set("body", text(b, "body", BODY_MAX, false));
  set("geoNotes", text(b, "geoNotes", NOTES_MAX, false));
  set("propertyId", uuidOf(b, "propertyId", false));
  set("fromBriefId", uuidOf(b, "fromBriefId", false));
  if (out.topic === undefined && out.fromBriefId === undefined) throw invalidRequest("topic is required (or fromBriefId, to copy a search brief)");
  return out;
}

export function parsePatch(raw: unknown): BriefPatch {
  const b = strictBody(raw, ["topic", "status", "outline", "body", "geoNotes", "targetQuery", "searchIntent", "aiQuestions", "contentGaps"]);
  const out: BriefPatch = {};
  const topic = text(b, "topic", TOPIC_MAX, false);
  if (topic !== undefined) out.topic = topic;
  if (b.status !== undefined) {
    if (typeof b.status !== "string" || !(STATUSES as readonly string[]).includes(b.status)) throw invalidRequest(`status must be one of ${STATUSES.join(", ")}`);
    out.status = b.status as BriefPatch["status"];
  }
  const outline = stringList(b, "outline", FACT_LIST_MAX, OUTLINE_ITEM_MAX);
  if (outline !== undefined) out.outline = outline;
  if (b.body !== undefined) {
    if (typeof b.body !== "string" || b.body.length > BODY_MAX) throw invalidRequest(`body must be a string of at most ${BODY_MAX} characters`);
    out.body = b.body;
  }
  const geo = nullableText(b, "geoNotes", NOTES_MAX);
  if (geo !== undefined) out.geoNotes = geo;
  const tq = nullableText(b, "targetQuery", QUERY_MAX);
  if (tq !== undefined) out.targetQuery = tq;
  const intent = intentOf(b);
  if (intent !== undefined) out.searchIntent = intent;
  const qs = stringList(b, "aiQuestions", FACT_LIST_MAX, FACT_MAX);
  if (qs !== undefined) out.aiQuestions = qs;
  const gaps = stringList(b, "contentGaps", FACT_LIST_MAX, FACT_MAX);
  if (gaps !== undefined) out.contentGaps = gaps;
  if (Object.keys(out).length === 0) throw invalidRequest("nothing to update");
  return out;
}

interface AssignFields {
  authorSub?: string;
  dueAt?: string | null;
  plannedPublishAt?: string | null;
}

function assignFieldsOf(b: Record<string, unknown>): AssignFields {
  const out: AssignFields = {};
  const author = uuidOf(b, "authorSub", false);
  if (author !== undefined) out.authorSub = author;
  const due = isoOrNull(b, "dueAt");
  if (due !== undefined) out.dueAt = due;
  const planned = isoOrNull(b, "plannedPublishAt");
  if (planned !== undefined) out.plannedPublishAt = planned;
  return out;
}

export function parseAssign(raw: unknown): { itemId: string } & AssignFields {
  const b = strictBody(raw, ["itemId", "authorSub", "dueAt", "plannedPublishAt"]);
  return { itemId: uuidOf(b, "itemId", true) as string, ...assignFieldsOf(b) };
}

export interface CreateDraftInput extends AssignFields {
  slug: string;
  fields?: Record<string, unknown>;
  blocks?: unknown[];
  seo?: Record<string, unknown>;
  note?: string;
}

export function parseCreateDraft(raw: unknown): CreateDraftInput {
  const b = strictBody(raw, ["slug", "fields", "blocks", "seo", "note", "authorSub", "dueAt", "plannedPublishAt"]);
  const out: CreateDraftInput = { slug: text(b, "slug", SLUG_MAX, true) as string, ...assignFieldsOf(b) };
  // The content body is WebDesk's to validate against the collection's composition; here only the shape is bounded.
  if (b.fields !== undefined) {
    if (!isPlainObject(b.fields)) throw invalidRequest("fields must be an object");
    out.fields = b.fields;
  }
  if (b.blocks !== undefined) {
    if (!Array.isArray(b.blocks)) throw invalidRequest("blocks must be an array");
    out.blocks = b.blocks;
  }
  if (b.seo !== undefined) {
    if (!isPlainObject(b.seo)) throw invalidRequest("seo must be an object");
    out.seo = b.seo;
  }
  if (b.note !== undefined) {
    if (typeof b.note !== "string" || b.note.length > 500) throw invalidRequest("note must be a string of at most 500 characters");
    out.note = b.note;
  }
  return out;
}

const LIST_QUERY = ["collectionKey", "locale", "status", "linked", "cursor", "limit"] as const;

export interface ListQuery {
  collectionKey?: string;
  locale?: string;
  status?: "draft" | "approved";
  linked?: boolean;
  cursor?: { ts: string; id: string };
  limit: number;
}

export function parseListQuery(raw: unknown): ListQuery {
  const q = strictQuery(raw, LIST_QUERY);
  const out: ListQuery = { limit: LIST_DEFAULT };
  if (q.collectionKey !== undefined) {
    if (q.collectionKey.length === 0 || q.collectionKey.length > 200) throw invalidRequest("collectionKey must be 1..200 characters");
    out.collectionKey = q.collectionKey;
  }
  if (q.locale !== undefined) {
    if (q.locale.length === 0 || q.locale.length > 35) throw invalidRequest("locale must be 1..35 characters");
    out.locale = q.locale;
  }
  if (q.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(q.status)) throw invalidRequest(`status must be one of ${STATUSES.join(", ")}`);
    out.status = q.status as "draft" | "approved";
  }
  if (q.linked !== undefined) {
    if (q.linked !== "true" && q.linked !== "false") throw invalidRequest("linked must be true or false");
    out.linked = q.linked === "true";
  }
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > LIST_MAX) throw invalidRequest(`limit must be an integer 1..${LIST_MAX}`);
    out.limit = n;
  }
  if (q.cursor !== undefined) out.cursor = decodeCursor(q.cursor);
  return out;
}

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`).toString("base64url");
}

function decodeCursor(raw: string): { ts: string; id: string } {
  let decoded = "";
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw invalidRequest("cursor is not valid");
  }
  const [ts, id, ...rest] = decoded.split("|");
  if (rest.length > 0 || !ts || !id || !UUID_RE.test(id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(ts)) throw invalidRequest("cursor is not valid");
  return { ts, id: id.toLowerCase() };
}

// ── views ────────────────────────────────────────────────────────────────────────────────────────

/** The writer's view: what a brief SAYS. The manager's view adds where it came from and how it was drafted. */
export function briefView(b: BriefRecord, manager: boolean): Record<string, unknown> {
  return {
    id: b.id,
    status: b.status,
    topic: b.topic,
    targetQuery: b.targetQuery,
    searchIntent: b.searchIntent,
    aiQuestions: b.aiQuestions,
    contentGaps: b.contentGaps,
    outline: b.outline,
    body: b.body,
    geoNotes: b.geoNotes,
    collectionKey: b.collectionKey,
    locale: b.locale,
    siteId: b.webdeskSiteId,
    tenantSlug: b.webdeskTenantSlug,
    itemId: b.webdeskItemId,
    linkedAt: b.linkedAt,
    assigneeId: b.assigneeId,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    ...(manager ? { provenance: { propertyId: b.propertyId, sourceBriefId: b.sourceBriefId, createdBy: b.createdBy } } : {}),
  };
}

/** The board row: no body, no outline. */
export function briefSummary(b: BriefRecord, manager: boolean): Record<string, unknown> {
  return {
    id: b.id,
    status: b.status,
    topic: b.topic,
    targetQuery: b.targetQuery,
    searchIntent: b.searchIntent,
    collectionKey: b.collectionKey,
    locale: b.locale,
    itemId: b.webdeskItemId,
    assigneeId: b.assigneeId,
    linkedAt: b.linkedAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    canManage: manager,
  };
}

function derivedKey(idem: string, label: string): string {
  return `brief-${label}-${createHash("sha256").update(`${idem}\u0000${label}`).digest("hex").slice(0, 48)}`;
}

function notFound(): NotFoundException {
  return new NotFoundException("brief not found");
}

// ── the service ──────────────────────────────────────────────────────────────────────────────────

export class WebdeskBriefsService {
  constructor(
    private readonly zoneB: WebdeskZoneB = webdeskZoneB,
    private readonly content: WebdeskContentService = webdeskContent,
    private readonly editorial: WebdeskEditorialService = webdeskEditorial,
  ) {}

  /** Cerbos `assign` on the brief's own (site, collection, locale): the right to manage briefs of that collection. */
  private manageResource(gate: ContentGate, siteId: string, b: { collectionKey: string | null; locale: string | null }) {
    return ItemGate.resourceOf(gate, siteId, null, { collectionKey: b.collectionKey ?? "", locale: b.locale ?? "" });
  }

  private async loadForSite(gate: ContentGate, siteId: string, briefId: string): Promise<BriefRecord> {
    if (!UUID_RE.test(briefId)) throw notFound();
    const brief = await getBrief(gate.tenantId, siteId, briefId.toLowerCase());
    if (!brief) throw notFound();
    return brief;
  }

  private async audit(gate: ContentGate, verb: string, brief: BriefRecord, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      await writeActivity(gate.tenantId, gate.principal.userId ?? null, verb, "search_content_brief", brief.id, {
        siteId: brief.webdeskSiteId, collectionKey: brief.collectionKey, locale: brief.locale, ...extra,
      });
    } catch (err) {
      logger.warn(`brief audit (${verb}) failed: ${(err as Error)?.message ?? "error"}`);
    }
  }

  /** Tell the assignee (ids and the brief's title only). Fail-soft; never on a no-change. */
  private async notifyAssigned(gate: ContentGate, site: SiteRef, brief: BriefRecord, assigneeId: string | undefined, itemId: string): Promise<void> {
    if (assigneeId === undefined || assigneeId === brief.assigneeId) return;
    try {
      await notifyBestEffort(gate.tenantId, gate.principal.userId ?? null, [assigneeId], "webdesk.brief.assigned", {
        title: `Brief assigned: ${brief.topic.slice(0, 120)}`,
        entityType: "search_content_brief",
        entityId: brief.id,
        tenantSlug: site.tenantSlug,
        siteId: site.siteId,
        collectionKey: brief.collectionKey,
        locale: brief.locale,
        itemId,
      });
    } catch (err) {
      logger.warn(`brief notification failed: ${(err as Error)?.message ?? "error"}`);
    }
  }

  // ── create ─────────────────────────────────────────────────────────────────────────────────────

  /** `POST …/briefs`. Gate: `webdesk_content_item:assign`. */
  async create(gate: ContentGate, site: SiteRef, rawBody: unknown): Promise<Record<string, unknown>> {
    gate.require("webdesk_content_item", "assign");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    // PHASE 2, before the body is validated: the collection and locale the body NAMES are what the caller asks to manage
    // briefs for; a scoped editor passes only inside its scope. (Read leniently; a non-object reads "" and denies.)
    const raw = isPlainObject(rawBody) ? rawBody : {};
    await authorize(
      gate.principal,
      ItemGate.resourceOf(gate, siteId, null, {
        collectionKey: typeof raw.collectionKey === "string" ? raw.collectionKey : "",
        locale: typeof raw.locale === "string" ? raw.locale : "",
      }),
      "assign",
    );
    const input = parseCreate(rawBody);
    await this.content.assertCollectionExists(site, input.collectionKey); // a typed 404 `collection-not-found` passes through
    if (!editable.tenant.locales.includes(input.locale)) throw invalidRequest("locale is not one of the tenant's declared locales");

    // The search link. NEVER a widening: whatever search data this reads, the caller must hold `read` on its property.
    let propertyId: string | null = null;
    let source: BriefRecord | null = null;
    if (input.fromBriefId !== undefined) {
      source = await getSearchBrief(gate.tenantId, input.fromBriefId);
      if (!source || !source.propertyId) throw new NotFoundException("search brief not found");
      propertyId = source.propertyId;
      if (input.propertyId !== undefined && input.propertyId !== propertyId) throw invalidRequest("propertyId does not match the property of fromBriefId");
    } else if (input.propertyId !== undefined) {
      if (!(await searchPropertyExists(gate.tenantId, input.propertyId))) throw new NotFoundException("property not found");
      propertyId = input.propertyId;
    }
    if (propertyId !== null) {
      await authorize(gate.principal, { kind: "resource_search_property", id: propertyId, tenantId: gate.tenantId, module: "search" }, "read");
    }

    // parseCreate guarantees a topic or a fromBriefId, and a fromBriefId resolved to `source` above.
    const topic = input.topic ?? (source as BriefRecord).topic;
    const brief = await insertBrief({
      tenantId: gate.tenantId,
      webdeskTenantSlug: site.tenantSlug,
      webdeskSiteId: siteId,
      collectionKey: input.collectionKey,
      locale: input.locale,
      topic,
      outline: input.outline ?? source?.outline ?? [],
      body: input.body ?? source?.body ?? "",
      geoNotes: input.geoNotes ?? source?.geoNotes ?? null,
      targetQuery: input.targetQuery ?? null,
      searchIntent: input.searchIntent ?? null,
      aiQuestions: input.aiQuestions ?? [],
      contentGaps: input.contentGaps ?? [],
      propertyId,
      sourceBriefId: source ? source.id : null,
      grounding: source && isPlainObject(source.grounding) ? source.grounding : {},
      createdBy: gate.principal.userId ?? null,
      originSite: config.originSite,
    });
    await this.audit(gate, "created", brief, { fromSearchBrief: source !== null });
    return briefView(brief, true);
  }

  // ── edit ───────────────────────────────────────────────────────────────────────────────────────

  /** `PATCH …/briefs/:briefId`. Gate: `assign`. */
  async update(gate: ContentGate, site: SiteRef, briefId: string, rawBody: unknown): Promise<Record<string, unknown>> {
    gate.require("webdesk_content_item", "assign");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    const brief = await this.loadForSite(gate, siteId, briefId);
    await authorize(gate.principal, this.manageResource(gate, siteId, brief), "assign"); // PHASE 2
    const patch = parsePatch(rawBody);
    const updated = await updateBrief(gate.tenantId, siteId, brief.id, patch);
    if (!updated) throw notFound();
    await this.audit(gate, "updated", updated, { fields: Object.keys(patch) });
    return briefView(updated, true);
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────

  /** `GET …/briefs/:briefId`. A manager reads any brief of a collection it manages; anyone else only through the linked item. */
  async get(gate: ContentGate, site: SiteRef, briefId: string): Promise<Record<string, unknown>> {
    gate.require("webdesk_content_item", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    const brief = await this.loadForSite(gate, siteId, briefId); // another site's or company's brief: 404, before any question
    const resource = this.manageResource(gate, siteId, brief);
    if (await probeAllowed(gate.principal, resource, "assign")) return briefView(brief, true);
    if (!brief.webdeskItemId) {
      await authorize(gate.principal, resource, "assign"); // denies (and records the denial): an unlinked brief is for managers
      throw notFound(); // unreachable: authorize threw
    }
    const itemGate = await this.content.openEditorialItem(gate, site, brief.webdeskItemId, "comment"); // PHASE 2 on the ITEM
    if ((itemGate.attrs?.briefRef ?? null) !== brief.id) throw notFound(); // WebDesk does not confirm the link
    return briefView(brief, false);
  }

  /** `GET …/items/:itemId/brief`: the brief of one item (the writer's path). */
  async forItem(gate: ContentGate, site: SiteRef, itemId: string): Promise<Record<string, unknown>> {
    gate.require("webdesk_content_item", "read");
    const itemGate = await this.content.openEditorialItem(gate, site, itemId, "comment"); // wall + item.get + Cerbos, PHASE 2
    const siteId = (await gate.resolveSite(this.zoneB, site)).site.siteId;
    if (!UUID_RE.test(itemId)) throw new NotFoundException("this item has no brief");
    const brief = await getBriefByItem(gate.tenantId, siteId, itemId.toLowerCase());
    if (!brief) throw new NotFoundException("this item has no brief");
    if ((itemGate.attrs?.briefRef ?? null) !== brief.id) throw new NotFoundException("this item has no brief");
    const manager = await probeAllowed(gate.principal, this.manageResource(gate, siteId, brief), "assign");
    return briefView(brief, manager);
  }

  /**
   * `GET …/briefs`: the writers' board. Every row passes Cerbos before it is returned:
   *   - a MANAGER of the row's (collection, locale) (`assign`, asked once per distinct pair) sees it;
   *   - anyone else sees it only when it is linked to an item and `comment` is allowed on that item with the author,
   *     state and brief reference WebDesk reports NOW (one `item.get` per candidate, ceiling 8 at once; the stored
   *     assignee only narrows the candidates, it never grants anything).
   * A WebDesk failure is the ordinary 5xx, never a quietly shorter list. A page may hold fewer rows than `limit`.
   */
  async list(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<Record<string, unknown>> {
    gate.require("webdesk_content_item", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    const q = parseListQuery(rawQuery);
    const page = await listBriefs(gate.tenantId, siteId, q);

    const pairs = new Map<string, { collectionKey: string; locale: string }>();
    for (const r of page.rows) pairs.set(`${r.collectionKey}\u0000${r.locale}`, { collectionKey: r.collectionKey ?? "", locale: r.locale ?? "" });
    const verdicts = await mapPool([...pairs.entries()], PROBE_CONCURRENCY, async ([k, p]) => ({ k, ok: await probeAllowed(gate.principal, this.manageResource(gate, siteId, p), "assign") }));
    const manages = new Set(verdicts.filter((v) => v.ok).map((v) => v.k));

    const decided = await mapPool(page.rows, PROBE_CONCURRENCY, async (row) => {
      const manager = manages.has(`${row.collectionKey}\u0000${row.locale}`);
      if (manager) return { row, visible: true, manager };
      if (!row.webdeskItemId) return { row, visible: false, manager };
      // Narrow first with the stored assignee as the owner (a writer who is not the assignee stops here, no egress)...
      const narrow = await probeAllowed(
        gate.principal,
        ItemGate.resourceOf(gate, siteId, row.webdeskItemId, { collectionKey: row.collectionKey ?? "", locale: row.locale ?? "", ownerId: row.assigneeId ?? "" }),
        "comment",
      );
      if (!narrow) return { row, visible: false, manager };
      // ...then decide on WebDesk's own facts.
      let facts: Awaited<ReturnType<WebdeskContentService["itemFacts"]>>;
      try {
        facts = await this.content.itemFacts(site, row.webdeskItemId);
      } catch (err) {
        if (err instanceof WebdeskProblem && err.getStatus() === 404) return { row, visible: false, manager }; // the item is gone
        throw err;
      }
      const ok = facts.briefRef === row.id
        && (await probeAllowed(
          gate.principal,
          ItemGate.resourceOf(gate, siteId, row.webdeskItemId, {
            collectionKey: facts.collectionKey, locale: facts.locale, ownerId: facts.ownerId, reviewState: facts.reviewState, published: facts.published,
          }),
          "comment",
        ));
      return { row, visible: ok, manager };
    });

    const rows = decided.filter((d) => d.visible);
    const last = page.rows[page.rows.length - 1];
    return {
      briefs: rows.map((d) => briefSummary(d.row, d.manager)),
      page: { limit: q.limit, hasMore: page.hasMore, cursor: page.hasMore && last ? encodeCursor(last.cursorTs, last.id) : null },
    };
  }

  // ── link: assign a brief to an existing item ─────────────────────────────────────────────────────

  /** `POST …/briefs/:briefId/assign`. Gate: `assign`. Links the brief to an existing item of the same collection and locale. */
  async assign(gate: ContentGate, site: SiteRef, briefId: string, rawBody: unknown, idempotencyKey: string): Promise<Record<string, unknown>> {
    gate.require("webdesk_content_item", "assign");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    const brief = await this.loadForSite(gate, siteId, briefId);
    await authorize(gate.principal, this.manageResource(gate, siteId, brief), "assign"); // PHASE 2 (the brief's scope)
    const input = parseAssign(rawBody);
    // PHASE 2 on the ITEM: `assign` with the author and state WebDesk reports. Only now may the item's collection be compared.
    const itemGate = await this.content.openEditorialItem(gate, site, input.itemId, "assign");
    if (itemGate.collectionKey !== brief.collectionKey || itemGate.locale !== brief.locale) {
      throw new ConflictException("brief_item_mismatch: the item is not in the brief's collection and locale");
    }
    const holder = await getBriefByItem(gate.tenantId, siteId, input.itemId);
    if ((brief.webdeskItemId !== null && brief.webdeskItemId.toLowerCase() !== input.itemId) || (holder && holder.id !== brief.id)) {
      throw new ConflictException(holder && holder.id !== brief.id ? "item_has_another_brief" : "brief_already_linked");
    }
    const result = await this.editorial.itemCommand(
      gate, site, input.itemId, "assign",
      { briefRef: brief.id, ...(input.authorSub !== undefined ? { authorSub: input.authorSub } : {}), ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}), ...(input.plannedPublishAt !== undefined ? { plannedPublishAt: input.plannedPublishAt } : {}) },
      idempotencyKey,
    );
    const outcome = await linkBrief(gate.tenantId, siteId, brief.id, input.itemId, input.authorSub);
    if (outcome !== "linked" && outcome !== "already-linked-here") throw new ConflictException(outcome === "not-found" ? "brief not found" : "brief_already_linked");
    await this.audit(gate, "linked", brief, { itemId: input.itemId, assigned: input.authorSub !== undefined });
    await this.notifyAssigned(gate, site, brief, input.authorSub, input.itemId);
    const fresh = (await getBrief(gate.tenantId, siteId, brief.id)) ?? brief;
    return { brief: briefView(fresh, true), assign: result.body };
  }

  // ── create a WebDesk draft from a brief ──────────────────────────────────────────────────────────

  /**
   * `POST …/briefs/:briefId/create-draft`. Gate: `assign`; the content create then runs its OWN two-phase `create` gate for the
   * brief's collection and locale (the caller must hold both). The item's locale and collection come from the BRIEF, never the body.
   * The item exists once WebDesk answers 201; the brief link and `briefRef` follow (see the header: a retry under the same
   * Idempotency-Key converges).
   */
  async createDraft(gate: ContentGate, site: SiteRef, briefId: string, rawBody: unknown, idempotencyKey: string): Promise<Record<string, unknown>> {
    gate.require("webdesk_content_item", "assign");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    const brief = await this.loadForSite(gate, siteId, briefId);
    await authorize(gate.principal, this.manageResource(gate, siteId, brief), "assign"); // PHASE 2
    const input = parseCreateDraft(rawBody);
    if (brief.webdeskItemId) throw new ConflictException("brief_already_linked");

    const createGate = await authorizeSite(gate.principal, gate.tenantId, siteId, "webdesk_content_item", "create");
    const created = await this.content.createItem(
      createGate, site, brief.collectionKey as string,
      {
        locale: brief.locale,
        slug: input.slug,
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        ...(input.blocks !== undefined ? { blocks: input.blocks } : {}),
        ...(input.seo !== undefined ? { seo: input.seo } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      idempotencyKey,
    );
    const createdItem = isPlainObject(created.body) && isPlainObject(created.body.item) ? created.body.item : null;
    const itemId = createdItem && typeof createdItem.itemId === "string" && UUID_RE.test(createdItem.itemId) ? createdItem.itemId.toLowerCase() : null;
    if (itemId === null) throw new BadRequestException("webdesk answered the create without an item id");

    const assignGate = await authorizeSite(gate.principal, gate.tenantId, siteId, "webdesk_content_item", "assign");
    await this.editorial.itemCommand(
      assignGate, site, itemId, "assign",
      { briefRef: brief.id, ...(input.authorSub !== undefined ? { authorSub: input.authorSub } : {}), ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}), ...(input.plannedPublishAt !== undefined ? { plannedPublishAt: input.plannedPublishAt } : {}) },
      derivedKey(idempotencyKey, "assign"),
    );
    const outcome = await linkBrief(gate.tenantId, siteId, brief.id, itemId, input.authorSub);
    if (outcome !== "linked" && outcome !== "already-linked-here") {
      throw new ConflictException(`brief_link_failed: the draft ${itemId} was created but the brief is ${outcome}`);
    }
    await this.audit(gate, "draft_created", brief, { itemId, assigned: input.authorSub !== undefined });
    await this.notifyAssigned(gate, site, brief, input.authorSub, itemId);
    const fresh = (await getBrief(gate.tenantId, siteId, brief.id)) ?? brief;
    return { brief: briefView(fresh, true), item: createdItem, version: isPlainObject(created.body) ? created.body.version : undefined, replayed: isPlainObject(created.body) ? created.body.replayed === true : false };
  }
}

export const webdeskBriefs = new WebdeskBriefsService();

// WSK-51 — the content editor's live read routes (write-plane design §4), Zone B control plane:
//
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/collections                              collection.list
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key                         collection.get
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key/items                   item.list
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId                    item.get
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/versions           item.versions
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/versions/:n        item.versionGet
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/media                                    media.list
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/media/:assetId/usage                     media.usage (WSK-43a)
//
// Guards: ControlAuthGuard (L1 mTLS + L2 token) -> CommandAuthorizationGuard (L3 `webdesk:read`). There
// is deliberately NO EditorialAssertionGuard: a read needs no editorial principal (design §4), so the
// ERP can read for a user whose assertion it has not minted, and nothing here can write. No audit row
// is written (see content-reads.service.ts).
//
// Query validation is strict (400 invalid-request, RFC 9457): an unknown query key, a bad enum, an
// out-of-range limit or a malformed cursor is refused rather than ignored, because a silently
// ignored `?includeDelete=true` would read as "there are no deleted items", and the editor treats an
// empty list as a claim.
import { Controller, Get, Param, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { ControlProblemFilter, problems } from "./content-problem";
import { REVIEW_STATES, type ReviewState } from "../editorial/editorial-model";
import { ContentReadsService, ITEM_STATES, type ItemListQuery, type ItemListState } from "./content-reads.service";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_CHARS = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,126})$/i;

type RawQuery = Record<string, unknown>;

/** Strict query reading: only the allowed keys, each a single string. */
function query(raw: RawQuery | undefined, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!allowed.includes(k)) throw problems.invalidRequest(`unknown query parameter "${k}" (allowed: ${allowed.join(", ") || "none"})`);
    if (typeof v !== "string") throw problems.invalidRequest(`query parameter "${k}" must be given once, as a string`);
    out[k] = v;
  }
  return out;
}

function limitOf(v: string | undefined): number {
  if (v === undefined) return DEFAULT_PAGE_LIMIT;
  if (!/^\d{1,4}$/.test(v) || Number(v) < 1 || Number(v) > MAX_PAGE_LIMIT) {
    throw problems.invalidRequest(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
  }
  return Number(v);
}

function cursorOf(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v.length === 0 || v.length > MAX_CURSOR_CHARS) throw problems.invalidRequest("cursor is malformed; pass back the `page.cursor` of the previous response unchanged");
  return v;
}

@Controller("control/v1/tenants/:tenantSlug/sites/:siteId")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
@UseFilters(ControlProblemFilter)
export class ContentReadsController {
  constructor(private readonly reads: ContentReadsService) {}

  @Get("collections")
  @Command("collection.list")
  async listCollections(@Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Query() raw: RawQuery) {
    query(raw, []);
    return this.reads.listCollections(tenantSlug, siteId);
  }

  @Get("collections/:key")
  @Command("collection.get")
  async getCollection(
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("key") key: string,
    @Query() raw: RawQuery,
  ) {
    query(raw, []);
    return this.reads.getCollection(tenantSlug, siteId, key);
  }

  @Get("collections/:key/items")
  @Command("item.list")
  async listItems(
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("key") key: string,
    @Query() raw: RawQuery,
  ) {
    const q = query(raw, ["locale", "state", "reviewState", "q", "includeDeleted", "cursor", "limit"]);
    if (q.state !== undefined && !(ITEM_STATES as readonly string[]).includes(q.state)) {
      throw problems.invalidRequest(`state must be one of ${ITEM_STATES.join(", ")}`);
    }
    if (q.reviewState !== undefined && !(REVIEW_STATES as readonly string[]).includes(q.reviewState)) {
      throw problems.invalidRequest(`reviewState must be one of ${REVIEW_STATES.join(", ")}`);
    }
    if (q.locale !== undefined && (q.locale.length === 0 || q.locale.length > 35)) {
      throw problems.invalidRequest("locale must be a non-empty string of at most 35 characters");
    }
    if (q.q !== undefined && (q.q.length === 0 || q.q.length > 200)) {
      throw problems.invalidRequest("q must be a non-empty string of at most 200 characters");
    }
    if (q.includeDeleted !== undefined && q.includeDeleted !== "true" && q.includeDeleted !== "false") {
      throw problems.invalidRequest("includeDeleted must be true or false");
    }
    const input: ItemListQuery = {
      locale: q.locale,
      state: q.state as ItemListState | undefined,
      reviewState: q.reviewState as ReviewState | undefined,
      q: q.q,
      includeDeleted: q.includeDeleted === "true",
      cursor: cursorOf(q.cursor),
      limit: limitOf(q.limit),
    };
    return this.reads.listItems(tenantSlug, siteId, key, input);
  }

  @Get("content/items/:itemId")
  @Command("item.get")
  async getItem(
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Query() raw: RawQuery,
  ) {
    const q = query(raw, ["version"]);
    let select: "head" | "live" | number = "head";
    if (q.version !== undefined) {
      if (q.version === "head" || q.version === "live") select = q.version;
      else if (/^[1-9]\d{0,8}$/.test(q.version)) select = Number(q.version);
      else throw problems.invalidRequest("version must be head, live or a version number (an integer >= 1)");
    }
    return this.reads.getItem(tenantSlug, siteId, itemId, select);
  }

  @Get("content/items/:itemId/versions")
  @Command("item.versions")
  async listVersions(
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Query() raw: RawQuery,
  ) {
    const q = query(raw, ["cursor", "limit"]);
    return this.reads.listVersions(tenantSlug, siteId, itemId, cursorOf(q.cursor), limitOf(q.limit));
  }

  @Get("content/items/:itemId/versions/:n")
  @Command("item.versionGet")
  async getVersion(
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Param("n") n: string,
    @Query() raw: RawQuery,
  ) {
    query(raw, []);
    if (!/^[1-9]\d{0,8}$/.test(n)) throw problems.invalidRequest("the version in the path must be an integer >= 1");
    return this.reads.getVersion(tenantSlug, siteId, itemId, Number(n));
  }

  @Get("media")
  @Command("media.list")
  async listMedia(@Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Query() raw: RawQuery) {
    const q = query(raw, ["mime", "q", "tag", "includeDeleted", "reviewState", "assetId", "cursor", "limit"]);
    if (q.mime !== undefined && !MIME_RE.test(q.mime)) {
      throw problems.invalidRequest("mime must be a media type (image/png) or a type wildcard (image/*)");
    }
    if (q.q !== undefined && (q.q.length === 0 || q.q.length > 200)) {
      throw problems.invalidRequest("q must be a non-empty string of at most 200 characters");
    }
    if (q.tag !== undefined && (q.tag.trim().length === 0 || q.tag.length > 100)) {
      throw problems.invalidRequest("tag must be a non-empty string of at most 100 characters");
    }
    if (q.includeDeleted !== undefined && q.includeDeleted !== "true" && q.includeDeleted !== "false") {
      throw problems.invalidRequest("includeDeleted must be true or false");
    }
    if (q.assetId !== undefined && !UUID_RE.test(q.assetId)) {
      throw problems.invalidRequest("assetId must be a media asset id (a uuid)");
    }
    if (q.reviewState !== undefined && !["accepted", "quarantined", "rejected", "all"].includes(q.reviewState)) {
      throw problems.invalidRequest("reviewState must be accepted (the default), quarantined, rejected or all");
    }
    return this.reads.listMedia(tenantSlug, siteId, {
      assetId: q.assetId?.toLowerCase(),
      reviewState: (q.reviewState ?? "accepted") as "accepted" | "quarantined" | "rejected" | "all",
      mime: q.mime,
      q: q.q,
      // Tags are stored normalised (trimmed, lower-cased): the filter is spelled the way the library stores them.
      tag: q.tag === undefined ? undefined : q.tag.trim().replace(/\s+/g, " ").toLowerCase(),
      includeDeleted: q.includeDeleted === "true",
      cursor: cursorOf(q.cursor),
      limit: limitOf(q.limit),
    });
  }

  @Get("media/:assetId/usage")
  @Command("media.usage")
  async mediaUsage(
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("assetId") assetId: string,
    @Query() raw: RawQuery,
  ) {
    query(raw, []);
    return this.reads.mediaUsage(tenantSlug, siteId, assetId);
  }
}

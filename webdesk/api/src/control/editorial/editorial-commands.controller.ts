// M5-W2b (writers' room design section 4.3) — the editorial review command routes, Zone B control plane:
//
//   POST /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/editorial/submit            editorial.submit
//   POST .../editorial/withdraw                                                                          editorial.withdraw
//   POST .../editorial/request-changes                                                                   editorial.requestChanges
//   POST .../editorial/seo-signoff                                                                       editorial.seoSignoff
//   POST .../editorial/approve                                                                           editorial.approve
//   POST .../editorial/assign                                                                            editorial.assign
//   POST .../editorial/comments                                                                          editorial.comment
//   POST .../editorial/comments/:commentId/resolve                                                       editorial.commentResolve
//   PUT  /control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key/editorial-policy                 editorial.policySet
//
// Gated exactly like the content writes: ControlAuthGuard (L1 mTLS + L2 token) -> CommandAuthorizationGuard
// (L3 scope: MEDIUM / webdesk:operate) -> EditorialAssertionGuard (L2e; a client editor is refused there with
// 403 client-command-not-allowed, these commands are not on the client allow-list) -> the handler, which
// validates the body SHAPE here and the state in the service. Guards run first, so a refused caller is refused
// whatever its body: validation can never pre-empt authorisation. Every write needs an Idempotency-Key.
import { Body, Controller, Headers, HttpCode, Param, Post, Put, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { EditorialAssertionGuard } from "../auth/editorial-assertion.guard";
import { requireEditorialPrincipal, type EditorialRequest } from "../auth/editorial-principal";
import { Command } from "../command.decorator";
import { ControlProblemFilter, problems } from "../content/content-problem";
import { isPlainObject } from "../content/content-projection";
import { EditorialCommandsService, type AssignInput, type EditorialCommandContext } from "./editorial-commands.service";

/** The command hash merges route params and body; a body carrying one of these would make it ambiguous (design 3.2). */
const RESERVED_BODY_KEYS = ["tenantSlug", "siteId", "itemId", "commentId", "key"] as const;
export const NOTE_MAX = 2000;
export const COMMENT_MAX = 4000;
export const ANCHOR_MAX = 512;
const SUB_MAX = 200;

function objectBody(raw: unknown, allowed: readonly string[], emptyOk: boolean): Record<string, unknown> {
  const b: unknown = (raw === undefined || raw === null) && emptyOk ? {} : raw;
  if (!isPlainObject(b)) throw problems.invalidRequest("the request body must be a JSON object");
  for (const k of RESERVED_BODY_KEYS) {
    if (k in b) throw problems.invalidRequest(`the body may not contain "${k}": it is a route parameter`);
  }
  for (const k of Object.keys(b)) {
    if (!allowed.includes(k)) throw problems.invalidRequest(`unknown body key "${k}" (allowed: ${allowed.join(", ") || "none"})`);
  }
  return b;
}

function versionOf(b: Record<string, unknown>): number {
  const v = b.version;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 2_147_483_647) {
    throw problems.invalidRequest("version is required and must be an integer >= 1");
  }
  return v;
}

function textOf(b: Record<string, unknown>, key: string, max: number, required: boolean): string | undefined {
  const v = b[key];
  if (v === undefined) {
    if (required) throw problems.invalidRequest(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max) throw problems.invalidRequest(`${key} must be a non-empty string of at most ${max} characters`);
  return v;
}

/** An ISO-8601 instant (a date or a date-time), normalised to UTC; null clears. */
function instantOf(b: Record<string, unknown>, key: string): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || v.length > 64 || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw problems.invalidRequest(`${key} must be an ISO-8601 date or date-time, or null to clear it`);
  }
  return new Date(v).toISOString();
}

function idempotencyKey(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 200) {
    throw problems.invalidRequest("the Idempotency-Key header is required (8..200 chars) on every editorial write");
  }
  return raw;
}

@Controller("control/v1/tenants/:tenantSlug/sites/:siteId")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard, EditorialAssertionGuard)
@UseFilters(ControlProblemFilter)
export class EditorialCommandsController {
  constructor(private readonly editorial: EditorialCommandsService) {}

  private async context(req: EditorialRequest, tenantSlug: string, siteId: string, idem: string | undefined): Promise<EditorialCommandContext> {
    const principal = requireEditorialPrincipal(req);
    const key = idempotencyKey(idem);
    const { tenant } = await this.editorial.resolveTenantSite(tenantSlug, siteId);
    return { tenant: { id: tenant.id, slug: tenant.slug }, siteId, principal, idempotencyKey: key };
  }

  @Post("content/items/:itemId/editorial/submit")
  @HttpCode(200)
  @Command("editorial.submit")
  async submit(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    const b = objectBody(raw, ["version"], false);
    const version = versionOf(b);
    return this.editorial.submit(await this.context(req, t, s, idem), itemId, { version });
  }

  @Post("content/items/:itemId/editorial/withdraw")
  @HttpCode(200)
  @Command("editorial.withdraw")
  async withdraw(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    objectBody(raw, [], true);
    return this.editorial.withdraw(await this.context(req, t, s, idem), itemId);
  }

  @Post("content/items/:itemId/editorial/request-changes")
  @HttpCode(200)
  @Command("editorial.requestChanges")
  async requestChanges(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    const b = objectBody(raw, ["version", "note"], false);
    const version = versionOf(b);
    const note = textOf(b, "note", NOTE_MAX, true) as string;
    return this.editorial.requestChanges(await this.context(req, t, s, idem), itemId, { version, note });
  }

  @Post("content/items/:itemId/editorial/seo-signoff")
  @HttpCode(200)
  @Command("editorial.seoSignoff")
  async seoSignoff(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    const b = objectBody(raw, ["version"], false);
    const version = versionOf(b);
    return this.editorial.seoSignoff(await this.context(req, t, s, idem), itemId, { version });
  }

  @Post("content/items/:itemId/editorial/approve")
  @HttpCode(200)
  @Command("editorial.approve")
  async approve(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    const b = objectBody(raw, ["version"], false);
    const version = versionOf(b);
    return this.editorial.approve(await this.context(req, t, s, idem), itemId, { version });
  }

  @Post("content/items/:itemId/editorial/assign")
  @HttpCode(200)
  @Command("editorial.assign")
  async assign(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    const b = objectBody(raw, ["authorSub", "dueAt", "plannedPublishAt", "briefRef"], false);
    const input: AssignInput = {};
    const authorSub = textOf(b, "authorSub", SUB_MAX, false);
    if (authorSub !== undefined) input.authorSub = authorSub;
    for (const k of ["dueAt", "plannedPublishAt"] as const) {
      const v = instantOf(b, k);
      if (v !== undefined) input[k] = v;
    }
    if ("briefRef" in b) {
      if (b.briefRef === null) input.briefRef = null;
      else input.briefRef = textOf(b, "briefRef", SUB_MAX, true) as string;
    }
    if (Object.keys(input).length === 0) throw problems.invalidRequest("assign needs at least one of authorSub, dueAt, plannedPublishAt, briefRef");
    return this.editorial.assign(await this.context(req, t, s, idem), itemId, input);
  }

  @Post("content/items/:itemId/editorial/comments")
  @Command("editorial.comment")
  async comment(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    const b = objectBody(raw, ["version", "anchor", "body"], false);
    const version = versionOf(b);
    const body = textOf(b, "body", COMMENT_MAX, true) as string;
    let anchor: string | undefined;
    if (b.anchor !== undefined) {
      // An RFC 6901 JSON pointer: "" (the whole document) or "/..." (0016's CHECK says the same).
      if (typeof b.anchor !== "string" || b.anchor.length > ANCHOR_MAX || !(b.anchor === "" || b.anchor.startsWith("/"))) {
        throw problems.invalidRequest(`anchor must be a JSON pointer ("" or starting with "/") of at most ${ANCHOR_MAX} characters`);
      }
      anchor = b.anchor;
    }
    return this.editorial.comment(await this.context(req, t, s, idem), itemId, { version, anchor, body });
  }

  @Post("content/items/:itemId/editorial/comments/:commentId/resolve")
  @HttpCode(200)
  @Command("editorial.commentResolve")
  async commentResolve(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("itemId") itemId: string, @Param("commentId") commentId: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    objectBody(raw, [], true);
    return this.editorial.commentResolve(await this.context(req, t, s, idem), itemId, commentId);
  }

  @Put("collections/:key/editorial-policy")
  @Command("editorial.policySet")
  async policySet(@Req() req: EditorialRequest, @Param("tenantSlug") t: string, @Param("siteId") s: string, @Param("key") key: string, @Headers("idempotency-key") idem: string | undefined, @Body() raw: unknown) {
    const b = objectBody(raw, ["reviewRequired", "seoSignoffRequired"], false);
    if (typeof b.reviewRequired !== "boolean") throw problems.invalidRequest("reviewRequired is required and must be a boolean");
    if (b.seoSignoffRequired !== undefined && typeof b.seoSignoffRequired !== "boolean") throw problems.invalidRequest("seoSignoffRequired must be a boolean");
    const seo = b.seoSignoffRequired === true;
    // A sign-off with no review can never be asked for (the table CHECK says so too): say so, do not drop it quietly.
    if (seo && !b.reviewRequired) throw problems.invalidRequest("seoSignoffRequired cannot be true while reviewRequired is false");
    return this.editorial.policySet(await this.context(req, t, s, idem), key, { reviewRequired: b.reviewRequired, seoSignoffRequired: seo });
  }
}

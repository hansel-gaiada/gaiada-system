// WSK-41 — the content authoring routes (write-plane design §3.1/§3.2), Zone B control plane:
//
//   POST /control/v1/tenants/:tenantSlug/sites/:siteId/content/items                     content.create
//   PUT  /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId             content.update
//   POST /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/restore     content.restoreVersion
//   POST /control/v1/tenants/:tenantSlug/sites/:siteId/content/publish                   content.publish   (HIGH)
//   POST /control/v1/tenants/:tenantSlug/sites/:siteId/content/schedule                  content.schedule  (HIGH)
//   POST /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/unpublish   content.unpublish
//   POST /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/delete      content.delete
//
// GATE ORDER (pinned by test/content-commands-gates.spec.ts): ControlAuthGuard (L1 mTLS + L2 token)
// -> CommandAuthorizationGuard (L3 scope, L4 WS4 for HIGH) -> EditorialAssertionGuard (L2e) ->
// the handler, which validates (shape here -> composition -> state in the service). Guards run before
// the handler in Nest, so a refused caller is refused whatever its body; validation can never
// pre-empt authorisation.
//
// Not reachable through the public proxy: /control/* is served only on the internal mTLS vhost
// (WSK-63a). See ../control.module.ts.
import { Body, Controller, Headers, HttpCode, Param, Post, Put, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { EditorialAssertionGuard } from "../auth/editorial-assertion.guard";
import { requireEditorialPrincipal, type EditorialRequest } from "../auth/editorial-principal";
import { requireControlContext } from "../auth/control-request";
import { Command } from "../command.decorator";
import { COMMAND_REGISTRY, type CommandName } from "../command-types";
import {
  ContentCommandsService,
  type CreateItemInput,
  type EditorialCommandContext,
  type ScheduleInput,
  type UpdateItemInput,
} from "./content-commands.service";
import { ControlProblemFilter, problems } from "./content-problem";
import { isPlainObject } from "./content-projection";

// ------------------------------------------------------------------------------------------------
// Shape validation (400 invalid-request). Composition and state checks are the service's.
// ------------------------------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The command hash merges route params and body; a body carrying one of these would make it ambiguous (design §3.2). */
const RESERVED_BODY_KEYS = ["tenantSlug", "siteId", "itemId"] as const;
const MAX_BATCH = 1000;

function body(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(raw)) throw problems.invalidRequest("the request body must be a JSON object");
  for (const k of RESERVED_BODY_KEYS) {
    if (k in raw) throw problems.invalidRequest(`the body may not contain "${k}": it is a route parameter`);
  }
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) throw problems.invalidRequest(`unknown body key "${k}" (allowed: ${allowed.join(", ")})`);
  }
  return raw;
}

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw problems.invalidRequest(`${field} must be a non-empty string (max ${max} chars)`);
  }
  return v;
}

function int(v: unknown, field: string, min: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > 2_147_483_647) {
    throw problems.invalidRequest(`${field} must be an integer >= ${min}`);
  }
  return v;
}

function optNote(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > 500) throw problems.invalidRequest("note must be a string of at most 500 characters");
  return v;
}

function optObject(v: unknown, field: string): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) throw problems.invalidRequest(`${field} must be a JSON object`);
  return v;
}

function optArray(v: unknown, field: string): unknown[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw problems.invalidRequest(`${field} must be an array`);
  return v;
}

function optInstant(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw problems.invalidRequest(`${field} must be an ISO 8601 timestamp or null`);
  return new Date(v).toISOString();
}

function batchItems(v: unknown): { itemId: string; version: number }[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BATCH) {
    throw problems.invalidRequest(`items must be an array of 1..${MAX_BATCH} { itemId, version }`);
  }
  const seen = new Set<string>();
  return v.map((raw, i) => {
    if (!isPlainObject(raw) || Object.keys(raw).some((k) => k !== "itemId" && k !== "version")) {
      throw problems.invalidRequest(`items[${i}] must be exactly { itemId, version }`);
    }
    if (typeof raw.itemId !== "string" || !UUID_RE.test(raw.itemId)) throw problems.invalidRequest(`items[${i}].itemId must be a uuid`);
    const itemId = raw.itemId.toLowerCase();
    if (seen.has(itemId)) throw problems.invalidRequest(`items[${i}].itemId is listed twice`);
    seen.add(itemId);
    return { itemId, version: int(raw.version, `items[${i}].version`, 1) };
  });
}

function idempotencyKey(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 200) {
    throw problems.invalidRequest("the Idempotency-Key header is required (8..200 chars) on every content write");
  }
  return raw;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The approval id a HIGH command claims. Read from the `x-ws4-assertion` header itself — the header
 * CommandAuthorizationGuard's PolicyDecisionPoint verified (HMAC, commandHash, expiry) before this
 * handler ran — so the id claimed in the audit row is the id that was verified, never a separate
 * convenience header. Falls back to the control context's id (the dev-mode stub's header, tests only).
 * MEDIUM commands claim nothing: a stray assertion on a MEDIUM call must not consume an approval.
 */
function claimedWs4ApprovalId(req: EditorialRequest, command: CommandName): string | null {
  if (COMMAND_REGISTRY[command].impactClass !== "high") return null;
  const header = firstHeader(req.headers["x-ws4-assertion"]);
  if (header) {
    const dot = header.indexOf(".");
    if (dot > 0) {
      try {
        const parsed = JSON.parse(Buffer.from(header.slice(0, dot), "base64url").toString("utf8")) as { approvalId?: unknown };
        if (typeof parsed.approvalId === "string" && parsed.approvalId.length > 0) return parsed.approvalId;
      } catch {
        /* fall through */
      }
    }
  }
  return requireControlContext(req).ws4ApprovalId;
}

@Controller("control/v1/tenants/:tenantSlug/sites/:siteId/content")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard, EditorialAssertionGuard)
@UseFilters(ControlProblemFilter)
export class ContentCommandsController {
  constructor(private readonly content: ContentCommandsService) {}

  private async context(
    req: EditorialRequest,
    command: CommandName,
    tenantSlug: string,
    siteId: string,
    idempotencyKeyRaw: string | undefined,
  ): Promise<EditorialCommandContext> {
    const principal = requireEditorialPrincipal(req);
    const key = idempotencyKey(idempotencyKeyRaw);
    const { tenant } = await this.content.resolveTenantSite(tenantSlug, siteId);
    return { tenant, siteId, principal, idempotencyKey: key, ws4ApprovalId: claimedWs4ApprovalId(req, command), command };
  }

  @Post("items")
  @Command("content.create")
  async create(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = body(raw, ["collectionKey", "locale", "slug", "twinOf", "fields", "blocks", "seo", "note"]);
    const input: CreateItemInput = {
      collectionKey: str(b.collectionKey, "collectionKey", 200),
      locale: str(b.locale, "locale", 35),
      slug: str(b.slug, "slug", 2048),
      twinOf: null,
      fields: optObject(b.fields, "fields"),
      blocks: optArray(b.blocks, "blocks"),
      seo: optObject(b.seo, "seo"),
      note: optNote(b.note),
    };
    if (b.twinOf !== undefined && b.twinOf !== null) {
      if (typeof b.twinOf !== "string" || !UUID_RE.test(b.twinOf)) throw problems.invalidRequest("twinOf must be an item id (uuid) or null");
      input.twinOf = b.twinOf.toLowerCase();
    }
    const ctx = await this.context(req, "content.create", tenantSlug, siteId, idem);
    return this.content.createItem(ctx, input);
  }

  @Put("items/:itemId")
  @Command("content.update")
  async update(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = body(raw, ["baseVersion", "fields", "blocks", "seo", "note"]);
    const input: UpdateItemInput = {
      baseVersion: int(b.baseVersion, "baseVersion", 0),
      fields: optObject(b.fields, "fields"),
      blocks: optArray(b.blocks, "blocks"),
      seo: optObject(b.seo, "seo"),
      note: optNote(b.note),
    };
    const ctx = await this.context(req, "content.update", tenantSlug, siteId, idem);
    return this.content.updateItem(ctx, itemId, input);
  }

  @Post("items/:itemId/restore")
  @HttpCode(200)
  @Command("content.restoreVersion")
  async restore(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = body(raw, ["version", "baseVersion", "note"]);
    const input = { version: int(b.version, "version", 1), baseVersion: int(b.baseVersion, "baseVersion", 0), note: optNote(b.note) };
    const ctx = await this.context(req, "content.restoreVersion", tenantSlug, siteId, idem);
    return this.content.restoreVersion(ctx, itemId, input);
  }

  @Post("publish")
  @HttpCode(200)
  @Command("content.publish")
  async publish(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = body(raw, ["items", "note"]);
    const input = { items: batchItems(b.items), note: optNote(b.note) };
    const ctx = await this.context(req, "content.publish", tenantSlug, siteId, idem);
    return this.content.publish(ctx, input);
  }

  @Post("schedule")
  @HttpCode(200)
  @Command("content.schedule")
  async schedule(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = body(raw, ["items", "publishAt", "unpublishAt"]);
    const input: ScheduleInput = {
      items: batchItems(b.items),
      publishAt: optInstant(b.publishAt, "publishAt"),
      unpublishAt: optInstant(b.unpublishAt, "unpublishAt"),
    };
    const now = Date.now();
    if (input.publishAt === null && input.unpublishAt === null) {
      throw problems.invalidRequest("give publishAt (a deferred publish) and/or unpublishAt (a scheduled takedown)");
    }
    if (input.publishAt !== null && Date.parse(input.publishAt) <= now) {
      throw problems.invalidRequest("publishAt must be in the future; to publish now use content.publish");
    }
    if (input.unpublishAt !== null && Date.parse(input.unpublishAt) <= now) {
      throw problems.invalidRequest("unpublishAt must be in the future; to take an item down now use content.unpublish");
    }
    if (input.publishAt !== null && input.unpublishAt !== null && Date.parse(input.unpublishAt) <= Date.parse(input.publishAt)) {
      throw problems.invalidRequest("unpublishAt must be after publishAt");
    }
    const ctx = await this.context(req, "content.schedule", tenantSlug, siteId, idem);
    return this.content.schedule(ctx, input);
  }

  @Post("items/:itemId/unpublish")
  @HttpCode(200)
  @Command("content.unpublish")
  async unpublish(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = body(raw, ["expectedPublishedVersion"]);
    const input = { expectedPublishedVersion: int(b.expectedPublishedVersion, "expectedPublishedVersion", 1) };
    const ctx = await this.context(req, "content.unpublish", tenantSlug, siteId, idem);
    return this.content.unpublish(ctx, itemId, input);
  }

  @Post("items/:itemId/delete")
  @HttpCode(200)
  @Command("content.delete")
  async remove(
    @Req() req: EditorialRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("itemId") itemId: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const b = body(raw, ["baseVersion"]);
    const input = { baseVersion: int(b.baseVersion, "baseVersion", 0) };
    const ctx = await this.context(req, "content.delete", tenantSlug, siteId, idem);
    return this.content.deleteItem(ctx, itemId, input);
  }
}

// M5-W2d — the ERP's BFF for the review flow (docs/plans/2026-10-11-m5-writers-room-design.md §4.3, §4.4, §8;
// FRONTEND-BFF-CONTRACT §27 "Writers' room review"). Routes are in `webdesk-content.controller.ts`; the MCP tools
// `webdesk.editorial.{submit,withdraw,requestChanges,seoSignoff,approve,assign,comment,setPolicy,board,history}` call them.
//
// THE ORDER OF EVERY ITEM COMMAND (the two-phase gate of webdesk-content.service.ts, unchanged):
//   1. the controller's first statement: `authorizeSite(...)` (phase 1, `webdesk_collection:read` on the route's site);
//   2. here: the cross-company wall, a WebDesk `item.get`, and the REAL action on that item with attributes from the route
//      and from WebDesk (`WebdeskContentService.openEditorialItem` -> `ItemGate.forItem`). A denied caller is 403 whatever
//      its body held, and WebDesk has received no write;
//   3. only then the body is validated, the editorial assertion is signed as the CALLER, and the command is forwarded with
//      an Idempotency-Key (`WebdeskZoneB.write`: two ledger rows, typed problems passed through byte for byte);
//   4. after WebDesk confirmed: notifications, fail-soft.
//
// WHICH CERBOS ACTION (design §2.1, §4.3): submit and withdraw -> `submit`; requestChanges -> `request_changes`;
// seoSignoff -> `seo_signoff`; approve -> `approve`; assign -> `assign`; comment and commentResolve -> `comment`;
// policySet -> `webdesk_collection:manage_editorial` on {siteId, collectionKey}; the reads -> `read`.
//
// MAKER != CHECKER (§4.4). `approve`'s `creatorId` is the creator of the version being approved, from WebDesk's read of the
// item (the SUBMITTED version of an item in review), never from the body. WebDesk itself pins the body's `version` to the
// submitted one (409 review-version-mismatch), so the version the body names cannot differ from the one whose creator
// Cerbos compared. The structural DENY then refuses a self-approval for every principal, platform_admin included, and the
// automation/bot/contributor DENY refuses a machine approver. WebDesk does not re-derive either (D39).
//
// NOTIFICATIONS carry ids and the item's title only; never a comment, a note or any body text. A submit goes to the editors
// in scope (`webdesk_editor` grants whose scope rows cover the item's site, collection and locale) and to the publisher
// tier (`webdev_manager` at company scope); changes requested and an approval go to the item's author (WebDesk's
// `author_sub`, the Cerbos `ownerId`). The actor is never told about their own action (`notify()` skips self).
import { Logger } from "@nestjs/common";
import { withTenants } from "../../db";
import { notifyBestEffort } from "../../core/client-notify";
import { authorize } from "../../core/http";
import type { Principal } from "../../rbac/principal";
import {
  ItemGate,
  UUID_RE,
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
  type ZoneBResult,
} from "./webdesk-content.service";
import type { WebdeskBffEditorialCommand } from "./webdesk-approved-command";
import { syncAssignee } from "./webdesk-brief-store";

const logger = new Logger("WebdeskEditorial");

const ITEM_PATH = "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId";
export const NOTE_MAX = 2000;
export const COMMENT_MAX = 4000;
export const ANCHOR_MAX = 512;
const SUB_MAX = 200;
const BOARD_PROBE_CONCURRENCY = 8;

/** The item commands: Cerbos action, WebDesk command, route suffix, body keys. */
type ItemCommand = "submit" | "withdraw" | "requestChanges" | "seoSignoff" | "approve" | "assign" | "comment" | "commentResolve";

interface ItemCommandSpec {
  action: "submit" | "request_changes" | "seo_signoff" | "approve" | "assign" | "comment";
  command: WebdeskBffEditorialCommand;
  suffix: string;
  /** Validates the body (strict allow-list; runs AFTER phase 2). */
  parse: (raw: unknown) => Record<string, unknown>;
}

const SPECS: Record<ItemCommand, ItemCommandSpec> = {
  submit: { action: "submit", command: "editorial.submit", suffix: "/editorial/submit", parse: (r) => versionOnly(r) },
  // withdraw is the author's/editor's undo of a submit: the same Cerbos action as submit (design §2.1).
  withdraw: { action: "submit", command: "editorial.withdraw", suffix: "/editorial/withdraw", parse: (r) => emptyBody(r) },
  requestChanges: { action: "request_changes", command: "editorial.requestChanges", suffix: "/editorial/request-changes", parse: parseRequestChanges },
  seoSignoff: { action: "seo_signoff", command: "editorial.seoSignoff", suffix: "/editorial/seo-signoff", parse: (r) => versionOnly(r) },
  approve: { action: "approve", command: "editorial.approve", suffix: "/editorial/approve", parse: (r) => versionOnly(r) },
  assign: { action: "assign", command: "editorial.assign", suffix: "/editorial/assign", parse: parseAssign },
  comment: { action: "comment", command: "editorial.comment", suffix: "/editorial/comments", parse: parseComment },
  commentResolve: { action: "comment", command: "editorial.commentResolve", suffix: "/editorial/comments/:commentId/resolve", parse: (r) => emptyBody(r) },
};

// ── body parsers (pure; WebDesk validates the same shapes again and owns the state rules) ────────

function emptyBody(raw: unknown): Record<string, unknown> {
  return strictBody(raw === undefined || raw === null ? {} : raw, []);
}

function versionOf(b: Record<string, unknown>): number {
  const v = b.version;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 2_147_483_647) throw invalidRequest("version is required and must be an integer >= 1");
  return v;
}

function textOf(b: Record<string, unknown>, key: string, max: number): string {
  const v = b[key];
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max) throw invalidRequest(`${key} is required and must be a non-empty string of at most ${max} characters`);
  return v;
}

function versionOnly(raw: unknown): Record<string, unknown> {
  const b = strictBody(raw, ["version"]);
  return { version: versionOf(b) };
}

function parseRequestChanges(raw: unknown): Record<string, unknown> {
  const b = strictBody(raw, ["version", "note"]);
  return { version: versionOf(b), note: textOf(b, "note", NOTE_MAX) };
}

function parseComment(raw: unknown): Record<string, unknown> {
  const b = strictBody(raw, ["version", "anchor", "body"]);
  const out: Record<string, unknown> = { version: versionOf(b), body: textOf(b, "body", COMMENT_MAX) };
  if (b.anchor !== undefined) {
    // An RFC 6901 JSON pointer ("" = the whole document, or "/…"), the shape WebDesk's CHECK states too.
    if (typeof b.anchor !== "string" || b.anchor.length > ANCHOR_MAX || !(b.anchor === "" || b.anchor.startsWith("/"))) {
      throw invalidRequest(`anchor must be a JSON pointer ("" or starting with "/") of at most ${ANCHOR_MAX} characters`);
    }
    out.anchor = b.anchor;
  }
  return out;
}

function parseAssign(raw: unknown): Record<string, unknown> {
  const b = strictBody(raw, ["authorSub", "dueAt", "plannedPublishAt", "briefRef"]);
  const out: Record<string, unknown> = {};
  if (b.authorSub !== undefined) out.authorSub = textOf(b, "authorSub", SUB_MAX);
  for (const k of ["dueAt", "plannedPublishAt"] as const) {
    if (b[k] === undefined) continue;
    if (b[k] !== null && (typeof b[k] !== "string" || (b[k] as string).length === 0 || (b[k] as string).length > 64)) {
      throw invalidRequest(`${k} must be an ISO-8601 date or date-time string, or null to clear it`);
    }
    out[k] = b[k];
  }
  if (b.briefRef !== undefined) out.briefRef = b.briefRef === null ? null : textOf(b, "briefRef", SUB_MAX);
  if (Object.keys(out).length === 0) throw invalidRequest("assign needs at least one of authorSub, dueAt, plannedPublishAt, briefRef");
  return out;
}

function parsePolicy(raw: unknown): Record<string, unknown> {
  const b = strictBody(raw, ["reviewRequired", "seoSignoffRequired"]);
  if (typeof b.reviewRequired !== "boolean") throw invalidRequest("reviewRequired is required and must be a boolean");
  if (b.seoSignoffRequired !== undefined && typeof b.seoSignoffRequired !== "boolean") throw invalidRequest("seoSignoffRequired must be a boolean");
  if (b.seoSignoffRequired === true && !b.reviewRequired) throw invalidRequest("seoSignoffRequired cannot be true while reviewRequired is false");
  return { reviewRequired: b.reviewRequired, ...(b.seoSignoffRequired !== undefined ? { seoSignoffRequired: b.seoSignoffRequired } : {}) };
}

// ── who to tell ──────────────────────────────────────────────────────────────────────────────────

/**
 * The editors a submit reaches: holders of an UNEXPIRED `webdesk_editor` grant at this company whose scope rows cover THIS
 * site, collection and locale ("all" or named), plus the publisher tier (`webdev_manager` at company scope). Read inside
 * `withTenants([tenantId])`, so the scope table's tenant wall (RLS) applies: another company's editor, even one on the
 * same WebDesk site id, cannot appear. The grant row's own company (`ur.scope_id`) is matched as well, belt and braces.
 * Returns distinct user ids; `notify()` still drops anyone who is not an active member of the company.
 */
export async function submitRecipients(tenantId: string, siteId: string, collectionKey: string, locale: string): Promise<string[]> {
  return withTenants([tenantId], async (c) => {
    const editors = await c.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id
         FROM user_role_editorial_scopes s
         JOIN user_roles ur ON ur.id = s.user_role_id
         JOIN roles r ON r.id = ur.role_id
        WHERE s.tenant_id = $1 AND s.site_id = $2
          AND r.name = 'webdesk_editor'
          AND ur.scope_type = 'company' AND ur.scope_id = $1::text
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
          AND (s.all_collections OR $3 = ANY(s.collections))
          AND (s.all_locales OR $4 = ANY(s.locales))`,
      [tenantId, siteId, collectionKey, locale],
    );
    const publishers = await c.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'webdev_manager'
          AND ur.scope_type = 'company' AND ur.scope_id = $1::text
          AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
      [tenantId],
    );
    return [...new Set([...editors.rows, ...publishers.rows].map((r) => r.user_id))];
  });
}

/**
 * M5-W4: after WebDesk confirmed an `assign` that named a new author, keep the linked brief's `assignee_id` equal to it (the
 * column filters the writers' board and picks a notification recipient; it grants nothing). Fail-soft, and a no-op for an
 * item with no brief or an author that is not an ERP user id.
 */
async function syncBriefAssignee(tenantId: string, siteId: string, itemId: string, authorSub: string): Promise<void> {
  try {
    await syncAssignee(tenantId, siteId, itemId, UUID_RE.test(authorSub) ? authorSub.toLowerCase() : null);
  } catch (err) {
    logger.warn(`brief assignee sync failed: ${(err as Error)?.message ?? "error"}`);
  }
}

interface NotifyFacts {
  tenantId: string;
  actorId: string | null;
  site: SiteRef;
  itemId: string;
  collectionKey: string;
  locale: string;
  itemTitle: string | null;
  ownerId: string;
  version: number | null;
}

/** A notification names the item (ids and title) and never carries text a person wrote. */
function payloadFor(f: NotifyFacts, headline: string): { title: string; entityType: string; entityId: string; [k: string]: unknown } {
  return {
    title: f.itemTitle ? `${headline}: ${f.itemTitle}` : headline,
    entityType: "webdesk_content_item",
    entityId: f.itemId,
    tenantSlug: f.site.tenantSlug,
    siteId: f.site.siteId,
    collectionKey: f.collectionKey,
    locale: f.locale,
    ...(f.version !== null ? { version: f.version } : {}),
  };
}

/** After WebDesk confirmed (never on a replay). Fail-soft: whatever goes wrong here is logged, never thrown. */
async function notifyAfter(cmd: ItemCommand, f: NotifyFacts): Promise<void> {
  try {
    if (cmd === "submit") {
      const ids = await submitRecipients(f.tenantId, f.site.siteId, f.collectionKey, f.locale);
      await notifyBestEffort(f.tenantId, f.actorId, ids, "webdesk.editorial.submitted", payloadFor(f, "Review requested"));
    } else if (cmd === "requestChanges" || cmd === "approve") {
      if (!UUID_RE.test(f.ownerId)) return; // a legacy item has no author: nobody to tell
      await notifyBestEffort(
        f.tenantId, f.actorId, [f.ownerId],
        cmd === "approve" ? "webdesk.editorial.approved" : "webdesk.editorial.changes_requested",
        payloadFor(f, cmd === "approve" ? "Approved" : "Changes requested"),
      );
    }
  } catch (err) {
    logger.warn(`editorial notification (${cmd}) failed: ${(err as Error)?.message ?? "error"}`);
  }
}

// ── the service ──────────────────────────────────────────────────────────────────────────────────

export class WebdeskEditorialService {
  constructor(
    private readonly zoneB: WebdeskZoneB = webdeskZoneB,
    private readonly content: WebdeskContentService = webdeskContent,
  ) {}

  /** One item command: phase 2, then the body, then the signed write, then the notification. */
  async itemCommand(gate: ContentGate, site: SiteRef, itemId: string, cmd: ItemCommand, rawBody: unknown, idempotencyKey: string, commentId?: string): Promise<ZoneBResult> {
    const spec = SPECS[cmd];
    // approve is opened as `webdesk_collection:read` (phase 1 only): an attribute-free `approve` is denied for EVERY principal
    // (no creator is known yet), so the old company-level first question cannot be asked for it; phase 2 below decides.
    if (cmd === "approve") gate.require("webdesk_collection", "read");
    else gate.require("webdesk_content_item", spec.action);
    const itemGate = await this.content.openEditorialItem(gate, site, itemId, spec.action); // PHASE 2, before the body
    const body = spec.parse(rawBody);
    if (cmd === "commentResolve" && (commentId === undefined || !UUID_RE.test(commentId))) throw invalidRequest("commentId must be a uuid");
    return this.send(itemGate, cmd, spec, body, idempotencyKey, commentId);
  }

  /** The write. Needs an `ItemGate`: the WebDesk read and the Cerbos check cannot be skipped to reach it. */
  private async send(g: ItemGate, cmd: ItemCommand, spec: ItemCommandSpec, body: Record<string, unknown>, idempotencyKey: string, commentId?: string): Promise<ZoneBResult> {
    const { gate, site } = g;
    const itemId = g.itemId as string;
    const attrs = g.attrs as NonNullable<ItemGate["attrs"]>;
    const result = await this.zoneB.write(gate.principal, gate.tenantId, {
      command: spec.command,
      verb: `webdesk.${spec.command}`,
      method: "POST",
      path: `${ITEM_PATH}${spec.suffix}`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId, ...(commentId !== undefined ? { commentId } : {}) },
      body,
      idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      entity: { type: "webdesk_content_item", id: UUID_RE.test(itemId) ? itemId : null },
      // Identifiers and the typed outcome only: never a note, a comment or a brief.
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId, collectionKey: attrs.collectionKey, locale: attrs.locale, ...(typeof body.version === "number" ? { version: body.version } : {}) },
      // No `reconcile`: a state transition that may have landed is re-read by the caller (item.get / history) and re-sent
      // under the SAME Idempotency-Key, which WebDesk answers `replayed: true`.
    });
    const replayed = isPlainObject(result.body) && result.body.replayed === true;
    if (cmd === "assign" && typeof body.authorSub === "string") await syncBriefAssignee(gate.tenantId, site.siteId, itemId, body.authorSub);
    if (!replayed) {
      await notifyAfter(cmd, {
        tenantId: gate.tenantId,
        actorId: gate.principal.userId ?? null,
        site,
        itemId,
        collectionKey: attrs.collectionKey,
        locale: attrs.locale,
        itemTitle: attrs.itemTitle,
        ownerId: attrs.ownerId,
        version: typeof body.version === "number" ? body.version : null,
      });
    }
    return result;
  }

  /** `PUT …/collections/:key/editorial-policy`: `webdesk_collection:manage_editorial` on {siteId, collectionKey}. */
  async setPolicy(gate: ContentGate, site: SiteRef, collectionKey: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_collection", "manage_editorial");
    const editable = await gate.resolveSite(this.zoneB, site);
    // PHASE 2, before the body: the site id is the wall's own, the collection key is the route's (WebDesk 404s an unknown one).
    await authorize(gate.principal, { kind: "webdesk_collection", tenantId: gate.tenantId, module: "webdev", siteId: editable.site.siteId, collectionKey }, "manage_editorial");
    const body = parsePolicy(rawBody);
    return this.zoneB.write(gate.principal, gate.tenantId, {
      command: "editorial.policySet",
      verb: "webdesk.editorial.policySet",
      method: "PUT",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key/editorial-policy",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, key: collectionKey },
      body,
      idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      entity: { type: "webdesk_collection", id: null },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, collectionKey, reviewRequired: body.reviewRequired, seoSignoffRequired: body.seoSignoffRequired ?? false },
    });
  }

  /** `GET …/items/:itemId/editorial`: the review record of one item. Phase 2 is `read` on the item. */
  async history(gate: ContentGate, site: SiteRef, itemId: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    await this.content.openEditorialItem(gate, site, itemId, "read");
    strictQuery(rawQuery, []);
    return this.zoneB.read({
      command: "editorial.history",
      path: `${ITEM_PATH}/editorial`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
    });
  }

  /**
   * `GET …/editorial/board`: the site's review board. WebDesk's answer covers EVERY collection of the site, so a caller whose
   * `read` reaches only some collections or locales (a writers' room grant) gets only those rows: each distinct
   * (collection, locale) pair in the page is asked of Cerbos (`read`, the route's site id), and a row it may not read is
   * dropped, as are the policies of collections it may not read. The site-wide `counts` are then withheld (they would
   * disclose the size of what the caller may not see). A caller whose `read` is company-level (a staff tier) gets WebDesk's
   * answer untouched.
   */
  async board(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    const query = strictQuery(rawQuery, ["state", "collection", "authorSub", "dueBefore", "cursor", "limit"]);
    const res = await this.zoneB.read({
      command: "editorial.board",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/editorial/board",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      query,
    });
    const principal: Principal = gate.principal;
    const resource = (collectionKey: string, locale: string) => ItemGate.resourceOf(gate, siteId, null, { collectionKey, locale });
    if (!isPlainObject(res.body) || !Array.isArray(res.body.items)) return res;
    if (await probeAllowed(principal, { kind: "webdesk_content_item", tenantId: gate.tenantId, module: "webdev", siteId }, "read")) {
      await authorize(principal, { kind: "webdesk_content_item", tenantId: gate.tenantId, module: "webdev", siteId }, "read");
      return res; // company-level reader: the whole board, as WebDesk answered
    }
    const pairs = new Map<string, { collectionKey: string; locale: string }>();
    for (const it of res.body.items) {
      if (isPlainObject(it) && typeof it.collectionKey === "string" && typeof it.locale === "string") {
        pairs.set(`${it.collectionKey}\u0000${it.locale}`, { collectionKey: it.collectionKey, locale: it.locale });
      }
    }
    const verdicts = await mapPool([...pairs.entries()], BOARD_PROBE_CONCURRENCY, async ([k, p]) => ({ k, ok: await probeAllowed(principal, resource(p.collectionKey, p.locale), "read") }));
    const readable = new Set(verdicts.filter((v) => v.ok).map((v) => v.k));
    const readableCollections = new Set([...readable].map((k) => k.split("\u0000")[0]));
    if (pairs.size > 0 && readable.size === 0) {
      // Nothing readable: the ordinary denial (and its audit row), never an empty board for a caller that may read nothing.
      const first = [...pairs.values()][0];
      await authorize(principal, resource(first.collectionKey, first.locale), "read");
    }
    const { counts: _counts, ...rest } = res.body;
    void _counts;
    return {
      status: res.status,
      body: {
        ...rest,
        items: res.body.items.filter((it) => isPlainObject(it) && readable.has(`${it.collectionKey}\u0000${it.locale}`)),
        policies: Array.isArray(res.body.policies)
          ? res.body.policies.filter((p) => isPlainObject(p) && typeof p.collectionKey === "string" && readableCollections.has(p.collectionKey))
          : [],
        countsWithheld: true,
      },
    };
  }
}

export const webdeskEditorial = new WebdeskEditorialService();

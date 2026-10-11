// WSK-49c — the CLIENT-MODE website BFF: what a client editor does to THEIR client's WebDesk site through the portal.
// Controller: webdesk-client-website.controller.ts (`/api/:tenantId/portal/clients/:clientId/website/...`).
// Rulings: WSK-D58 (a client publisher self-publishes ONE item; a batch needs a second client person), WSK-D59 (clients
// change only what the composition marks client-editable; enforced twice), WSK-D60 (the role is scoped to a client
// record), WSK-D62 (a client may publish only what a client could have changed).
//
// It is the staff content BFF in CLIENT MODE, not a second implementation. Every immediate write, the preview, the
// publish filing and the media calls are DELEGATED to `WebdeskContentService` / `WebdeskMediaService`, handed a
// `ContentGate` opened for the client (`ContentGate.openClient`). That gate is what makes the shared code behave as a
// client call: its Cerbos checks name the client (`resource.attr.clientId`), its site wall asks the site -> client link
// FIRST, its egress writes are signed with `ce: true`, and a publish request is filed with the client on the row. What
// this class adds is only what is specific to a client:
//
//   * THE ORDER, on every route (the controller's first statement is the Cerbos check; this class never opens a gate):
//       1. Cerbos, as the caller, under the client-editor rules (`client_website_editor` for the URL's client);
//       2. the site wall: the caller's portal scope contains that client (`resolvePortalScope`) AND the site is linked to
//          it (`webdesk_site_clients`, loaded in the request's tenant): anything else is a uniform 404 / 403;
//       3. the request body, strictly (a client body never carries `seo`; a publish never carries a schedule);
//       4. the D59 / D62 PRE-CHECK against what WebDesk holds, with WebDesk's own rule (`webdesk-client-guard.ts`),
//          refusing with WebDesk's problem slugs BEFORE any write is sent;
//       5. only then the delegated call, which signs `ce: true` and lets WebDesk check again (the authority).
//   * `seo` is never accepted from the client, and an update RE-SENDS the item's existing seo (and, when the client
//     omits them, its existing fields and generic blocks), so a partial client edit cannot silently remove what the
//     client cannot see or change. A deleted item is never written to.
//   * the `clientEditable` map the portal renders read-only fields from, computed from the composition by the vendored rule.
//   * the publish decisions (D58): file a request, list the client's requests, approve (a single item the editor filed
//     themselves, or another client editor's batch), or self-publish one item in one call.
import { BadGatewayException, NotFoundException } from "@nestjs/common";
import { withTenants } from "../../db";
import type { Principal } from "../../rbac/principal";
import { approveClientWebdeskPublish } from "./webdesk-approved-command";
import {
  ContentGate,
  UUID_RE,
  WebdeskProblem,
  invalidRequest,
  isPlainObject,
  parsePublishItems,
  strictBody,
  strictQuery,
  webdeskContent,
  webdeskZoneB,
  type ContentKind,
  type ContentAction,
  type SiteRef,
  type WebdeskContentService,
  type WebdeskTenantEntry,
  type WebdeskZoneB,
  type ZoneBResult,
} from "./webdesk-content.service";
import { webdeskMedia, type WebdeskMediaService } from "./webdesk-media.service";
import {
  CompositionReader,
  assembleClientContent,
  assertClientMayChange,
  assertClientMayCreate,
  assertClientMayPublish,
  clientEditableMap,
  fieldNotClientEditable,
  itemDeleted,
  refuseClientSchedule,
  refuseClientSeo,
  splitStoredContent,
} from "./webdesk-client-guard";
import { assertPortalClient, clientGateContext, listSiteClientLinks } from "./webdesk-site-clients.service";
import type { CollectionComposition } from "./vocabulary/composition";

const REQUEST_STATUSES: readonly string[] = ["pending", "approved", "rejected", "cancelled", "all"];
const ITEM_PATH = "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId";

/** `item.get`'s answer, narrowed to what the client BFF reads. */
interface ItemRead {
  item: { itemId: string; collectionKey: string; deletedAt: string | null; headVersion: number };
  version: { blocks: unknown; seo: unknown };
}

function itemNotFound(): WebdeskProblem {
  return new WebdeskProblem(404, {
    type: "https://webdesk.gaiada.online/errors/item-not-found",
    title: "Item not found",
    status: 404,
    detail: "No such item on this site.",
  });
}

export class WebdeskClientWebsiteService {
  constructor(
    private readonly zoneB: WebdeskZoneB = webdeskZoneB,
    private readonly content: WebdeskContentService = webdeskContent,
    private readonly media: WebdeskMediaService = webdeskMedia,
  ) {}

  /**
   * THE gate for a client route: Cerbos FIRST (the client-editor rules for the URL's client), as the controller's first
   * statement. The URL's `clientId` only reaches Cerbos here, which matches it against the caller's OWN server-derived
   * grants; the site wall then checks it against the portal scope and the site -> client link on every call.
   */
  gate(
    principal: Principal, tenantId: string, clientId: string, kind: ContentKind, action: ContentAction, opts: { notifyDeciders?: boolean } = {},
  ): Promise<ContentGate> {
    return ContentGate.openClient(principal, tenantId, kind, action, clientGateContext(principal, tenantId, clientId, opts));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // reads
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** `GET …/website` → `{clientId, sites:[{tenantSlug, siteId, name, kind, defaultLocale, locales, linkedAt}]}`: THIS client's linked sites. */
  async listSites(gate: ContentGate): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const client = this.clientOf(gate);
    await assertPortalClient(gate.principal, gate.tenantId, client.clientId);
    const links = await listSiteClientLinks(gate.tenantId, client.clientId);
    // A failed read is a typed 503, never `[]` (an empty list is a claim): `tenantsOf` throws the typed error.
    const tenants = await this.zoneB.tenantsOf(gate.tenantId);
    const sites = links.flatMap((l) => {
      const t: WebdeskTenantEntry | undefined = tenants.find((x) => x.slug === l.tenantSlug && x.status === "active");
      const s = t?.sites.find((x) => x.siteId.toLowerCase() === l.siteId);
      return t && s
        ? [{ tenantSlug: t.slug, siteId: s.siteId, name: s.name, kind: s.kind, defaultLocale: t.defaultLocale, locales: t.locales, linkedAt: l.linkedAt }]
        : [];
    });
    return { status: 200, body: { clientId: client.clientId, sites } };
  }

  /** `GET …/sites/:slug/:siteId/collections`: Zone B's collection list (compositions included) + each collection's `clientEditable` map. */
  async listCollections(gate: ContentGate, site: SiteRef): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    await gate.resolveSite(this.zoneB, site);
    const r = await this.zoneB.read({
      command: "collection.list",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
    });
    const body = isPlainObject(r.body) ? r.body : {};
    const collections = Array.isArray(body.collections) ? body.collections : [];
    return {
      status: r.status,
      body: {
        ...body,
        collections: collections.map((c) =>
          isPlainObject(c) && typeof c.key === "string"
            ? { ...c, clientEditable: clientEditableMap(c.key, (isPlainObject(c.composition) ? c.composition : {}) as CollectionComposition) }
            : c,
        ),
      },
    };
  }

  /** `GET …/collections/:key/items`: the staff list, minus `includeDeleted` and `state=deleted` (a client never sees a deleted item). */
  async listItems(gate: ContentGate, site: SiteRef, collectionKey: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    await gate.resolveSite(this.zoneB, site);
    const q = strictQuery(rawQuery, ["locale", "state", "q", "cursor", "limit", "slug"]);
    if (q.state === "deleted") throw invalidRequest("a client editor cannot list deleted items");
    return this.content.listItems(gate, site, collectionKey, q);
  }

  /** `GET …/items/:itemId[?version=]` → Zone B's item + `composition` + the per-field `clientEditable` map (the UI's read-only switch). */
  async getItem(gate: ContentGate, site: SiteRef, itemId: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const r = await this.content.getItem(gate, site, itemId, rawQuery);
    const body = isPlainObject(r.body) ? r.body : {};
    const item = isPlainObject(body.item) ? body.item : null;
    if (!item || typeof item.collectionKey !== "string") throw new BadGatewayException({ message: "webdesk_error", reason: "item_shape" });
    if (typeof item.deletedAt === "string") throw itemNotFound();
    const composition = await new CompositionReader(this.zoneB, site).get(item.collectionKey);
    return { status: r.status, body: { ...body, composition, clientEditable: clientEditableMap(item.collectionKey, composition) } };
  }

  async listVersions(gate: ContentGate, site: SiteRef, itemId: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    return this.content.listVersions(gate, site, itemId, rawQuery);
  }

  async getVersion(gate: ContentGate, site: SiteRef, itemId: string, n: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    return this.content.getVersion(gate, site, itemId, n, rawQuery);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // writes (immediate): create · update · restore · preview
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * `POST …/collections/:key/items`. Body `{locale, slug, twinOf?, fields?, blocks?, note?}`; a client body carries no `seo`.
   * D59 pre-check first: the collection must accept a client create, and every non-editable part must be absent/null.
   */
  async createItem(gate: ContentGate, site: SiteRef, collectionKey: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "create");
    await gate.resolveSite(this.zoneB, site);
    const b = strictBody(rawBody, ["collectionKey", "locale", "slug", "twinOf", "fields", "blocks", "seo", "note"]);
    if (b.collectionKey !== undefined && b.collectionKey !== collectionKey) {
      throw invalidRequest("collectionKey in the body does not match the collection in the path");
    }
    refuseClientSeo(b);
    const composition = await new CompositionReader(this.zoneB, site).get(collectionKey);
    assertClientMayCreate(collectionKey, composition, { fields: this.optFields(b.fields), blocks: this.optBlocks(b.blocks) });
    const { seo: _seo, ...forward } = b;
    void _seo;
    return this.content.createItem(gate, site, collectionKey, forward, idempotencyKey);
  }

  /**
   * `PUT …/items/:itemId`. Body `{baseVersion, fields?, blocks?, note?}`. The BFF reads the item's HEAD and:
   *   * refuses `seo` from the client (422 field-not-client-editable `/seo`);
   *   * fills what the client omitted FROM THE HEAD (fields, generic blocks, and ALWAYS the existing seo), so an update
   *     that leaves something out never removes it (the 49b note: omitting `seo` from an item that has one IS a change);
   *   * refuses a deleted item (409) and any change to a non-editable path (422, the pointers) BEFORE anything is sent.
   * A stale `baseVersion` is WebDesk's 409 (it is decided first there too), not an ERP guess.
   */
  async updateItem(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "update");
    await gate.resolveSite(this.zoneB, site);
    const b = strictBody(rawBody, ["baseVersion", "fields", "blocks", "seo", "note"]);
    refuseClientSeo(b);
    if (typeof b.baseVersion !== "number" || !Number.isInteger(b.baseVersion) || b.baseVersion < 0) throw invalidRequest("baseVersion must be a non-negative integer");
    const head = await this.readItem(site, itemId);
    this.assertWritable(head, itemId);
    const composition = await new CompositionReader(this.zoneB, site).get(head.item.collectionKey);
    this.refuseRedirect(head.item.collectionKey);
    const stored = splitStoredContent(composition, head.version);
    const fields = this.optFields(b.fields) ?? stored.fields;
    const blocks = this.optBlocks(b.blocks) ?? stored.blocks;
    assertClientMayChange(composition, { blocks: head.version.blocks, seo: head.version.seo }, assembleClientContent(head.item.collectionKey, composition, { fields, blocks, seo: stored.seo }));
    return this.content.updateItem(
      gate, site, itemId,
      { baseVersion: b.baseVersion, ...(fields !== undefined ? { fields } : {}), blocks, seo: stored.seo, ...(b.note !== undefined ? { note: b.note } : {}) },
      idempotencyKey,
    );
  }

  /** `POST …/items/:itemId/restore`. Body `{version, baseVersion, note?}`. The restored version must differ from the head only in client-editable paths. */
  async restoreVersion(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "update");
    await gate.resolveSite(this.zoneB, site);
    const b = strictBody(rawBody, ["version", "baseVersion", "note"]);
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) throw invalidRequest("version must be a positive integer");
    if (typeof b.baseVersion !== "number" || !Number.isInteger(b.baseVersion) || b.baseVersion < 0) throw invalidRequest("baseVersion must be a non-negative integer");
    const head = await this.readItem(site, itemId);
    this.assertWritable(head, itemId);
    this.refuseRedirect(head.item.collectionKey);
    const source = await this.readItem(site, itemId, b.version); // a missing version is WebDesk's typed 404/409, passed through
    const composition = await new CompositionReader(this.zoneB, site).get(head.item.collectionKey);
    assertClientMayChange(composition, { blocks: head.version.blocks, seo: head.version.seo }, { blocks: source.version.blocks, seo: source.version.seo });
    return this.content.restoreVersion(gate, site, itemId, b, idempotencyKey);
  }

  /** `POST …/items/:itemId/preview`: WSK-46's preview link, authorised as the item's `update` (a link discloses the draft). */
  async previewItem(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "update");
    return this.content.previewItem(gate, site, itemId, rawBody, idempotencyKey);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // publishing (D58, D62)
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * `POST …/sites/:slug/:siteId/publish-requests` body `{items:[{itemId, version}], note?}` -> 202 `{approvalId, command, itemCount}`.
   * Files ONE WS4 approval (the client is on the row); it publishes nothing. A `publishAt` / `unpublishAt` is 403
   * client-command-not-allowed (a client never schedules). D62 pre-check first: a publish that would put live a change to
   * a path a client could not have made is 422 publish-not-client-editable and nothing is filed.
   */
  async requestPublish(gate: ContentGate, site: SiteRef, rawBody: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "request_publish");
    await gate.resolveSite(this.zoneB, site);
    if (isPlainObject(rawBody) && ("publishAt" in rawBody || "unpublishAt" in rawBody)) refuseClientSchedule();
    const b = strictBody(rawBody, ["items", "note"]);
    const items = parsePublishItems(b.items);
    await assertClientMayPublish(this.zoneB, site, items);
    return this.content.requestPublish(gate, site, b);
  }

  /**
   * `POST …/sites/:slug/:siteId/items/:itemId/publish` body `{version?}` (default: the head): SELF-PUBLISH ONE ITEM (D58).
   * Files the request and approves it as the same person in one call, through the SAME Cerbos rules the two-step route
   * uses (the single-item self-approval arm). If the approval step is refused or fails before WebDesk is called, the
   * request it just filed is withdrawn so no orphan is left pending. Answers like `approve`.
   */
  async publishItem(
    principal: Principal, tenantId: string, clientId: string, site: SiteRef, itemId: string, rawBody: unknown,
  ): Promise<ZoneBResult> {
    const quiet = await this.gate(principal, tenantId, clientId, "webdesk_content_item", "request_publish", { notifyDeciders: false });
    await quiet.resolveSite(this.zoneB, site);
    const b = strictBody(rawBody === undefined || rawBody === null ? {} : rawBody, ["version"]);
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    let version: number;
    if (b.version === undefined) {
      version = (await this.readItem(site, itemId)).item.headVersion;
    } else if (typeof b.version === "number" && Number.isInteger(b.version) && b.version >= 1) {
      version = b.version;
    } else {
      throw invalidRequest("version must be an integer >= 1 (omit it to publish the item's head version)");
    }
    if (version < 1) throw invalidRequest("this item has no version to publish yet");
    const filed = await this.requestPublish(quiet, site, { items: [{ itemId, version }] });
    const approvalId = (filed.body as { approvalId: string }).approvalId;
    try {
      return await this.approvePublishRequest(await this.gate(principal, tenantId, clientId, "webdesk_content_item", "request_publish"), approvalId);
    } catch (err) {
      // The approval step threw: the row is still `pending` unless it was already decided. Withdraw it (best effort) so the
      // client is not left with a request they did not ask to leave, then surface the original error.
      try {
        await this.content.withdrawPublishRequest(quiet, site, approvalId);
      } catch {
        /* already decided, or already gone: nothing to withdraw */
      }
      throw err;
    }
  }

  /** `GET …/publish-requests[?status=…]` (default `pending`): this CLIENT's publish requests, every client editor's, newest first (<= 100). */
  async listPublishRequests(gate: ContentGate, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const client = this.clientOf(gate);
    const query = strictQuery(rawQuery, ["status"]);
    const status = query.status ?? "pending";
    if (!REQUEST_STATUSES.includes(status)) throw invalidRequest(`status must be one of ${REQUEST_STATUSES.join(", ")}`);
    await assertPortalClient(gate.principal, gate.tenantId, client.clientId);
    const me = gate.principal.userId as string;
    const params: unknown[] = [client.clientId, gate.tenantId];
    if (status !== "all") params.push(status);
    const found = await withTenants([gate.tenantId], (c) =>
      c.query<{
        id: string; status: string; created_at: Date | string; execution_status: string | null; requested_by: string | null;
        requester_name: string | null; tool_args: Record<string, unknown> | null;
      }>(
        // The approval must be a content.publish FILED FOR THIS CLIENT (its own `clientId`, set only by the portal BFF) and
        // its site must STILL be linked to this client: a staff-filed request, another client's, or a re-pointed site never appears.
        `SELECT aa.id, aa.status, aa.created_at, aa.execution_status, aa.requested_by, u.name AS requester_name, aa.tool_args
           FROM automation_approvals aa
           LEFT JOIN users u ON u.id = aa.requested_by
          WHERE aa.origin = 'webdesk' AND aa.deleted_at IS NULL AND aa.workflow_id = 'content.publish'
            AND aa.tool_args->>'clientId' = $1
            AND EXISTS (SELECT 1 FROM webdesk_site_clients wsc
                         WHERE wsc.tenant_id = $2 AND wsc.client_id = $1::uuid
                           AND wsc.tenant_slug = aa.tool_args->>'tenantSlug' AND wsc.site_id::text = aa.tool_args->>'siteId')
            ${status !== "all" ? "AND aa.status = $3" : ""}
          ORDER BY aa.created_at DESC, aa.id DESC LIMIT 100`,
        params,
      ),
    );
    const requests = found.rows.map((r) => {
      const items = Array.isArray(r.tool_args?.items) ? (r.tool_args?.items as unknown[]) : [];
      const itemIds = items.flatMap((i) => (isPlainObject(i) && typeof i.itemId === "string" ? [i.itemId] : []));
      const mine = r.requested_by === me;
      return {
        approvalId: r.id,
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
        tenantSlug: r.tool_args?.tenantSlug ?? null,
        siteId: r.tool_args?.siteId ?? null,
        itemCount: itemIds.length,
        itemIds,
        requestedBy: { userId: r.requested_by, name: r.requester_name },
        requestedByMe: mine,
        // A HINT for the UI; Cerbos (publish, with the row's creator and itemCount) is the authority at approval.
        canApprove: r.status === "pending" && (!mine || itemIds.length === 1),
        executionStatus: r.execution_status ?? null,
      };
    });
    return { status: 200, body: { requests } };
  }

  /**
   * `POST …/publish-requests/:approvalId/approve`: decide AND execute (D58). Cerbos decides who: the requester for a
   * single item they filed, anyone else holding the same client's grant for a batch (a self-approved batch is denied).
   * Order (a refusal before step 4 leaves the request pending and sends nothing): the row is this client's publish
   * (else 404) -> the site is still linked to this client -> the D62 pre-check on the stored items -> Cerbos as the
   * decider -> the decide UPDATE -> the in-band execution as the decider, signed `ce: true`.
   */
  async approvePublishRequest(gate: ContentGate, approvalId: string): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "request_publish");
    const client = this.clientOf(gate);
    await assertPortalClient(gate.principal, gate.tenantId, client.clientId);
    const result = await approveClientWebdeskPublish({
      tenantId: gate.tenantId,
      approvalId,
      decider: gate.principal,
      clientId: client.clientId,
      beforeDecide: async (row) => {
        const site: SiteRef = { tenantSlug: row.tenantSlug, siteId: row.siteId };
        await gate.resolveSite(this.zoneB, site);
        await assertClientMayPublish(this.zoneB, site, row.items);
      },
    });
    const w = result.webdesk;
    // The client sees the outcome, not WebDesk's internals (the staging rebuild is the agency's business).
    return {
      status: 200,
      body: {
        approvalId: result.id,
        status: result.status,
        executionStatus: w.executionStatus,
        ...(w.executionStatus === "executed" && (w.command === "content.publish" || w.command === "content.schedule")
          ? { selfPublish: w.selfPublish, reconciled: w.reconciled, items: w.items }
          : {}),
        ...(w.executionStatus === "failed" ? { error: w.error } : {}),
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // the media library (WSK-43b, client mode): read · upload token · update. Never delete.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  async listMedia(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "read");
    await gate.resolveSite(this.zoneB, site);
    if (isPlainObject(rawQuery) && "includeDeleted" in rawQuery) throw invalidRequest("a client editor cannot list deleted media");
    return this.media.list(gate, site, rawQuery);
  }

  async mintUploadToken(gate: ContentGate, site: SiteRef, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "upload");
    return this.media.mintUploadToken(gate, site, rawBody, idempotencyKey);
  }

  async updateMedia(gate: ContentGate, site: SiteRef, assetId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "update");
    return this.media.update(gate, site, assetId, rawBody, idempotencyKey);
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────

  private clientOf(gate: ContentGate): NonNullable<ContentGate["client"]> {
    if (!gate.client) throw new NotFoundException("not a client route");
    return gate.client;
  }

  private optFields(v: unknown): Record<string, unknown> | undefined {
    if (v === undefined) return undefined;
    if (!isPlainObject(v)) throw invalidRequest("fields must be an object");
    return v;
  }

  private optBlocks(v: unknown): unknown[] | undefined {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw invalidRequest("blocks must be an array");
    return v;
  }

  /** The `redirect` system collection keeps its values under seo, which is never client-editable: a client never writes it. */
  private refuseRedirect(collectionKey: string): void {
    if (collectionKey === "redirect") throw fieldNotClientEditable(["/seo/redirect"]);
  }

  private assertWritable(read: ItemRead, itemId: string): void {
    if (read.item.deletedAt !== null) throw itemDeleted(itemId);
  }

  /** One `item.get` (head, or version `n`) narrowed to what the writes need. WebDesk's typed 404s pass through. */
  private async readItem(site: SiteRef, itemId: string, version?: number): Promise<ItemRead> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const { body } = await this.zoneB.read({
      command: "item.get",
      path: ITEM_PATH,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      ...(version !== undefined ? { query: { version: String(version) } } : {}),
    });
    const b = isPlainObject(body) ? body : {};
    const item = isPlainObject(b.item) ? b.item : null;
    const v = isPlainObject(b.version) ? b.version : null;
    if (!item || !v || typeof item.collectionKey !== "string") throw new BadGatewayException({ message: "webdesk_error", reason: "item_shape" });
    return {
      item: {
        itemId: typeof item.itemId === "string" ? item.itemId : itemId,
        collectionKey: item.collectionKey,
        deletedAt: typeof item.deletedAt === "string" ? item.deletedAt : null,
        headVersion: typeof item.headVersion === "number" ? item.headVersion : 0,
      },
      version: { blocks: v.blocks, seo: v.seo },
    };
  }
}

/** The process-wide client-mode service (shares the wall cache and the egress seam with the staff BFF). */
export const webdeskClientWebsite = new WebdeskClientWebsiteService();

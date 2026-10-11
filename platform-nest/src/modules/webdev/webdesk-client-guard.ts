// WSK-49c — the ERP's half of "enforced twice" (WSK-D59) and the ERP-first check of WSK-D62.
//
// A client write is the LEAST-TRUSTED write in the system. WebDesk refuses a client's non-editable change itself
// when the editorial assertion carries `ce` (webdesk/api README "Client editors (WSK-49)"); this file is the SECOND,
// EARLIER layer D59 requires: before a client create/update/restore/publish leaves the ERP, the same rule is applied
// here and the same problem slugs are answered, so a refusal costs no egress and no ledger row for the attempt.
// WebDesk's check stays the authority; this one only ever refuses earlier. They cannot disagree about the RULE
// because the rule is not restated: `isClientEditable`, the content diff (`changedContentPointers` via
// `clientEditViolations` / `clientCreateViolations`) and `collectionAcceptsClientCreate` come from the vendored
// copy of `webdesk/delivery/vocabulary/client-editable.ts` (`./vocabulary/`, written by
// scripts/vendor-webdesk-vocabulary.mjs, drift-checked by vocabulary-vendor.test.ts). What IS restated here is
// small and is not the rule: how an authoring request becomes the stored `{blocks, seo}` (WebDesk's
// `assembleItemContent`, an API function, not part of the shared vocabulary), pinned by this file's tests.
//
// What a client can never send, and what answers it:
//   * `seo` on a write        -> 422 field-not-client-editable, pointer `/seo` (seo is never client-editable, D59).
//                                The BFF re-sends the item's EXISTING seo so an update that omits it does not remove
//                                it (a removal IS a seo change and WebDesk would refuse it; the 49b note).
//   * a non-editable path     -> 422 field-not-client-editable, the offending JSON pointers in `issues[]`.
//   * a deleted item          -> 409 item-deleted.
//   * a publish carrying a protected change (D62) -> 422 publish-not-client-editable, `/items/<index>` + pointer.
//   * a create where nothing is client-editable, or where a REQUIRED field is not client-editable (so a client could
//     never supply it) -> 422 field-not-client-editable on `/collectionKey` / the required fields, with a plain reason.
import { BadGatewayException } from "@nestjs/common";
import { WebdeskProblem, isPlainObject, type SiteRef, type WebdeskZoneB } from "./webdesk-content.service";
import {
  clientCreateViolations,
  clientEditViolations,
  collectionAcceptsClientCreate,
  isClientEditable,
  type ItemContent,
} from "./vocabulary/client-editable";
import type { CollectionComposition } from "./vocabulary/composition";
import type { FieldDef } from "./vocabulary/primitives";

const PROBLEM_BASE = "https://webdesk.gaiada.online/errors";
const MAX_LISTED = 50;
/** The system collection whose typed values live under `seo.redirect` (WebDesk `REDIRECT_COLLECTION_KEY`). Never client-editable. */
const REDIRECT_COLLECTION_KEY = "redirect";
const ITEM_READ_CONCURRENCY = 8;

// ── the problems (same slug, status and body shape as WebDesk's, so the UI has ONE shape per refusal) ──────────────────

/** 422 field-not-client-editable. Mirrors webdesk/api `fieldNotClientEditable`. */
export function fieldNotClientEditable(pointers: string[], detail?: string): WebdeskProblem {
  return new WebdeskProblem(422, {
    type: `${PROBLEM_BASE}/field-not-client-editable`,
    title: "Field not client-editable",
    status: 422,
    detail: detail ?? "A client editor may change only the fields the composition marks client-editable (ui.clientEditable). Nothing was written.",
    issues: pointers.slice(0, MAX_LISTED).map((path) => ({ path, message: "this part of the item is not client-editable" })),
    total: pointers.length,
  });
}

/** 422 publish-not-client-editable (WSK-D62). Mirrors webdesk/api `publishNotClientEditable`. */
export function publishNotClientEditable(found: { index: number; pointers: string[] }[]): WebdeskProblem {
  const all = found.flatMap((f) => f.pointers.map((p) => `/items/${f.index}${p}`));
  return new WebdeskProblem(422, {
    type: `${PROBLEM_BASE}/publish-not-client-editable`,
    title: "Publish not client-editable",
    status: 422,
    detail:
      "A client editor may publish only what a client could have changed: this publish would put live a change to a " +
      "path that is not client-editable (ui.clientEditable). Nothing was published.",
    issues: all.slice(0, MAX_LISTED).map((path) => ({ path, message: "this part of the item is not client-editable" })),
    total: all.length,
  });
}

/** 403 client-command-not-allowed: the ERP refuses a command a client may never run (schedule here), with WebDesk's slug. */
export function clientCommandNotAllowed(command: string): WebdeskProblem {
  return new WebdeskProblem(403, {
    type: `${PROBLEM_BASE}/client-command-not-allowed`,
    title: "Command not allowed for a client editor",
    status: 403,
    detail:
      `A client editor may not run ${command}. Clients create, update, restore, publish, preview and add media; ` +
      "they never delete, unpublish, schedule or delete media. Nothing was changed.",
  });
}

export function itemDeleted(itemId: string): WebdeskProblem {
  return new WebdeskProblem(409, {
    type: `${PROBLEM_BASE}/item-deleted`,
    title: "Item deleted",
    status: 409,
    detail: `Item ${itemId} has been deleted.`,
  });
}

// ── content assembly (the only restated part: WebDesk's `assembleItemContent`, minus its validation) ───────────────────

export interface ContentInput {
  fields?: Record<string, unknown>;
  blocks?: unknown[];
  seo?: Record<string, unknown>;
}

/**
 * An authoring request's `{fields, blocks, seo}` -> the stored `{blocks, seo}` a version holds. A collection that
 * declares fields stores them as `blocks[0] = { type: 'fields', props }` followed by the request's generic blocks;
 * the `redirect` system collection stores its fields under `seo.redirect` with `blocks: []`. Never modifies a value.
 * (WebDesk validates the result against the composition; the ERP does not need to: it only needs the CHANGED PATHS.)
 */
export function assembleClientContent(collectionKey: string, composition: CollectionComposition, input: ContentInput): ItemContent {
  const seoIn = isPlainObject(input.seo) ? input.seo : {};
  if (collectionKey === REDIRECT_COLLECTION_KEY) return { blocks: [], seo: { ...seoIn, redirect: input.fields ?? {} } };
  const declaresFields = Array.isArray(composition.fields);
  const tail = Array.isArray(input.blocks) ? input.blocks : [];
  return { blocks: declaresFields ? [{ type: "fields", props: input.fields ?? {} }, ...tail] : [...tail], seo: seoIn };
}

/** The fields block's props and the generic blocks of a STORED content (what the BFF re-sends when the client omits them). */
export function splitStoredContent(composition: CollectionComposition, content: { blocks: unknown; seo: unknown }): {
  fields: Record<string, unknown> | undefined;
  blocks: unknown[];
  seo: Record<string, unknown>;
} {
  const blocks = Array.isArray(content.blocks) ? content.blocks : [];
  const seo = isPlainObject(content.seo) ? content.seo : {};
  if (!Array.isArray(composition.fields)) return { fields: undefined, blocks, seo };
  const first = blocks[0];
  const fields = isPlainObject(first) && first.type === "fields" && isPlainObject(first.props) ? first.props : {};
  return { fields, blocks: blocks.slice(1), seo };
}

// ── the per-field map the portal UI renders from ─────────────────────────────────────────────────────────────────────────

export interface ClientEditableMap {
  /** Dotted path -> editable, for every declared field at every depth (`h1`, `faq`, `faq.q`). A multiple group's members use the same dotted path. */
  fields: Record<string, boolean>;
  /** Generic blocks (everything after the fields block): editable iff the collection is. */
  blocks: boolean;
  /** `seo` is NEVER client-editable (WSK-D59: the agency keeps SEO-critical fields). Always false; here so the UI need not know. */
  seo: false;
  /** Can a client create an item in this collection, and if not, why (so the UI can say it plainly). */
  create: { allowed: boolean; reason: null | "system-collection" | "nothing-editable" | "required-fields-not-editable"; blockedBy: string[] };
}

function escapeSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Every declared field's editability, computed ONLY through `isClientEditable` (the rule is never restated here). */
export function clientEditableMap(collectionKey: string, composition: CollectionComposition): ClientEditableMap {
  const fields: Record<string, boolean> = {};
  const walk = (defs: unknown, ptr: string, dotted: string): void => {
    if (!Array.isArray(defs)) return;
    for (const raw of defs) {
      if (!isPlainObject(raw) || typeof raw.name !== "string") continue;
      const f = raw as unknown as FieldDef;
      const at = `${ptr}/${escapeSegment(f.name)}`;
      const key = dotted ? `${dotted}.${f.name}` : f.name;
      fields[key] = isClientEditable(composition, at);
      if (f.primitive === "group" && Array.isArray(f.fields)) walk(f.fields, f.multiple ? `${at}/0` : at, key);
    }
  };
  if (collectionKey !== REDIRECT_COLLECTION_KEY) walk(composition.fields, "/blocks/0/props", "");
  const declaresFields = Array.isArray(composition.fields);
  return {
    fields,
    blocks: collectionKey === REDIRECT_COLLECTION_KEY ? false : isClientEditable(composition, declaresFields ? "/blocks/1" : "/blocks/0"),
    seo: false,
    create: createVerdict(collectionKey, composition, fields),
  };
}

function createVerdict(collectionKey: string, composition: CollectionComposition, editable: Record<string, boolean>): ClientEditableMap["create"] {
  if (collectionKey === REDIRECT_COLLECTION_KEY) return { allowed: false, reason: "system-collection", blockedBy: [] };
  if (!collectionAcceptsClientCreate(composition)) return { allowed: false, reason: "nothing-editable", blockedBy: [] };
  // A REQUIRED top-level field that is not client-editable can never be supplied by a client (a create must leave every
  // non-editable part absent), so the create is impossible, not merely restricted. Say so by name.
  const blockedBy = (Array.isArray(composition.fields) ? composition.fields : [])
    .filter((f) => isPlainObject(f) && f.required === true && typeof f.name === "string" && editable[f.name] === false)
    .map((f) => f.name);
  return blockedBy.length > 0 ? { allowed: false, reason: "required-fields-not-editable", blockedBy } : { allowed: true, reason: null, blockedBy: [] };
}

// ── the pre-checks ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `seo` may not be sent by a client. An empty object is "nothing" (the same as absent); anything else is refused. */
export function refuseClientSeo(body: Record<string, unknown>): void {
  if (body.seo === undefined || body.seo === null) return;
  if (isPlainObject(body.seo) && Object.keys(body.seo).length === 0) return;
  throw fieldNotClientEditable(["/seo"], "A client editor may not send seo: it is never client-editable, and the portal keeps the item's existing seo as it is. Nothing was written.");
}

/** D59 on CREATE: the collection must accept a client create, and every non-editable part of the content must be absent/null. */
export function assertClientMayCreate(collectionKey: string, composition: CollectionComposition, input: ContentInput): void {
  const verdict = clientEditableMap(collectionKey, composition).create;
  if (!verdict.allowed) {
    if (verdict.reason === "required-fields-not-editable") {
      throw fieldNotClientEditable(
        verdict.blockedBy.map((n) => `/blocks/0/props/${escapeSegment(n)}`),
        `A client editor cannot create an item in collection "${collectionKey}": the required field(s) ${verdict.blockedBy.join(", ")} are not client-editable, ` +
          "so a client cannot fill them in. Ask Gaiada to create the item; you can then edit its editable fields. Nothing was written.",
      );
    }
    throw fieldNotClientEditable(
      ["/collectionKey"],
      `Nothing in collection "${collectionKey}" is client-editable, so a client editor cannot create an item in it. Nothing was written.`,
    );
  }
  const violations = clientCreateViolations(composition, assembleClientContent(collectionKey, composition, { ...input, seo: {} }));
  if (violations.length > 0) throw fieldNotClientEditable(violations);
}

/** D59 on UPDATE / RESTORE: every path that changes against the item's HEAD must be client-editable; one bad path refuses the whole write. */
export function assertClientMayChange(composition: CollectionComposition, head: ItemContent, after: ItemContent): void {
  const violations = clientEditViolations(composition, head, after);
  if (violations.length > 0) throw fieldNotClientEditable(violations);
}

interface RawItemRead {
  item: { itemId: string; collectionKey: string; deletedAt: string | null; headVersion: number; publishedVersion: number | null };
  version: { blocks: unknown; seo: unknown };
  live: { blocks: unknown; seo: unknown } | null;
}

function parseItemRead(body: unknown, itemId: string): RawItemRead {
  const b = isPlainObject(body) ? body : {};
  const item = isPlainObject(b.item) ? b.item : null;
  const version = isPlainObject(b.version) ? b.version : null;
  if (!item || !version || typeof item.collectionKey !== "string") throw new BadGatewayException({ message: "webdesk_error", reason: "item_shape" });
  const live = isPlainObject(b.live) ? b.live : null;
  return {
    item: {
      itemId: typeof item.itemId === "string" ? item.itemId : itemId,
      collectionKey: item.collectionKey,
      deletedAt: typeof item.deletedAt === "string" ? item.deletedAt : null,
      headVersion: typeof item.headVersion === "number" ? item.headVersion : 0,
      publishedVersion: typeof item.publishedVersion === "number" ? item.publishedVersion : null,
    },
    version: { blocks: version.blocks, seo: version.seo },
    live: live ? { blocks: live.blocks, seo: live.seo } : null,
  };
}

/** The composition of a collection, from WebDesk (`collection.get`), memoised per call. */
export class CompositionReader {
  private readonly cache = new Map<string, Promise<CollectionComposition>>();
  constructor(private readonly zoneB: WebdeskZoneB, private readonly site: SiteRef) {}

  get(collectionKey: string): Promise<CollectionComposition> {
    let hit = this.cache.get(collectionKey);
    if (!hit) {
      hit = this.zoneB
        .read({
          command: "collection.get",
          path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key",
          params: { tenantSlug: this.site.tenantSlug, siteId: this.site.siteId, key: collectionKey },
        })
        .then((r) => {
          const c = isPlainObject(r.body) ? r.body.composition : undefined;
          return (isPlainObject(c) ? c : {}) as CollectionComposition;
        });
      this.cache.set(collectionKey, hit);
    }
    return hit;
  }
}

/**
 * WSK-D62: "a client may publish only what a client could have changed". For EACH requested item, every path that would
 * change on the LIVE page, from the currently PUBLISHED version (an empty baseline when it was never published: all its
 * non-empty paths count) to the version being published, must be client-editable, else the WHOLE publish is refused with
 * 422 publish-not-client-editable (`/items/<index>` + pointer) and nothing is filed or sent. The same diff WebDesk makes
 * (`changedContentPointers`); a version already live is a no-change publish and passes. Reads only.
 *
 * A deleted item is 409 item-deleted. One `item.get?version=n` per item gives the version AND the live version in one answer.
 */
export async function assertClientMayPublish(
  zoneB: WebdeskZoneB,
  site: SiteRef,
  items: ReadonlyArray<{ itemId: string; version: number }>,
): Promise<void> {
  const compositions = new CompositionReader(zoneB, site);
  const found: { index: number; pointers: string[] }[] = [];
  let next = 0;
  let failed: unknown = null;
  const reads: Array<RawItemRead | undefined> = new Array(items.length);
  const worker = async (): Promise<void> => {
    while (failed === null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        const r = await zoneB.read({
          command: "item.get",
          path: "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId",
          params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId: items[i].itemId },
          query: { version: String(items[i].version) },
        });
        reads[i] = parseItemRead(r.body, items[i].itemId);
      } catch (err) {
        failed = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ITEM_READ_CONCURRENCY, items.length) }, worker));
  if (failed !== null) throw failed;

  for (const [index, read] of reads.entries()) {
    const r = read as RawItemRead;
    if (r.item.deletedAt !== null) throw itemDeleted(r.item.itemId);
    const composition = await compositions.get(r.item.collectionKey);
    const next_ = { blocks: r.version.blocks, seo: r.version.seo };
    const pointers = r.live
      ? clientEditViolations(composition, { blocks: r.live.blocks, seo: r.live.seo }, next_)
      : clientCreateViolations(composition, next_); // never published: an empty baseline
    if (pointers.length > 0) found.push({ index, pointers });
  }
  if (found.length > 0) throw publishNotClientEditable(found);
}

/** A client may never schedule: WebDesk's `content.schedule` is not on its allow-list. */
export function refuseClientSchedule(): never {
  throw clientCommandNotAllowed("content.schedule");
}

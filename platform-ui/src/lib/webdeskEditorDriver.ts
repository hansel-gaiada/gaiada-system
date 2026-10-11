// WSK-49d — the seams that let the Website workspace's own components run in CLIENT MODE.
//
// TYPES ONLY (no runtime, no imports of server code at run time), so the shared components and the portal can use
// them without pulling `server-only` into the browser. The staff editor never builds any of this: every prop
// that takes one is OPTIONAL and absent means exactly what it meant before WSK-49d, so the staff editor's behaviour
// is unchanged by construction (its existing tests run untouched).
//
// WHY A DRIVER AND NOT A FORK. The portal's editor must be the same editor: the same FieldEditor tree, the same
// 422/409/stale/unconfirmed states, the same preview, history and media. What differs is WHICH server actions it
// calls (`/api/:t/portal/clients/:clientId/website/…` instead of `/api/:t/modules/webdev/content/…`), and a few
// things that do not exist for a client (delete, unpublish, schedule, twin creation, seo, the staff publish bar).
// A driver is the first, `ClientModeCfg` is the second.
import type { ReactNode } from "react";
import type { EditorBundle } from "./webdeskContent";
import type { SiteScope } from "./webdeskContentActions";
import type {
  Block, ItemDetail, ItemRef, ItemWriteResult, PreviewLink, WdResult,
} from "./webdeskContentModel";
import type { MediaDeleted, MediaListBody, MediaQuery, MediaUsage, MediaWriteResult, UploadToken, MediaAsset } from "./webdeskMediaModel";

/** What the item editor sends on a save. A CLIENT save sends `{ baseVersion, fields, note }` only: `blocks` and `seo`
 *  are the BFF's to refill from the head (§16j), so a client never states them. */
export interface EditorSaveInput {
  baseVersion: number;
  fields: Record<string, unknown>;
  blocks?: Block[];
  seo?: Record<string, unknown>;
  note?: string;
}

export interface EditorCreateInput {
  collectionKey: string;
  locale: string;
  slug: string;
  twinOf: string | null;
  fields: Record<string, unknown>;
  blocks: Block[];
  seo?: Record<string, unknown>;
  note?: string;
}

export type EditorWriteFailure = Exclude<WdResult<ItemWriteResult>, { kind: "ok" }>;

/** The item editor's server calls. The staff editor's own are bound in `ItemEditor.tsx`; the portal's in `portalWebsiteDriver.ts`. */
export interface EditorDriver {
  refreshEditor(scope: SiteScope, collectionKey: string, slug: string, locale: string): Promise<WdResult<EditorBundle>>;
  getItemHead(scope: SiteScope, itemId: string): Promise<WdResult<ItemDetail>>;
  saveItem(scope: SiteScope, itemId: string, input: EditorSaveInput): Promise<WdResult<ItemWriteResult>>;
  /** Create, then open the new item from the server (success redirects; only a failure returns). */
  createAndOpen(scope: SiteScope, input: EditorCreateInput, routeBase: string): Promise<EditorWriteFailure>;
  previewItem(scope: SiteScope, itemId: string, version: number): Promise<WdResult<PreviewLink>>;
}

/** The media library's server calls. A driver WITHOUT `usage` shows no "Where it's used"; WITHOUT `remove` no Delete. */
export interface MediaDriver {
  list(scope: SiteScope, query?: MediaQuery): Promise<WdResult<MediaListBody>>;
  mintToken(scope: SiteScope, bucket: "media" | "video"): Promise<WdResult<UploadToken>>;
  update(scope: SiteScope, assetId: string, patch: { title?: string | null; alt?: Record<string, string>; tags?: string[] }, idempotencyKey?: string): Promise<WdResult<{ asset: MediaAsset }>>;
  usage?(scope: SiteScope, assetId: string): Promise<WdResult<MediaUsage>>;
  remove?(scope: SiteScope, assetId: string, idempotencyKey?: string): Promise<MediaWriteResult<MediaDeleted>>;
}

/** `clientEditable` from the BFF's item/collection read (§16j), exactly as sent. Never recomputed in the browser. */
export interface ClientEditable {
  /** One entry per declared field at every depth: `"title"`, `"faq.answer"` (a multiple group's members share one dotted path). */
  fields: Record<string, boolean>;
  blocks: boolean;
  /** Always false: SEO is the agency's. */
  seo: false;
  create: { allowed: boolean; reason: "system-collection" | "nothing-editable" | "required-fields-not-editable" | null; blockedBy: string[] };
}

/** What the editor tells the client-mode publishing panel (in place of the staff PublishBar). */
export interface ClientPublishSlot {
  item: ItemRef;
  /** The saved head version a publish would name. */
  version: number;
  dirty: boolean;
  /** Why publishing is off (read-only, stale, unconfirmed), or null. */
  blocked: string | null;
  /** The head version is the viewer's own change (D58: "Publish now" is for a change the viewer made). */
  headIsMine: boolean;
  /** Who made the latest change, when it is not the viewer (for the words beside the disabled button). */
  headAuthor: string | null;
  onItemChanged: (item: ItemRef) => void;
  onUnavailable: (reason: string) => void;
  onUnconfirmed: (what: string) => void;
}

export interface ClientModeCfg {
  clientId: string;
  /** The viewer's `users.id`: whether the head version is theirs. */
  viewerId: string;
  editable: ClientEditable;
  driver: EditorDriver;
  mediaDriver: MediaDriver;
  /** The publishing panel (self-publish ONE item, D58). Rendered by the portal so this editor imports nothing portal. */
  renderPublish: (slot: ClientPublishSlot) => ReactNode;
}

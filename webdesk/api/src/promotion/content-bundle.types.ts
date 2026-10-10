// WSK-25 — the promotion engine's own portable representation of "a site's content", exported
// from one Zone B instance's local Postgres and imported into another's (see
// ../../migrations/0008_promotion.sql's header for why this is cross-INSTANCE, not cross-row: the
// frozen 0002_content.sql schema has no `env_id` column, so "staging" and "production" content
// are separate Zone B deployments, never two rows in one database).
//
// Deliberately keyed by NATURAL identifiers (collection `key`, and the item's identity
// `localizationGroupId`+`locale`; `slug` is mutable and is not identity), never by the
// source database's own UUIDs — a target instance's `collections`/`content_items` rows were
// provisioned independently and will not share primary keys with the source, even when both
// describe "the same" logical site. Import resolves every reference locally by these natural
// keys; see content-bundle.service.ts's `applyBundle`.
//
// HONEST SCOPE LIMIT, stated once here rather than buried: `mediaAssets` carries METADATA ONLY
// (bucket_key/mime/size_bytes/scan_status). Design D-13 ("bulk media moves via per-promotion
// short-lived pre-signed URLs") describes the real object-bytes transfer mechanism; building that
// needs a live MinIO on both ends of a promotion, which this ticket does not have and must not
// fake. `applyBundle` therefore never inserts a media_assets row that claims bytes exist locally
// when they do not — see that file's own comment on `mediaAssetKeysNotTransferred`.

export interface BundleCollection {
  key: string;
  schema: unknown;
}

export interface BundleContentItem {
  collectionKey: string;
  locale: string;
  slug: string;
  localizationGroupId: string;
  blocks: unknown;
  seo: unknown;
  publishState: "draft" | "scheduled" | "published" | "unpublished";
  publishAt: string | null;
  unpublishAt: string | null;
  previewToken: string | null;
  searchText: string | null;
}

export interface BundleMediaAssetRef {
  bucketKey: string;
  mime: string;
  sizeBytes: number;
  scanStatus: "pending" | "clean" | "infected" | "error";
}

export interface ContentBundle {
  /** Informational only — `applyBundle` always writes to the CALLER-supplied target siteId, never this value. */
  siteId: string;
  exportedAt: string;
  collections: BundleCollection[];
  contentItems: BundleContentItem[];
  mediaAssets: BundleMediaAssetRef[];
}

/**
 * Who is writing a bundle, for the write plane's attribution (WSK-41, WSK-D51). The promotion
 * routes are control-channel commands without an editorial assertion, so the principal is the
 * control channel's: its subject, its kind, and the command's WS4 approval id.
 */
export interface BundleWriter {
  /** content_versions.created_by and content_items.last_published_by (ControlPrincipal.subject). */
  actor: string;
  /** attribution.pk: "automation" for an automation-initiated control call, else "human" (ControlPrincipal.automation). */
  actorKind: "human" | "automation";
  /** attribution.apr: the WS4 approval id of the promote/rollback command; null when it carries none. */
  ws4ApprovalId: string | null;
  /** content_versions.note (<= 500 chars): e.g. `promotion <runId>` / `rollback <runId>`. */
  note: string;
}

export interface ApplyBundleResult {
  collectionsWritten: number;
  /** Items inserted or updated (a slug-only update counts; an unchanged item does not). */
  itemsWritten: number;
  /** Items whose content hash, publish fields, slug and preview token already equal the bundle's: not touched, no version. */
  itemsUnchanged: number;
  /** content_versions rows appended (one per item whose content or publish state changed, or that is new). */
  versionsAppended: number;
  /** >0 only in 'restore' mode — live local items the snapshot being restored does not describe, SOFT-deleted (deleted_at) to make the restore exact. Their versions are kept. */
  itemsDeleted: number;
  /** Media object keys the bundle references that this run could NOT transfer (D-13 gap, stated honestly rather than silently dropped). */
  mediaAssetKeysNotTransferred: string[];
}

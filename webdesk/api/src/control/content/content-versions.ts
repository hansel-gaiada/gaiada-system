// WSK-41 / WSK-D51 — the ONE place a content_versions row is written.
//
// Two callers append versions: the authoring commands (content-commands.service.ts: create, adopt,
// update/restore) and the promotion import (promotion/content-bundle.service.ts: promote, rollback).
// They must agree on what a version row is, so the row's shape lives here and nowhere else:
//   * content_hash is sha256(canonicalize({blocks, seo})), computed HERE from the same blocks/seo
//     that are stored (contentHash, content-projection.ts), so a caller can never store a hash that
//     does not match the row;
//   * attribution is {pk, agt?, req?, apr?} (attributionOf below), the shape 0009 documents;
//   * the version number is chosen by the caller: nextVersionNumber() is the shared rule for a row
//     that may already have versions without a head_version (a pre-0009 row).
// content_versions is append-only for the app role (0002's REVOKE UPDATE, DELETE), so this is
// INSERT-only by construction.
import type { PoolClient } from "pg";
import { contentHash } from "./content-projection";

/** The attribution-relevant part of a principal: an EditorialPrincipal satisfies it as is. */
export interface AttributionSource {
  pk: "human" | "automation" | "agent";
  agt?: string;
  req?: string;
  apr?: string;
  /** WSK-49b: the principal is a client editor (the signed assertion carried `ce: true`). */
  clientEditor?: boolean;
}

/** content_versions.attribution: {pk, agt?, req?, apr?, ce?}. Only the fields the principal carries (`ce: "true"` marks a client editor's write, WSK-49b). */
export function attributionOf(p: AttributionSource): Record<string, string> {
  const a: Record<string, string> = { pk: p.pk };
  if (p.agt) a.agt = p.agt;
  if (p.req) a.req = p.req;
  if (p.apr) a.apr = p.apr;
  if (p.clientEditor === true) a.ce = "true";
  return a;
}

/** The next free version number for an item: one past the highest existing version row (1 when there is none). */
export async function nextVersionNumber(client: PoolClient, itemId: string): Promise<number> {
  const { rows } = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM content_versions WHERE content_item_id = $1`,
    [itemId],
  );
  return rows[0].next;
}

export interface NewVersion {
  tenantId: string;
  itemId: string;
  version: number;
  blocks: unknown;
  seo: Record<string, unknown>;
  /** content_versions.publish_state: the state the content was written in (free text, no CHECK). */
  publishState: string;
  /** Opaque principal id (EditorialPrincipal.sub, or the control channel's subject for a promotion). */
  createdBy: string;
  /** Bounded to 500 characters by 0009's CHECK. */
  note: string | null;
  attribution: Record<string, string>;
}

/** Appends one version row. Returns the stored hash and the row's created_at. */
export async function insertContentVersion(client: PoolClient, v: NewVersion): Promise<{ contentHash: string; createdAt: Date }> {
  const hash = contentHash(v.blocks, v.seo);
  const { rows } = await client.query<{ created_at: Date }>(
    `INSERT INTO content_versions
       (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by, content_hash, note, attribution)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb)
     RETURNING created_at`,
    [
      v.tenantId,
      v.itemId,
      v.version,
      JSON.stringify(v.blocks),
      JSON.stringify(v.seo),
      v.publishState,
      v.createdBy,
      hash,
      v.note,
      JSON.stringify(v.attribution),
    ],
  );
  return { contentHash: hash, createdAt: rows[0].created_at };
}

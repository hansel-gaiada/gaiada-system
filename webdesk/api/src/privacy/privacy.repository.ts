// WSK-38 — raw SQL against `submissions`/`media_assets` (owned by forms/**/media/** respectively;
// this ticket does not edit either module, only queries the same tables — the same relationship
// content.service.ts (WSK-05) and media.service.ts (WSK-07) already have to tables neither of
// THEM created). Every method here takes an already-checked-out `PoolClient` running under an
// ALREADY-ACTIVE tenant context (the caller entered it via `db.withTenant`, same discipline as
// SubmissionsRepository's own header) — `tenant_id` is still filtered explicitly in every query
// (WSK-D16 app-layer-scoping doctrine: a GUC gap must degrade to a wrong app-layer filter, never a
// silent cross-tenant read/write), redundant with RLS under normal operation.
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { SubmissionAttachmentRef } from "../forms/dto";

export type MatchedSubmissionRow = {
  id: string;
  form_def_id: string;
  status: string;
  payload: { fields?: Record<string, unknown>; attachments?: SubmissionAttachmentRef[] };
  consent_notice_text: string;
  consent_notice_version: string;
  consent_accepted_at: string;
  data_subject_ref: string | null;
  created_at: string;
  expires_at: string;
};

export type MediaAssetLookupRow = {
  id: string;
  bucket_key: string;
  mime: string;
  size_bytes: string; // bigint -> string, same as media/dto.ts's own MediaAssetRow
};

@Injectable()
export class PrivacyRepository {
  /**
   * "Matched by the identifying fields a form actually collected" (design §11/WSK-D22b), not by a
   * hardcoded field-name list: matches EITHER the `data_subject_ref` correlator (populated today
   * only from an `email` field — forms.service.ts's own `normalizeDataSubjectRef`) OR any VALUE
   * inside `payload.fields`, whatever that form's own field names happen to be — a generic
   * `jsonb_each_text` scan over the fields object rather than assuming "email"/"phone" are the
   * literal keys. Case-insensitive on both sides (`identifierNormalized` is already lower-cased by
   * identifier.ts before it reaches here). A submission already scrubbed by either purge or a
   * prior erase (`payload = '{}'`) naturally stops matching via the fields scan, but can still
   * surface via `data_subject_ref` if that column was not also cleared (purge does not clear it —
   * 0007_privacy_dsr.sql's own comment; erase does).
   */
  async findByIdentifier(client: PoolClient, tenantId: string, identifierNormalized: string): Promise<MatchedSubmissionRow[]> {
    const { rows } = await client.query<MatchedSubmissionRow>(
      `SELECT id, form_def_id, status, payload, consent_notice_text, consent_notice_version,
              consent_accepted_at, data_subject_ref, created_at, expires_at
         FROM submissions
        WHERE tenant_id = $1
          AND (
            lower(data_subject_ref) = $2
            OR EXISTS (
              SELECT 1 FROM jsonb_each_text(COALESCE(payload -> 'fields', '{}'::jsonb)) AS kv(k, v)
               WHERE lower(v) = $2
            )
          )
        ORDER BY created_at DESC`,
      [tenantId, identifierNormalized],
    );
    return rows;
  }

  async findMediaAssetsByIds(client: PoolClient, tenantId: string, ids: string[]): Promise<MediaAssetLookupRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await client.query<MediaAssetLookupRow>(
      `SELECT id, bucket_key, mime, size_bytes FROM media_assets WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, ids],
    );
    return rows;
  }

  /**
   * The erasure write, per migrations/0007_privacy_dsr.sql's resolution: SCRUB, don't DELETE.
   * `data_subject_ref` is nulled (unlike the time-based purge job, which leaves it — a known,
   * reported inconsistency, not fixed here) so the row stops being findable by identity; consent
   * columns are DELIBERATELY untouched (they describe the notice shown/accepted, not the subject's
   * own data — see the migration's header). Caller must already be inside a transaction; this
   * method does not BEGIN/COMMIT itself so it can be composed with the media_assets delete and the
   * dsr_requests insert atomically (privacy.service.ts's `erase()`).
   */
  async eraseSubmissions(client: PoolClient, tenantId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rows } = await client.query<{ id: string }>(
      `UPDATE submissions
          SET status = 'erased', payload = '{}'::jsonb, data_subject_ref = NULL
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        RETURNING id`,
      [tenantId, ids],
    );
    return rows.length;
  }

  /** media_assets rows carry no evidentiary purpose once their object is gone (unlike
   *  submissions — see privacy.service.ts's header) — hard DELETE, not a tombstone. Caller must
   *  have already deleted the underlying storage objects (see privacy-attachments.service.ts). */
  async deleteMediaAssets(client: PoolClient, tenantId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rows } = await client.query<{ id: string }>(
      `DELETE FROM media_assets WHERE tenant_id = $1 AND id = ANY($2::uuid[]) RETURNING id`,
      [tenantId, ids],
    );
    return rows.length;
  }

  async insertDsrRequest(
    client: PoolClient,
    input: {
      tenantId: string;
      kind: "find" | "export" | "erase";
      subjectRefHash: string;
      requestedBy: string;
      ws4ApprovalId: string | null;
      submissionCount: number;
      attachmentCount: number;
    },
  ): Promise<{ id: string; created_at: string }> {
    const { rows } = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO dsr_requests (tenant_id, kind, subject_ref_hash, requested_by, ws4_approval_id, submission_count, attachment_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        input.tenantId,
        input.kind,
        input.subjectRefHash,
        input.requestedBy,
        input.ws4ApprovalId,
        input.submissionCount,
        input.attachmentCount,
      ],
    );
    return rows[0];
  }
}

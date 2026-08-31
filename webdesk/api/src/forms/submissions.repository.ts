// WSK-10 — submissions writes. Every INSERT runs under an already-active tenant context
// (FormContextGuard already entered it before this is ever called), matching every other
// tenant-scoped repository in this codebase; the tenant_id/site_id/form_def_id columns are still
// written explicitly (WSK-D16 app-layer-scoping doctrine — a GUC gap must degrade to a wrong
// app-layer filter, never a silent cross-tenant write), redundant with RLS under normal operation.
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import type { ConsentRecord } from "./consent";
import type { SubmissionAttachmentRef } from "./dto";

export type InsertSubmissionInput = {
  tenantId: string;
  siteId: string;
  formDefId: string;
  fields: Record<string, unknown>;
  attachments: SubmissionAttachmentRef[];
  consent: ConsentRecord;
  retentionDays: number;
  dataSubjectRef: string | null;
};

export type SubmissionRow = {
  id: string;
  status: string;
  expires_at: string;
  created_at: string;
};

@Injectable()
export class SubmissionsRepository {
  constructor(private readonly db: DbService) {}

  async insert(client: PoolClient, input: InsertSubmissionInput): Promise<SubmissionRow> {
    const payload = { fields: input.fields, attachments: input.attachments };
    const { rows } = await client.query<SubmissionRow>(
      `INSERT INTO submissions (
         tenant_id, site_id, form_def_id, payload, status,
         consent_notice_text, consent_notice_version, consent_accepted_at,
         data_subject_ref, expires_at
       )
       VALUES ($1, $2, $3, $4::jsonb, 'received', $5, $6, now(), $7, now() + make_interval(days => $8))
       RETURNING id, status, expires_at, created_at`,
      [
        input.tenantId,
        input.siteId,
        input.formDefId,
        JSON.stringify(payload),
        input.consent.text,
        input.consent.version,
        input.dataSubjectRef,
        input.retentionDays,
      ],
    );
    return rows[0];
  }

  /** WSK-38's forward-looking hook (0003_forms.sql's own comment on `data_subject_ref`) —
   *  find-by-tenant-and-correlator, used by the cross-tenant RLS probe test to prove the row this
   *  ticket wrote is invisible outside its own tenant context. Not exposed via any HTTP route in
   *  this ticket — a read-facing submissions endpoint is Sites-tab/console territory (WSK-23/24),
   *  out of scope here. */
  async findById(id: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query(`SELECT * FROM submissions WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
}

// M5-L1/L2 — forms.submission.get: the control-plane read the ERP makes AFTER it sees a Zone B
// `form.received` fact. That fact is ids-only (no personal data on the bus; inbound events are never
// trusted as data), so the authoritative copy of one submission is fetched here, over the authenticated
// control channel.
//
// TENANCY. The route's tenant slug is resolved first (platform context; an unknown or archived tenant is
// the SAME 404 as an unknown submission, so there is no existence oracle). The submission is then read
// under THAT tenant's `webdesk.tenant_ctx` (RLS is the wall) AND filtered on its tenant_id (the query is
// the second wall): a submission id that belongs to tenant B, asked for through tenant A's slug, matches
// zero rows and is the uniform 404.
//
// GONE. A purged (retention) or erased (privacy.erase) submission no longer holds the data, and what is
// left (a tombstone consent text, an empty payload) must not be served as if it were the submission:
// 410 `submission-gone`. The ERP reads that as "nothing to import", not as a failure.
//
// Like every control read (content-reads.service.ts) it is a live SELECT, takes no editorial assertion
// and writes no audit row.
import { Injectable } from "@nestjs/common";
import { DbService } from "../../db/db.service";
import { ControlProblem } from "../content/content-problem";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubmissionGetResult {
  submissionId: string;
  formId: string;
  formKey: string;
  /** The tenant slug: the Zone B `form.received` fact calls it `siteSlug` (see forms.service.ts). */
  siteSlug: string;
  createdAt: string;
  status: string;
  fields: Record<string, unknown>;
  consent: { text: string; version: string; acceptedAt: string };
  attribution: Record<string, unknown> | null;
  /** null = unknown = NO consent. */
  visitorConsent: Record<string, unknown> | null;
}

type Row = {
  id: string;
  form_def_id: string;
  form_key: string;
  status: string;
  payload: { fields?: Record<string, unknown> } | null;
  consent_notice_text: string;
  consent_notice_version: string;
  consent_accepted_at: Date | string;
  attribution: Record<string, unknown> | null;
  visitor_consent: Record<string, unknown> | null;
  created_at: Date | string;
};

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export const submissionNotFound = () =>
  new ControlProblem(404, "submission-not-found", "Submission not found", "No such submission for this tenant.");
export const submissionGone = () =>
  new ControlProblem(410, "submission-gone", "Submission gone", "This submission was purged or erased; its data no longer exists.");

@Injectable()
export class FormsReadsService {
  constructor(private readonly db: DbService) {}

  async getSubmission(tenantSlug: string, submissionId: string): Promise<SubmissionGetResult> {
    if (!UUID_RE.test(submissionId)) throw submissionNotFound();
    const tenant = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string; slug: string; status: string }>(
        `SELECT id, slug, status FROM tenants WHERE slug = $1`,
        [tenantSlug],
      );
      return rows[0] ?? null;
    });
    if (!tenant || tenant.status !== "active") throw submissionNotFound();

    const row = await this.db.withTenant(tenant.id, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT s.id, s.form_def_id, f.key AS form_key, s.status, s.payload,
                s.consent_notice_text, s.consent_notice_version, s.consent_accepted_at,
                s.attribution, s.visitor_consent, s.created_at
           FROM submissions s
           JOIN form_defs f ON f.id = s.form_def_id AND f.tenant_id = s.tenant_id
          WHERE s.id = $1 AND s.tenant_id = $2`,
        [submissionId, tenant.id],
      );
      return rows[0] ?? null;
    });
    if (!row) throw submissionNotFound();
    if (row.status === "purged" || row.status === "erased") throw submissionGone();

    return {
      submissionId: row.id,
      formId: row.form_def_id,
      formKey: row.form_key,
      siteSlug: tenant.slug,
      createdAt: iso(row.created_at),
      status: row.status,
      fields: row.payload?.fields ?? {},
      consent: { text: row.consent_notice_text, version: row.consent_notice_version, acceptedAt: iso(row.consent_accepted_at) },
      attribution: row.attribution ?? null,
      visitorConsent: row.visitor_consent ?? null,
    };
  }
}

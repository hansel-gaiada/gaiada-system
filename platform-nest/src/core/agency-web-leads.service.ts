// M5-L4 — a gaiada.com (WebDesk) form submission becomes an `agency_leads` row, `source = 'web'`.
// Plan: docs/plans/2026-10-11-webdesk-m5-plan.md (M5-L4). Shared contract: WebDesk's control-plane read
// `forms.submission.get { siteSlug, submissionId }` (M5-L2), impact LOW, 410 `submission-gone` for a
// purged/erased submission.
//
// ── TRUST MODEL ─────────────────────────────────────────────────────────────────────────────────────
// The Zone B `form.received` event is ids-only and never trusted as DATA: it is only a wake-up that names a
// submission. The authoritative copy is FETCHED over the existing authenticated ERP→WebDesk control client
// (mTLS + Keycloak client-credentials; `webdeskZoneB.read`, the same egress seam the Website workspace uses —
// no new credential). The cross-company wall is the one the Website workspace uses too: the WebDesk tenant
// slug must be an ACTIVE tenant whose `company_ref` is THIS company (`tenant.list?companyRef=`, filtered in
// Zone B's SQL), else a uniform 404 — so a valid body naming another company's slug creates nothing.
//
// ── PRIVACY ─────────────────────────────────────────────────────────────────────────────────────────
// Field VALUES (names, emails, phones, messages) are never logged, never put in an event payload and never
// put in an error message. Logs carry the submission id, the form key (configuration, not personal data) and
// typed outcome tokens only. `agency_leads` itself legitimately holds the contact fields; that is its job.
//
// ── IDEMPOTENCY ─────────────────────────────────────────────────────────────────────────────────────
// `ux_lead_tenant_submission` (partial unique on (tenant_id, submission_ref)) is the mechanism; a repeat
// returns the EXISTING lead and does not re-fetch (so it also survives the submission being purged later).
//
// ── DEFAULT OFF ─────────────────────────────────────────────────────────────────────────────────────
// `AGENCY_WEB_LEADS_ENABLED=1` is required. Owner ruling: each phase waits for counsel. Read at call time
// (not at import) so a test or an operator flips it without a rebuild.
//
// ── PLAIN TENANT WALL ───────────────────────────────────────────────────────────────────────────────
// Like every other `agency_leads` access (agency-leads.service.ts header, design §3.1): `withTenants` with NO
// `{ modules }` option; passing one would read/write zero rows.
import { Logger } from "@nestjs/common";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { emitEvent } from "../events/outbox.service";
import { scrubText } from "./scrub";
import { webdeskZoneB, WebdeskProblem } from "../modules/webdev/webdesk-content.service";

const logger = new Logger("AgencyWebLeads");

const ORG_NAME_CAP = 300;
const CONTACT_NAME_CAP = 200;
const CONTACT_EMAIL_CAP = 320;
const CONTACT_PHONE_CAP = 40;
const ORG_NAME_FALLBACK = "(not given)";
const ATTRIBUTION_MAX_BYTES = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBMISSION_PATH = "/control/v1/tenants/:tenantSlug/forms/submissions/:submissionId";

export function webLeadsEnabled(): boolean {
  return process.env.AGENCY_WEB_LEADS_ENABLED === "1";
}

// ───────────────────────────────────────────────────────────────────────────── per-form mapping
/** Which submitted field id feeds which lead column. Keyed by the WebDesk FORM KEY. The ids are the site's
 *  real field ids (gaiada-web-revamp `src/config/forms.ts` CONTACT_FIELDS / AUDIT_FIELDS and
 *  `src/lib/forms/onboard-questions.ts`) — "the integration contract": a renamed id on the site is a
 *  breaking change that must update this table. Each lead column lists candidate ids in priority order. */
export interface FormMapping {
  orgName: readonly string[];
  contactName: readonly string[];
  contactEmail: readonly string[];
  contactPhone: readonly string[];
}

export const WEB_FORM_MAPPINGS: Readonly<Record<string, FormMapping>> = {
  // The /contact/ form: name, selectcontact (preferred channel), email_address, phone_number, message.
  // It has no business-name field, so org_name falls back to the contact's name.
  contact: { orgName: [], contactName: ["name"], contactEmail: ["email_address"], contactPhone: ["phone_number"] },
  // The free-audit form: name, email_address, phone_number, website_url, business_type, message.
  // `business_type` is a CATEGORY chip, not a name, so it is deliberately not used as org_name.
  audit: { orgName: [], contactName: ["name"], contactEmail: ["email_address"], contactPhone: ["phone_number"] },
  // The discovery intake (SCHEMA_VERSION onboard.2026-09-07.v1): org_name, contact_name, contact_email,
  // contact_phone are its own ids.
  onboard: { orgName: ["org_name"], contactName: ["contact_name"], contactEmail: ["contact_email"], contactPhone: ["contact_phone"] },
};

export interface MappedLead {
  orgName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

function firstString(fields: Record<string, unknown>, ids: readonly string[]): string | null {
  for (const id of ids) {
    const v = fields[id];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Pure. `null` when the form key has no mapping (the caller creates nothing). `org_name` is NOT NULL in the
 *  table: business-name field, else the contact's name, else "(not given)". Free text (names) goes through
 *  `scrubText`; email/phone are structured identifiers and are not (scrubText would rewrite a real address). */
export function mapSubmissionToLead(formKey: string | null | undefined, fields: unknown): MappedLead | null {
  const mapping = typeof formKey === "string" && Object.prototype.hasOwnProperty.call(WEB_FORM_MAPPINGS, formKey)
    ? WEB_FORM_MAPPINGS[formKey]
    : null;
  if (!mapping) return null;
  const f = fields !== null && typeof fields === "object" && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {};
  const rawOrg = firstString(f, mapping.orgName);
  const rawName = firstString(f, mapping.contactName);
  const rawEmail = firstString(f, mapping.contactEmail);
  const rawPhone = firstString(f, mapping.contactPhone);
  const contactName = rawName ? scrubText(rawName).text.slice(0, CONTACT_NAME_CAP) : null;
  const orgSource = rawOrg ?? rawName;
  const orgName = orgSource ? scrubText(orgSource).text.slice(0, ORG_NAME_CAP) : ORG_NAME_FALLBACK;
  return {
    orgName: orgName.trim() ? orgName : ORG_NAME_FALLBACK,
    contactName,
    contactEmail: rawEmail ? rawEmail.slice(0, CONTACT_EMAIL_CAP) : null,
    contactPhone: rawPhone ? rawPhone.slice(0, CONTACT_PHONE_CAP) : null,
  };
}

function plainObjectOrNull(v: unknown, maxBytes: number): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  return JSON.stringify(v).length > maxBytes ? null : (v as Record<string, unknown>);
}

// ──────────────────────────────────────────────────────────────────────────────────── the service
export type WebLeadOutcome =
  | { outcome: "created"; leadId: string }
  | { outcome: "existing"; leadId: string }
  | { outcome: "gone" }
  | { outcome: "unmapped_form" }
  | { outcome: "disabled" }
  | { outcome: "invalid" };

/** The egress seam, swappable by a test. */
export interface WebLeadsDeps {
  /** The cross-company wall: resolves (throws a 404) unless `siteSlug` is an active tenant of `tenantId`. */
  assertTenantOwnsSite(tenantId: string, siteSlug: string): Promise<void>;
  /** `forms.submission.get`; resolves the parsed body, or `"gone"` for a 410. Other failures throw. */
  fetchSubmission(siteSlug: string, submissionId: string): Promise<Record<string, unknown> | "gone">;
}

export const defaultWebLeadsDeps: WebLeadsDeps = {
  async assertTenantOwnsSite(tenantId, siteSlug) {
    await webdeskZoneB.resolveEditableTenant(tenantId, siteSlug);
  },
  async fetchSubmission(siteSlug, submissionId) {
    try {
      const { body } = await webdeskZoneB.read({
        command: "forms.submission.get",
        path: SUBMISSION_PATH,
        params: { tenantSlug: siteSlug, submissionId },
      });
      return body as Record<string, unknown>;
    } catch (err) {
      if (err instanceof WebdeskProblem && err.getStatus() === 410) return "gone";
      throw err;
    }
  },
};

async function findExisting(tenantId: string, submissionId: string): Promise<string | null> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM agency_leads WHERE tenant_id = $1 AND submission_ref = $2 AND deleted_at IS NULL`,
      [tenantId, submissionId],
    ),
  );
  return rows[0]?.id ?? null;
}

export interface CreateFromWebSubmissionInput {
  tenantId: string;
  siteSlug: string;
  submissionId: string;
}

/** Fetch the submission from WebDesk, map it, insert idempotently. Throws only for infrastructure failures
 *  (WebDesk unreachable / refusing us / the wall's 404) so the caller can answer or retry; every legitimate
 *  business outcome is a typed `WebLeadOutcome`. The CALLER authorizes (Cerbos `create` on `agency_lead`) or is
 *  the trusted event path; this function authorizes nothing. */
export async function createLeadFromWebSubmission(
  input: CreateFromWebSubmissionInput,
  deps: WebLeadsDeps = defaultWebLeadsDeps,
): Promise<WebLeadOutcome> {
  if (!webLeadsEnabled()) return { outcome: "disabled" };
  const { tenantId, siteSlug, submissionId } = input;
  if (!UUID_RE.test(submissionId) || !siteSlug) return { outcome: "invalid" };

  // The wall FIRST: another company's slug never reaches the fetch or the insert.
  await deps.assertTenantOwnsSite(tenantId, siteSlug);

  const existingId = await findExisting(tenantId, submissionId);
  if (existingId) return { outcome: "existing", leadId: existingId };

  const fetched = await deps.fetchSubmission(siteSlug, submissionId);
  if (fetched === "gone") {
    logger.log(`submission ${submissionId}: gone (purged or erased); no lead created`);
    return { outcome: "gone" };
  }
  if (fetched === null || typeof fetched !== "object" || fetched.submissionId !== submissionId) {
    // Shape/identity mismatch: never guess which submission this was. Ids only in the message.
    throw new Error(`forms.submission.get answered an unexpected shape for submission ${submissionId}`);
  }

  const formKey = typeof fetched.formKey === "string" ? fetched.formKey : null;
  const mapped = mapSubmissionToLead(formKey, fetched.fields);
  if (!mapped) {
    logger.warn(`submission ${submissionId}: form key ${formKey === null ? "(absent)" : `'${formKey.slice(0, 64)}'`} has no lead mapping; no lead created`);
    return { outcome: "unmapped_form" };
  }

  const attribution = plainObjectOrNull(fetched.attribution, ATTRIBUTION_MAX_BYTES);
  const visitorConsent = plainObjectOrNull(fetched.visitorConsent, ATTRIBUTION_MAX_BYTES);
  const id = newId();
  const result = await withTenants([tenantId], async (c) => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO agency_leads
         (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status,
          origin_site, origin_form, submission_ref, attribution, visitor_consent, web_site_slug)
       VALUES ($1, $2, $3, $4, $5, $6, 'web', 'new', $7, $8, $9, $10::jsonb, $11::jsonb, $12)
       ON CONFLICT (tenant_id, submission_ref) WHERE submission_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        id, tenantId, mapped.orgName, mapped.contactName, mapped.contactEmail, mapped.contactPhone,
        config.originSite, formKey, submissionId,
        attribution === null ? null : JSON.stringify(attribution),
        visitorConsent === null ? null : JSON.stringify(visitorConsent),
        siteSlug.slice(0, 200),
      ],
    );
    if (ins.rows[0]) {
      // Ids and the form key only: the outbox must carry no personal data (and no org name).
      await emitEvent(c, tenantId, "agency_lead", id, "agency.lead.created", {
        source: "web", originForm: formKey, submissionRef: submissionId,
      });
      return { created: true as const, leadId: id };
    }
    const again = await c.query<{ id: string }>(
      `SELECT id FROM agency_leads WHERE tenant_id = $1 AND submission_ref = $2`,
      [tenantId, submissionId],
    );
    return { created: false as const, leadId: again.rows[0].id };
  });
  return result.created ? { outcome: "created", leadId: result.leadId } : { outcome: "existing", leadId: result.leadId };
}

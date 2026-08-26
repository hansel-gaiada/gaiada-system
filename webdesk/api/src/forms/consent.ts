// WSK-10 / WSK-D22c — "consent is recorded per submission: which notice text and which version
// the submitter accepted, stored alongside the payload — consent you cannot evidence is consent
// you do not have" (webdesk-design.md §11).
//
// `submissions.consent_notice_text` / `consent_notice_version` are BOTH `NOT NULL`
// (0003_forms.sql) but `form_defs` carries only `consent_notice_version` — there is no
// `consent_notice_text` column anywhere in the frozen schema (flagged as a gap in the ticket
// report; a proper fix is a senior-db-owned migration adding one). The convention this ticket
// adopts, entirely inside the existing `form_defs.schema` jsonb (no DDL needed):
//   schema.consentNotice.text — the notice text currently in force for this form.
// `form_defs.consent_notice_version` (the real column) stays the version of record. Both fall
// back to a generic default (forms.config.ts) so the NOT NULL columns are ALWAYS populated with
// something evidenced, never silently blank — a form that never configured consent copy still
// gets a real, auditable default notice rather than an empty string.
//
// Consent itself is a UNIVERSAL requirement of this endpoint (`consent: true` in the request
// body), not something a form author can opt out of by omitting a "consent"-typed field from
// their schema — WSK-D22c's own wording ("per submission", not "per form that remembered to ask")
// reads as a floor every submission clears, not a per-tenant option.
import { formsConfig } from "./forms.config";
import type { FormSchemaDef } from "./form-schema.service";

export type ConsentRecord = { text: string; version: string };

export function resolveConsentRecord(
  schema: FormSchemaDef | null | undefined,
  consentNoticeVersionColumn: string | null,
): ConsentRecord {
  const text = schema?.consentNotice?.text?.trim();
  const version = consentNoticeVersionColumn?.trim();
  return {
    text: text && text.length > 0 ? text : formsConfig.defaultConsentNoticeText,
    version: version && version.length > 0 ? version : formsConfig.defaultConsentNoticeVersion,
  };
}

/** Body-level consent flag must be the literal boolean `true` — a truthy string, `1`, or absent
 *  field all refuse. This is the ONE thing this endpoint will not sanitize/coerce around: a
 *  submitter who did not affirmatively tick the box did not consent. */
export function hasAffirmedConsent(body: { consent?: unknown }): boolean {
  return body.consent === true;
}

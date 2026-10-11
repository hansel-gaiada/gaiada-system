// WSK-38 — the one normalization/hashing seam every privacy/** file goes through for a data
// subject's identifying value (design §11/WSK-D22b: "matched by the identifying fields a form
// actually collected — email/phone are the realistic keys"). Two rules, both load-bearing:
//
//   1. `normalizeIdentifier` is the ONLY place a caller-supplied identifier is trimmed/lowercased
//      before it touches a query — matching forms/consent.ts's own `normalizeDataSubjectRef`
//      convention exactly (trim + lowercase), so a submission's `data_subject_ref` (written at
//      submit time by that file) and a DSR command's search term are normalized the SAME way and
//      therefore actually compare equal.
//   2. `hashIdentifier` is the ONLY place the identifier is allowed into anything durable
//      (dsr_requests.subject_ref_hash, this command's own audit_entries.args_hash input). Never
//      the raw value — see migrations/0007_privacy_dsr.sql's header for why: a ledger proving an
//      erasure happened must not itself become a second, un-erasable copy of the thing erased.
import { createHash } from "node:crypto";
import { normalizePhone } from "../forms/subject-refs";

export function normalizeIdentifier(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Domain-separated (prefixed) so this hash can never be confused with, or collided against, a
 *  hash of the same string computed for an unrelated purpose elsewhere in this codebase. */
export function hashIdentifier(normalized: string): string {
  return createHash("sha256").update(`webdesk:privacy:subject:${normalized}`).digest("hex");
}

export type ResolvedSubject = {
  /** trim + lower-case of what the caller typed: the email correlator and the raw field-value scan key. */
  normalized: string;
  /** The phone correlator (digits with country code, forms/subject-refs.ts) when the identifier is a phone number, else null. */
  phoneRef: string | null;
  /** What dsr_requests.subject_ref_hash and the audit args hash are computed from: the phone digits for a phone
   *  (so "+62 812-34" and "62812 34" are one subject in the ledger), else `normalized`. Only ever hashed. */
  hashBasis: string;
  /**
   * M5-G6: present ONLY when the identifier is a uuid: it is then also looked up as a CONSENT ID in consent_records
   * (a browser-held random id, not a person: privacy.find counts its records, export returns them, erase deletes them).
   * Absent otherwise, so the shape for every other identifier is exactly what it was.
   */
  consentId?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** M5-L1: an identifier is looked up as an email/raw value AND, when it parses as a phone number, as a phone ref. */
export function resolveSubject(raw: string): ResolvedSubject {
  const normalized = normalizeIdentifier(raw);
  const phoneRef = normalized.includes("@") ? null : normalizePhone(raw);
  const subject: ResolvedSubject = { normalized, phoneRef, hashBasis: phoneRef ?? normalized };
  if (UUID_RE.test(normalized)) subject.consentId = normalized;
  return subject;
}

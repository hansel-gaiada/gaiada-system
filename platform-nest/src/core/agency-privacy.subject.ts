// M5-G5 — the data subject of an agency-intake privacy request: how a person is identified, hashed and
// matched, and which AD-1 answers are "person fields". PURE: no database, no I/O, so every rule here is
// unit-tested without services (agency-privacy.subject.test.ts).
//
// Addendum: legal/website-visitor-addendum.md §9.3 items 3, 7, 8, 9 (R-V11, R-V12).
//
// ── NORMALISATION (identical to WebDesk's, on purpose) ──────────────────────────────────────────────
// Email: trim + lower-case (webdesk/api/src/forms/subject-refs.ts `normalizeEmail`).
// Phone: `normalizePhone` below is a byte-for-byte port of the same file's function:
//   1. only digits, spaces, `-`, `.`, `(`, `)` and one leading `+` are accepted, else no ref;
//   2. every non-digit is removed; a leading `+` or `00` (the international call prefix) is dropped;
//   3. 7 to 15 digits must remain (E.164 allows 15), else no ref;
//   4. a national leading 0 is NOT rewritten to a country code (no country is hard-wired into a
//      multi-tenant platform: the internal-now-SaaS-later ruling). "0812…" and "+62 812…" are two keys.
// The two projects share no package (root rule: standalone projects), so the port is kept honest by a
// parity table in the unit test, not by an import.
//
// ── HASHING ──────────────────────────────────────────────────────────────────────────────────────────
// `subjectHash` is the ONLY form in which an identifier is ever stored (the DSR ledger, the suppression
// list). It is SHA-256 over a domain-separated string, and the domain is deliberately WebDesk's own
// (`webdesk:privacy:subject:`, webdesk/api/src/privacy/identifier.ts `hashIdentifier`) with the same basis
// (the lower-cased email, or the phone digits). So one person's request produces the SAME hash in WebDesk's
// `dsr_requests` and in this platform's `agency_dsr_requests`, which is what the §9.3 item 5 fan-out needs
// to correlate the two ledgers without either one holding the plaintext. Residual, the same as WebDesk's:
// a phone number has few enough digits that its hash can be brute-forced; the ledgers are tenant-walled
// and never leave the database.
import { createHash } from "node:crypto";

/** WebDesk's own domain prefix (see the header for why it is shared, not renamed). */
export const SUBJECT_HASH_DOMAIN = "webdesk:privacy:subject:";

const PHONE_CHARS = /^\+?[\d\s().-]+$/;
const EMAIL_MAX = 320;
const PHONE_MAX = 40;

/** trim + lower-case; null for an empty string. */
export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/** Digits with the country code if one was given; null when it is not a usable phone number (header). */
export function normalizePhone(raw: string): string | null {
  const v = raw.trim();
  if (!PHONE_CHARS.test(v)) return null;
  let digits = v.replace(/\D/g, "");
  if (v.startsWith("+")) {
    // the digits already are country code + number
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** SHA-256 hex of the domain-separated basis. The basis is an ALREADY-normalised email or phone. */
export function subjectHash(basis: string): string {
  return createHash("sha256").update(`${SUBJECT_HASH_DOMAIN}${basis}`).digest("hex");
}

/** One data subject: at least one of the two keys. Plaintext lives only in memory for the request. */
export interface Subject {
  email: string | null;
  phone: string | null;
  emailHash: string | null;
  phoneHash: string | null;
}

export type SubjectParse = { ok: true; subject: Subject } | { ok: false; reason: "subject_invalid"; message: string };

/**
 * Parse a request body's `{ email?, phone? }`. At least one must be present and valid. A present-but-
 * invalid key refuses the whole request rather than being dropped: an operator who typed a malformed phone
 * next to a valid email must not get a confident "no data" for the half that was ignored.
 */
export function parseSubject(body: unknown): SubjectParse {
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const refuse = (message: string): SubjectParse => ({ ok: false, reason: "subject_invalid", message });
  let email: string | null = null;
  let phone: string | null = null;
  if (b.email !== undefined && b.email !== null) {
    if (typeof b.email !== "string" || b.email.length > EMAIL_MAX) return refuse("email must be a string of at most 320 characters");
    const e = normalizeEmail(b.email);
    if (!e || !/^[^\s@]+@[^\s@]+$/.test(e)) return refuse("email is not an email address");
    email = e;
  }
  if (b.phone !== undefined && b.phone !== null) {
    if (typeof b.phone !== "string" || b.phone.length > PHONE_MAX) return refuse("phone must be a string of at most 40 characters");
    const p = normalizePhone(b.phone);
    if (!p) return refuse("phone must be 7 to 15 digits, optionally with a leading + or 00, spaces, dashes, dots or brackets");
    phone = p;
  }
  if (!email && !phone) return refuse("give the person's email, phone, or both");
  return {
    ok: true,
    subject: { email, phone, emailHash: email ? subjectHash(email) : null, phoneHash: phone ? subjectHash(phone) : null },
  };
}

/** True when a stored contact pair belongs to the subject (either key matching is enough). */
export function contactMatches(subject: Pick<Subject, "email" | "phone">, stored: { email?: unknown; phone?: unknown }): boolean {
  if (subject.email && typeof stored.email === "string" && normalizeEmail(stored.email) === subject.email) return true;
  if (subject.phone && typeof stored.phone === "string" && normalizePhone(stored.phone) === subject.phone) return true;
  return false;
}

/** The hashes a stored contact pair would be suppressed under (normalised, then hashed). */
export function contactHashes(stored: { email?: unknown; phone?: unknown }): { kind: "email" | "phone"; hash: string }[] {
  const out: { kind: "email" | "phone"; hash: string }[] = [];
  const e = typeof stored.email === "string" ? normalizeEmail(stored.email) : null;
  const p = typeof stored.phone === "string" ? normalizePhone(stored.phone) : null;
  if (e) out.push({ kind: "email", hash: subjectHash(e) });
  if (p) out.push({ kind: "phone", hash: subjectHash(p) });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────── AD-1 person fields
/**
 * The AD-1 answers that hold personal data about a PERSON (agency-discovery-questionnaire.ts, schema
 * `agency-discovery.2026-09-05.v1`). Everything else in the questionnaire is about the prospect's
 * BUSINESS (offering, audience, brand, pages, platform…), which erasure keeps: those answers are the
 * evidentiary basis of scope (AD-1 design §3.2), and a person's erasure right does not reach a company's
 * description of itself.
 *   - the primary contact block: contact_name, contact_role, contact_email, contact_phone;
 *   - the answers whose help text asks for a named person: decision_makers ("Names and roles of everyone
 *     who can approve"), approval_process ("Who reviews what"), content_owner_dates ("Name a person and a
 *     date"), lead_routing ("the person responsible"), dns_owner ("Name the person or company"),
 *     maintenance_owner ("Content owner and technical owner").
 * Free text elsewhere (`anything_else`, …) is handled by `scrubAnswers`'s second pass, which removes the
 * subject's own email, phone and name wherever they appear. A third party named in free text who is NOT
 * the requester is the residual the addendum already records (R-V7 / R-V12).
 */
export const AD1_PERSON_FIELDS: readonly string[] = Object.freeze([
  "contact_name", "contact_role", "contact_email", "contact_phone",
  "decision_makers", "approval_process", "content_owner_dates", "lead_routing", "dns_owner", "maintenance_owner",
]);

/** What a scrubbed value becomes. A marker, not a deletion: the review UI distinguishes "key absent" (never
 *  answered) from an answer, and an erased answer must not read as "the prospect skipped this". */
export const ERASED_MARKER = "[erased]";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every string inside a JSON value, rewritten by `fn` (arrays and objects are walked; other leaves kept). */
function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = mapStrings(x, fn);
    return out;
  }
  return v;
}

/**
 * Scrub one AD-1 `answers` object for an erasure. Two passes, both pure:
 *   1. every present AD1_PERSON_FIELDS key is replaced by ERASED_MARKER (an absent key stays absent);
 *   2. in every other string (nested arrays/objects included), each occurrence of the subject's own
 *      identifiers is replaced by ERASED_MARKER: the given email (case-insensitive), the given phone in
 *      the form it was typed, and any name in `names` of three or more characters (case-insensitive).
 * Returns the new object and how many values changed. Never mutates its input.
 */
export function scrubAnswers(
  answers: unknown,
  needles: { emails?: (string | null | undefined)[]; phones?: (string | null | undefined)[]; names?: (string | null | undefined)[] },
): { answers: Record<string, unknown>; changed: number } {
  const src = answers !== null && typeof answers === "object" && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const terms = [
    ...(needles.emails ?? []), ...(needles.phones ?? []), ...(needles.names ?? []),
  ]
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  // Longest first, so a full name is replaced before a shorter term inside it.
  const unique = [...new Set(terms.map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
  const re = unique.length > 0 ? new RegExp(unique.map(escapeRegExp).join("|"), "gi") : null;

  let changed = 0;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (AD1_PERSON_FIELDS.includes(key)) {
      if (value !== ERASED_MARKER) changed += 1;
      out[key] = ERASED_MARKER;
      continue;
    }
    if (!re) {
      out[key] = value;
      continue;
    }
    const before = JSON.stringify(value);
    const next = mapStrings(value, (s) => s.replace(re, ERASED_MARKER));
    if (JSON.stringify(next) !== before) changed += 1;
    out[key] = next;
  }
  return { answers: out, changed };
}

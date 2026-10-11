// M5-L1 — a WebDesk-local PAN / national-ID scrub for FREE-TEXT form fields, applied before persist.
//
// Why it exists: a public contact form's "message" box is where people paste things they should not
// (a card number "so you can bill me", an ID number). AD-1 (platform-nest/src/core/scrub.ts, `scrubText`)
// already redacts the "never persist in the clear" identifiers for the agency intake, but the forms path
// had no equivalent. Components share no packages, so the PATTERNS are ported here, with the source named:
//
//   Ported from platform-nest/src/core/scrub.ts `scrubText` (rules RULES[0] PAN and RULES[1] NIK) and the
//   same redaction tags: [REDACTED-PAN], [REDACTED-NIK]. If that ruleset changes, change this one by hand.
//
// What differs from the source, and why (the source is deliberately blunt; a public form must not mangle
// legitimate text):
//   - PAN: `scrubText` redacts ANY 13-19 digit run. Here a candidate must also pass the LUHN checksum (every
//     real card number does; about 9 in 10 random long numbers do not). It must not be preceded by `+` (an
//     international phone number), and when grouped with spaces or dashes the grouping must look like a
//     card (4-4-4-4 / 4-6-5), so "62 812 3456 7890" (a phone number with its country code, 13 digits)
//     is left alone whatever its checksum.
//   - NIK (Indonesian national ID, 16 digits): redacted only when the digits have a NIK's structure, i.e.
//     province code 11-94, a day 01-31 (women: +40, so 41-71) and a month 01-12. A 16-digit run that
//     fails that (an order number, a timestamp) stays. A Luhn-valid 16-digit run is a PAN first and is
//     redacted as one.
//   - Emails are NOT redacted (`scrubText` does). On a lead form a message such as "write to me at
//     a@b.co" is the whole point; the dedicated email field is the submitter's contact anyway.
//
// Scope: string values of free-text fields only. Email and tel fields, and non-string values, are never
// touched (see isContactField). Select / date values cannot carry free text (zod already constrained them
// before this runs), so scrubbing them would only cost time; they are skipped by type.
//
// Known limits, stated plainly: a 13-19 digit order number that happens to pass Luhn and is written
// contiguously WILL be redacted (about 1 in 10); a card number split in an unusual way ("4111 11 11 ...")
// will NOT be caught; no attempt is made at other countries' national IDs. This is a day-one backstop,
// not a DLP product.
import { isContactField } from "./subject-refs";
import type { FormSchemaDef } from "./form-schema.service";

export const PAN_TAG = "[REDACTED-PAN]";
export const NIK_TAG = "[REDACTED-NIK]";

/** 13 to 19 digits, each optionally followed by one space or dash, not part of a longer digit run, not after a `+`. */
const PAN_CANDIDATE = /(?<![\d+])\d(?:[ -]?\d){12,18}(?!\d)/g;
const NIK_CANDIDATE = /(?<![\d+])\d{16}(?!\d)/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Contiguous, or grouped the way card numbers are printed: 4-4-4-4(-3) or 4-6-5, one separator character throughout. */
function cardGrouping(candidate: string): boolean {
  if (!/[ -]/.test(candidate)) return true;
  const sep = candidate.includes(" ") ? " " : "-";
  if (candidate.includes(sep === " " ? "-" : " ")) return false;
  const groups = candidate.split(sep);
  if (groups.some((g) => !/^\d+$/.test(g))) return false;
  const lens = groups.map((g) => g.length);
  if (lens.length === 3 && lens[0] === 4 && lens[1] === 6 && lens[2] === 5) return true; // Amex
  const lastOk = lens[lens.length - 1] >= 1 && lens[lens.length - 1] <= 4;
  return lens.slice(0, -1).every((n) => n === 4) && lastOk;
}

/** Province 11-94, day 01-31 (+40 for women), month 01-12. The year and the serial are not checked. */
export function nikStructureValid(d: string): boolean {
  if (!/^\d{16}$/.test(d)) return false;
  const province = Number(d.slice(0, 2));
  let day = Number(d.slice(6, 8));
  const month = Number(d.slice(8, 10));
  if (day > 40) day -= 40;
  return province >= 11 && province <= 94 && day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

export type ScrubResult = { text: string; redactions: number };

export function scrubIdentifiers(input: string): ScrubResult {
  let redactions = 0;
  let text = input.replace(PAN_CANDIDATE, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !cardGrouping(m) || !luhnValid(digits)) return m;
    redactions++;
    return PAN_TAG;
  });
  text = text.replace(NIK_CANDIDATE, (m) => {
    if (!nikStructureValid(m)) return m;
    redactions++;
    return NIK_TAG;
  });
  return { text, redactions };
}

const FREE_TEXT_TYPES = new Set(["text", "textarea"]);

/**
 * Scrubs every free-text string field. Never mutates the input. `redactions` is a count only: the caller
 * may log it, but must never log what was redacted.
 */
export function scrubFreeTextFields(
  fields: Record<string, unknown>,
  schemaDef: FormSchemaDef,
): { fields: Record<string, unknown>; redactions: number } {
  const typeOf = new Map((schemaDef.fields ?? []).map((f) => [f.key, f.type]));
  const out: Record<string, unknown> = {};
  let redactions = 0;
  for (const [key, value] of Object.entries(fields)) {
    const type = typeOf.get(key);
    if (typeof value === "string" && type !== undefined && FREE_TEXT_TYPES.has(type) && !isContactField(schemaDef, key)) {
      const r = scrubIdentifiers(value);
      redactions += r.redactions;
      out[key] = r.text;
    } else {
      out[key] = value;
    }
  }
  return { fields: out, redactions };
}

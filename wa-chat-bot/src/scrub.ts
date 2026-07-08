// Ingestion scrubber (day-one spec, 5a.5). Redacts sensitive identifiers BEFORE anything
// is stored or sent to AI. This is the CANONICAL copy; ai-gateway/src/scrub.ts mirrors it
// verbatim (components are separate projects, not a shared package) — bump the version and
// keep both in sync when editing. A cross-copy version test guards drift.
//
// Default-on categories redact real-world PII with low false-positive risk. Opt-in
// categories (phone, email) are high-recall but higher false-positive, enabled via config.

export const SCRUB_RULESET_VERSION = 2;

export type RedactionType = "PAN" | "KTP" | "PASSPORT" | "NPWP" | "BANK_ACCT" | "PHONE" | "EMAIL";
export interface Redaction {
  type: RedactionType;
}
export interface ScrubResult {
  clean: string;
  redactions: Redaction[];
}

export interface ScrubOptions {
  phone?: boolean; // opt-in: Indonesian mobile numbers
  email?: boolean; // opt-in: email addresses
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

// Indonesian NIK: first 2 digits are a province code. Valid provinces are 11–96
// (with gaps, but the range check alone kills most 16-digit false positives like
// order numbers). Combined with the DDMMYY birth-date sanity check it's precise.
function looksLikeNik(d: string): boolean {
  if (d.length !== 16) return false;
  const prov = Number(d.slice(0, 2));
  if (prov < 11 || prov > 96) return false;
  let day = Number(d.slice(6, 8));
  if (day > 40) day -= 40; // females: DD + 40
  const month = Number(d.slice(8, 10));
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

export function scrub(input: string, opts: ScrubOptions = {}): ScrubResult {
  const redactions: Redaction[] = [];
  let text = input;

  // 1) PAN: 13-19 digit runs (spaces/dashes allowed) that pass Luhn.
  text = text.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      redactions.push({ type: "PAN" });
      return "[REDACTED-CARD]";
    }
    return match;
  });

  // 2) NPWP (Indonesian tax id): 99.999.999.9-999.999 or 15 bare digits, labelled or formatted.
  text = text.replace(/\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b/g, () => {
    redactions.push({ type: "NPWP" });
    return "[REDACTED-ID]";
  });
  text = text.replace(/\bNPWP\b\D{0,10}(\d{15})\b/gi, () => {
    redactions.push({ type: "NPWP" });
    return "NPWP [REDACTED-ID]";
  });

  // 3) KTP/NIK: labelled 16-digit, OR unlabelled 16-digit that validates as a real NIK.
  text = text.replace(/\b(NIK|KTP)\b\D{0,12}(\d{16})\b/gi, (_m, label) => {
    redactions.push({ type: "KTP" });
    return `${label} [REDACTED-ID]`;
  });
  text = text.replace(/\b\d{16}\b/g, (match) => {
    if (looksLikeNik(match)) {
      redactions.push({ type: "KTP" });
      return "[REDACTED-ID]";
    }
    return match;
  });

  // 4) Bank account: only when labelled (rek/rekening/account/acct/a.n/a/n + digit run),
  //    since bare account numbers are indistinguishable from ordinary numbers.
  text = text.replace(/\b(rek(?:ening)?|acc(?:ount|t)?|a[./]?n)\b\s*[:.]?\s*(\d[\d -]{6,18}\d)/gi, (_m, label) => {
    redactions.push({ type: "BANK_ACCT" });
    return `${label} [REDACTED-ACCT]`;
  });

  // 5) Passport: 1-2 letters + 6-8 digits.
  text = text.replace(/\b[A-Z]{1,2}\d{6,8}\b/g, () => {
    redactions.push({ type: "PASSPORT" });
    return "[REDACTED-ID]";
  });

  // 6) Phone (opt-in): Indonesian mobile — +62 / 62 / 0 prefix, 9-13 digits.
  if (opts.phone) {
    text = text.replace(/(?:\+?62|0)8\d(?:[ -]?\d){7,11}\b/g, () => {
      redactions.push({ type: "PHONE" });
      return "[REDACTED-PHONE]";
    });
  }

  // 7) Email (opt-in).
  if (opts.email) {
    text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => {
      redactions.push({ type: "EMAIL" });
      return "[REDACTED-EMAIL]";
    });
  }

  return { clean: text, redactions };
}

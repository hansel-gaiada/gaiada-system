// M5-L2 — the two OPTIONAL, best-effort top-level members of a form submission: `attribution` (where the
// visitor came from) and `visitor_consent` (the cookie-banner choice at submit time). Shared contract
// (M5-L2 <-> M5-L4 <-> the site):
//
//   attribution    allow-listed keys only; unknown keys are DROPPED; a value over its limit or of the wrong
//                  type drops THAT key; the serialized object over 4 KB is dropped WHOLE.
//   visitor_consent malformed => stored as null. null / absent means "unknown", which every reader must
//                  treat as NO consent.
//
// NOTHING here can refuse a submission: the functions never throw, they return what survived plus a count
// of what was dropped. The caller logs the counts (never a value: a dropped value may be exactly the
// personal data the allow-list exists to keep out).
//
// Deliberate normalisations beyond the bare contract, each in the privacy-protective direction:
//   - `landing` / `form_page` are PATHS: anything from the first `?` or `#` on is cut off (a query string
//     can carry an email address or a token), and a value that does not then start with "/" is dropped.
//   - `referrer` must look like a bare host name (letters, digits, dots, hyphens); a full URL, a path or a
//     port is dropped, because only an external HOST is wanted.
//   - A string containing a control character is dropped (nothing legitimate carries one).
//   - `sections_seen`: more than 50 items drops the key; a single bad item (not a string, over 64 chars, or
//     outside [A-Za-z0-9_.:-]) is filtered out individually and counted as a drop.
//   - `visitor_consent` needs BOTH flags as real booleans, a version of 1-32 chars and a parseable ISO-8601
//     `decided_at` (stored normalised to UTC). Anything less is null: a half-filled consent record is not
//     evidence of consent, and null already reads as "no consent".

export const ATTRIBUTION_MAX_BYTES = 4096;
export const ATTRIBUTION_MAX_SECTIONS = 50;

const LIMITS = {
  path: 512,
  host: 253,
  param: 200,
  section: 64,
  consentVersion: 32,
} as const;

const PATH_KEYS = ["landing", "form_page"] as const;
const PARAM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "li_fat_id",
  "fbp",
  "fbc",
] as const;

/** Every key an attribution object may carry. Anything else is dropped. */
export const ATTRIBUTION_ALLOWED_KEYS: readonly string[] = [...PATH_KEYS, "referrer", ...PARAM_KEYS, "sections_seen"];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SECTION_RE = /^[A-Za-z0-9_.:-]+$/;
// ISO-8601 date-time WITH a zone designator. Date.parse alone is too forgiving ("2026", "Oct 11").
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type Attribution = Record<string, string | string[]>;

export type AttributionResult = {
  /** The cleaned object, or null when nothing survived (or the whole object was dropped). */
  value: Attribution | null;
  /** How many keys/items were dropped (an over-size object counts as one). Zero when nothing was supplied. */
  dropped: number;
};

export function sanitizeAttribution(raw: unknown): AttributionResult {
  if (raw === undefined || raw === null) return { value: null, dropped: 0 };
  if (!isPlainObject(raw)) return { value: null, dropped: 1 };

  const out: Attribution = {};
  let dropped = 0;

  for (const [key, value] of Object.entries(raw)) {
    if (!ATTRIBUTION_ALLOWED_KEYS.includes(key)) {
      dropped++;
      continue;
    }

    if (key === "sections_seen") {
      if (!Array.isArray(value) || value.length > ATTRIBUTION_MAX_SECTIONS) {
        dropped++;
        continue;
      }
      const kept: string[] = [];
      for (const item of value) {
        if (typeof item === "string" && item.length > 0 && item.length <= LIMITS.section && SECTION_RE.test(item)) kept.push(item);
        else dropped++;
      }
      if (kept.length > 0) out[key] = kept;
      continue;
    }

    if (typeof value !== "string" || value.length === 0 || CONTROL_CHARS.test(value)) {
      dropped++;
      continue;
    }

    if ((PATH_KEYS as readonly string[]).includes(key)) {
      if (value.length > LIMITS.path) {
        dropped++;
        continue;
      }
      const path = value.split(/[?#]/, 1)[0];
      if (!path.startsWith("/") || path.startsWith("//")) {
        dropped++;
        continue;
      }
      out[key] = path;
    } else if (key === "referrer") {
      const host = value.toLowerCase();
      if (value.length > LIMITS.host || !HOST_RE.test(host)) {
        dropped++;
        continue;
      }
      out[key] = host;
    } else {
      // utm_* / click ids / fbp / fbc
      if (value.length > LIMITS.param) {
        dropped++;
        continue;
      }
      out[key] = value;
    }
  }

  if (Object.keys(out).length === 0) return { value: null, dropped };
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > ATTRIBUTION_MAX_BYTES) return { value: null, dropped: dropped + 1 };
  return { value: out, dropped };
}

export type VisitorConsent = { analytics: boolean; marketing: boolean; version: string; decided_at: string };

export type VisitorConsentResult = {
  value: VisitorConsent | null;
  /** True when something was supplied but could not be kept (so it is stored as null). */
  malformed: boolean;
};

export function sanitizeVisitorConsent(raw: unknown): VisitorConsentResult {
  if (raw === undefined || raw === null) return { value: null, malformed: false };
  if (!isPlainObject(raw)) return { value: null, malformed: true };

  const { analytics, marketing, version, decided_at: decidedAt } = raw;
  if (typeof analytics !== "boolean" || typeof marketing !== "boolean") return { value: null, malformed: true };
  if (typeof version !== "string" || version.length === 0 || version.length > LIMITS.consentVersion || CONTROL_CHARS.test(version)) {
    return { value: null, malformed: true };
  }
  if (typeof decidedAt !== "string" || !ISO_DATETIME_RE.test(decidedAt)) return { value: null, malformed: true };
  const when = new Date(decidedAt);
  if (Number.isNaN(when.getTime())) return { value: null, malformed: true };

  return { value: { analytics, marketing, version, decided_at: when.toISOString() }, malformed: false };
}

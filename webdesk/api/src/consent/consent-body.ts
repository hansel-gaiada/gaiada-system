// M5-G6 — the strict allow-list for the consent endpoint's body, and the coarse user-agent bucket.
// Pure: no Nest, no database.
//
//   consentId  a uuid the browser generated. Absent or not a uuid => the server mints a fresh one (never an
//              error: a site bug must not lose the visitor's decision). The value is only ever compared as a
//              uuid and stored in a uuid column.
//   analytics, marketing  required booleans (a string "true" is refused: consent is never coerced).
//   version    required string, 1-32 chars, no control characters: the banner / notice version shown.
//   action     'grant' | 'update' | 'withdraw'. Absent => 'grant' for a new consent id, 'update' for a supplied one.
//              Anything else is refused. A 'withdraw' withdraws everything: both categories are stored false
//              whatever the body said (a withdrawal that keeps a category is a contradiction, and the table's
//              CHECK refuses it).
//
// Every other key is DROPPED (never stored, never an error). The count of dropped keys is returned so the
// caller can log it WITHOUT the values.
import { randomUUID } from "node:crypto";

export const CONSENT_ACTIONS = ["grant", "update", "withdraw"] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
export const CONSENT_ALLOWED_KEYS = ["consentId", "analytics", "marketing", "version", "action"] as const;
export const UA_CLASSES = ["desktop", "mobile", "tablet", "bot", "unknown"] as const;
export type UserAgentClass = (typeof UA_CLASSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export type ParsedConsent = {
  consentId: string;
  /** True when the server minted the id (none or an invalid one was supplied). */
  minted: boolean;
  analytics: boolean;
  marketing: boolean;
  version: string;
  action: ConsentAction;
  droppedKeys: number;
};

export type ParseOutcome = { ok: true; value: ParsedConsent } | { ok: false; reason: string };

export function parseConsentBody(raw: unknown): ParseOutcome {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "body must be a JSON object" };
  const body = raw as Record<string, unknown>;

  let droppedKeys = 0;
  for (const k of Object.keys(body)) if (!(CONSENT_ALLOWED_KEYS as readonly string[]).includes(k)) droppedKeys++;

  if (typeof body.analytics !== "boolean") return { ok: false, reason: "analytics must be a boolean" };
  if (typeof body.marketing !== "boolean") return { ok: false, reason: "marketing must be a boolean" };
  const version = body.version;
  if (typeof version !== "string" || version.length === 0 || version.length > 32 || CONTROL_CHARS.test(version)) {
    return { ok: false, reason: "version must be a string of 1-32 characters" };
  }

  const supplied = isUuid(body.consentId);
  const consentId = supplied ? (body.consentId as string).toLowerCase() : randomUUID();

  let action: ConsentAction;
  if (body.action === undefined) action = supplied ? "update" : "grant";
  else if ((CONSENT_ACTIONS as readonly unknown[]).includes(body.action)) action = body.action as ConsentAction;
  else return { ok: false, reason: "action must be grant, update or withdraw" };

  const withdraw = action === "withdraw";
  return {
    ok: true,
    value: {
      consentId,
      minted: !supplied,
      analytics: withdraw ? false : body.analytics,
      marketing: withdraw ? false : body.marketing,
      version,
      action,
      droppedKeys,
    },
  };
}

/**
 * A coarse bucket from the User-Agent header; the header itself is never stored or logged. Order matters:
 * bots first (a crawler's string often also says "Mobile"), then tablets, then phones. Empty or absent is
 * 'unknown'; anything else is 'desktop'.
 */
export function classifyUserAgent(header: unknown): UserAgentClass {
  if (typeof header !== "string" || header.trim() === "") return "unknown";
  const ua = header.toLowerCase();
  if (/bot|crawl|spider|slurp|headless|lighthouse|python-requests|curl\/|wget\/|facebookexternalhit|preview/.test(ua)) return "bot";
  if (/ipad|tablet|kindle|silk\/|playbook|(android(?!.*mobile))/.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone|blackberry|opera mini/.test(ua)) return "mobile";
  return "desktop";
}

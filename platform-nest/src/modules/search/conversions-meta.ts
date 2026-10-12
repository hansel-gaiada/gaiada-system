// M5-P3 — the Meta Conversions API adapter for lead conversions (Graph API `POST /{dataset_id}/events`). Design:
// docs/plans/2026-10-11-m5-lead-pipeline-design.md §8.8 ("Meta CAPI: event_id, action_source, user_data with em, ph, fbc and fbp").
// SIMULATE-ONLY. This file builds the request Meta WOULD receive and a non-personal `summary` of it; it owns no network primitive,
// reads no token and has no live uploader. A live Meta upload also needs what does not exist yet: Meta Business Verification (plan
// O-7), a dataset (pixel) id and a system-user access token, and a decision on where those live. Until then `meta_capi` can only run
// in simulate, and the boot guard (conversions-uploaders.ts) refuses to start with it listed in SEARCH_CONVERSIONS_LIVE_PLATFORMS.
// EVERYTHING HERE IS UNVERIFIED AGAINST REAL META until staging acceptance: written from Meta's documentation, not from a live call.
//
// ── THE RULES THIS FILE ENCODES (Meta's "Customer Information Parameters" normalisation) ───────────────────────────────────
//  * `em`: trim, lower-case, then SHA-256 hex. NO gmail dot-removal (that is Google's rule, not Meta's).
//  * `ph`: digits only WITH the country code, no `+`, no leading zeros (a `00` international prefix is dropped), then SHA-256 hex. A
//    national number ("0812...") is never guessed at: no country is hard-wired into a multi-tenant platform.
//  * `fbc` and `fbp` are NOT hashed (Meta says so); they are the browser cookie values as the site captured them, and they identify a
//    browser, so they ride ONLY when the lead's consent snapshot says marketing === true (the gate guarantees it; the builder checks
//    again, so a direct caller cannot bypass it).
//  * `event_id` (design §8.5): the bare submission id for the platform's OWN Lead event (the browser Pixel's `Lead` carries
//    eventID = submission id, legal/website-visitor-addendum.md F3), so Meta merges the browser copy and the server copy; otherwise
//    `${submissionRef}:${conversionKey}`. "Own Lead event" = event name `Lead` AND conversion key `lead`, so two targets can never
//    collide on one bare id.
//  * `custom_data.value/currency` ride only on the `won` stage, only when the target sends value and the ledger row carries one (O4).
//  * `action_source: "website"`. NOTE for staging: Meta documents `client_user_agent` as required for website events and this system
//    does not store a user agent. A rejection for that reason would show on the first live call; that is a contract question for the
//    architect, not something to paper over here.
import { createHash } from "node:crypto";
import { marketingConsentState, type LeadConversionFacts } from "../../core/agency-lead-pipeline.service";
import type { ConversionIdentifierKind, ConversionPlan, PlanLedger } from "./conversions";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Meta event names: a standard (`Lead`, `Purchase`, `Contact` ...) or a custom name. Letters, digits, underscore; starts with a letter. */
const EVENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
export function isMetaEventName(v: unknown): v is string {
  return typeof v === "string" && EVENT_NAME_RE.test(v);
}

/** Meta's `em` rule: trim and lower-case. Returns null when it is not plausibly an email. */
export function normalizeEmailForMeta(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at < 1 || at === v.length - 1 || /\s/.test(v)) return null;
  return v;
}

/** Meta's `ph` rule: digits only, with the country code, no `+`, no leading zeros. Only a number written WITH a country code (a leading
 *  `+` or `00`) can be made one. 8 to 15 digits. */
export function normalizePhoneForMeta(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(v)) return null;
  let digits = v.replace(/\D/g, "");
  if (v.startsWith("+")) {
    // already country code + number
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else {
    return null;
  }
  digits = digits.replace(/^0+/, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** The browser cookies as Meta formats them: `fb.<subdomainIndex>.<creationTimeMs>.<value>`. Anything else is ignored, never trusted. */
const FB_COOKIE_RE = /^fb\.[0-2]\.\d{10,13}\.[A-Za-z0-9_-]{1,200}$/;
function cookieOf(attribution: unknown, key: "fbc" | "fbp"): string | null {
  if (!attribution || typeof attribution !== "object" || Array.isArray(attribution)) return null;
  const v = (attribution as Record<string, unknown>)[key];
  return typeof v === "string" && FB_COOKIE_RE.test(v) ? v : null;
}

type MetaFacts = Pick<LeadConversionFacts, "attribution" | "contactEmail" | "contactPhone" | "visitorConsent">;

/** The identifier kinds this lead can offer Meta, in a fixed order. fbc / fbp count ONLY with marketing consent. Empty = nothing usable. */
export function metaIdentifierKinds(f: MetaFacts): ConversionIdentifierKind[] {
  const kinds: ConversionIdentifierKind[] = [];
  if (normalizeEmailForMeta(f.contactEmail)) kinds.push("email");
  if (normalizePhoneForMeta(f.contactPhone)) kinds.push("phone");
  if (marketingConsentState(f.visitorConsent) === "given") {
    if (cookieOf(f.attribution, "fbc")) kinds.push("fbc");
    if (cookieOf(f.attribution, "fbp")) kinds.push("fbp");
  }
  return kinds;
}

/** The de-duplication id (design §8.5). See the header for the Lead rule. */
export function metaEventId(submissionRef: string, conversionKey: string, eventName: string): string {
  return eventName === "Lead" && conversionKey === "lead" ? submissionRef : `${submissionRef}:${conversionKey}`;
}

/** `event_source_url` from the property's site URL (origin only) and the form page PATH the lead came from. Null unless both are usable.
 *  The attribution sanitiser stores paths only, and this accepts nothing with a query string or fragment. */
export function metaEventSourceUrl(siteUrl: string | null | undefined, attribution: unknown): string | null {
  if (!siteUrl || !attribution || typeof attribution !== "object" || Array.isArray(attribution)) return null;
  const page = (attribution as Record<string, unknown>).form_page;
  if (typeof page !== "string" || !/^\/[A-Za-z0-9\-._~%/]{0,511}$/.test(page)) return null;
  try {
    const u = new URL(siteUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${page}`;
  } catch {
    return null;
  }
}

/** The non-personal record of a Meta upload (persisted in `search_conversion_uploads.outcome`): names and kinds, never a value. */
export interface MetaUploadSummary {
  platform: "meta_capi";
  conversionKey: string;
  eventName: string;
  eventId: string;
  eventTime: number;
  actionSource: "website";
  /** Names of the request fields that carry an identifier (the values are never recorded). */
  identifierFields: string[];
  identifierKinds: ConversionIdentifierKind[];
  valueSent: boolean;
  currency: string | null;
  eventSourceUrlSent: boolean;
  /** True when the event id is the bare submission id, i.e. it merges with the browser Pixel's Lead. */
  mergesWithPixelLead: boolean;
}

export interface MetaUploadPlan extends ConversionPlan {
  /** `{ data: [event] }`, the JSON body for `POST /v{n}/{dataset_id}/events`. HOLDS HASHES AND COOKIES: memory only, one call. The
   *  access token is NOT in it (a live uploader would add it as a bearer, and none exists). */
  body: Record<string, unknown>;
  summary: MetaUploadSummary;
}

/**
 * Build the Conversions API request for one lead conversion. The gate has ALREADY passed (marketing consent given, not suppressed,
 * an identifier exists). Nothing is sent from here.
 */
export function buildMetaUploadRequest(input: {
  facts: MetaFacts;
  ledger: PlanLedger;
  /** The target's `conversion_action`: the Meta event name. */
  conversionAction: string;
  sendValue: boolean;
  eventSourceUrl?: string | null;
}): MetaUploadPlan {
  const { facts, ledger } = input;
  if (!isMetaEventName(input.conversionAction)) throw new Error("conversionAction is not a Meta event name");
  const time = Date.parse(ledger.occurredAt);
  if (Number.isNaN(time)) throw new Error("occurredAt is not a date");
  const eventTime = Math.floor(time / 1000);
  const eventId = metaEventId(ledger.submissionRef, ledger.conversionKey, input.conversionAction);

  const userData: Record<string, unknown> = {};
  const fields: string[] = [];
  const kinds: ConversionIdentifierKind[] = [];
  const email = normalizeEmailForMeta(facts.contactEmail);
  if (email) {
    userData.em = [sha256(email)];
    fields.push("user_data.em");
    kinds.push("email");
  }
  const phone = normalizePhoneForMeta(facts.contactPhone);
  if (phone) {
    userData.ph = [sha256(phone)];
    fields.push("user_data.ph");
    kinds.push("phone");
  }
  // The consent gate, a second time, at the only place the browser cookies are read.
  if (marketingConsentState(facts.visitorConsent) === "given") {
    const fbc = cookieOf(facts.attribution, "fbc");
    if (fbc) {
      userData.fbc = fbc;
      fields.push("user_data.fbc");
      kinds.push("fbc");
    }
    const fbp = cookieOf(facts.attribution, "fbp");
    if (fbp) {
      userData.fbp = fbp;
      fields.push("user_data.fbp");
      kinds.push("fbp");
    }
  }

  const event: Record<string, unknown> = {
    event_name: input.conversionAction,
    event_time: eventTime,
    event_id: eventId,
    action_source: "website",
    user_data: userData,
  };
  const url = input.eventSourceUrl ?? null;
  if (url) event.event_source_url = url;

  let valueSent = false;
  if (input.sendValue && ledger.stage === "won" && ledger.dealValue !== null && ledger.dealCurrency !== null) {
    const v = Number(ledger.dealValue);
    if (Number.isFinite(v)) {
      event.custom_data = { value: v, currency: ledger.dealCurrency.toLowerCase() };
      valueSent = true;
    }
  }

  return {
    body: { data: [event] },
    summary: {
      platform: "meta_capi",
      conversionKey: ledger.conversionKey,
      eventName: input.conversionAction,
      eventId,
      eventTime,
      actionSource: "website",
      identifierFields: fields,
      identifierKinds: kinds,
      valueSent,
      currency: valueSent ? ledger.dealCurrency : null,
      eventSourceUrlSent: url !== null,
      mergesWithPixelLead: eventId === ledger.submissionRef,
    },
  };
}

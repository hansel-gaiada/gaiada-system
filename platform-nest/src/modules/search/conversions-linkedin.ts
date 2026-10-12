// M5-P4 — the LinkedIn Conversions API adapter for lead conversions (ERP side; the Insight tag is SITE work, its contract is in
// docs/FRONTEND-BFF-CONTRACT.md §28b). Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §8.8 ("LinkedIn: conversionEvents with
// eventId, and a SHA-256 email or the first-party tracking id").
// SIMULATE-ONLY. It builds the `POST /rest/conversionEvents` request LinkedIn WOULD receive and a non-personal `summary`; it owns no
// network primitive, reads no token and has no live uploader. A live upload also needs an OAuth token with the `rw_conversions` scope
// for the ad account and a decision on where it lives. Until then `linkedin_capi` runs only in simulate, and the boot guard
// (conversions-uploaders.ts) refuses to start with it listed in SEARCH_CONVERSIONS_LIVE_PLATFORMS.
// EVERYTHING HERE IS UNVERIFIED AGAINST REAL LINKEDIN until staging acceptance: written from LinkedIn's documentation.
//
// ── THE RULES THIS FILE ENCODES ─────────────────────────────────────────────────────────────────────────────────────────
//  * `user.userIds[]` carries `SHA256_EMAIL` (trim, lower-case, SHA-256 hex) and/or `LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID` (the
//    `li_fat_id` the Insight tag captured; passed through as the site gave it, never hashed). LinkedIn needs at least one.
//  * `li_fat_id` identifies a browser, so it rides ONLY with marketing consent (the gate guarantees it; the builder checks again).
//  * `conversion` is the conversion rule URN `urn:lla:llaPartnerConversion:{id}`, from the target's `conversion_action` (a bare numeric
//    id is expanded to the URN).
//  * `conversionHappenedAt` is epoch MILLISECONDS; `eventId` is the de-dupe id: the bare submission id for the `lead` conversion key
//    (so an Insight-tag conversion fired on form submit with the same event id merges), otherwise `${submissionRef}:${conversionKey}`.
//  * `conversionValue` (`currencyCode` + `amount` as a decimal string) rides only on `won`, only when the target sends value and the
//    ledger row carries one (O4).
import { createHash } from "node:crypto";
import { marketingConsentState, type LeadConversionFacts } from "../../core/agency-lead-pipeline.service";
import type { ConversionIdentifierKind, ConversionPlan, PlanLedger } from "./conversions";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const URN_RE = /^urn:lla:llaPartnerConversion:\d{1,20}$/;
const BARE_ID_RE = /^\d{1,20}$/;
/** The conversion rule as a target may be configured: the full URN, or its numeric id. */
export function isLinkedInConversionRef(v: unknown): v is string {
  return typeof v === "string" && (URN_RE.test(v) || BARE_ID_RE.test(v));
}
export function linkedInConversionUrn(action: string): string | null {
  if (URN_RE.test(action)) return action;
  if (BARE_ID_RE.test(action)) return `urn:lla:llaPartnerConversion:${action}`;
  return null;
}

/** LinkedIn's email rule: trim and lower-case, then SHA-256. Returns null when it is not plausibly an email. */
export function normalizeEmailForLinkedIn(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at < 1 || at === v.length - 1 || /\s/.test(v)) return null;
  return v;
}

const LI_FAT_ID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
function liFatIdOf(attribution: unknown): string | null {
  if (!attribution || typeof attribution !== "object" || Array.isArray(attribution)) return null;
  const v = (attribution as Record<string, unknown>).li_fat_id;
  return typeof v === "string" && LI_FAT_ID_RE.test(v) ? v : null;
}

type LinkedInFacts = Pick<LeadConversionFacts, "attribution" | "contactEmail" | "visitorConsent">;

/** The identifier kinds this lead can offer LinkedIn: an email, or a `li_fat_id` (only with marketing consent). Empty = nothing usable. */
export function linkedInIdentifierKinds(f: LinkedInFacts): ConversionIdentifierKind[] {
  const kinds: ConversionIdentifierKind[] = [];
  if (normalizeEmailForLinkedIn(f.contactEmail)) kinds.push("email");
  if (marketingConsentState(f.visitorConsent) === "given" && liFatIdOf(f.attribution)) kinds.push("li_fat_id");
  return kinds;
}

export function linkedInEventId(submissionRef: string, conversionKey: string): string {
  return conversionKey === "lead" ? submissionRef : `${submissionRef}:${conversionKey}`;
}

/** A decimal string as LinkedIn takes it: Postgres's `numeric(20,4)::text` with the trailing zeros trimmed ("2500.5000" -> "2500.5"). */
export function linkedInAmount(dealValue: string): string {
  return dealValue.includes(".") ? dealValue.replace(/0+$/, "").replace(/\.$/, "") : dealValue;
}

export interface LinkedInUploadSummary {
  platform: "linkedin_capi";
  conversionKey: string;
  conversion: string;
  eventId: string;
  conversionHappenedAt: number;
  identifierFields: string[];
  identifierKinds: ConversionIdentifierKind[];
  valueSent: boolean;
  currency: string | null;
  /** True when the event id is the bare submission id, i.e. it merges with an Insight-tag conversion fired on form submit. */
  mergesWithInsightTag: boolean;
}

export interface LinkedInUploadPlan extends ConversionPlan {
  /** One `conversionEvents` element, the JSON body for `POST /rest/conversionEvents`. HOLDS A HASH AND A TRACKING ID: memory only. */
  body: Record<string, unknown>;
  summary: LinkedInUploadSummary;
}

/** Build the request for one lead conversion. The gate has ALREADY passed. Nothing is sent from here. */
export function buildLinkedInUploadRequest(input: {
  facts: LinkedInFacts;
  ledger: PlanLedger;
  /** The target's `conversion_action`: the conversion rule URN or its numeric id. */
  conversionAction: string;
  sendValue: boolean;
}): LinkedInUploadPlan {
  const { facts, ledger } = input;
  const urn = linkedInConversionUrn(input.conversionAction);
  if (!urn) throw new Error("conversionAction is not a LinkedIn conversion rule");
  const happenedAt = Date.parse(ledger.occurredAt);
  if (Number.isNaN(happenedAt)) throw new Error("occurredAt is not a date");
  const eventId = linkedInEventId(ledger.submissionRef, ledger.conversionKey);

  const userIds: Array<{ idType: string; idValue: string }> = [];
  const fields: string[] = [];
  const kinds: ConversionIdentifierKind[] = [];
  const email = normalizeEmailForLinkedIn(facts.contactEmail);
  if (email) {
    userIds.push({ idType: "SHA256_EMAIL", idValue: sha256(email) });
    fields.push("user.userIds.SHA256_EMAIL");
    kinds.push("email");
  }
  // The consent gate, a second time, at the only place the tracking id is read.
  const fat = marketingConsentState(facts.visitorConsent) === "given" ? liFatIdOf(facts.attribution) : null;
  if (fat) {
    userIds.push({ idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: fat });
    fields.push("user.userIds.LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID");
    kinds.push("li_fat_id");
  }

  const body: Record<string, unknown> = {
    conversion: urn,
    conversionHappenedAt: happenedAt,
    eventId,
    user: { userIds },
  };
  let valueSent = false;
  if (input.sendValue && ledger.stage === "won" && ledger.dealValue !== null && ledger.dealCurrency !== null) {
    body.conversionValue = { currencyCode: ledger.dealCurrency, amount: linkedInAmount(ledger.dealValue) };
    valueSent = true;
  }

  return {
    body,
    summary: {
      platform: "linkedin_capi",
      conversionKey: ledger.conversionKey,
      conversion: urn,
      eventId,
      conversionHappenedAt: happenedAt,
      identifierFields: fields,
      identifierKinds: kinds,
      valueSent,
      currency: valueSent ? ledger.dealCurrency : null,
      mergesWithInsightTag: eventId === ledger.submissionRef,
    },
  };
}

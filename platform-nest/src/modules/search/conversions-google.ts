// M5-P2 — the Google Ads adapter for lead conversions: `ConversionUploadService.UploadClickConversions` for a click id
// (gclid / gbraid / wbraid) and ENHANCED CONVERSIONS FOR LEADS (SHA-256 of a normalised email and an E.164 phone).
// Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §8.8. EVERYTHING HERE IS UNVERIFIED AGAINST REAL GOOGLE until
// staging acceptance (the same standing caveat google/api-client.ts states for the whole Ads surface): the request shape,
// the field names and the partial-failure behaviour are written from Google's documentation, not from a live call.
//
// ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────────────────────────────────────────────────
//  * It owns no network primitive. The live call goes through `googleAdsMutateRequest` (google/api-client.ts), the module's
//    sanctioned Ads transport, which sends once and NEVER retries a non-401. egress-inventory.test.ts is unchanged.
//  * It adds no secret and reads none: the developer token and login-customer-id are read where the transport reads them
//    (config.search.google), and the OAuth connection is the property's own (resolvePropertyConnection).
//  * It records nothing. `buildGoogleUploadRequest` returns the request body (which holds identifiers, in memory, for the
//    one call) AND a `summary` of what the body carries, as KINDS and field names only. Only the summary may be persisted.
import { config } from "../../config";
import type { LeadConversionFacts } from "../../core/agency-lead-pipeline.service";
import { googleAdsMutateRequest } from "./google/api-client";
import { normalizeAdsCustomerId } from "./google/ads-client";
import { getGoogleConnection, resolvePropertyConnection } from "./google/oauth";
import {
  REASON, clickIdOf, normalizeEmailForGoogle, normalizePhoneE164, sha256Hex, type ConversionPlatform, type GoogleIdentifierKind,
} from "./conversions";

/** What the adapter needs from the ledger row. No personal data. */
export interface GoogleUploadLedger {
  submissionRef: string;
  conversionKey: string;
  occurredAt: string; // ISO-8601
  dealValue: string | null;
  dealCurrency: string | null;
}

/** The non-personal record of an upload: persisted in `search_conversion_uploads.outcome`. Kinds and names, never values. */
export interface UploadSummary {
  platform: ConversionPlatform;
  conversionKey: string;
  conversionAction: string;
  orderId: string;
  conversionDateTime: string;
  /** Names of the request fields that carry an identifier (the values are never recorded). */
  identifierFields: string[];
  identifierKinds: GoogleIdentifierKind[];
  valueSent: boolean;
  currency: string | null;
  consent: { adUserData: "GRANTED" };
  partialFailure: true;
}

export interface GoogleUploadPlan {
  /** The JSON body for `POST /v{n}/customers/{id}:uploadClickConversions`. HOLDS IDENTIFIERS: memory only, one call. */
  body: Record<string, unknown>;
  summary: UploadSummary;
}

/** Google's `conversion_date_time`: `yyyy-mm-dd hh:mm:ss+|-hh:mm`. Always UTC here. */
export function googleDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error("occurredAt is not a date");
  return `${d.toISOString().slice(0, 19).replace("T", " ")}+00:00`;
}

/** The conversion action as Google's resource name: a full `customers/{id}/conversionActions/{id}` stays as given, a bare numeric
 *  id is expanded with the customer when one is known (live), else left bare (simulate never reaches Google). */
export function conversionActionResource(action: string, customerId: string | null): string {
  if (/^customers\/\d+\/conversionActions\/\d+$/.test(action)) return action;
  if (/^\d{1,20}$/.test(action) && customerId) return `customers/${customerId}/conversionActions/${action}`;
  return action;
}

/**
 * Build the upload request for one lead conversion. The gate has ALREADY passed (consent given, not suppressed, an identifier
 * exists), which is the only reason `consent.adUserData = GRANTED` is ever sent.
 *  - exactly ONE click id (gclid, else gbraid, else wbraid), when the lead has one;
 *  - `userIdentifiers`: hashedEmail and hashedPhoneNumber (SHA-256 hex of the normalised value), when usable;
 *  - the value and currency only when the TARGET sends value AND the ledger row carries one;
 *  - `orderId` = `${submissionRef}:${conversionKey}`, Google's own de-duplication per conversion action.
 */
export function buildGoogleUploadRequest(input: {
  facts: Pick<LeadConversionFacts, "attribution" | "contactEmail" | "contactPhone">;
  ledger: GoogleUploadLedger;
  conversionAction: string;
  customerId: string | null;
  sendValue: boolean;
}): GoogleUploadPlan {
  const { facts, ledger } = input;
  const conversion: Record<string, unknown> = {
    conversionAction: conversionActionResource(input.conversionAction, input.customerId),
    conversionDateTime: googleDateTime(ledger.occurredAt),
    orderId: `${ledger.submissionRef}:${ledger.conversionKey}`,
  };
  const identifierFields: string[] = [];
  const kinds: GoogleIdentifierKind[] = [];

  const click = clickIdOf(facts.attribution);
  if (click) {
    conversion[click.kind] = click.value;
    identifierFields.push(click.kind);
    kinds.push(click.kind);
  }
  const userIdentifiers: Array<Record<string, unknown>> = [];
  const email = normalizeEmailForGoogle(facts.contactEmail);
  if (email) {
    userIdentifiers.push({ userIdentifierSource: "FIRST_PARTY", hashedEmail: sha256Hex(email) });
    identifierFields.push("userIdentifiers.hashedEmail");
    kinds.push("email");
  }
  const phone = normalizePhoneE164(facts.contactPhone);
  if (phone) {
    userIdentifiers.push({ userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha256Hex(phone) });
    identifierFields.push("userIdentifiers.hashedPhoneNumber");
    kinds.push("phone");
  }
  if (userIdentifiers.length > 0) conversion.userIdentifiers = userIdentifiers;

  let valueSent = false;
  if (input.sendValue && ledger.dealValue !== null && ledger.dealCurrency !== null) {
    const v = Number(ledger.dealValue);
    if (Number.isFinite(v)) {
      conversion.conversionValue = v;
      conversion.currencyCode = ledger.dealCurrency;
      valueSent = true;
    }
  }
  // Only ever reached because the consent gate passed (strictly marketing === true).
  conversion.consent = { adUserData: "GRANTED" };

  return {
    body: { conversions: [conversion], partialFailure: true, validateOnly: false },
    summary: {
      platform: "google_ads",
      conversionKey: ledger.conversionKey,
      conversionAction: input.conversionAction,
      orderId: conversion.orderId as string,
      conversionDateTime: conversion.conversionDateTime as string,
      identifierFields,
      identifierKinds: kinds,
      valueSent,
      currency: valueSent ? ledger.dealCurrency : null,
      consent: { adUserData: "GRANTED" },
      partialFailure: true,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────── the live uploader
export type UploadResult = { ok: true } | { ok: false; error: string; ambiguous: boolean };

export interface UploadInput {
  tenantId: string;
  propertyId: string;
  conversionAction: string;
  /** The plan built with `customerId: null`; the live uploader rebuilds nothing, it only needs the customer for the path and the action. */
  body: Record<string, unknown>;
}
export type ConversionUploader = (input: UploadInput) => Promise<UploadResult>;

/**
 * The LIVE Google uploader. Reached only when `google_ads` is listed in SEARCH_CONVERSIONS_LIVE_PLATFORMS. Every refusal before
 * the send is `ambiguous: false` ("nothing was sent"); a transport answer of status 0 (timeout or socket) or a 5xx is
 * `ambiguous: true` ("it may have landed"), and the executor NEVER resends after one. Google de-duplicates on `orderId`, but a
 * human decides what to do next, not a loop.
 */
export const googleAdsConversionUploader: ConversionUploader = async (input) => {
  if (!config.search.google.adsDeveloperToken) return { ok: false, error: REASON.notConfigured, ambiguous: false };
  const connectionId = await resolvePropertyConnection(input.tenantId, input.propertyId, "google_ads");
  if (!connectionId) return { ok: false, error: REASON.googleNotLinked, ambiguous: false };
  const connection = await getGoogleConnection(input.tenantId, connectionId);
  if (!connection || connection.provider !== "google_ads") return { ok: false, error: REASON.googleNotLinked, ambiguous: false };
  const customerId = normalizeAdsCustomerId(connection.externalAccount ?? "");
  if (!customerId) return { ok: false, error: REASON.googleCustomerNotLinked, ambiguous: false };

  // The conversion action may have been stored as a bare id: expand it now that the customer is known.
  const conversions = (input.body.conversions as Array<Record<string, unknown>>).map((c) => ({
    ...c,
    conversionAction: conversionActionResource(String(c.conversionAction), customerId),
  }));
  const body = { ...input.body, conversions };

  let res;
  try {
    res = await googleAdsMutateRequest<{ partialFailureError?: { code?: unknown } | null; results?: unknown[] }>({
      tenantId: input.tenantId,
      connectionId,
      path: `/${config.search.google.adsApiVersion}/customers/${customerId}:uploadClickConversions`,
      body,
    });
  } catch {
    // The transport throws only before anything was sent (a 401 that survived a forced refresh: the connection is unusable).
    return { ok: false, error: REASON.googleNotLinked, ambiguous: false };
  }
  if (res.status === 0 || res.status >= 500) return { ok: false, error: REASON.ambiguous, ambiguous: true };
  if (res.status < 200 || res.status >= 300) return { ok: false, error: `${REASON.googleRefused}:${res.status}`, ambiguous: false };
  const pf = res.data?.partialFailureError;
  if (pf !== undefined && pf !== null) {
    // The numeric code only: Google's message text can echo the identifier it rejected.
    const code = typeof pf.code === "number" ? pf.code : 0;
    return { ok: false, error: `${REASON.googlePartialFailure}:${code}`, ambiguous: false };
  }
  return { ok: true };
};

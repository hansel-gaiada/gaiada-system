// M5-P2 — ad-platform conversion uploads from a lead's stage change: the PURE half (vocabulary, the write-mode switch,
// the gate's decision, normalisation and hashing, the content binding). No database, no network, so every rule here is
// unit-tested without services (conversions.test.ts). The DB half is conversions.service.ts; the platform adapter is
// conversions-google.ts. Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §7 and §8 (D8).
//
// ── THE SHAPE, IN ONE PARAGRAPH ─────────────────────────────────────────────────────────────────────────────────────────
// `agency.lead.stage_changed` (ids and stages only, no personal data) reaches `handleStageChanged` through the `agency_lead`
// stream. For a target the tenant configured (site slug + platform + stage) the handler runs the GATE, inserts a ledger row
// (the insert IS the de-duplication claim) and files ONE WS4 approval (origin `search`, workflow `search.conversions.upload`,
// impact high). A human decides it in the inbox; decide() executes it IN-BAND as the decider, under the gate AGAIN, in
// `simulate` mode unless the platform is listed in SEARCH_CONVERSIONS_LIVE_PLATFORMS. Personal data is read from the lead at
// execution time, normalised and hashed in memory, sent, and never written anywhere.
import { createHash } from "node:crypto";
import { marketingConsentState, type LeadConversionFacts } from "../../core/agency-lead-pipeline.service";

// ─────────────────────────────────────────────────────────────────────────────────────────── vocabulary
/** `automation_approvals.workflow_id` AND `tool_name` of an upload approval. decide() recognises the row by origin AND workflow. */
export const CONVERSION_UPLOAD_WORKFLOW = "search.conversions.upload";
export const CONVERSION_UPLOAD_TOOL = "search.conversions.upload";
/** `automation_approvals.origin` (migration 202610131210 admits it). */
export const CONVERSION_APPROVAL_ORIGIN = "search";

export function isConversionUploadRequest(origin: string, workflowId: string | null): boolean {
  return origin === CONVERSION_APPROVAL_ORIGIN && workflowId === CONVERSION_UPLOAD_WORKFLOW;
}

export type ConversionPlatform = "google_ads" | "meta_capi" | "linkedin_capi";
/** The platforms the ledger and the CHECKs know about (P3 Meta, P4 LinkedIn will fill theirs in). */
export const ALL_PLATFORMS: readonly ConversionPlatform[] = ["google_ads", "meta_capi", "linkedin_capi"];
/** The platforms a target may be configured for TODAY: only those with an adapter. */
export const SUPPORTED_PLATFORMS: readonly ConversionPlatform[] = ["google_ads"];
export const PLATFORM_LABEL: Record<ConversionPlatform, string> = {
  google_ads: "Google Ads",
  meta_capi: "Meta Conversions API",
  linkedin_capi: "LinkedIn Conversions API",
};

export function isPlatform(v: unknown): v is ConversionPlatform {
  return typeof v === "string" && (ALL_PLATFORMS as readonly string[]).includes(v);
}

/** The ledger's status vocabulary (migration 202610131200). */
export type UploadStatus = "pending_approval" | "executing" | "simulated" | "uploaded" | "failed" | "rejected" | "skipped";

/** Typed reasons. snake_case tokens, stored in `search_conversion_uploads.reason` and (prefixed) in `execution_error`.
 *  Never user text, never an identifier. */
export const REASON = {
  leadNotFound: "lead_not_found",
  leadDeleted: "lead_deleted",
  consentNotGiven: "consent_not_given",
  consentUnknown: "consent_unknown",
  suppressed: "suppressed",
  noIdentifier: "no_identifier",
  alreadyClaimed: "already_claimed",
  targetDisabled: "target_disabled",
  // execution
  argsInvalid: "conversion_args_invalid",
  ledgerNotPending: "ledger_not_pending",
  contentChanged: "content_changed",
  notConfigured: "conversion_not_configured",
  googleNotLinked: "google_ads_not_linked",
  googleCustomerNotLinked: "google_ads_customer_not_linked",
  googlePartialFailure: "google_partial_failure",
  googleRefused: "google_refused",
  ambiguous: "conversion_ambiguous",
  unreachable: "conversion_unreachable",
  rejected: "approval_rejected",
  internalError: "conversion_internal_error",
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────── the write-mode switch
/**
 * Design §8.7: kept SEPARATE from `SEARCH_ADS_WRITE_MODE` (which governs campaign mutations). A comma-separated list of
 * platforms that may run LIVE, for example `google_ads`. Default EMPTY: every platform runs in simulate. Read from
 * `process.env` directly, the same ownership seam `SEARCH_ADS_WRITE_MODE` uses (sem-executor-google-ads.ts).
 * LIVE ALSO NEEDS what the owner has not provided: the Google Ads developer token and a linked Ads account, gate G2, and
 * the O-8 ads access audit. Until then: simulate.
 */
export const SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV = "SEARCH_CONVERSIONS_LIVE_PLATFORMS";

export interface LivePlatformsParse {
  platforms: Set<ConversionPlatform>;
  /** Tokens that are not a known platform. A BOOT ERROR (a typo must never read as "simulate everywhere"). */
  unknown: string[];
}

export function parseLivePlatforms(raw: string | undefined): LivePlatformsParse {
  const platforms = new Set<ConversionPlatform>();
  const unknown: string[] = [];
  for (const tok of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (isPlatform(tok)) platforms.add(tok);
    else unknown.push(tok);
  }
  return { platforms, unknown };
}

export function conversionModeFor(platform: ConversionPlatform, env: NodeJS.ProcessEnv = process.env): "simulate" | "live" {
  return parseLivePlatforms(env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]).platforms.has(platform) ? "live" : "simulate";
}

// ─────────────────────────────────────────────────────────────────────────────────────────── the gate
/** What kinds of identifier a lead can offer Google. Kinds only: the values are read at execution and never recorded. */
export type GoogleIdentifierKind = "gclid" | "gbraid" | "wbraid" | "email" | "phone";

const CLICK_ID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid"] as const;

/** The click id Google should be sent: gclid, else gbraid, else wbraid (Google takes exactly one). A malformed value is ignored. */
export function clickIdOf(attribution: unknown): { kind: "gclid" | "gbraid" | "wbraid"; value: string } | null {
  if (!attribution || typeof attribution !== "object" || Array.isArray(attribution)) return null;
  const a = attribution as Record<string, unknown>;
  for (const kind of CLICK_ID_KEYS) {
    const v = a[kind];
    if (typeof v === "string" && CLICK_ID_RE.test(v)) return { kind, value: v };
  }
  return null;
}

/** Google's email rule: trim, lower-case; for gmail.com / googlemail.com remove the dots before the @. UNVERIFIED until staging. */
export function normalizeEmailForGoogle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at < 1 || at === v.length - 1 || /\s/.test(v)) return null;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") return `${local.replace(/\./g, "")}@${domain}`;
  return v;
}

/**
 * E.164 for Google: `+` and the digits with the country code. Only a number written WITH a country code (a leading `+` or
 * `00`) can be made one: no country is hard-wired into a multi-tenant platform, so a national "0812..." is NOT guessed at
 * and yields null. 8 to 15 digits.
 */
export function normalizePhoneE164(raw: unknown): string | null {
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
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The identifier kinds this lead can offer Google. Empty = nothing usable (the gate refuses `no_identifier`). */
export function googleIdentifierKinds(f: Pick<LeadConversionFacts, "attribution" | "contactEmail" | "contactPhone">): GoogleIdentifierKind[] {
  const kinds: GoogleIdentifierKind[] = [];
  const click = clickIdOf(f.attribution);
  if (click) kinds.push(click.kind);
  if (normalizeEmailForGoogle(f.contactEmail)) kinds.push("email");
  if (normalizePhoneE164(f.contactPhone)) kinds.push("phone");
  return kinds;
}

export type GateVerdict = { ok: true; identifierKinds: GoogleIdentifierKind[] } | { ok: false; reason: string };

/**
 * The gate (design §8.4), pure. It runs at PLANNING and again under the lock at EXECUTION, on freshly read facts, so a lead
 * whose consent was withdrawn, who was erased or suppressed, or whose record is gone between the two is refused the second time.
 * Order: the lead exists, consent is STRICTLY `marketing === true`, the contact is not on G5's `ad_upload` suppression list,
 * the platform has a usable identifier. `suppressed` is read by the caller (it is a database question) and passed in.
 */
export function evaluateGate(
  facts: LeadConversionFacts | null,
  platform: ConversionPlatform,
  suppressed: boolean,
): GateVerdict {
  if (!facts) return { ok: false, reason: REASON.leadNotFound };
  if (facts.deletedAt !== null) return { ok: false, reason: REASON.leadDeleted };
  const consent = marketingConsentState(facts.visitorConsent);
  if (consent === "not_given") return { ok: false, reason: REASON.consentNotGiven };
  if (consent !== "given") return { ok: false, reason: REASON.consentUnknown };
  if (suppressed) return { ok: false, reason: REASON.suppressed };
  if (platform !== "google_ads") return { ok: false, reason: REASON.noIdentifier }; // adapters for the others arrive with P3 / P4
  const kinds = googleIdentifierKinds(facts);
  if (kinds.length === 0) return { ok: false, reason: REASON.noIdentifier };
  return { ok: true, identifierKinds: kinds };
}

// ─────────────────────────────────────────────────────────────────────────────────────────── the content binding
/** Everything the approval is bound to (design §8.6: "the ids, platform, conversion key, value and currency"). No personal data. */
export interface ConversionBinding {
  ledgerId: string;
  tenantId: string;
  propertyId: string;
  leadId: string;
  stageEventId: string;
  submissionRef: string;
  platform: ConversionPlatform;
  stage: string;
  conversionKey: string;
  dealValue: string | null;
  dealCurrency: string | null;
}

/** sha256 over a fixed-order serialisation. The value is Postgres's `numeric(20,4)::text`, so planning and execution agree. */
export function conversionContentHash(b: ConversionBinding): string {
  const ordered = [
    b.ledgerId, b.tenantId, b.propertyId, b.leadId, b.stageEventId, b.submissionRef, b.platform, b.stage, b.conversionKey,
    b.dealValue ?? "", b.dealCurrency ?? "",
  ];
  return sha256Hex(JSON.stringify(ordered));
}

/** `automation_approvals.tool_args` of an upload approval. Ids, the stage, the conversion key, value and the hash: nothing else. */
export interface ConversionToolArgs {
  ledgerId: string;
  propertyId: string;
  leadId: string;
  stageEventId: string;
  platform: ConversionPlatform;
  conversionKey: string;
  stage: string;
  dealValue: string | null;
  dealCurrency: string | null;
  contentHash: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const STAGE_RE = /^[a-z][a-z_]{1,31}$/;

/** Strict parse of the stored args at execution. Anything else, or an extra key, is refused: the args are caller-controlled JSON
 *  read back out of the database, never trusted as already clean. */
export function parseConversionToolArgs(raw: unknown): ConversionToolArgs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const allowed = new Set(["ledgerId", "propertyId", "leadId", "stageEventId", "platform", "conversionKey", "stage", "dealValue", "dealCurrency", "contentHash"]);
  if (Object.keys(a).some((k) => !allowed.has(k))) return null;
  const uuid = (x: unknown): x is string => typeof x === "string" && UUID_RE.test(x);
  if (!uuid(a.ledgerId) || !uuid(a.propertyId) || !uuid(a.leadId) || !uuid(a.stageEventId)) return null;
  if (!isPlatform(a.platform)) return null;
  if (typeof a.conversionKey !== "string" || !KEY_RE.test(a.conversionKey)) return null;
  if (typeof a.stage !== "string" || !STAGE_RE.test(a.stage)) return null;
  const dv = a.dealValue ?? null;
  const dc = a.dealCurrency ?? null;
  if ((dv === null) !== (dc === null)) return null;
  if (dv !== null && (typeof dv !== "string" || !/^\d{1,16}(\.\d{1,4})?$/.test(dv))) return null;
  if (dc !== null && (typeof dc !== "string" || !/^[A-Z]{3}$/.test(dc))) return null;
  if (typeof a.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(a.contentHash)) return null;
  return {
    ledgerId: a.ledgerId, propertyId: a.propertyId, leadId: a.leadId, stageEventId: a.stageEventId,
    platform: a.platform, conversionKey: a.conversionKey, stage: a.stage,
    dealValue: dv as string | null, dealCurrency: dc as string | null, contentHash: a.contentHash,
  };
}

/** What the approver reads in the inbox. Words and counts: no name, no contact, no identifier. */
export function approvalReason(platform: ConversionPlatform, stage: string, conversionKey: string, dealValue: string | null, dealCurrency: string | null): string {
  const value = dealValue !== null && dealCurrency !== null ? `, value ${dealValue} ${dealCurrency}` : "";
  return `Upload the "${stage}" conversion (${conversionKey}${value}) for a website lead to ${PLATFORM_LABEL[platform]}. Personal data leaves only after you approve.`;
}

/** The tool-args / reason strings never carry these. Exported for the tests' grep. */
export const NO_PERSONAL_DATA_KEYS: readonly string[] = ["email", "phone", "name", "gclid", "gbraid", "wbraid", "hashedEmail", "hashedPhoneNumber", "contact"];

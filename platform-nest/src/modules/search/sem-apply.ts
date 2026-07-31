// SM-21 — the api-mode (AUTOMATED twin) execution path for SEM change proposals
// (docs/blueprints/seo-sem-design.md §04/§07/§12 SM-21, decision D-6/D-8; tracker §1/§6o/§6ba).
// Pure, synchronous, no I/O — same split every sibling sub-module in this directory uses
// (search-audit.ts, sem-plan.ts, sem-export.ts, sem-search-terms.ts): `search.controller.ts` owns
// every DB read/write, every Cerbos call, and the transaction boundaries; this file owns
//   (a) the CONTENT IDENTITY of an approved proposal (`hashChangeProposalContent`),
//   (b) the translation of a proposal into a bounded list of atomic OPERATIONS
//       (`buildChangeOperations`) each carrying a stable, server-computed `ref`,
//   (c) the EXECUTOR SEAM (`AdsExecutor` + the simulate/live resolution rules), and
//   (d) `reconcileExecution` — the echo-validation + outcome-classification step that decides
//       whether an execution was applied / partial / failed / indeterminate.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS PATH MUST NOT DO — the four failure modes, and where each is closed
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// This is the only surface in the module that executes a change against a client's LIVE advertising
// account. The four ways it can be worse than doing nothing, and the mechanism that closes each:
//
//   1. Executing something never approved.
//      Closed in the controller, NOT here: execution requires `search_change_proposals.approval_id`
//      to be non-NULL and to resolve to an `automation_approvals` row with `status='approved'`. The
//      linkage is read from STORED STATE (the proposal's own column) — never from a request
//      parameter, never by searching the approvals table for "a row that mentions this proposal".
//      That distinction is load-bearing: `POST /api/:t/automation-approvals` lets any member-tier
//      principal file an approval row with arbitrary `tool_args`, so an approval DISCOVERED by
//      matching tool_args would be forgeable. An approval REFERENCED by the proposal is not: only
//      this module's own suspend step writes that column, and only while it is still NULL.
//
//   2. Executing something twice.
//      Closed at the SCHEMA, not in application logic: `search_change_executions` carries
//      `UNIQUE (approval_id)` (migration 0064). The INSERT of the execution row IS the consumption
//      of the approval — claim-then-execute — so a second attempt (sequential OR genuinely
//      concurrent) loses at the index with a `23505`, which the controller maps to a 409. There is
//      deliberately NO `ON CONFLICT` clause on that insert: unlike SM-20's idempotent ingest, a
//      second execution attempt must be REFUSED, not absorbed.
//
//   3. Executing something DIFFERENT from what was approved.
//      Closed by content binding: `hashChangeProposalContent(kind, mode, payload)` is computed
//      server-side at suspend time, stored inside the approval row's `tool_args.payloadHash`, and
//      RECOMPUTED from the live proposal row at execution time. Any difference refuses. This is a
//      second, independent wall behind SM-18's app-level rule that `payload`/`mode` are only
//      editable while `status='proposed'` — the hash holds even if a future route, a migration, or
//      a direct SQL edit changes the row, because it does not depend on that rule being obeyed.
//
//   4. Reporting success when nothing happened (or when we cannot tell).
//      Closed by `reconcileExecution` below: four outcomes, none of which round to the others.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D14: THERE IS NO AUTOMATIC RESUME, AND THAT IS THE DESIGN — NOT AN OVERSIGHT
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Project memory `d14-no-resume-gap` records a verified platform-wide fact: approving a suspended
// automation write executes NOTHING (migration 0014's own header says so — resumption is a
// Temporal/durable-workflow concern the spec defers). This ticket does NOT build a resume mechanism
// and does not pretend one exists. Instead it takes the route design §07 already specified for
// exactly this reason: **the caller re-drives.**
//
//   attempt 1 (no approval)   -> 202, an approval row is filed, NOTHING is executed
//   a human decides it        -> the existing POST /api/:t/automation-approvals/:id/decide, unchanged
//   attempt 2 (same route)    -> the approval is consumed and the change executes exactly once
//
// So the "approved row is the authorization artifact" (design §07's own words) rather than a
// trigger. Consequences, stated rather than discovered later:
//   - Nothing happens on decision. An approved-but-never-re-driven proposal stays un-executed
//     forever. That is strictly safer than an event-handler that executes a live ad-account change
//     with no human present at the moment of execution, and it is why this ticket deliberately does
//     NOT register an `automation_approval.decided` eventHandler the way HR's leave flow does
//     (`modules/hr/leave-decision.ts`). HR's handler moves an internal row; this would spend a
//     client's money.
//   - A REJECTED approval is terminal for that proposal: `approval_id` is already set, so the
//     suspend step will not mint a second approval, and execution requires `status='approved'`.
//     Remediation is a NEW proposal — never a re-decision of the old one.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ECHO-VALIDATION (addendum §A14 / §A14.5, tracker §6bc/§6bi) — APPLIED TO THE EXECUTOR
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// §A14's rule is written for vendor-boundary INGEST paths, and its logic transposes exactly onto a
// vendor-boundary WRITE: every operation we send carries an identity (`ref`); the executor's reply
// must echo those identities back. What the response says about ops we did not send — or fails to
// say about ops we did — is a statement about the ADDRESSING SCHEME, not about one row.
//
// §A14.5's pairing discriminator is the part that decides the remedy here. A results array paired
// to a sent-operations array is positionally/identity-paired, so an unknown, duplicated, or missing
// `ref` impeaches every other result in the same response: we can no longer say WHICH change
// applied. The remedy is therefore record-everything-then-refuse-attribution (`indeterminate`) —
// never skip-the-bad-one-and-continue, which would silently mislabel the survivors.
//
// And the money/data split (§A14.5) transposes too. Here "the money" is the LIVE SIDE EFFECT: by
// the time a response comes back, changes may already exist in the client's ad account. So the
// execution row is always written with everything we know BEFORE the refusal is raised — the
// controller commits the settlement, then throws. Withholding the record to "reject" the execution
// would reproduce the SM-50 orphan class in its most expensive form: a live ad-account change with
// no local trace of it.
//
// Canonicalization before comparing is §A14.5's rule verbatim (trim + NFC + collapse whitespace +
// lowercase): a raw-only variance is the counterparty restating our own id (accepted, counted in
// `refsRestated`), while a CANONICAL mismatch is a different identity (refused). An ABSENT echo is
// not a mismatch in §A14.5's ingest framing — but it is here, and the difference is deliberate: an
// ingest can defer a missing row to the next pull, whereas a missing operation result means a live
// change whose outcome we will never learn. Absence is therefore treated as an identity failure.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// MONEY LANGUAGE (addendum §A3) — nothing in this file is OUR cost
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// A budget/bid operation carries the CLIENT's own advertising budget in minor units. It is never
// metered as our cost-to-serve, never written to `search_provider_calls`, never summed with
// `cost_usd`. This path calls no data vendor and writes no ledger row — see the controller's route
// header. `search_term_metrics_daily.cost_minor`'s column comment (0062) makes the identical point
// about the same class of figure.
import { createHash } from "node:crypto";

// ── Bounds (hostile/oversized input must 400, never 500 and never a half-executed batch) ──────────
// Validation runs BEFORE the claim row is inserted and before any executor is called, so an
// oversized proposal never reaches the ad account partially — same discipline as
// search-audit.ts's validateCrawlerReport and sem-search-terms.ts's validateSearchTermBatch.
export const MAX_OPERATIONS_PER_EXECUTION = 1_000;

/** Test-only lever that widens the admission->claim window so the replay race can be genuinely
 *  forced instead of hopefully raced (the §6ay lesson: a concurrent test that never actually
 *  collides passes while proving nothing; SM-20's `INGEST_RACE_DELAY_MS` is the precedent this
 *  copies deliberately). Production always runs at 0. The test that sets it also asserts the
 *  elapsed time actually grew, per the negative-control rule's clause 3 (instruments self-assert). */
export const APPLY_RACE_DELAY_MS = { value: 0 };

export const EXECUTION_STATUSES = ["dispatched", "applied", "partial", "failed", "indeterminate"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const APPLY_KINDS = ["launch", "pause", "budget", "bid", "negatives_batch", "ads_batch"] as const;
export type ApplyKind = (typeof APPLY_KINDS)[number];
const APPLY_KIND_SET = new Set<string>(APPLY_KINDS);
export function isApplyKind(v: string): v is ApplyKind {
  return APPLY_KIND_SET.has(v);
}

/** Raised for anything the CALLER can fix (an unexecutable payload, an oversized batch). The
 *  controller maps it to a 400 — mirroring sem-export.ts's `ExportInputError` convention exactly so
 *  a hostile payload can never surface as a 500. */
export class ApplyInputError extends Error {}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (a) CONTENT IDENTITY
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Deep, key-sorted JSON — the canonical form the content hash is computed over. Byte-identical in
 *  behaviour to `search-audit.ts`'s own `canonicalize` (SM-08's precedent, which the ticket brief
 *  directs this to follow rather than invent a second scheme). Reimplemented rather than imported
 *  so this file stays independent of the audit module's private helpers; `sem-export.ts` already
 *  established that convention for `summarizeKeywordProvenance`. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * THE content identity of a change proposal — the thing an approval decision is bound to.
 *
 * Covers `kind`, `mode` and `payload` together, because all three determine WHAT WOULD EXECUTE:
 *   - `payload` is the obvious one (0034's own column comment: "exact intended change (hashed for
 *     approval match)");
 *   - `kind` selects which operations are built from that payload at all — the same
 *     `{ids: [...]}` payload means "add these negatives" under one kind and "publish these ads"
 *     under another;
 *   - `mode` is what makes this the api path rather than the manual one. A proposal that flipped
 *     manual->api after its approval was minted would be executing under an authorization granted
 *     for a different execution channel.
 *
 * Server-computed, always. Nothing a caller sends ever contributes to this value.
 */
export function hashChangeProposalContent(kind: string, mode: string, payload: unknown): string {
  const canonical = JSON.stringify(canonicalize({ kind, mode, payload: payload ?? {} }));
  return createHash("sha256").update(canonical).digest("hex");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (b) OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export const OPERATION_TYPES = [
  "campaign.launch", "campaign.pause", "campaign.budget", "campaign.bid",
  "keyword.add", "negative.add", "ad.publish",
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

/** One atomic change to be made in the ad account. `ref` is its identity in the request/response
 *  pairing — a stable, server-computed string built from OUR OWN row ids (the "our ids travel with
 *  the artifact" convention `sem-export.ts` and `sem-search-terms.ts` already use), never a bare
 *  array index. A positional identity would make the echo check tautological: any response of the
 *  right LENGTH would validate, which is precisely the vendor-trust assumption §A14 exists to
 *  remove. `entityId` is the local row this operation is about, so a per-change result can be
 *  cascaded back onto exactly the rows that actually applied. */
export interface ChangeOperation {
  ref: string;
  opType: OperationType;
  entityType: "search_campaign" | "search_keyword" | "search_negative" | "search_ad";
  entityId: string;
  /** Human/executor-readable field set. Values are scalars only — an executor is never handed a
   *  nested structure it might interpret differently from the CSV twin. */
  fields: Record<string, string | number | null>;
}

export interface ApplyCampaignFacts {
  id: string;
  name: string;
  platform: string;
  budgetMinor: number | null;
  currency: string | null;
  bidStrategy: string | null;
  targetCpaMinor: number | null;
  targetRoas: number | null;
}
export interface ApplyNegativeFact { id: string; term: string; matchType: string; adGroupName: string | null }
export interface ApplyAdFact { id: string; adGroupName: string; headlines: string[]; descriptions: string[]; finalUrl: string | null }
export interface ApplyLaunchKeywordFact { keywordId: string; keyword: string; adGroupName: string }

export interface ApplyFacts {
  campaign: ApplyCampaignFacts;
  payload: Record<string, unknown>;
  negatives?: ApplyNegativeFact[];
  ads?: ApplyAdFact[];
  launchKeywords?: ApplyLaunchKeywordFact[];
}

function refFor(opType: OperationType, entityId: string): string {
  return `${opType}#${entityId}`;
}

/**
 * Turns an approved proposal + the rows it references into the bounded operation list that will be
 * sent to the ad account. PURE: the controller has already resolved every row through the
 * tenant+module-scoped connection, so nothing here can widen scope.
 *
 * Every kind produces at least one operation, and `launch`/`negatives_batch`/`ads_batch` produce
 * genuinely MANY — which is why partial execution is a real state this path must represent rather
 * than a theoretical one (property 4 of the ticket brief).
 *
 * Deliberately mirrors `sem-export.ts`'s per-kind field selection (payload override, else the
 * campaign's own stored value) so the manual CSV twin and the automated twin cannot drift into
 * applying two different changes from the same proposal. Where the CSV needed a display string,
 * this needs the raw value; the SELECTION rule is the same.
 */
export function buildChangeOperations(kind: string, facts: ApplyFacts): ChangeOperation[] {
  if (!isApplyKind(kind)) throw new ApplyInputError(`unknown change-proposal kind '${kind}'`);
  const { campaign, payload } = facts;
  const ops: ChangeOperation[] = [];

  if (kind === "launch") {
    const keywords = facts.launchKeywords ?? [];
    if (keywords.length === 0) {
      throw new ApplyInputError("no ad-group/keyword rows to launch for this campaign yet");
    }
    ops.push({
      ref: refFor("campaign.launch", campaign.id),
      opType: "campaign.launch",
      entityType: "search_campaign",
      entityId: campaign.id,
      fields: {
        name: campaign.name,
        platform: campaign.platform,
        budgetMinor: campaign.budgetMinor,
        currency: campaign.currency,
        bidStrategy: campaign.bidStrategy,
      },
    });
    for (const kw of keywords) {
      ops.push({
        ref: refFor("keyword.add", kw.keywordId),
        opType: "keyword.add",
        entityType: "search_keyword",
        entityId: kw.keywordId,
        // Match type: 'broad' for the same reason sem-export.ts's named assumption #2 gives — our
        // schema models no per-keyword target match type, and Broad is Ads' own default for a new
        // keyword. Named here rather than silently chosen.
        fields: { keyword: kw.keyword, adGroupName: kw.adGroupName, matchType: "broad" },
      });
    }
  } else if (kind === "pause") {
    ops.push({
      ref: refFor("campaign.pause", campaign.id),
      opType: "campaign.pause",
      entityType: "search_campaign",
      entityId: campaign.id,
      fields: { name: campaign.name, status: "paused" },
    });
  } else if (kind === "budget") {
    const budgetMinor = typeof payload.budgetMinor === "number" ? payload.budgetMinor : campaign.budgetMinor;
    const currency = typeof payload.currency === "string" ? payload.currency : campaign.currency;
    if (budgetMinor === null || !Number.isFinite(budgetMinor) || !currency) {
      throw new ApplyInputError("budgetMinor+currency required — set them on the proposal payload or on the campaign itself first");
    }
    if (budgetMinor < 0) throw new ApplyInputError("budgetMinor cannot be negative");
    ops.push({
      ref: refFor("campaign.budget", campaign.id),
      opType: "campaign.budget",
      entityType: "search_campaign",
      entityId: campaign.id,
      // The CLIENT's own ad budget (§A3) — never our cost-to-serve. See the file header.
      fields: { name: campaign.name, budgetMinor, currency },
    });
  } else if (kind === "bid") {
    const bidStrategy = typeof payload.bidStrategy === "string" ? payload.bidStrategy : campaign.bidStrategy;
    const targetCpaMinor = typeof payload.targetCpaMinor === "number" ? payload.targetCpaMinor : campaign.targetCpaMinor;
    const targetRoas = typeof payload.targetRoas === "number" ? payload.targetRoas : campaign.targetRoas;
    if (!bidStrategy) {
      throw new ApplyInputError("bidStrategy required — set it on the proposal payload or on the campaign itself first");
    }
    ops.push({
      ref: refFor("campaign.bid", campaign.id),
      opType: "campaign.bid",
      entityType: "search_campaign",
      entityId: campaign.id,
      fields: { name: campaign.name, bidStrategy, targetCpaMinor: targetCpaMinor ?? null, targetRoas: targetRoas ?? null },
    });
  } else if (kind === "negatives_batch") {
    const negatives = facts.negatives ?? [];
    if (negatives.length === 0) {
      throw new ApplyInputError("payload.ids (the negative-keyword row ids this batch covers) must resolve to at least one negative in this campaign");
    }
    for (const neg of negatives) {
      ops.push({
        ref: refFor("negative.add", neg.id),
        opType: "negative.add",
        entityType: "search_negative",
        entityId: neg.id,
        fields: { term: neg.term, matchType: neg.matchType, adGroupName: neg.adGroupName, campaignName: campaign.name },
      });
    }
  } else {
    // ads_batch — the only remaining member of APPLY_KINDS.
    const ads = facts.ads ?? [];
    if (ads.length === 0) {
      throw new ApplyInputError("payload.ids (the ad row ids this batch covers) must resolve to at least one ad in this campaign");
    }
    for (const ad of ads) {
      ops.push({
        ref: refFor("ad.publish", ad.id),
        opType: "ad.publish",
        entityType: "search_ad",
        entityId: ad.id,
        fields: {
          adGroupName: ad.adGroupName,
          // Flattened to joined scalars deliberately (see ChangeOperation's doc comment): the
          // executor receives exactly the strings the manual CSV would carry, in the same order,
          // with no nested shape to reinterpret. The tab separator cannot occur inside a Google
          // RSA asset, so this is lossless for the values this schema can hold.
          headlines: ad.headlines.join("\t"),
          descriptions: ad.descriptions.join("\t"),
          finalUrl: ad.finalUrl,
        },
      });
    }
  }

  if (ops.length > MAX_OPERATIONS_PER_EXECUTION) {
    throw new ApplyInputError(
      `this proposal expands to ${ops.length} operations, above the ${MAX_OPERATIONS_PER_EXECUTION} ceiling — split it into smaller proposals rather than executing a batch this path has never been proven at`,
    );
  }
  // Refs must be unique or the echo check degenerates: two operations sharing a ref cannot be told
  // apart in the response, so a single result would "cover" both. Structurally impossible given the
  // (opType, own-row-id) construction above — asserted anyway, because if a future kind ever
  // violates it the failure would otherwise be a silent mis-attribution rather than a refusal.
  const seen = new Set<string>();
  for (const op of ops) {
    if (seen.has(op.ref)) throw new ApplyInputError(`duplicate operation ref '${op.ref}' — refusing to execute an ambiguous batch`);
    seen.add(op.ref);
  }
  return ops;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (c) THE EXECUTOR SEAM
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export interface ChangeOperationResult {
  /** MUST echo the `ref` of the operation this result is for (§A14). */
  ref: string;
  outcome: "applied" | "failed";
  /** The ad platform's own id for the created/updated resource, when it returns one. Recorded, never
   *  required — its absence is not an identity failure (the `ref` is the identity). */
  remoteId?: string | null;
  /** Why it failed, for the operator. Bounded by the controller before persistence. */
  detail?: string | null;
}

export interface ExecutorReport {
  /** e.g. 'google_ads' for a real push, 'simulation' for the built-in simulator. */
  provider: string;
  /** The executor's OWN claim about whether anything left this process. Cross-checked against the
   *  platform's mode by `reconcileExecution` — an executor claiming a live push while the platform
   *  is in simulate mode is refused, never trusted (see `MODE_MISMATCH` below). */
  simulated: boolean;
  results: ChangeOperationResult[];
}

export interface AdsExecutorContext {
  tenantId: string;
  proposalId: string;
  campaignId: string;
  kind: ApplyKind;
  operations: ChangeOperation[];
}
export type AdsExecutor = (ctx: AdsExecutorContext) => Promise<ExecutorReport>;

/**
 * The built-in SIMULATION executor. Reaches nothing — no network, no Google, no vendor — and says
 * so (`simulated: true`, `provider: 'simulation'`), which is what gets stamped on the execution row
 * (property 5 of the brief: the fact lives in the database, not only in the UI).
 *
 * It has no failure model on purpose. A simulator that invented failures would be manufacturing a
 * counterparty behaviour we have never observed — the §A10.2/§A10.5 doctrine (a green sandbox
 * validates our code against OUR OWN MODEL of the vendor) says that is worth less than nothing on a
 * path whose whole job is to be honest about outcomes. Partial/indeterminate handling is therefore
 * proven by INJECTING an executor in tests (`setAdsExecutorForTest`), never by teaching the
 * production simulator to lie.
 */
export const simulationAdsExecutor: AdsExecutor = async (ctx) => ({
  provider: "simulation",
  simulated: true,
  results: ctx.operations.map((op) => ({
    ref: op.ref,
    outcome: "applied" as const,
    // Deterministic, obviously-synthetic, and namespaced so it can never be mistaken for a real
    // Google resource name (which are of the form 'customers/123/adGroupCriteria/456~789').
    remoteId: `simulated://${op.opType}/${op.entityId}`,
    detail: null,
  })),
});

/** SM-26's registration seam. It will register the real Google Ads push here; until then LIVE mode
 *  has NO executor and this route refuses rather than silently simulating (absence of capability
 *  must never look like a working control — the same house rule the UI's `PaidActionGate` and
 *  `ApplyProposalTwins` already apply on the front end). */
let liveExecutor: AdsExecutor | null = null;
export function registerLiveAdsExecutor(fn: AdsExecutor): void {
  liveExecutor = fn;
}
export function clearLiveAdsExecutor(): void {
  liveExecutor = null;
}

/** Test-only total override of executor resolution — the same shape as `setStorageForTest`. Never
 *  called from production code: the mode-based resolution below is the only production path. */
let testExecutor: AdsExecutor | null = null;
export function setAdsExecutorForTest(fn: AdsExecutor | null): void {
  testExecutor = fn;
}

export class NoLiveExecutorError extends Error {}

/**
 * Resolves which executor runs, from the platform mode. The two directions are MUTUALLY EXCLUSIVE,
 * mirroring `main.ts`'s boot-time provider-mode exclusion:
 *
 *   simulate -> ALWAYS the built-in simulator, even if SM-26 has registered a live executor. A demo
 *               instance must be structurally incapable of touching a real ad account; "we
 *               registered a live pusher but the mode says simulate" is a misconfiguration whose
 *               only safe reading is the more restrictive one.
 *   live     -> the registered executor, or a refusal. Never the simulator: silently simulating a
 *               live push and reporting success would be the exact "reporting success when nothing
 *               happened" failure this ticket exists to prevent.
 *
 * `providerMode` is reused as the mode source rather than a new env var because this file cannot
 * touch `config.ts` (owned elsewhere this wave) AND because it is already the module's established
 * answer to "is this environment producing real or demo artifacts" for edges that carry neither a
 * DispatchResult nor an OAuth connection (0062's file header states that precedent for SM-20's
 * webhook). STATED LIMIT for the architect: `providerMode` nominally describes DATA vendors, so if
 * a future deployment ever wants live Google Ads writes alongside simulated keyword data, this
 * needs its own switch. Today the combination is impossible (no live executor exists at all), so
 * one mode is honest rather than merely convenient.
 */
export function resolveAdsExecutor(providerMode: "simulate" | "live"): { executor: AdsExecutor; expectSimulated: boolean } {
  if (testExecutor) return { executor: testExecutor, expectSimulated: providerMode === "simulate" };
  if (providerMode === "simulate") return { executor: simulationAdsExecutor, expectSimulated: true };
  if (!liveExecutor) {
    throw new NoLiveExecutorError(
      "no live Google Ads executor is registered — api-mode execution against a real ad account lands with SM-26. The approval path is built and testable in simulate mode; it deliberately refuses rather than pretending to push.",
    );
  }
  return { executor: liveExecutor, expectSimulated: false };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (d) RECONCILIATION — echo-validation + outcome classification
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** §A14.5's canonicalizer, verbatim: trim + NFC + collapse whitespace + lowercase. Raw-only
 *  variance (a counterparty restating our ref with different spacing/case) is a restatement to
 *  ACCEPT AND COUNT; a canonical mismatch is a different identity, which is refused. */
export function canonicalizeRef(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface PerChangeRecord {
  ref: string;
  opType: OperationType;
  entityType: ChangeOperation["entityType"];
  entityId: string;
  outcome: "applied" | "failed" | "unknown";
  remoteId: string | null;
  detail: string | null;
}

export interface ReconciledExecution {
  status: ExecutionStatus;
  changesTotal: number;
  changesApplied: number;
  changesFailed: number;
  /** Operations we sent whose outcome the response never told us. Non-zero forces `indeterminate`. */
  changesUnknown: number;
  /** Refs echoed with raw-only variance — accepted, counted, disclosed (§A14.5). */
  refsRestated: number;
  /** Non-empty => the addressing scheme is impeached => `indeterminate`, no attribution claimed. */
  echoViolations: string[];
  perChange: PerChangeRecord[];
  /** Row ids of operations we can say applied — the ONLY ids the controller cascades onto. Empty
   *  whenever `status === 'indeterminate'`: an impeached response attributes nothing. */
  appliedEntityIds: string[];
}

const MODE_MISMATCH = "executor reported simulated=";

/**
 * Classifies an execution. FOUR outcomes, chosen so that no real state has to be rounded into a
 * neighbouring one (property 4 of the brief; the same reasoning that produced the ledger's
 * `incurred` status — "the action happened, the result is not in our hands"):
 *
 *   applied       every operation applied. The only outcome that stamps the proposal 'applied'.
 *   partial       >=1 applied AND >=1 failed, and we know exactly which. The `incurred` shape.
 *   failed        zero applied. Nothing reached the account, or every operation was refused.
 *   indeterminate the response could not be paired to what we sent (unknown/duplicate/missing ref)
 *                 or the executor's mode claim contradicts the platform's. Live changes MAY exist;
 *                 we refuse to say which. Records everything, attributes nothing.
 *
 * `indeterminate` is deliberately NOT collapsed into `partial`: partial means "we know the split",
 * indeterminate means "we do not". Conflating them would let an unreadable response be reported as
 * a known outcome, which is the fourth failure mode in this file's header.
 */
export function reconcileExecution(
  operations: ChangeOperation[],
  report: ExecutorReport,
  expectSimulated: boolean,
): ReconciledExecution {
  const echoViolations: string[] = [];

  // Mode honesty first — it is a statement about the whole response, not about one operation.
  // Checked BEFORE pairing so a mode-lying executor can never be reported as a clean success.
  if (report.simulated !== expectSimulated) {
    echoViolations.push(
      `${MODE_MISMATCH}${report.simulated} while the platform expected simulated=${expectSimulated} — refusing to attribute any outcome`,
    );
  }

  const byCanonicalRef = new Map<string, ChangeOperation>();
  for (const op of operations) byCanonicalRef.set(canonicalizeRef(op.ref), op);

  const matched = new Map<string, ChangeOperationResult>();
  let refsRestated = 0;
  for (const res of report.results) {
    const raw = typeof res.ref === "string" ? res.ref : "";
    const canonical = canonicalizeRef(raw);
    const op = byCanonicalRef.get(canonical);
    if (!op) {
      // A result for something we never sent. Per §A14.5's pairing discriminator this impeaches the
      // addressing scheme, not just this line — so it is recorded and the whole response refused,
      // never skipped-and-continued.
      echoViolations.push(`result echoes ref '${raw}' which was never sent`);
      continue;
    }
    if (matched.has(canonical)) {
      echoViolations.push(`ref '${raw}' echoed more than once — cannot tell which result is authoritative`);
      continue;
    }
    if (raw !== op.ref) refsRestated++;
    matched.set(canonical, res);
  }

  const perChange: PerChangeRecord[] = [];
  const appliedEntityIds: string[] = [];
  let changesApplied = 0;
  let changesFailed = 0;
  let changesUnknown = 0;
  for (const op of operations) {
    const res = matched.get(canonicalizeRef(op.ref));
    if (!res) {
      changesUnknown++;
      perChange.push({
        ref: op.ref, opType: op.opType, entityType: op.entityType, entityId: op.entityId,
        outcome: "unknown", remoteId: null, detail: "the executor's response said nothing about this operation",
      });
      continue;
    }
    const outcome = res.outcome === "applied" ? "applied" as const : "failed" as const;
    if (outcome === "applied") { changesApplied++; appliedEntityIds.push(op.entityId); } else { changesFailed++; }
    perChange.push({
      ref: op.ref, opType: op.opType, entityType: op.entityType, entityId: op.entityId,
      outcome,
      remoteId: typeof res.remoteId === "string" ? res.remoteId : null,
      detail: typeof res.detail === "string" ? res.detail.slice(0, 500) : null,
    });
  }
  if (changesUnknown > 0) {
    echoViolations.push(`${changesUnknown} of ${operations.length} operations got no result — outcome unattributable`);
  }

  let status: ExecutionStatus;
  if (echoViolations.length > 0) status = "indeterminate";
  else if (changesApplied === 0) status = "failed";
  else if (changesFailed === 0) status = "applied";
  else status = "partial";

  return {
    status,
    changesTotal: operations.length,
    changesApplied,
    changesFailed,
    changesUnknown,
    refsRestated,
    echoViolations,
    perChange,
    // An impeached response attributes NOTHING — the cascade must not stamp rows live off a
    // response we have just declared unreadable.
    appliedEntityIds: status === "indeterminate" ? [] : appliedEntityIds,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Cerbos action selection
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Which `resource_search_campaign` action gates executing this kind. NO POLICY FILE IS TOUCHED by
 * this ticket — every action below is already enumerated in SM-03's `resource_search_campaign.yaml`
 * and already restricted to module_manager/company_admin/group_executive (its own header says all
 * four execution twins ride `search:campaign:launch`).
 *
 * Three kinds have a purpose-named action and use it. `pause`/`bid`/`ads_batch` have none, and map
 * to `launch` — the policy's own header calls `launch` the action EVERY live-account action rides,
 * so this is the documented general case, not a widening. Inventing three new action strings would
 * mean editing a live Cerbos policy file, and project memory `cerbos-new-policy-needs-restart`
 * records that policy changes are not reliably hot-reloaded in this dev environment — an unlisted
 * action reads as a silent DENY that looks like a logic bug. Reusing already-granted actions keeps
 * that risk at zero for identical authorization semantics (all four are granted to exactly the same
 * derived roles).
 */
export function cerbosActionForKind(kind: ApplyKind): "launch" | "set_budget" | "apply_negatives" {
  if (kind === "budget") return "set_budget";
  if (kind === "negatives_batch") return "apply_negatives";
  return "launch";
}

/** The MCP tool name that names this execution, recorded on the approval row so a human deciding it
 *  in the unified inbox sees WHICH declared high-impact tool they are authorizing (design §07's tool
 *  table). Mirrors `cerbosActionForKind`'s grouping. */
export function toolNameForKind(kind: ApplyKind): string {
  if (kind === "budget") return "search.setBudget";
  if (kind === "negatives_batch") return "search.applyNegatives";
  return "search.launchCampaign";
}

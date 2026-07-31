// SM-26 — the Google Ads MUTATE executor that registers into SM-21's approve-execute-replay seam
// (sem-apply.ts's `AdsExecutor`/`registerLiveAdsExecutor`; design §04/§07/§12, addendum §A12.6/§A14.5
// "generalised to writes"; tracker §6bp Rulings 3/6). This file owns exactly what SM-21 left open for
// it (sem-apply.ts's own comment on `liveExecutor`): turning a bounded `ChangeOperation[]` into real
// Google Ads mutate HTTP calls, and reconciling what came back into the `ExecutorReport` shape
// sem-apply.ts already knows how to classify. It does NOT reopen sem-apply.ts's own logic — see
// "WHY THIS FILE NEVER RETURNS A HAND-ROLLED `indeterminate`" below.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE PRE-RULING THIS FILE IMPLEMENTS, VERBATIM (tracker §6bp Ruling 6)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Google Ads mutate responses (`.../{resource}:mutate`) return results POSITIONALLY, in request
// order, each carrying only the created/updated `resource_name` — there is NO client-supplied
// per-operation ref echoed back (confirmed against SM-51's sandbox fixture, `ads-mutate.ts`; SM-41G
// confirms the vendor fact for real). That is the opposite of every other vendor boundary this module
// has echo-validated, where the RESPONSE carries an identity to check. Here there is nothing in the
// response to validate an identity against, so SM-26 supplies the pairing authority itself:
//
//   1. Persist an ORDERED operation manifest (`search_ads_execution_manifest`, migration 0066) BEFORE
//      sending anything. The manifest predates the response — that is what makes positional parsing
//      admissible here, unlike DFS's `task_post` (§6bi): order preservation is the vendor's documented
//      contract, and nothing response-derived can rewrite an addressing scheme that was already
//      written down before the response existed.
//   2. Parse strictly POSITIONALLY against our own manifest, per Ads resource-type mutate call (Ads
//      pairs results per RPC, not globally — see "WHY OPERATIONS ARE GROUPED BY RESOURCE" below).
//   3. Any COUNT/SHAPE mismatch (wrong result count, non-2xx, unparsable body) for ANY resource-type
//      call ⇒ the WHOLE execution's addressing is impeached ⇒ every operation in this execution
//      becomes `indeterminate`, never a partial guess. A per-result `partialFailureError` INSIDE a
//      correctly-sized response is a PER-ROW outcome (that one operation failed), never an addressing
//      failure — the two are deliberately not conflated.
//   4. Every returned `resource_name` is captured — onto the manifest table (forensic, always) and
//      onto the `ExecutorReport` (authoritative, only when the addressing was NOT impeached) — for
//      ledger/console reconciliation and the SM-41G artifact.
//   5. If SM-41G finds a real per-operation echo after all, prefer it over position — the manifest
//      stays either way as the durable pre-send record.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE NEVER RETURNS A HAND-ROLLED `indeterminate` (or `partial`, or `applied`)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// sem-apply.ts's `reconcileExecution` ALREADY implements exactly the classification Ruling 6.3 asks
// for: an operation with no matching result becomes `outcome: 'unknown'`, and `changesUnknown > 0`
// forces `status = 'indeterminate'` — see its own header ("`indeterminate` is deliberately NOT
// collapsed into `partial`"). So when this file's own count/shape check fires, it does NOT invent its
// own indeterminate status — it returns an `ExecutorReport` with `results: []` (nothing echoed for
// anything), and sem-apply.ts's unmodified, already-verified logic derives `indeterminate` on its own,
// for every operation, via the identical mechanism DFS-style vendors trigger it through. This file
// therefore never duplicates sem-apply.ts's classification and never needs to (this ticket's file
// ownership deliberately excludes sem-apply.ts — see this file's own header comment on that boundary).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WHY OPERATIONS ARE GROUPED BY RESOURCE, AND WHAT "THE MANIFEST" MEANS ACROSS MULTIPLE CALLS
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// A `search_change_proposals` kind can expand into operations targeting SEVERAL distinct Ads
// resources in one execution (a `launch` proposal creates a Campaign AND several AdGroupCriteria/
// keywords). Real Ads exposes one Mutate RPC PER RESOURCE TYPE (`CampaignService.MutateCampaigns`,
// `AdGroupCriterionService.MutateAdGroupCriteria`, …), each independently positionally-paired — this
// is also exactly what SM-51's sandbox models (`/v{n}/customers/{id}/{resource}:mutate`, one `resource`
// segment per call). So this executor groups planned operations by their target resource (preserving
// original order within each group), sends ONE mutate call per group, and positionally pairs each
// group's response against ONLY that group's slice of the manifest. The manifest table itself still
// records a single GLOBAL send order across the whole execution (0066's own `position` column) — that
// is the forensic ordering a human reconciling an incident reads, even though the Ads-side pairing
// happens per resource-type call underneath it.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE FORBIDDEN CROSS-PRODUCT (tracker §6bp Ruling 3.2; addendum §A12.6) — refused, no override flag
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// A live executor must refuse a proposal whose payload derives from SIMULATED keyword data
// (`search_keywords.metrics_simulated`, migration 0048's own provenance column — the same fact
// sem-plan.ts's `KeywordProvenanceSummary` already summarizes for display). Spending a client's real
// ad budget on top of fabricated market-data metrics is §A2's never-blend rule arriving at the write
// edge. Checked BEFORE the manifest is persisted and BEFORE any network call, so a refusal here is
// unambiguously "nothing was sent" — see the executor-contract note below.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE EXECUTOR-CONTRACT DISCIPLINE THIS FILE MUST HONOUR (search.controller.ts STEP 6/7, unmodified)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// search.controller.ts's own comment states the rule this file must never violate: "a throw is the
// executor saying it did not act... throw only when nothing was sent" (a throw records `status =
// 'failed'`, never `indeterminate`). Every throw below happens strictly BEFORE the first Ads mutate
// HTTP call for this execution — connection/link/customer-id resolution, the forbidden-cross-product
// refusal, and operation-body planning (which can fail for an unresolvable ad group or an unavailable
// campaign-budget resource — see their own error classes) all run before `persistExecutionManifest`.
// Once even ONE mutate call has been attempted, this file NEVER throws again — a request that got no
// usable answer (network failure, non-2xx, wrong-shaped body) is folded into the addressing-impeached
// path and returned as a normal (empty-results) `ExecutorReport`, never rethrown, because by then a
// live side effect may already exist and withholding a report would be the SM-50 orphan class with a
// live ad-account change and no local trace (§A14.5's writes clause 3, "record-before-raise").
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// KNOWN, FLAGGED-NOT-FIXED GAPS (staging/follow-up, stated plainly rather than papered over)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//   * `campaign.launch`'s Campaign create body carries NO `campaignBudget` resource reference: a real
//     Ads campaign create requires a COMMITTED CampaignBudget resource_name, which requires either a
//     prerequisite mutate call (this schema has no campaign_budget external-id column to resume
//     against) or the unified `googleAds:mutate` RPC's cross-resource temp-id linking (SM-51's sandbox
//     does not model that RPC). This body will be rejected by real Google Ads until a follow-up ticket
//     adds the missing schema column and the two-call choreography.
//   * `campaign.budget` (an update to an EXISTING campaign's spend cap) is refused pre-send outright
//     (`AdsCampaignBudgetResourceUnavailableError`) for the identical reason — there is no honest
//     resource_name to construct, and guessing one is worse than refusing.
//   * `keyword.add` / `ad.publish` / an ad-group-scoped `negative.add` all require the target ad
//     group's OWN linked `external_id` (`search_ad_groups.external_id`) to already exist. On a genuine
//     first-time `launch`, it never does yet: `buildChangeOperations` (sem-apply.ts, out of this
//     ticket's file ownership) emits no `ad_group.create` operation at all, so there is no operation in
//     this executor's input that could create one. Refused pre-send (`AdsAdGroupResourceUnavailableError`)
//     rather than fabricated. Reachable in practice once a prior sync (SM-25c's read pull) has written a
//     real external_id back onto `search_ad_groups` for an already-live campaign.
//   * The exact Ads REST field names/enum casing used below (`advertisingChannelType`, `matchType`
//     values, `biddingStrategyType`, etc.) are this ticket's best-effort model of the vendor, per the
//     SAME "UNVERIFIED — SM-41G" disclaimer `api-client.ts`/`ads-client.ts` already carry for the read
//     side. A green run against SM-51's sandbox proves this executor is a validated client of OUR OWN
//     MODEL of the vendor, not a validated Google integration (§A12.5, verbatim).
//   * Per standing policy: no real developer token / OAuth client / Ads account exists in dev. Every
//     acceptance criterion that requires one ("do these operations apply as intended against a real
//     account", "real mutate response shapes", "is there really no operation echo after all") is
//     deferred to SM-41G in staging — stated plainly, not silently skipped.
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { googleAdsMutateRequest } from "./google/api-client";
import { normalizeAdsCustomerId } from "./google/ads-client";
import {
  GoogleAdsCustomerNotLinkedError, GoogleAdsNotConfiguredError, GoogleConnectionNotLinkedError, GooglePropertyNotBoundError,
} from "./google/errors";
import { getGoogleConnection, resolvePropertyConnection } from "./google/oauth";
import type { AdsExecutor, AdsExecutorContext, ChangeOperation, ChangeOperationResult } from "./sem-apply";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The write-mode split (tracker §6bp Ruling 3.1; addendum §A12.6)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
export const SEARCH_ADS_WRITE_MODE_ENV = "SEARCH_ADS_WRITE_MODE";

/**
 * Independent of `SEARCH_PROVIDER_MODE` — "may this environment touch a real ad account" and "are
 * data vendors live" are independent deployment facts (a funded-data-key staging environment with no
 * real ad account yet is a legitimate, likely configuration). Default `'simulate'`, matching
 * `SEARCH_PROVIDER_MODE`'s own default-to-restrictive convention in spirit (though that var itself
 * defaults to `'live'` for backward compatibility — this is a BRAND NEW switch with no prior
 * deployment to stay compatible with, so it defaults to the safer value outright).
 *
 * Read directly from `process.env`, NOT `config.ts`: the identical file-ownership seam SM-49's own
 * `SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL_ENV` uses (main.ts's own comment states that exact precedent —
 * "Read directly from process.env, NOT config.ts... TODO(follow-up): fold this into config.ts... once
 * that ownership frees up"). Reported to the architect rather than done here (config.ts is this
 * ticket's explicit report-don't-touch file).
 */
export function resolveSearchAdsWriteMode(): "simulate" | "live" {
  return process.env[SEARCH_ADS_WRITE_MODE_ENV] === "live" ? "live" : "simulate";
}

/** Boot-time refusal, never a runtime one — mirrors `main.ts`'s own `assertProvenance` shape exactly
 *  (design addendum §A4.3/§A10.4: "mode/driver mutual exclusion is a boot error, not a warning"). */
export class AdsWriteModeBootError extends Error {}

/**
 * `live` with no registered executor must abort startup, never silently simulate and never merely
 * log (tracker §6bp Ruling 3.1). Pure and synchronous — trivially unit-testable without booting the
 * whole app.
 *
 * WIRED (tracker §6bv/§6bv.1, SM-75): `main.ts`'s `wireSearchProviderModeAndAdsWriteMode()` calls
 * `registerLiveAdsExecutor(googleAdsLiveExecutor)` immediately followed by this function against
 * `resolveSearchAdsWriteMode()`, both at that function's top level — deliberately OUTSIDE the
 * `SEARCH_PROVIDER_MODE` if/else, and unconditional on every boot. (SM-24's gate caught an earlier
 * revision of that call site nested inside the `SEARCH_PROVIDER_MODE === "live"` branch, which let
 * `SEARCH_PROVIDER_MODE=simulate` skip both the registration and this assertion — the exact
 * simulated-data-with-live-ad-writes combination §A12.6 calls legitimate, silently unguarded. Fixed;
 * `sm75-search-boot-wiring.test.ts` pins the placement so a regression back into a mode branch goes
 * red.) This function now genuinely gates the running server, not merely the intended behaviour.
 */
export function assertAdsWriteModeBootSafe(writeMode: "simulate" | "live", hasLiveExecutorRegistered: boolean): void {
  if (writeMode === "live" && !hasLiveExecutorRegistered) {
    throw new AdsWriteModeBootError(
      `[search] BOOT ERROR: ${SEARCH_ADS_WRITE_MODE_ENV}=live but no live Google Ads executor is ` +
        "registered — api-mode execution against a real ad account must never silently fall back to " +
        "simulation (design addendum §A12.6, tracker §6bp Ruling 3.1). Call " +
        "registerLiveAdsExecutor(googleAdsLiveExecutor) (sem-executor-google-ads.ts) before boot, or " +
        `leave ${SEARCH_ADS_WRITE_MODE_ENV} unset (or 'simulate').`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Local error family — every throw here happens strictly before the first network call (see file
// header: "throw only when nothing was sent"). Plain `Error` subclasses, not `GoogleSurfaceError`:
// these are never mapped through `GoogleOAuthErrorFilter` — they are always caught by
// search.controller.ts's own generic executor try/catch (STEP 6), which reads `.message` and records
// `status='failed'`, exactly like sem-apply.ts's own `ApplyInputError`/`NoLiveExecutorError` pattern.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export class SimulatedKeywordDataRefusedError extends Error {
  constructor(readonly keywordIds: string[]) {
    super(
      `refusing to execute a live Ads write derived from simulated keyword data (${keywordIds.length} ` +
        `keyword row(s): ${keywordIds.slice(0, 5).join(", ")}${keywordIds.length > 5 ? ", …" : ""}) — ` +
        "design addendum §A12.6 / tracker §6bp Ruling 3.2: spending a client's real ad budget on top " +
        "of fabricated keyword metrics is the never-blend rule (§A2) arriving at the write edge. There " +
        "is no override flag — regenerate the plan from real pulls first. Nothing was sent.",
    );
    this.name = "SimulatedKeywordDataRefusedError";
  }
}

export class AdsAdGroupResourceUnavailableError extends Error {
  constructor(readonly adGroupName: string) {
    super(
      `ad group '${adGroupName}' has no linked Google Ads external_id yet — this executor cannot ` +
        "create or reference an ad group inline (buildChangeOperations, sem-apply.ts, emits no " +
        "ad_group.create operation for a first-time launch; flagged, not fixed — an upstream gap in " +
        "the operation model, out of this ticket's file ownership). Nothing was sent.",
    );
    this.name = "AdsAdGroupResourceUnavailableError";
  }
}

export class AdsCampaignBudgetResourceUnavailableError extends Error {
  constructor(readonly entityId: string) {
    super(
      `cannot update the Ads CampaignBudget resource for campaign row ${entityId} — this schema has ` +
        "no campaign_budget external-id column to construct a resource_name from (flagged, not fixed: " +
        "a follow-up ticket must add one, or resolve it via a read-back pull). Refusing pre-send rather " +
        "than guessing a resource_name. Nothing was sent.",
    );
    this.name = "AdsCampaignBudgetResourceUnavailableError";
  }
}

export class AdsCampaignNotLinkedError extends Error {
  constructor(readonly campaignId: string) {
    super(
      `campaign ${campaignId} has no linked Google Ads external_id — pause/budget/bid/campaign-level ` +
        "negative operations require an already-synced live campaign. Nothing was sent.",
    );
    this.name = "AdsCampaignNotLinkedError";
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Campaign → engagement → property → connection resolution
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// `AdsExecutorContext` (sem-apply.ts) carries only tenantId/proposalId/campaignId/kind/operations — no
// connectionId, no propertyId, no engagementId (search.controller.ts already resolved everything it
// needed through those; the executor gets the bounded operation list only). This executor resolves
// the SAME chain ads-client.ts's read path is handed pre-resolved by its own caller
// (`pullAdsMetricsForEngagement`'s params), starting one join earlier from `campaignId` alone.

interface CampaignAdsLink {
  propertyId: string;
  /** Google's own campaign id, digits-only, once a prior launch/sync has written it back — NULL for a
   *  campaign that has never been created in Ads yet (the normal state for a first-time `launch`). */
  campaignExternalId: string | null;
}

async function resolveCampaignAdsLink(tenantId: string, campaignId: string): Promise<CampaignAdsLink> {
  const rows = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ property_id: string; external_id: string | null }>(
        `SELECT se.property_id, sc.external_id
           FROM search_campaigns sc
           JOIN search_engagements se ON se.id = sc.engagement_id
          WHERE sc.id = $1 AND sc.deleted_at IS NULL`,
        [campaignId],
      ),
    { modules: ["search"] },
  );
  const row = rows.rows[0];
  if (!row) {
    throw new Error(
      `sem-executor-google-ads.ts: campaign ${campaignId} has no resolvable engagement/property ` +
        "(deleted, or the engagement row is missing) — nothing was sent",
    );
  }
  return { propertyId: row.property_id, campaignExternalId: row.external_id };
}

async function findSimulatedKeywordIds(tenantId: string, keywordIds: string[]): Promise<string[]> {
  if (keywordIds.length === 0) return [];
  const rows = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM search_keywords WHERE id = ANY($1::uuid[]) AND metrics_simulated = true`,
        [keywordIds],
      ),
    { modules: ["search"] },
  );
  return rows.rows.map((r) => r.id);
}

async function loadAdGroupExternalIds(
  tenantId: string,
  campaignId: string,
  names: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (names.length === 0) return map;
  const rows = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ name: string; external_id: string | null }>(
        `SELECT name, external_id FROM search_ad_groups
          WHERE campaign_id = $1 AND name = ANY($2::text[]) AND deleted_at IS NULL`,
        [campaignId, names],
      ),
    { modules: ["search"] },
  );
  for (const r of rows.rows) map.set(r.name, r.external_id);
  return map;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Operation planning: ChangeOperation -> { ads resource, mutate operation body }
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type AdsMutateResource = "campaigns" | "campaignCriteria" | "adGroupCriteria" | "adGroupAds";

export interface PlannedAdsOperation {
  op: ChangeOperation;
  resource: AdsMutateResource;
  body: unknown;
}

function campaignResourceName(customerId: string, externalId: string): string {
  return `customers/${customerId}/campaigns/${externalId}`;
}
function adGroupResourceName(customerId: string, externalId: string): string {
  return `customers/${customerId}/adGroups/${externalId}`;
}

function stringField(fields: ChangeOperation["fields"], key: string): string | undefined {
  const v = fields[key];
  return typeof v === "string" ? v : undefined;
}
function numberField(fields: ChangeOperation["fields"], key: string): number | undefined {
  const v = fields[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Every op's Ads body-shape, planned BEFORE any manifest write or network call — a planning failure
 *  (unresolvable ad group, unavailable budget resource) means nothing was sent (see file header). */
export async function planAdsOperations(
  ctx: AdsExecutorContext,
  facts: { customerId: string; campaignExternalId: string | null },
): Promise<PlannedAdsOperation[]> {
  const adGroupNames = [
    ...new Set(
      ctx.operations
        .filter((o) => o.opType === "keyword.add" || o.opType === "ad.publish" || o.opType === "negative.add")
        .map((o) => stringField(o.fields, "adGroupName"))
        .filter((n): n is string => typeof n === "string" && n.length > 0),
    ),
  ];
  const adGroupLinks = await loadAdGroupExternalIds(ctx.tenantId, ctx.campaignId, adGroupNames);

  function requireAdGroupResourceName(adGroupName: string): string {
    const externalId = adGroupLinks.get(adGroupName);
    if (!externalId) throw new AdsAdGroupResourceUnavailableError(adGroupName);
    return adGroupResourceName(facts.customerId, externalId);
  }
  function requireCampaignResourceName(): string {
    if (!facts.campaignExternalId) throw new AdsCampaignNotLinkedError(ctx.campaignId);
    return campaignResourceName(facts.customerId, facts.campaignExternalId);
  }

  const planned: PlannedAdsOperation[] = [];
  for (const op of ctx.operations) {
    switch (op.opType) {
      case "campaign.launch": {
        planned.push({
          op,
          resource: "campaigns",
          body: {
            create: {
              name: stringField(op.fields, "name"),
              status: "ENABLED",
              advertisingChannelType: "SEARCH",
              // See file header "KNOWN, FLAGGED-NOT-FIXED GAPS": no campaignBudget reference — a real
              // create needs a committed CampaignBudget resource_name this executor cannot construct.
            },
          },
        });
        break;
      }
      case "campaign.pause": {
        planned.push({
          op,
          resource: "campaigns",
          body: { update: { resourceName: requireCampaignResourceName(), status: "PAUSED" }, updateMask: "status" },
        });
        break;
      }
      case "campaign.budget": {
        // Refused pre-send outright — see file header. Nothing sent for this op OR any sibling op in
        // the same execution (the whole plan build fails together, per the executor contract).
        throw new AdsCampaignBudgetResourceUnavailableError(op.entityId);
      }
      case "campaign.bid": {
        const resourceName = requireCampaignResourceName();
        const bidStrategy = stringField(op.fields, "bidStrategy");
        const targetCpaMinor = numberField(op.fields, "targetCpaMinor");
        const targetRoas = numberField(op.fields, "targetRoas");
        const update: Record<string, unknown> = { resourceName };
        const maskParts = ["bidding_strategy_type"];
        if (bidStrategy) update.biddingStrategyType = bidStrategy.toUpperCase();
        if (targetCpaMinor !== undefined) {
          update.targetCpa = { targetCpaMicros: String(Math.round(targetCpaMinor * 10000)) };
          maskParts.push("target_cpa.target_cpa_micros");
        }
        if (targetRoas !== undefined) {
          update.targetRoas = { targetRoas };
          maskParts.push("target_roas.target_roas");
        }
        planned.push({ op, resource: "campaigns", body: { update, updateMask: maskParts.join(",") } });
        break;
      }
      case "keyword.add": {
        const adGroupName = stringField(op.fields, "adGroupName") ?? "";
        const adGroup = requireAdGroupResourceName(adGroupName);
        const matchType = (stringField(op.fields, "matchType") ?? "broad").toUpperCase();
        planned.push({
          op,
          resource: "adGroupCriteria",
          body: { create: { adGroup, status: "ENABLED", keyword: { text: stringField(op.fields, "keyword"), matchType } } },
        });
        break;
      }
      case "negative.add": {
        const adGroupName = stringField(op.fields, "adGroupName");
        const matchType = (stringField(op.fields, "matchType") ?? "exact").toUpperCase();
        const term = stringField(op.fields, "term");
        if (adGroupName) {
          const adGroup = requireAdGroupResourceName(adGroupName);
          planned.push({
            op,
            resource: "adGroupCriteria",
            body: { create: { adGroup, negative: true, keyword: { text: term, matchType } } },
          });
        } else {
          const campaign = requireCampaignResourceName();
          planned.push({
            op,
            resource: "campaignCriteria",
            body: { create: { campaign, negative: true, keyword: { text: term, matchType } } },
          });
        }
        break;
      }
      case "ad.publish": {
        const adGroupName = stringField(op.fields, "adGroupName") ?? "";
        const adGroup = requireAdGroupResourceName(adGroupName);
        const headlines = (stringField(op.fields, "headlines") ?? "").split("\t").filter(Boolean).map((text) => ({ text }));
        const descriptions = (stringField(op.fields, "descriptions") ?? "").split("\t").filter(Boolean).map((text) => ({ text }));
        const finalUrl = stringField(op.fields, "finalUrl");
        planned.push({
          op,
          resource: "adGroupAds",
          body: {
            create: {
              adGroup,
              status: "ENABLED",
              ad: {
                responsiveSearchAd: { headlines, descriptions },
                ...(finalUrl ? { finalUrls: [finalUrl] } : {}),
              },
            },
          },
        });
        break;
      }
      default: {
        // ChangeOperation.opType is sem-apply.ts's closed OPERATION_TYPES union — an unreached case
        // here is already a compile error; this is a defensive belt for a future member landing in
        // that file without a corresponding branch here.
        throw new Error(`sem-executor-google-ads.ts: unhandled operation type '${String((op as ChangeOperation).opType)}'`);
      }
    }
  }
  return planned;
}

interface AdsOperationGroup {
  resource: AdsMutateResource;
  items: PlannedAdsOperation[];
}

/** Preserves first-seen order across resources, and original order within each resource — the
 *  ordering `search_ads_execution_manifest.position` records globally, and what each resource-type
 *  mutate call's OWN positional pairing is checked against locally. */
function groupPlannedOperations(planned: PlannedAdsOperation[]): AdsOperationGroup[] {
  const order: AdsMutateResource[] = [];
  const byResource = new Map<AdsMutateResource, PlannedAdsOperation[]>();
  for (const p of planned) {
    if (!byResource.has(p.resource)) {
      byResource.set(p.resource, []);
      order.push(p.resource);
    }
    byResource.get(p.resource)!.push(p);
  }
  return order.map((resource) => ({ resource, items: byResource.get(resource)! }));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The manifest — persisted BEFORE any network call (Ruling 6.1)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** The dispatched execution row's own id — see file header on why this is looked up rather than
 *  carried on `AdsExecutorContext`. Returns null only if the claim insert (search.controller.ts STEP
 *  5) never committed, which should be structurally impossible by the time an executor runs; treated
 *  as "nothing was sent" (a throw) rather than assumed. */
export async function findDispatchedExecutionId(tenantId: string, proposalId: string): Promise<string | null> {
  const rows = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM search_change_executions
          WHERE proposal_id = $1 AND status = 'dispatched'
          ORDER BY created_at DESC LIMIT 1`,
        [proposalId],
      ),
    { modules: ["search"] },
  );
  return rows.rows[0]?.id ?? null;
}

export async function persistExecutionManifest(
  tenantId: string,
  executionId: string,
  planned: PlannedAdsOperation[],
): Promise<void> {
  await withTenants(
    [tenantId],
    async (c) => {
      for (let position = 0; position < planned.length; position++) {
        const p = planned[position];
        await c.query(
          `INSERT INTO search_ads_execution_manifest
             (id, tenant_id, execution_id, position, ref, op_type, entity_type, entity_id, ads_resource)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [newId(), tenantId, executionId, position, p.op.ref, p.op.opType, p.op.entityType, p.op.entityId, p.resource],
        );
      }
    },
    { modules: ["search"] },
  );
}

interface ManifestOutcome {
  resourceName: string | null;
  outcome: "applied" | "failed";
  detail: string | null;
}

export async function updateExecutionManifestOutcomes(
  tenantId: string,
  executionId: string,
  outcomes: Map<string, ManifestOutcome>,
  impeachmentNote: string | null,
): Promise<void> {
  await withTenants(
    [tenantId],
    async (c) => {
      for (const [ref, o] of outcomes) {
        await c.query(
          `UPDATE search_ads_execution_manifest
              SET resource_name = $3, outcome = $4, error_detail = $5, updated_at = now()
            WHERE tenant_id = $1 AND execution_id = $2 AND ref = $6`,
          [tenantId, executionId, o.resourceName, o.outcome, o.detail, ref],
        );
      }
      if (impeachmentNote) {
        // Applied only to rows we learned NOTHING about (outcome still NULL) — a row already updated
        // above keeps its real per-row result even when the overall execution is impeached, because
        // the manifest is forensic (see file header): it should say what was actually observed, not
        // what the ExecutorReport was allowed to attribute.
        await c.query(
          `UPDATE search_ads_execution_manifest
              SET error_detail = COALESCE(error_detail, $3), updated_at = now()
            WHERE tenant_id = $1 AND execution_id = $2 AND outcome IS NULL`,
          [tenantId, executionId, impeachmentNote.slice(0, 2000)],
        );
      }
    },
    { modules: ["search"] },
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The executor itself
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface AdsMutateResponseBody {
  results?: Array<{ resourceName?: string }>;
  partialFailureError?: { code?: number; message?: string };
}

/** Test-only lever, same shape and same purpose as sem-apply.ts's own `APPLY_RACE_DELAY_MS`: widens
 *  the window between the manifest commit and the first network call so a test can PROVE the manifest
 *  is durable and queryable WHILE the network call has demonstrably not happened yet (sandbox hit
 *  count still 0), rather than merely inferring the order from a green result. Production always runs
 *  at 0 — this branch is unreachable there. The test that sets it also asserts the hit count directly
 *  (the negative-control rule's "instruments self-assert" clause). */
export const MANIFEST_TO_NETWORK_DELAY_MS = { value: 0 };

export const googleAdsLiveExecutor: AdsExecutor = async (ctx: AdsExecutorContext) => {
  // ── Fail-closed prerequisites (nothing sent yet) ────────────────────────────────────────────────
  if (!config.search.google.adsDeveloperToken) throw new GoogleAdsNotConfiguredError();

  const link = await resolveCampaignAdsLink(ctx.tenantId, ctx.campaignId);
  const connectionId = await resolvePropertyConnection(ctx.tenantId, link.propertyId, "google_ads");
  if (!connectionId) throw new GooglePropertyNotBoundError(link.propertyId, "google_ads");
  const connection = await getGoogleConnection(ctx.tenantId, connectionId);
  if (!connection) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  // Defensive, mirrors ads-client.ts's own guard: §6bq already closes the wrong-provider gap inside
  // `resolvePropertyConnection` itself (the JOIN now requires `ic.provider = $2`), so this can only
  // fire on a data shape that guard should already prevent — kept anyway as defence-in-depth, "as
  // instructed" per that ticket's own gate note.
  if (connection.provider !== "google_ads") throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  const customerId = normalizeAdsCustomerId(connection.externalAccount ?? "");
  if (!customerId) throw new GoogleAdsCustomerNotLinkedError(connectionId);

  // ── Ruling 3.2 / §A12.6 — THE FORBIDDEN CROSS-PRODUCT, refused, no override flag ────────────────
  const keywordEntityIds = ctx.operations.filter((o) => o.entityType === "search_keyword").map((o) => o.entityId);
  const simulatedIds = await findSimulatedKeywordIds(ctx.tenantId, keywordEntityIds);
  if (simulatedIds.length > 0) throw new SimulatedKeywordDataRefusedError(simulatedIds);

  // ── Plan every operation's Ads body BEFORE touching the manifest table or the network ───────────
  const planned = await planAdsOperations(ctx, { customerId, campaignExternalId: link.campaignExternalId });

  const executionId = await findDispatchedExecutionId(ctx.tenantId, ctx.proposalId);
  if (!executionId) {
    throw new Error(
      "sem-executor-google-ads.ts: no dispatched search_change_executions row exists for this " +
        "proposal — the claim insert (search.controller.ts STEP 5) must commit before the executor " +
        "runs. Nothing was sent.",
    );
  }

  // ══ Ruling 6.1 — PERSIST THE MANIFEST BEFORE THE SEND ══════════════════════════════════════════
  await persistExecutionManifest(ctx.tenantId, executionId, planned);
  if (MANIFEST_TO_NETWORK_DELAY_MS.value > 0) {
    // Test-only widening of the manifest->network window (see the lever's own doc comment above).
    await new Promise((r) => setTimeout(r, MANIFEST_TO_NETWORK_DELAY_MS.value));
  }

  const groups = groupPlannedOperations(planned);
  const outcomes = new Map<string, ManifestOutcome>();
  let addressingImpeached = false;
  const impeachmentReasons: string[] = [];

  for (const group of groups) {
    const path = `/${config.search.google.adsApiVersion}/customers/${customerId}/${group.resource}:mutate`;
    let http;
    try {
      http = await googleAdsMutateRequest<AdsMutateResponseBody>({
        tenantId: ctx.tenantId,
        connectionId,
        path,
        body: { operations: group.items.map((i) => i.body), partialFailure: true },
      });
    } catch (err) {
      // A connection-layer failure with an unattempted-elsewhere group still impeaches the WHOLE
      // execution's addressing (Ruling 6.3) — we cannot say whether an EARLIER group in this same
      // loop actually succeeded in a way we can still attribute once ANY group is unreadable.
      addressingImpeached = true;
      impeachmentReasons.push(`'${group.resource}': ${err instanceof Error ? err.message : "request failed"}`);
      continue;
    }
    const results = Array.isArray(http.data?.results) ? http.data!.results! : null;
    if (http.status < 200 || http.status >= 300 || !results || results.length !== group.items.length) {
      addressingImpeached = true;
      impeachmentReasons.push(
        `'${group.resource}': expected ${group.items.length} result(s), got ` +
          `${results ? results.length : "none"} (HTTP ${http.status})`,
      );
      continue;
    }
    // Strict positional parse against OUR OWN manifest order (this group's own `items`, which is a
    // slice of the manifest already committed above), never against anything the response describes
    // about itself.
    for (let i = 0; i < group.items.length; i++) {
      const item = group.items[i];
      const r = results[i];
      const resourceName = typeof r?.resourceName === "string" && r.resourceName ? r.resourceName : null;
      outcomes.set(item.op.ref, {
        resourceName,
        outcome: resourceName ? "applied" : "failed",
        detail: resourceName
          ? null
          : (http.data?.partialFailureError?.message?.slice(0, 500) ?? "operation returned no resource name"),
      });
    }
  }

  await updateExecutionManifestOutcomes(
    ctx.tenantId,
    executionId,
    outcomes,
    addressingImpeached ? impeachmentReasons.join("; ").slice(0, 2000) : null,
  );

  if (addressingImpeached) {
    // Ruling 6.3: ANY count/shape mismatch anywhere impeaches the WHOLE execution's addressing.
    // Returning zero results lets sem-apply.ts's OWN, unmodified `reconcileExecution` derive
    // `indeterminate` for every operation (changesUnknown === operations.length) — see this file's
    // header on why this file never hand-rolls that classification itself.
    return { provider: "google_ads", simulated: false, results: [] };
  }

  const results: ChangeOperationResult[] = ctx.operations.map((op) => {
    const o = outcomes.get(op.ref);
    if (!o) return { ref: op.ref, outcome: "failed", remoteId: null, detail: "no result recorded for this operation" };
    return { ref: op.ref, outcome: o.outcome, remoteId: o.resourceName, detail: o.detail };
  });
  return { provider: "google_ads", simulated: false, results };
};

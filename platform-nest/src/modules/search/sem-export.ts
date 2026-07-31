// SM-30 — the manual-apply/export twin (docs/blueprints/seo-sem-design.md §04/§07/§08/§12 SM-30;
// D-8: "manual twin — approved proposal → Ads-Editor export → human applies, P3, zero OAuth").
// Pure, synchronous, no I/O: search.controller.ts owns every DB read and the `files`/storage write;
// this file only turns already-resolved rows into an Ads-Editor-importable CSV. Same pure/testable
// split as sem-plan.ts / sem-drafts.ts / search-audit.ts.
//
// ── Where the CSV shape comes from (ticket's own instruction: research the real format, name the
//    assumption where confidence runs out) ──────────────────────────────────────────────────────────
// Verified via Google's own Ads Editor documentation (support.google.com/google-ads/editor, "Prepare
// a CSV file" / "CSV file columns", fetched while building this ticket):
//   - Campaigns:  "Campaign" (name), "Campaign daily budget", "Campaign status" (Enabled|Paused|Removed)
//   - Ad groups:  "Campaign", "Ad group" (name), "Ad group status", "Max CPC"
//   - Keywords:   "Campaign", "Ad group", "Keyword", and a criterion-type column (Ads Editor accepts
//                 several header spellings — "Type"/"Criterion type"/"Match type" — for the SAME
//                 column); values include "Broad"/"Phrase"/"Exact" for positive keywords and
//                 "Negative"/"Campaign negative" prefixes for negatives.
//   - RSAs:       "Headline 1".."Headline 15", "Description line 1".."Description line 4",
//                 "Final URL", "Path 1", "Path 2".
// NAMED ASSUMPTIONS (Ads Editor does not publish one single canonical header spelling per column,
// and some fields have no documented column at all for our schema — each is called out at its use
// site below, not silently invented):
//   1. Criterion-type vocabulary for MATCH-TYPE-SPECIFIC negatives ("Negative Broad/Phrase/Exact",
//      "Campaign Negative Broad/Phrase/Exact") — Google's docs confirm the "Negative"/"Campaign
//      negative" PREFIX but not the exact three-way match-type suffix spelling; this is the closest
//      documented shape, not a verified byte-exact string.
//   2. New targeting keywords (the 'launch' kind) default to Criterion Type "Broad" — our schema
//      does not model a per-keyword target match type, so Broad (Ads Editor's own default for a new
//      keyword) is used rather than inventing a value we have no source for.
//   3. "Target ROAS" is emitted as the RAW STORED RATIO (e.g. 3.5) — whether Ads Editor's own column
//      expects a ratio or a percentage was not confirmed with confidence; a human must check this in
//      Ads Editor before applying, and the API response says so (see buildAdsEditorExport's return).
//   4. "Ad status" on a NEW ad has no live state yet; 'approved' (this ticket only exports approved
//      ads, see below) maps to "Enabled", matching Ads Editor's own vocabulary for an ad the human
//      wants live once imported.
//   5. Path1/Path2 (Ads Editor's display-path columns) are always blank — the schema has no field
//      for them; emitting an invented value would be worse than an honest blank.
// A file that looks right and imports wrong is worse than an obvious stub — REAL Ads Editor column
// NAMES are used throughout (never invented), and every value this file could not verify is confined
// to the assumptions list above, not smuggled in unlabeled.
//
// ── Honesty in the export (ticket hazard #3; standing house rule §A2/§A4.7, same rule sem-plan.ts's
//    KeywordProvenanceSummary enforces for plan generation) ────────────────────────────────────────
// Only the 'launch' kind is genuinely "data-informed": it lists targeting keywords carrying
// provider-pulled volume/difficulty/cpc, exactly the surface sem-plan.ts's own header calls the
// "confident wrong answer" risk. The other five kinds (pause/budget/bid/negatives_batch/ads_batch)
// change structural/copy fields that never carry a provider metric — their provenance is honestly
// `null` ("not applicable"), never coerced to a zero-count that would look like "verified real data,
// zero simulated" when the truth is "no market data touches this export at all" (the module's
// standing "absent stays absent" rule).
// Three independent, non-conflicting channels carry the marker so it can never be missed nor corrupt
// the import:
//   (a) API response `provenance` — the full KeywordProvenanceSummary-shaped object, read by the
//       console (a later ticket) and by this ticket's own tests;
//   (b) filename — `...-SIMULATED.csv` whenever `simulatedCount > 0`, a channel that CANNOT affect
//       CSV parsing;
//   (c) a trailing, per-row "Notes" column (an ADDITIONAL column, never a shifted/prepended row) on
//       the 'launch' CSV only, stamping each keyword row's OWN provenance ("verified market data" /
//       "SIMULATED — do not treat as real market research" / "not yet pulled — no market data").
// A leading comment row was deliberately REJECTED: Ads Editor's own docs say the first row is read as
// the header row (with a manual remap option) — a stray leading line risks the header shifting into
// data silently, which is exactly the "imports wrong" failure this ticket's own instruction warns
// against. A trailing extra column is the safe channel: Ads Editor's column mapping step lets a human
// pick which columns matter, so an extra unmapped column cannot corrupt which field lands where.
import type { KeywordProvenanceSummary } from "./sem-plan";

export const CHANGE_PROPOSAL_EXPORT_KINDS = ["launch", "pause", "budget", "bid", "negatives_batch", "ads_batch"] as const;
export type ChangeProposalExportKind = (typeof CHANGE_PROPOSAL_EXPORT_KINDS)[number];

// ── CSV primitives ──────────────────────────────────────────────────────────────────────────────────
function csvField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvField).join(",");
}
/** CRLF line endings (Ads Editor / Excel convention) and a trailing CRLF after the last row. */
function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map(csvRow).join("\r\n") + "\r\n";
}

// ── Provenance (launch only — see file header) ────────────────────────────────────────────────────
export interface ProvenanceKeywordRow {
  metricsProvider: string | null;
  metricsSimulated: boolean;
}

/** Same accounting rule as sem-plan.ts's summarizeProvenance (reimplemented, not imported, to avoid
 *  touching a sibling ticket's file for a private helper — the exported TYPE is reused so both
 *  producers agree on shape). Never blends providers, never folds "unpulled" into "real" or "0". */
export function summarizeKeywordProvenance(rows: ProvenanceKeywordRow[]): KeywordProvenanceSummary {
  const providers = new Set<string>();
  let simulatedCount = 0;
  let realCount = 0;
  let unpulledCount = 0;
  for (const r of rows) {
    if (r.metricsProvider === null) { unpulledCount++; continue; }
    providers.add(r.metricsProvider);
    if (r.metricsSimulated) simulatedCount++;
    else realCount++;
  }
  return { providers: [...providers].sort(), simulatedCount, realCount, unpulledCount };
}

function provenanceNote(row: ProvenanceKeywordRow): string {
  if (row.metricsProvider === null) return "not yet pulled — no market data";
  return row.metricsSimulated ? "SIMULATED — do not treat as real market research" : "verified market data";
}

// ── Per-kind input facts (assembled by the controller from already tenant/RLS-scoped reads) ────────
export interface CampaignFacts {
  name: string;
}

export interface LaunchKeywordFact extends ProvenanceKeywordRow {
  adGroupName: string;
  keyword: string;
}

export interface BudgetFacts {
  budgetMinor: number;
  currency: string;
}

export interface BidFacts {
  bidStrategy: string | null;
  targetCpaMinor: number | null;
  targetRoas: number | null;
}

export interface NegativeFact {
  adGroupName: string | null; // null = campaign-level negative
  term: string;
  matchType: "broad" | "phrase" | "exact";
}

export interface AdFact {
  adGroupName: string;
  headlines: string[];
  descriptions: string[];
  finalUrl: string | null;
}

export const RSA_MAX_HEADLINES = 15;
export const RSA_MAX_DESCRIPTIONS = 4;

export class ExportInputError extends Error {}

/** Negative match type -> Ads Editor criterion-type string (assumption #1, file header). */
function negativeCriterionType(scope: "campaign" | "ad_group", matchType: NegativeFact["matchType"]): string {
  const suffix = matchType === "broad" ? "Broad" : matchType === "phrase" ? "Phrase" : "Exact";
  return scope === "campaign" ? `Campaign Negative ${suffix}` : `Negative ${suffix}`;
}

export interface AdsEditorExport {
  filename: string;
  contentType: "text/csv";
  csv: string;
  /** null when this export kind carries no provider market data at all (see file header) — never a
   *  zero-filled summary standing in for "not applicable". */
  provenance: KeywordProvenanceSummary | null;
}

function baseFilename(kind: ChangeProposalExportKind, proposalId: string, simulated: boolean): string {
  const shortId = proposalId.slice(0, 8);
  return `sem-${kind}-${shortId}${simulated ? "-SIMULATED" : ""}.csv`;
}

/** 'launch' — Ads Editor "Keywords" CSV shape (Campaign, Ad group, Keyword, Criterion Type), one row
 *  per targeting keyword under every ad group this campaign already has planned. This is the
 *  documented, single-file-importable shape (Ads Editor can implicitly create a referenced
 *  Campaign/Ad group by name on import) — it is the "build sheet" for a launch. */
export function buildLaunchExport(campaign: CampaignFacts, proposalId: string, keywords: LaunchKeywordFact[]): AdsEditorExport {
  const provenance = summarizeKeywordProvenance(keywords);
  const rows: (string | number)[][] = [["Campaign", "Ad group", "Keyword", "Criterion Type", "Notes"]];
  for (const k of keywords) {
    rows.push([campaign.name, k.adGroupName, k.keyword, "Broad", provenanceNote(k)]); // assumption #2
  }
  return {
    filename: baseFilename("launch", proposalId, provenance.simulatedCount > 0),
    contentType: "text/csv",
    csv: toCsv(rows),
    provenance,
  };
}

/** 'pause' — Ads Editor "Campaigns" CSV shape, status column only. */
export function buildPauseExport(campaign: CampaignFacts, proposalId: string): AdsEditorExport {
  const rows: (string | number)[][] = [
    ["Campaign", "Campaign status"],
    [campaign.name, "Paused"],
  ];
  return { filename: baseFilename("pause", proposalId, false), contentType: "text/csv", csv: toCsv(rows), provenance: null };
}

/** 'budget' — Ads Editor "Campaigns" CSV shape, daily budget in MAJOR units (Ads Editor's budget
 *  column has no currency field of its own — it is always the account's own currency; verifying the
 *  proposal's `currency` matches the live account currency is the human's job before applying, and
 *  is not something this export can check). */
export function buildBudgetExport(campaign: CampaignFacts, proposalId: string, facts: BudgetFacts): AdsEditorExport {
  if (!Number.isFinite(facts.budgetMinor)) throw new ExportInputError("budgetMinor is required to export a budget change");
  const major = (facts.budgetMinor / 100).toFixed(2);
  const rows: (string | number)[][] = [
    ["Campaign", "Campaign daily budget"],
    [campaign.name, major],
  ];
  return { filename: baseFilename("budget", proposalId, false), contentType: "text/csv", csv: toCsv(rows), provenance: null };
}

/** 'bid' — Ads Editor "Campaigns" CSV shape, bid-strategy fields. Target ROAS unit is assumption #3
 *  (file header) — emitted exactly as stored, never rescaled on a guess. */
export function buildBidExport(campaign: CampaignFacts, proposalId: string, facts: BidFacts): AdsEditorExport {
  if (facts.bidStrategy === null && facts.targetCpaMinor === null && facts.targetRoas === null) {
    throw new ExportInputError("at least one of bidStrategy/targetCpaMinor/targetRoas is required to export a bid change");
  }
  const rows: (string | number)[][] = [
    ["Campaign", "Bid Strategy Type", "Target CPA", "Target ROAS"],
    [
      campaign.name,
      facts.bidStrategy ?? "",
      facts.targetCpaMinor === null ? "" : (facts.targetCpaMinor / 100).toFixed(2),
      facts.targetRoas === null ? "" : facts.targetRoas,
    ],
  ];
  return { filename: baseFilename("bid", proposalId, false), contentType: "text/csv", csv: toCsv(rows), provenance: null };
}

/** 'negatives_batch' — Ads Editor negative-keywords CSV shape. Refuses (ExportInputError) an empty
 *  resolved list rather than emit a header-only CSV that LOOKS like a successful export of nothing. */
export function buildNegativesBatchExport(campaign: CampaignFacts, proposalId: string, negatives: NegativeFact[]): AdsEditorExport {
  if (negatives.length === 0) throw new ExportInputError("no negative-keyword rows resolved for this proposal");
  const rows: (string | number)[][] = [["Campaign", "Ad group", "Keyword", "Criterion Type"]];
  for (const n of negatives) {
    rows.push([
      campaign.name,
      n.adGroupName ?? "",
      n.term,
      negativeCriterionType(n.adGroupName === null ? "campaign" : "ad_group", n.matchType),
    ]);
  }
  return { filename: baseFilename("negatives_batch", proposalId, false), contentType: "text/csv", csv: toCsv(rows), provenance: null };
}

/** 'ads_batch' — Ads Editor RSA CSV shape (Headline 1-15 / Description line 1-4 / Final URL / Path
 *  1-2 / Ad status). Headlines/descriptions are padded to the full column count with blanks — never
 *  truncated silently (the controller is responsible for refusing an ad with MORE than the cap
 *  before it ever reaches here; see search.controller.ts's export route). */
export function buildAdsBatchExport(campaign: CampaignFacts, proposalId: string, ads: AdFact[]): AdsEditorExport {
  if (ads.length === 0) throw new ExportInputError("no ad rows resolved for this proposal");
  const headlineCols = Array.from({ length: RSA_MAX_HEADLINES }, (_, i) => `Headline ${i + 1}`);
  const descCols = Array.from({ length: RSA_MAX_DESCRIPTIONS }, (_, i) => `Description line ${i + 1}`);
  const rows: (string | number)[][] = [
    ["Campaign", "Ad group", ...headlineCols, ...descCols, "Final URL", "Path 1", "Path 2", "Ad status"],
  ];
  for (const ad of ads) {
    const headlines = [...ad.headlines.slice(0, RSA_MAX_HEADLINES)];
    while (headlines.length < RSA_MAX_HEADLINES) headlines.push("");
    const descriptions = [...ad.descriptions.slice(0, RSA_MAX_DESCRIPTIONS)];
    while (descriptions.length < RSA_MAX_DESCRIPTIONS) descriptions.push("");
    rows.push([
      campaign.name, ad.adGroupName, ...headlines, ...descriptions,
      ad.finalUrl ?? "", "", "", // Path 1 / Path 2: assumption #5, always blank
      "Enabled", // assumption #4 — this export only ever carries already-'approved' ads
    ]);
  }
  return { filename: baseFilename("ads_batch", proposalId, false), contentType: "text/csv", csv: toCsv(rows), provenance: null };
}

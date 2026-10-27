// PV7-07 — drafting an account summary: the narrative (one gateway call, fail-soft) and the draft row (BFF §56.3).
//
// ── THE NARRATIVE NEVER FAILS A DRAFT ────────────────────────────────────────────────────────────────
// `draftSummaryNarrative` makes ONE `completeViaGateway` call (the only sanctioned AI egress path; no vendor SDK) with the
// snapshot's own numbers as the only facts, and hands the completion to the reports module's `parseNarrative`, whose
// hallucinated-numeral guard rejects a text that states a number the facts do not hold. Every other outcome (an unconfigured
// gateway, a timeout, a non-2xx, an empty or over-long completion, a rejected numeral) gives the deterministic narrative built
// from the snapshot. `source` says which one stands; it is stored with the draft and a staff edit makes it `human`.
//
// ── ONE LIVE SUMMARY PER CLIENT AND MONTH ────────────────────────────────────────────────────────────
// A transaction-scoped advisory lock on (tenant, client, month), then "is there a live row for this month" (a draft or a
// published one; a withdrawn one does not count). The partial UNIQUE index `ux_client_reports_live_summary_period` is the
// database's backstop. The snapshot and the gateway call are made BEFORE the lock (they are slow), so a second request that
// races the first builds its own snapshot, finds the first one's row inside the lock, and returns that.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../../db";
import { config } from "../../../config";
import { completeViaGateway, type CompletionResult } from "../../search/providers/gateway-client";
import type { AiCallAttribution } from "../../ai-usage/gateway-usage";
import { parseNarrative } from "../../reports/narrative";
import {
  buildSummaryNarrativePrompt, deterministicSummaryNarrative, summaryGroundingFacts,
} from "./document";
import { summaryPeriodLabel, type AccountSummarySnapshot, type SummaryPeriod } from "./snapshot";

/** Longest narrative a staff edit may save. */
export const MAX_SUMMARY_NARRATIVE_CHARS = 20_000;

export interface NarrativeDraft { text: string; source: "ai" | "deterministic"; model: string | null }

export interface NarrativeDeps {
  /** Override the gateway call (tests). Throwing is a gateway failure. */
  complete?: (prompt: string) => Promise<CompletionResult>;
}

/** AIP-03a: whose draft this is. Required: the one AI call is a usage row. */

export async function draftSummaryNarrative(snapshot: AccountSummarySnapshot, attribution: AiCallAttribution, deps: NarrativeDeps = {}): Promise<NarrativeDraft> {
  const facts = summaryGroundingFacts(snapshot);
  const fallbackText = deterministicSummaryNarrative(snapshot);
  let raw: string | null = null;
  let model: string | null = null;
  try {
    const completion = await (deps.complete ?? ((p: string) => completeViaGateway(p, { attribution })))(buildSummaryNarrativePrompt(facts));
    raw = completion.text;
    model = completion.provider ?? null;
  } catch {
    raw = null; // fail-soft: a gateway that is down or unconfigured drafts the deterministic narrative, never fails the draft
  }
  const parsed = parseNarrative(raw, model, facts, { source: "deterministic", text: fallbackText });
  return parsed.source === "ai"
    ? { text: parsed.text, source: "ai", model }
    : { text: fallbackText, source: "deterministic", model: null };
}

export interface LiveSummary { id: string; status: "draft" | "published" }

/** The live (draft or published) summary of a client's month, or null. */
export async function findLiveSummary(c: PoolClient, clientId: string, periodStart: string): Promise<LiveSummary | null> {
  const r = await c.query<LiveSummary>(
    `SELECT id, status FROM client_reports
      WHERE client_id = $1 AND source = 'account_summary' AND period_start = $2::date AND status <> 'withdrawn'
      ORDER BY created_at ASC LIMIT 1`,
    [clientId, periodStart],
  );
  return r.rows[0] ?? null;
}

export interface InsertedSummary { created: boolean; id: string; status: "draft" | "published" }

/** Insert the draft, or report the live summary a racing request already made. */
export async function insertSummaryDraft(
  tenantId: string,
  input: { clientId: string; actor: string; period: SummaryPeriod; snapshot: AccountSummarySnapshot; narrative: NarrativeDraft },
): Promise<InsertedSummary> {
  const { clientId, actor, period, snapshot, narrative } = input;
  return withTenants([tenantId], async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`account_summary:${tenantId}:${clientId}:${period.periodStart}`]);
    const existing = await findLiveSummary(c, clientId, period.periodStart);
    if (existing) return { created: false, id: existing.id, status: existing.status };
    const id = newId();
    await c.query(
      `INSERT INTO client_reports (id, tenant_id, client_id, project_id, source, source_id, title, period_start, period_end,
                                   status, snapshot, narrative_md, narrative_source, generated_at, created_by, origin_site)
       VALUES ($1, $2, $3, NULL, 'account_summary', NULL, $4, $5::date, $6::date, 'draft', $7::jsonb, $8, $9, $10::timestamptz, $11, $12)`,
      [id, tenantId, clientId, `Account summary, ${summaryPeriodLabel(period.period)}`, period.periodStart, period.periodEnd,
       JSON.stringify(snapshot), narrative.text, narrative.source, snapshot.generatedAt, actor, config.originSite],
    );
    return { created: true, id, status: "draft" as const };
  });
}

// SMM-26 follow-up — the "weekly per opted-in engagement" scheduled sweep for the
// `smm-agent-content-brief` flow (`content-brief.ts`), closing `docs/plans/smm-tracker.md`'s own
// SMM-26 follow-up row: "needs an architect decision on an automation service identity before a
// principal-less job can legitimately call WS8's per-principal-scoped RAG search". That decision is
// now made (owner-authorised): a dedicated, PER-TENANT automation principal
// (`../../seed/social-content-brief-automation.ts` — read its header FIRST; it has the tested
// argument for why per-tenant, never one global principal, is the only safe shape here).
//
// SHAPE mirrors `best-time-job.ts`/`inbox-triage-job.ts` deliberately: `withGlobal` for the tenant
// list, per-tenant work, per-tenant AND per-engagement failures caught and logged so one bad
// tenant/engagement can never abort the sweep for anyone else.
//
// ── OPT-IN LIVES ON THE ENGAGEMENT, NEVER A TENANT-WIDE OR GLOBAL SWITCH ─────────────────────────
// `social_engagements.tool_scope.ai.autoWeeklyBrief` — an additive jsonb key alongside the existing
// `ai.drafting`/`ai.cloudPolish`/`ai.imageGen` triple 0105's own migration comment documents (no
// migration needed here either). ABSENCE MEANS "not opted in" (default false) — the OPPOSITE
// polarity from `ai.drafting`'s own "absence means the default (true)" (`content-brief.ts`'s own
// comment): a per-call, human-invoked draft is safe to default ON; an UNATTENDED weekly draft that
// spends `ai-gateway-go` calls with nobody watching the response is not, so it needs an explicit,
// affirmative opt-in rather than inheriting the on-demand tool's own permissive default.
//
// ── THE IDENTITY, AND WHY THIS FILE DOES NOT MINT ONE ────────────────────────────────────────────
// This file only LOOKS UP the per-tenant principal (`findContentBriefAutomationPrincipal`) — never
// creates one. An opted-in engagement in a tenant with no provisioned principal is counted
// `principal_not_provisioned`, a DISTINCT, observable outcome from `refused` (the flow itself
// declined, e.g. `ai_drafting_disabled`) and from `drafted` — "opted in", "opted in but unprovisioned",
// "opted in but nothing to brief" and "the sweep never ran at all" must never collapse into one
// silent zero (this module's own standing "absent ≠ zero" discipline, restated for a fourth case).
//
// ── THE MODULE GUC (recurring defect class #1) ───────────────────────────────────────────────────
// `loadOptedInEngagementIds` self-declares via `declareSocialModuleScope` on its own transaction —
// omit it and this function silently returns zero engagements FOREVER, which reads exactly like "no
// tenant has opted in yet" and would never be caught by casual observation. Regression-pinned in
// `content-brief-job.test.ts`.
//
// ── NO EVENT EMISSION, NO WRITEACTIVITY HERE — REUSED, NOT DUPLICATED ────────────────────────────
// `runContentBrief` already emits `social.post.idea_drafted` per created idea (`content-brief.ts`);
// this file is a thin per-tenant/per-engagement orchestration loop over that existing function and
// adds no second copy of its bookkeeping. Matches `best-time-job.ts`/`inbox-sync-job.ts`, neither of
// which writes `work_activity` or emits events of their own either.
import { withGlobal, withTenants } from "../../db";
import { declareSocialModuleScope } from "./module-scope";
import { runContentBrief, type ContentBriefResult } from "./content-brief";
import { findContentBriefAutomationPrincipal } from "../../seed/social-content-brief-automation";

interface OptedInEngagementRow {
  id: string;
}

async function loadOptedInEngagementIds(tenantId: string): Promise<string[]> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const { rows } = await c.query<OptedInEngagementRow>(
      `SELECT id FROM social_engagements
        WHERE status = 'active' AND deleted_at IS NULL
          AND coalesce(tool_scope->'ai'->>'autoWeeklyBrief', 'false') = 'true'`,
    );
    return rows.map((r) => r.id);
  });
}

export type ContentBriefSweepOutcome =
  | { engagementId: string; outcome: "drafted"; ideasCreated: number; variantsCreated: number }
  | { engagementId: string; outcome: "refused"; reason: string }
  | { engagementId: string; outcome: "principal_not_provisioned" }
  | { engagementId: string; outcome: "error"; reason: string };

/** One tenant's sweep. `principalUserId` is resolved ONCE per tenant, not per engagement — it is the
 *  SAME per-tenant principal for every opted-in engagement that tenant holds, exactly the boundary
 *  `social-content-brief-automation.ts` proves: this identity's RAG reach is bounded by its own
 *  tenant membership, never by which engagement triggered a given call. */
export async function pullTenantContentBriefSweep(tenantId: string): Promise<{
  engagements: number; drafted: number; refused: number; principalNotProvisioned: number; errors: number;
  results: ContentBriefSweepOutcome[];
}> {
  const engagementIds = await loadOptedInEngagementIds(tenantId);
  const results: ContentBriefSweepOutcome[] = [];
  let drafted = 0;
  let refused = 0;
  let principalNotProvisioned = 0;
  let errors = 0;

  if (engagementIds.length === 0) {
    return { engagements: 0, drafted, refused, principalNotProvisioned, errors, results };
  }

  const principalUserId = await findContentBriefAutomationPrincipal(tenantId);

  for (const engagementId of engagementIds) {
    if (!principalUserId) {
      principalNotProvisioned += 1;
      results.push({ engagementId, outcome: "principal_not_provisioned" });
      continue;
    }
    try {
      const result: ContentBriefResult = await runContentBrief(tenantId, engagementId, principalUserId, {});
      if (result.kind === "not_found" || result.kind === "refuse") {
        refused += 1;
        results.push({ engagementId, outcome: "refused", reason: result.kind === "refuse" ? result.reason : "not_found" });
      } else {
        drafted += 1;
        const ideasCreated = result.ideas.filter((i) => i.created).length;
        const variantsCreated = result.ideas.reduce((n, i) => n + i.variants.filter((v) => v.created).length, 0);
        results.push({ engagementId, outcome: "drafted", ideasCreated, variantsCreated });
      }
    } catch (err) {
      errors += 1;
      results.push({ engagementId, outcome: "error", reason: (err as Error).message });
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-CONTENT-BRIEF-SWEEP] engagement ${engagementId} (tenant ${tenantId}) failed:`, (err as Error).message);
    }
  }

  return { engagements: engagementIds.length, drafted, refused, principalNotProvisioned, errors, results };
}

/** Sweep every tenant. Mirrors `runBestTimePull`/`runMetricsPull` verbatim: `withGlobal` for the
 *  company list, per-tenant failures caught and logged so one bad tenant can never abort the rest. */
export async function runContentBriefSweep(): Promise<{
  tenants: number; engagements: number; drafted: number; refused: number; principalNotProvisioned: number; errors: number;
}> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let engagements = 0;
  let drafted = 0;
  let refused = 0;
  let principalNotProvisioned = 0;
  let errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      const r = await pullTenantContentBriefSweep(tenantId);
      engagements += r.engagements;
      drafted += r.drafted;
      refused += r.refused;
      principalNotProvisioned += r.principalNotProvisioned;
      errors += r.errors;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-CONTENT-BRIEF-SWEEP] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, engagements, drafted, refused, principalNotProvisioned, errors };
}

/** Weekly loop. Only started by `main.ts` when `config.social.contentBrief.weeklySweep.enabled` is
 *  true (dark by default, and a HARD gate — see `config.ts`'s own comment: this spends
 *  `ai-gateway-go` calls per opted-in engagement it finds). */
export function startContentBriefSweepLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runContentBriefSweep();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-CONTENT-BRIEF-SWEEP] sweep run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-CONTENT-BRIEF-SWEEP] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

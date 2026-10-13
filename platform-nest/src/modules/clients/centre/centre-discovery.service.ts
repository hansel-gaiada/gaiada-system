// PV6-04 (CC-D6) — the DB half of "fill the Business profile from the discovery answers". The pure
// planner is `discovery-map.ts`; this file reads the answers, applies the plan and records it. Used by
// the lead conversion (inside its transaction) and by the staff routes (centre-discovery.controller.ts).
import type { PoolClient } from "pg";
import { newId } from "../../../db";
import { config } from "../../../config";
import { emitEvent } from "../../../events/outbox.service";
import { applyCentrePatch } from "./validation";
import { loadProfileRow, saveProfileRow, emptyProfileState, DEFAULT_BUSINESS_TYPE } from "./store";
import { planDiscoveryFill, type DiscoveryFillPlan } from "./discovery-map";

/** The answers of the latest submission of the lead that was converted into this client, or null when
 *  the client has no converted lead or that lead has no submission (also the case when the agency module
 *  was never used for the company). */
export async function loadDiscoveryAnswers(c: PoolClient, tenantId: string, clientId: string): Promise<Record<string, unknown> | null> {
  const r = await c.query<{ answers: Record<string, unknown> }>(
    `SELECT s.answers
       FROM agency_leads l
       JOIN agency_discovery_submissions s ON s.lead_id = l.id AND s.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND l.converted_client_id = $2 AND l.deleted_at IS NULL
      ORDER BY s.created_at DESC LIMIT 1`,
    [tenantId, clientId],
  );
  return r.rows[0]?.answers ?? null;
}

/** The same plan the fill would apply, against the client's current profile; null = nothing to fill from. */
export async function previewDiscoveryFill(c: PoolClient, tenantId: string, clientId: string): Promise<DiscoveryFillPlan | null> {
  const answers = await loadDiscoveryAnswers(c, tenantId, clientId);
  if (!answers) return null;
  const existing = await loadProfileRow(c, tenantId, clientId);
  return planDiscoveryFill(answers, existing?.state ?? emptyProfileState(DEFAULT_BUSINESS_TYPE));
}

export interface DiscoveryFillResult {
  filled: string[];
  skipped: { key: string; reason: string }[];
}

/** Write the empty-key part of the plan for `answers` and record it, all on `c` (the caller's
 *  transaction): the profile row, the `client.centre_updated` event and one `via: "discovery"` activity
 *  naming the changes and any refused value. Writes nothing when there is nothing to fill or name. */
export async function fillProfileFromAnswers(
  c: PoolClient,
  args: { tenantId: string; clientId: string; actorId: string | null; answers: Record<string, unknown> },
): Promise<DiscoveryFillResult> {
  const { tenantId, clientId, actorId, answers } = args;
  const existing = await loadProfileRow(c, tenantId, clientId);
  const current = existing?.state ?? emptyProfileState(DEFAULT_BUSINESS_TYPE);
  const plan = planDiscoveryFill(answers, current);
  const filled = Object.keys(plan.fill);
  if (filled.length > 0) {
    const result = applyCentrePatch(current, { profile: plan.fill });
    if ("error" in result) throw new Error(`discovery fill produced an invalid patch: ${result.error}`);
    await saveProfileRow(c, tenantId, clientId, result.state, actorId);
    await emitEvent(c, tenantId, "client", clientId, "client.centre_updated", { changes: result.changes.map((ch) => ch.path) });
  }
  const refused = plan.skipped.filter((s) => s.reason !== "already filled");
  if (filled.length > 0 || refused.length > 0) {
    await c.query(
      `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
       VALUES ($1, $2, $3, 'updated', 'client', $4, $5, $6)`,
      [newId(), tenantId, actorId, clientId,
       JSON.stringify({ via: "discovery", changes: filled.map((k) => ({ path: `profile.${k}`, before: null, after: plan.fill[k].slice(0, 200) })), skipped: refused }),
       config.originSite],
    );
  }
  return { filled, skipped: plan.skipped };
}

// SCP-1b — `PipelinePost`, the read of one pipeline post (FRONTEND-BFF-CONTRACT §63.6.2). Everything is read from the
// rows; `actions[]` is decided for the caller by the machine's `probe` (the steps of §63.3.2 that need no body) on one
// Cerbos call, and `checks[]` by `readChecks`, so the page shows exactly what the routes would answer.
//
// Fields a later ticket owns answer their neutral value and say which ticket: `health` (SCP-1c). None is a made-up number.
// `boost` (SCP-4a) is the post's open boost, else its newest, as a `BoostRow` (boosts-data.ts `readPostBoost`, BFF §63.11).
// `tasks` (SCP-1n) is the PM tasks that point at the post.
import type { PoolClient } from "pg";
import type { Principal } from "../../../rbac/principal";
import type { Resource } from "../../../rbac/cerbos";
import { SCP } from "./fixture";
import { readChecks } from "./handoff-checks";
import { listPostTasks } from "./post-tasks";
import { readSimulatedPublishOffer } from "./simulated-publish";
import { readPostBoost } from "./boosts-data";
import { readPostIdea } from "./ideas-data";
import {
  actionsFromStatus, cerbosActionsToAsk, changeCaseOf, engineStatusOf, holderOf, phaseOf, postStateFromRow, primaryActionOf, probe,
  type PipelinePostState,
} from "./machine";
import {
  approvedScheduleOf, holderUserIds, loadCycle, loadDesigns, loadEngagement, loadFacts, loadVariants, reviewHashOf, userNames,
  type PostRow,
} from "./pipeline-data";

/** The values `POST posts/:postId/actions` accepts (BFF §63.3.1, §63.6.5): every staff action of the fixture except those
 *  with routes of their own (create; edit is PATCH …/pipeline; suggest is the suggestions routes; the designs routes). */
export const OWN_ROUTE_ACTIONS = new Set(["create", "edit", "suggest", "add_design", "remove_design"]);
export const ACTION_ROUTE_ACTIONS: readonly string[] = SCP.actions
  .filter((a) => !OWN_ROUTE_ACTIONS.has(a.action) && !(typeof a.cerbosAction === "string" && a.cerbosAction.startsWith("portal:")))
  .map((a) => a.action);

export const HOLDER_LABELS: Record<string, string> = {
  officer: "The officer", copywriter: "A copywriter", approver: "The HoD or the GM", designer: "The designer",
  client: "The client", publisher: "The publisher", external: "Someone outside the team",
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const iso = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : new Date(v).toISOString());

export interface ReadInput {
  c: PoolClient;
  tenantId: string;
  row: PostRow;
  principal: Principal;
  resource: Resource;
  cerbos: Record<string, boolean>;
  who: { ownerId: string; approverIds: string[]; assigneeIds: string[] };
}

/** The Cerbos actions the read's `actions[]` needs for this post (one `checkActions` call). */
export function readCerbosActions(state: PipelinePostState): string[] {
  const names = actionsFromStatus(state).filter((a) => ACTION_ROUTE_ACTIONS.includes(a));
  return [...new Set(names.flatMap((a) => cerbosActionsToAsk(a, state)))];
}

export async function buildPipelinePost(i: ReadInput): Promise<Record<string, unknown>> {
  const { c, tenantId, row } = i;
  const state = postStateFromRow(row);
  const engagement = await loadEngagement(c, tenantId, row.engagement_id);
  const cycle = row.cycle_id ? await loadCycle(c, tenantId, row.cycle_id) : null;
  const variants = await loadVariants(c, tenantId, row.id);
  const designs = await loadDesigns(c, tenantId, row.id);
  const callerId = i.principal.userId ?? null;

  const copyLog = await c.query<{ field: string; before: unknown; after: unknown; via: string; edited_by: string; suggested_by: string | null; stage: string; edited_at: Date }>(
    `SELECT field, before, after, via, edited_by::text AS edited_by, suggested_by::text AS suggested_by, stage, edited_at
       FROM social_post_copy_edits WHERE tenant_id = $1 AND post_id = $2 ORDER BY edited_at, id`,
    [tenantId, row.id],
  );
  const actionNames = SCP.actions.map((a) => a.action);
  const history = await c.query<{ verb: string; actor_id: string | null; metadata: Record<string, unknown>; occurred_at: Date }>(
    `SELECT verb, actor_id::text AS actor_id, metadata, occurred_at FROM activities
      WHERE tenant_id = $1 AND target_entity_type = 'social_post' AND target_entity_id = $2
        AND (verb = ANY($3::text[]) OR verb = 'changed_after_client')
      ORDER BY occurred_at, id`,
    [tenantId, row.id, actionNames],
  );
  // The client's latest decision on the post (SCP-2, BFF §63.6.2 `clientDecision`): the newest decided review that carries a
  // decision id, as the portal gave it (`decided_by` the contact) or as staff recorded it on the client's behalf (`recorded_by`
  // and `channel`, `decided_by` NULL). Null before any decision, and again once the post goes back to the client (the reviews
  // are reset).
  const decisionRow = (await c.query<{
    decision_id: string; status: string; change_kind: string | null; comment: string | null; anchor: unknown;
    decided_at: Date; decided_by: string | null; recorded_by: string | null; channel: string | null;
  }>(
    `SELECT r.decision_id::text AS decision_id, r.status, r.change_kind, r.comment, r.anchor, r.decided_at,
            r.decided_by::text AS decided_by, r.recorded_by::text AS recorded_by, r.channel
       FROM social_post_client_reviews r
       JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id AND v.deleted_at IS NULL
      WHERE r.tenant_id = $1 AND v.post_id = $2 AND r.decision_id IS NOT NULL AND r.status IN ('approved', 'changes_requested')
      ORDER BY r.decided_at DESC, r.id LIMIT 1`,
    [tenantId, row.id],
  )).rows[0] ?? null;
  const request = row.creative_request_id
    ? (await c.query<{ id: string; title: string; status: string }>(`SELECT id::text AS id, title, status FROM work_requests WHERE id = $1`, [row.creative_request_id])).rows[0] ?? null
    : null;

  const names = await userNames(c, [
    engagement?.owner_id, state.authorId,
    ...copyLog.rows.flatMap((r) => [r.edited_by, r.suggested_by]),
    ...history.rows.map((r) => r.actor_id),
    ...Object.values(state.suggestions).map((s) => s.by),
    ...(row.skipped_checks ?? []).map((s) => s.by),
    decisionRow?.decided_by, decisionRow?.recorded_by,
  ]);
  const person = (id: string | null | undefined) => (id ? { id, name: names.get(id) ?? "Someone" } : null);

  // actions[]: each route action whose from matches, decided for this caller without a body.
  const isAutomation = i.principal.kind === "automation" || i.principal.kind === "bot";
  const principalFacts = {
    userId: callerId ?? undefined, isAutomation,
    isAuthor: !!callerId && state.authorId === callerId, isOfficer: !!callerId && i.who.ownerId === callerId,
  };
  const actions: Array<{ action: string; allowed: boolean; reason?: string }> = [];
  if (engagement && state.pipelineStatus !== null) {
    for (const name of actionsFromStatus(state).filter((a) => ACTION_ROUTE_ACTIONS.includes(a))) {
      const facts = await loadFacts(c, { tenantId, action: name, state, params: {}, engagement, cycle, callerId, who: i.who });
      actions.push(probe({ action: name, post: state, principal: principalFacts, cerbos: i.cerbos, facts }));
    }
  }
  const primary = state.pipelineStatus ? primaryActionOf(state) : null;
  const nextAction = primary && actions.some((a) => a.action === primary && a.allowed) ? primary : null;

  const holderRole = state.pipelineStatus ? holderOf(state) : null;
  const holder = holderRole === null
    ? { role: null, userIds: [], label: "Nobody" }
    : { role: holderRole, userIds: (await holderUserIds(tenantId, state, i.who)).userIds, label: HOLDER_LABELS[holderRole] ?? holderRole };

  const checks = readChecks({
    format: state.format, caption: state.caption, scheduledAt: state.scheduledAt, placement: state.placement,
    hashtags: state.hashtags, onAssetText: state.onAssetText, mustHaves: state.mustHaves, rawAssets: state.rawAssets,
    platforms: engagement?.platforms ?? [],
    hashtagSets: Array.isArray(engagement?.hashtag_strategy?.sets) ? engagement!.hashtag_strategy.sets! : [],
    readyBy: cycle?.ready_by ?? null,
  });

  const suggestions: Record<string, unknown> = {};
  for (const [col, s] of Object.entries(state.suggestions)) {
    const field = col.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
    const current = (state as unknown as Record<string, unknown>)[field];
    suggestions[field] = { value: s.value, base: s.base, stale: !sameJson(s.base, current), by: person(s.by), at: s.at };
  }

  const cc = changeCaseOf(state);
  const tasks = await listPostTasks(c, i.principal, tenantId, row.id);
  return {
    id: row.id,
    engagementId: row.engagement_id,
    clientId: engagement?.client_id ?? null,
    clientName: engagement?.client_name ?? null,
    cycleId: row.cycle_id,
    cycleMonth: cycle?.month ?? null,
    title: state.title, format: state.format, pillar: state.pillar, angle: state.angle, objective: state.objective,
    keyMessage: state.keyMessage, caption: state.caption, onAssetText: state.onAssetText, cta: state.cta, hashtags: state.hashtags,
    visualDirection: state.visualDirection,
    rawAssets: state.rawAssets.map((a) => ({ url: a.url ?? null, label: a.label ?? null, source: a.source ?? null, aiNote: a.aiNote ?? null })),
    placement: state.placement, scheduledAt: state.scheduledAt,
    // Who scheduled it (`social_posts.schedule_via`, BFF §63.1): the UI draws the unschedule button for the route that holds it.
    scheduleVia: state.scheduleVia === "manual" || state.scheduleVia === "publisher" ? state.scheduleVia : null,
    isExtra: row.is_extra, isStory: state.format === "story", mustHaves: state.mustHaves,
    pipelineStatus: state.pipelineStatus, phase: phaseOf(state), statusSince: iso(row.status_since),
    engineStatus: row.status ?? engineStatusOf(state, variants.map((v) => v.status), state.archived),
    change: state.changeBy ? { by: state.changeBy, kind: state.changeKind, returnTo: state.returnTo, note: state.changeNote, case: cc } : null,
    changedOnly: state.changedOnly, copyBefore: state.copyBefore,
    block: state.blockedFrom ? { reason: state.blockReason, waitingOn: state.blockWaitingOn, from: state.blockedFrom, at: state.blockedAt } : null,
    creativeSource: state.creativeSource, creativeState: state.creativeState,
    creativeRequest: request,
    designs: designs.map((d) => ({
      id: d.id, position: d.position,
      // An asset's own source and AI note are on `creative_assets` (SCP-1h, file 4), set where the asset is saved: the latest live version's.
      asset: d.asset_group_id
        ? { groupId: d.asset_group_id, versionId: d.asset_version_id, versionNo: d.asset_version_no, name: d.asset_name, source: d.asset_source, aiNote: d.asset_ai_note }
        : null,
      link: d.link_url ? { url: d.link_url, source: d.link_source, aiNote: d.link_ai_note } : null,
      fileId: d.file_id,
    })),
    suggestions,
    checks,
    skippedChecks: (row.skipped_checks ?? []).map((s) => ({ codes: s.codes, reason: s.reason, by: person(s.by), at: s.at })),
    officer: person(engagement?.owner_id),
    author: person(state.authorId),
    holder,
    health: null, // SCP-1c: cycles, deadlines and health (BFF §63.5)
    // SCP-Sc: what the page needs to say why a post is failed or simulated: the variant's own mark and its recorded failure
    // (`<code>: <message>` as dispatch.ts and the status sweep write it: no credential, no caption, never a link a person typed).
    variants: variants.map((v) => ({
      id: v.id, network: v.network, handle: v.handle, status: v.status, reviewStatus: v.review_status ?? null, validation: v.validation ?? null,
      simulated: v.simulated === true, lastError: v.status === "failed" ? v.last_error : null,
    })),
    // SCP-Sc: "Publish now (simulated)": null unless the post is a simulated publisher schedule and the switch is on (BFF §63.10).
    simulatedPublishNow: await readSimulatedPublishOffer(c, tenantId, row, i.cerbos.approve),
    approvedSchedule: approvedScheduleOf(state, variants),
    reviewHash: reviewHashOf(variants),
    liveUrl: row.live_url, wentLiveAt: iso(row.went_live_at), simulated: row.simulated, archivedAt: iso(row.archived_at),
    boost: await readPostBoost(c, tenantId, row.id), // SCP-4a: the open boost, else the newest, or null (BFF §63.6.2, §63.11)
    tasks, // the PM tasks that point at this post (SCP-1n, BFF §63.13)
    idea: await readPostIdea(c, tenantId, row.id), // SCP-5c: the idea this post was planned from, or null (BFF §63.25.4); never in the portal
    copyLog: copyLog.rows.map((r) => ({
      field: r.field, before: r.before, after: r.after, via: r.via, by: person(r.edited_by), suggestedBy: person(r.suggested_by), stage: r.stage, at: iso(r.edited_at),
    })),
    // Never a note's text (BFF §63.6.2): the activity metadata carries none.
    history: history.rows.map((h) => ({
      action: h.verb, from: (h.metadata?.from as string | null) ?? null, to: (h.metadata?.to as string | null) ?? null,
      by: person(h.actor_id), agent: ((h.metadata?.via as { agent?: string } | undefined)?.agent) ?? null, at: iso(h.occurred_at),
      recorded: typeof h.metadata?.channel === "string" ? { channel: h.metadata.channel } : null, viaPortal: h.metadata?.viaPortal === true,
    })),
    actions,
    nextAction,
    clientDecision: decisionRow
      ? {
          decisionId: decisionRow.decision_id,
          kind: decisionRow.status === "approved" ? "approved" : "changes",
          ...(decisionRow.change_kind ? { changeKind: decisionRow.change_kind } : {}),
          ...(decisionRow.comment ? { note: decisionRow.comment } : {}),
          ...(decisionRow.anchor ? { anchor: decisionRow.anchor } : {}),
          decidedAt: iso(decisionRow.decided_at),
          via: decisionRow.recorded_by ? "recorded" : "portal",
          ...(decisionRow.channel ? { channel: decisionRow.channel } : {}),
          decidedBy: person(decisionRow.decided_by),
          recordedBy: person(decisionRow.recorded_by),
        }
      : null,
  };
}

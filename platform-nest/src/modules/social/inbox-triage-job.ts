// SMM-16 — AI triage over SMM-15's inbox rows: sentiment/category/urgency classification
// (`smm-inbox-triage`), and the SLA + spike guard (`smm-inbox-sla-guard`, the job 0105's own
// `ix_social_inbox_threads_sla` comment already named). Design addendum §A4/P2 row, unchanged scope.
//
// ── THE THING THIS TICKET WAS BRIEFED AGAINST: A CLASSIFIER THAT CAN SEE ANOTHER CLIENT'S COMMENTS ─
// This is AI output over client-scoped data, exactly like SMM-19 (brand-voice drafting) and SMM-23
// (report narratives) — both shipped a cross-client leak test for the same reason. Unlike those two,
// this file has NO knowledge-service retrieval step to be the leak boundary; the boundary is simply
// "one gateway call gets one thread's own messages, never two threads' text in the same prompt, and
// never a thread from a tenant the current sweep is not scoped to". `classifyOneThread` below is the
// ONLY place that builds a prompt, and it is only ever given ONE thread's own `loadThreadMessages`
// result — see `ai-drafts.ts`'s own header on `TriageGroundingFacts` for the other half of this
// argument. `inbox-triage-job.test.ts`'s cross-client leak test proves both directions: two threads
// belonging to two different clients in the SAME tenant, classified in the same sweep, never see
// each other's text in the gateway call, and a sweep scoped to tenant A never touches tenant B's
// threads at all (the ordinary RLS wall, proven rather than assumed).
//
// ── A CLASSIFICATION IS A GUESS, NEVER LAUNDERED INTO A FACT ──────────────────────────────────────
// See `ai-drafts.ts`'s header on `parseTriageDraft`. This file's own half of that discipline: a
// gateway failure, an unconfigured gateway, or an unparsable/out-of-vocabulary response all write
// `ai_triage_status = 'unavailable'` — never a guessed 'neutral'/'other'/'low' masquerading as the
// model's real answer. `202608211200_social_inbox_triage.sql`'s `sit_triage_shape` CHECK makes the
// three (four, with `purged`) states structurally exclusive, so this file cannot accidentally leave
// a row in an inconsistent state even if a future edit tried to.
//
// ── SLA GUARD: THE THRESHOLD ALREADY LIVES ON THE ENGAGEMENT, NEVER INVENTED HERE ────────────────
// 0105's own `social_engagements.tool_scope` comment ships an EXAMPLE shape with
// `"inbox":{"enabled":true,"slaMinutes":240,"dm":false}` — a per-engagement, human-set operational
// commitment, not a number this ticket gets to choose. `refreshThreadSla` reads ONLY that value; an
// engagement with no `inbox.slaMinutes` configured gets NO `sla_due_at` at all, never a fallback
// number invented to give it one. Urgency classification is informational ONLY — it does not shrink
// or extend `sla_due_at` — because doing so would mean inventing an "urgent posts get N% less time"
// threshold this ticket has no data to justify (the very thing the brief says not to do).
//
// ── SPIKE DETECTION: THE ONE PLACE A CONFIG NUMBER WAS UNAVOIDABLE ────────────────────────────────
// Unlike the SLA threshold, nothing in the schema carries a volume baseline, and no account is
// connected yet (app reviews deferred to staging, D-23) to measure one from. `config.social.triage
// .slaGuard`'s spike knobs are self-imposed operational defaults with their rationale written in
// `config.ts` itself — never presented as a measured or claimed vendor/business number. See that
// file's own comment before touching any of them.
//
// ── SHAPE mirrors `inbox-sync-job.ts`/`inbox-retention-job.ts`/`metrics-job.ts` deliberately: reads
// own transaction (own declared module scope) → gateway call OUTSIDE any transaction (the same
// discipline every other outbound call in this module holds — a slow/failing gateway call inside a
// transaction would stall every other query on it) → write own transaction (own declared module
// scope). Per-tenant AND per-thread failures are caught and logged so one bad thread or one tenant's
// outage never aborts the rest of the sweep.
//
// ── ⚠ THE MODULE GUC (recurring defect class #1) ──────────────────────────────────────────────────
// Every `social_*` table carries 0105's THIRD RLS wall. Every read/write function below declares its
// OWN module scope via `declareSocialModuleScope` — delete any one of those calls and that function
// reads/writes ZERO ROWS, silently, forever: a triage sweep that classifies nothing, an SLA guard
// that never alerts, a spike detector that never fires. Each has its own regression test in
// `inbox-triage-job.test.ts` that opens the caller-side transaction with NO `{modules:['social']}`
// option and asserts a real row changed.
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { declareSocialModuleScope } from "./publish-precondition";
import { emitEvent } from "../../events/outbox.service";
import { completeViaGateway, type GatewayCallOptions } from "./gateway-client";
import { buildTriagePrompt, parseTriageDraft, type TriageGroundingFacts } from "./ai-drafts";
import type { Network } from "./media-rules";

// ── classification reads (own transaction, own declared scope, no network I/O) ────────────────────

interface EligibleThreadRow {
  threadId: string;
  network: Network;
  engagementName: string | null;
}

/** Threads worth a classification attempt this sweep: never-attempted, OR left `unavailable` long
 *  enough ago to be worth retrying (see `config.social.triage.retryUnavailableAfterMs`'s own
 *  rationale). Never re-touches a `classified` or `purged` row — a purged row's own CHECK forbids
 *  writing a fresh classification back onto it anyway (the retention decision, see the migration). */
async function loadThreadsForClassification(
  c: PoolClient, now: Date, cap: number, retryAfterMs: number,
): Promise<EligibleThreadRow[]> {
  const { rows } = await c.query<EligibleThreadRow>(
    `SELECT t.id AS "threadId", t.network AS "network", e.name AS "engagementName"
       FROM social_inbox_threads t
       LEFT JOIN social_post_variants v ON v.id = t.post_variant_id AND v.tenant_id = t.tenant_id
       LEFT JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = t.tenant_id
       LEFT JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = t.tenant_id
      WHERE t.deleted_at IS NULL
        AND (
          t.ai_triage_status = 'unclassified'
          OR (t.ai_triage_status = 'unavailable' AND t.ai_triage_at < $1::timestamptz - make_interval(secs => $2::int))
        )
      ORDER BY t.last_message_at ASC NULLS LAST
      LIMIT $3`,
    [now, Math.floor(retryAfterMs / 1000), cap],
  );
  return rows;
}

async function loadThreadMessages(
  c: PoolClient, threadId: string,
): Promise<Array<{ authorHandle: string | null; body: string; postedAt: string }>> {
  const { rows } = await c.query<{ authorHandle: string | null; body: string; postedAt: string }>(
    `SELECT author_handle AS "authorHandle", body, posted_at AS "postedAt"
       FROM social_inbox_messages
      WHERE thread_id = $1 AND direction = 'in'
      ORDER BY posted_at ASC`,
    [threadId],
  );
  return rows;
}

// ── the write (own transaction, own declared scope) ────────────────────────────────────────────────

interface ClassifyOutcome {
  classified: boolean; // true => 'classified', false => 'unavailable'
}

/** Persist one thread's classification outcome. Idempotent in the sense that matters: it only ever
 *  writes a value into a column the shape CHECK (`sit_triage_shape`) will accept, and never onto a
 *  thread whose activity content has since been purged (the SAME CHECK refuses that combination
 *  structurally — see the migration). */
async function writeTriageOutcome(
  tenantId: string, threadId: string, outcome: ClassifyOutcome,
  result: { sentiment: string; category: string; urgency: string } | null, now: Date,
): Promise<void> {
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    if (outcome.classified && result) {
      await c.query(
        `UPDATE social_inbox_threads
            SET sentiment = $2, category = $3, urgency = $4,
                ai_triage_status = 'classified', ai_triage_at = $5, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL AND activity_content_purged_at IS NULL`,
        [threadId, result.sentiment, result.category, result.urgency, now],
      );
    } else {
      await c.query(
        `UPDATE social_inbox_threads
            SET ai_triage_status = 'unavailable', ai_triage_at = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [threadId, now],
      );
    }
  });
}

/** One thread, end to end: read its own messages (ONLY its own — see file header), call the gateway
 *  (no transaction open), parse (never throws — `ai-drafts.ts`), persist. A gateway failure of any
 *  kind (unconfigured, HTTP error, timeout) is caught HERE and treated exactly like an unparsable
 *  response: `ai_triage_status = 'unavailable'`, never a thrown error that would abort the sweep. */
export async function classifyOneThread(
  tenantId: string, thread: EligibleThreadRow, now: Date, gatewayOpts?: GatewayCallOptions,
): Promise<ClassifyOutcome> {
  const messages = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadThreadMessages(c, thread.threadId);
  });

  if (messages.length === 0) {
    // Nothing to classify yet (a thread row created ahead of its first message landing, or every
    // message purged already) — leave it `unclassified`, never write `unavailable` for a thread we
    // never actually attempted to classify.
    return { classified: false };
  }

  const facts: TriageGroundingFacts = {
    network: thread.network,
    engagementName: thread.engagementName ?? "this account",
    messages,
  };

  let raw: string | null = null;
  try {
    const res = await completeViaGateway(buildTriagePrompt(facts), gatewayOpts);
    raw = res.text;
  } catch {
    raw = null; // fail-closed to 'unavailable' below — see file header
  }

  const parsed = parseTriageDraft(raw);
  await writeTriageOutcome(tenantId, thread.threadId, { classified: parsed.result !== null }, parsed.result, now);
  return { classified: parsed.result !== null };
}

export interface TenantTriageResult {
  attempted: number;
  classified: number;
  unavailable: number;
  errors: number;
}

/** One tenant's classification sweep. Per-thread failures are caught and counted so one bad thread
 *  or one gateway hiccup never aborts the rest of the tenant's sweep, mirroring every other job in
 *  this module. */
export async function pullTenantInboxTriage(
  tenantId: string, now: Date = new Date(), gatewayOpts?: GatewayCallOptions,
): Promise<TenantTriageResult> {
  const cap = config.social.triage.maxThreadsPerTenantPerRun;
  const retryAfterMs = config.social.triage.retryUnavailableAfterMs;

  const eligible = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadThreadsForClassification(c, now, cap, retryAfterMs);
  });

  let classified = 0;
  let unavailable = 0;
  let errors = 0;
  let attempted = 0;
  for (const thread of eligible) {
    try {
      const outcome = await classifyOneThread(tenantId, thread, now, gatewayOpts);
      attempted += 1;
      if (outcome.classified) classified += 1;
      else unavailable += 1;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[SOCIAL-INBOX-TRIAGE] thread ${thread.threadId} (tenant ${tenantId}) failed:`, (err as Error).message,
      );
    }
  }
  return { attempted, classified, unavailable, errors };
}

export async function runInboxTriage(now: Date = new Date()): Promise<{
  tenants: number; attempted: number; classified: number; unavailable: number; errors: number;
}> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let attempted = 0, classified = 0, unavailable = 0, errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      const r = await pullTenantInboxTriage(tenantId, now);
      attempted += r.attempted; classified += r.classified; unavailable += r.unavailable; errors += r.errors;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-INBOX-TRIAGE] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, attempted, classified, unavailable, errors };
}

/** Only started by main.ts when `config.social.triage.classifyEnabled` is true — dark by default. */
export function startInboxTriageLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runInboxTriage();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-INBOX-TRIAGE] sweep run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-INBOX-TRIAGE] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ── SLA guard (`smm-inbox-sla-guard`) ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface SlaRefreshRow {
  threadId: string;
  slaDueAt: string;
}

/** Assign/refresh `sla_due_at` for every OPEN thread whose own engagement has configured
 *  `tool_scope.inbox.slaMinutes` — see the file header on why this is the ONLY source of that
 *  number. A thread with no linked post (a DM/mention with `post_variant_id IS NULL`) or whose
 *  engagement never set `slaMinutes` gets no `sla_due_at` at all: a known, named gap, never a
 *  fallback duration invented to paper over it. Re-running only advances `sla_due_at` forward when
 *  `last_message_at` has moved (a fresh comment restarts the response clock) — never backward,
 *  never onto a thread that has left `open` (a replied/escalated/dismissed/closed thread's clock is
 *  someone else's concern, SMM-17/18's). */
async function refreshThreadSla(c: PoolClient): Promise<SlaRefreshRow[]> {
  const { rows } = await c.query<SlaRefreshRow>(
    `UPDATE social_inbox_threads t
        SET sla_due_at = t.last_message_at
              + make_interval(secs => (((e.tool_scope -> 'inbox' ->> 'slaMinutes')::numeric) * 60)::int),
            updated_at = now()
       FROM social_post_variants v, social_posts p, social_engagements e
      WHERE t.post_variant_id = v.id AND v.tenant_id = t.tenant_id
        AND p.id = v.post_id AND p.tenant_id = t.tenant_id
        AND e.id = p.engagement_id AND e.tenant_id = t.tenant_id
        AND t.status = 'open' AND t.deleted_at IS NULL AND t.last_message_at IS NOT NULL
        AND e.tool_scope -> 'inbox' ->> 'slaMinutes' IS NOT NULL
        AND (e.tool_scope -> 'inbox' ->> 'slaMinutes') ~ '^[0-9]+(\\.[0-9]+)?$'
        AND (
          t.sla_due_at IS NULL
          OR t.sla_due_at <> t.last_message_at
               + make_interval(secs => (((e.tool_scope -> 'inbox' ->> 'slaMinutes')::numeric) * 60)::int)
        )
      RETURNING t.id AS "threadId", t.sla_due_at AS "slaDueAt"`,
  );
  return rows;
}

interface SlaBreachRow {
  threadId: string;
  network: Network;
  engagementId: string | null;
  slaDueAt: string;
}

/** Threads that HAVE breached their own `sla_due_at` (uses 0105's `ix_social_inbox_threads_sla`
 *  index) and have not already been alerted for THIS breach — `sla_alerted_at < sla_due_at` is the
 *  re-arm check: if `sla_due_at` moves forward again (a fresh comment on a re-opened thread), a new
 *  breach past the NEW deadline gets its own alert rather than being silenced by a stale marker. */
async function findAndMarkSlaBreaches(c: PoolClient, now: Date): Promise<SlaBreachRow[]> {
  const { rows } = await c.query<SlaBreachRow>(
    `UPDATE social_inbox_threads t
        SET sla_alerted_at = $1, updated_at = now()
       FROM (
         SELECT t2.id
           FROM social_inbox_threads t2
          WHERE t2.status = 'open' AND t2.deleted_at IS NULL
            AND t2.sla_due_at IS NOT NULL AND t2.sla_due_at <= $1::timestamptz
            AND (t2.sla_alerted_at IS NULL OR t2.sla_alerted_at < t2.sla_due_at)
       ) breach
      WHERE t.id = breach.id
      RETURNING t.id AS "threadId", t.network AS "network", t.sla_due_at AS "slaDueAt",
        (SELECT p.engagement_id FROM social_post_variants v
           JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = t.tenant_id
          WHERE v.id = t.post_variant_id AND v.tenant_id = t.tenant_id) AS "engagementId"`,
    [now],
  );
  return rows;
}

export interface TenantSlaGuardResult {
  refreshed: number;
  breaches: number;
  notified: number;
  unnotifiable: number;
}

/** One tenant's SLA sweep: refresh due-dates, then find+mark breaches and emit a notification event
 *  per breach that resolves to a real engagement (see the header on threads with no linked post —
 *  those are counted `unnotifiable`, never silently dropped). Rides the ALREADY-DRAINED
 *  "social_post_variant" stream (main.ts#startConsumerLoop) deliberately, the SAME reasoning
 *  SMM-31's two events used — never a new stream name that would need a main.ts change to be read
 *  at all (this module's own recurring defect class #2). */
export async function runTenantSlaGuard(tenantId: string, now: Date = new Date()): Promise<TenantSlaGuardResult> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const refreshed = await refreshThreadSla(c);
    const breaches = await findAndMarkSlaBreaches(c, now);
    let notified = 0;
    let unnotifiable = 0;
    for (const b of breaches) {
      if (!b.engagementId) { unnotifiable += 1; continue; }
      await emitEvent(c, tenantId, "social_post_variant", b.threadId, "social.inbox.sla_breached", {
        threadId: b.threadId, network: b.network, engagementId: b.engagementId, slaDueAt: b.slaDueAt,
      });
      notified += 1;
    }
    return { refreshed: refreshed.length, breaches: breaches.length, notified, unnotifiable };
  });
}

// ── spike detection ─────────────────────────────────────────────────────────────────────────────────

interface ConnectedAccountRow {
  accountId: string;
  network: Network;
  clientId: string;
}

async function loadConnectedAccounts(c: PoolClient): Promise<ConnectedAccountRow[]> {
  const { rows } = await c.query<ConnectedAccountRow>(
    `SELECT id AS "accountId", network, client_id AS "clientId"
       FROM social_accounts WHERE status = 'connected' AND deleted_at IS NULL`,
  );
  return rows;
}

interface AccountWindowCounts {
  recent: number;
  baseline: number;
}

async function loadAccountWindowCounts(
  c: PoolClient, accountId: string, now: Date, windowMinutes: number, baselineWindows: number,
): Promise<AccountWindowCounts> {
  const { rows } = await c.query<{ recent: string; baseline: string }>(
    `SELECT
       count(*) FILTER (WHERE m.posted_at >= $2::timestamptz - make_interval(mins => $3::int)) AS recent,
       count(*) FILTER (
         WHERE m.posted_at < $2::timestamptz - make_interval(mins => $3::int)
           AND m.posted_at >= $2::timestamptz - make_interval(mins => $3::int * ($4::int + 1))
       ) AS baseline
     FROM social_inbox_messages m
     JOIN social_inbox_threads t ON t.id = m.thread_id
    WHERE t.account_id = $1 AND m.direction = 'in'`,
    [accountId, now, windowMinutes, baselineWindows],
  );
  return { recent: Number(rows[0]?.recent ?? 0), baseline: Number(rows[0]?.baseline ?? 0) };
}

/** One tenant's per-account spike check. See the file header + `config.ts`'s own comment on why the
 *  thresholds are a documented operational default, never a measured or claimed business number.
 *
 *  DEDUP (was a named follow-up, now closed): a sustained spike used to re-fire on EVERY sweep tick
 *  for as long as it lasted, so one burst became a stream of identical bells. The dedup state is the
 *  `outbox_events` log itself — every emit is already durably recorded there, it is never pruned, and
 *  `idx_outbox_events_entity (tenant_id, entity_type, entity_id)` already indexes exactly the lookup
 *  needed. That is deliberately NOT a new table: a second store of "did we already say this" would
 *  have to be kept in agreement with the log that actually decides what was emitted.
 *
 *  A suppressed spike is counted as `suppressed`, never silently skipped — the caller can tell
 *  "quiet because nothing is spiking" from "quiet because we already said so", which are different
 *  facts. Same reason an account with no resolvable client engagement is counted `unnotifiable`
 *  rather than dropped. Notifies via the SAME drained stream as the SLA guard. */
/** Has a spike for this account already been announced inside the cooldown? Reads the durable
 *  `outbox_events` log rather than a purpose-built dedup table — see `runTenantSpikeDetection`'s
 *  docstring for why. `outbox_events` is a CORE table (no module predicate), so the surrounding
 *  `declareSocialModuleScope` is inert for it and the tenant wall alone applies. */
async function spikeAlreadyAnnounced(
  c: PoolClient, accountId: string, now: Date, cooldownMinutes: number,
): Promise<boolean> {
  if (cooldownMinutes <= 0) return false;
  const { rows } = await c.query<{ one: number }>(
    `SELECT 1 AS one FROM outbox_events
      WHERE entity_type = 'social_post_variant'
        AND entity_id = $1
        AND event_type = 'social.inbox.spike_detected'
        AND created_at >= $2::timestamptz - make_interval(mins => $3::int)
      LIMIT 1`,
    [accountId, now, cooldownMinutes],
  );
  return rows.length > 0;
}

export async function runTenantSpikeDetection(tenantId: string, now: Date = new Date()): Promise<{
  accountsChecked: number; spikes: number; notified: number; unnotifiable: number; suppressed: number;
}> {
  const { windowMinutes: winM, baselineWindows: baseW, multiplier, minRecent } = {
    windowMinutes: config.social.triage.slaGuard.spikeWindowMinutes,
    baselineWindows: config.social.triage.slaGuard.spikeBaselineWindows,
    multiplier: config.social.triage.slaGuard.spikeMultiplier,
    minRecent: config.social.triage.slaGuard.spikeMinRecentCount,
  };
  // `0` means derive — see config.ts's own comment. Derived from THIS run's effective window/baseline
  // rather than the raw defaults, so an operator who widens the window also widens the cooldown and
  // cannot accidentally end up re-notifying inside a single baseline period.
  const configuredRenotify = config.social.triage.slaGuard.spikeRenotifyMinutes;
  const renotifyM = configuredRenotify > 0 ? configuredRenotify : winM * (baseW + 1);
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const accounts = await loadConnectedAccounts(c);
    let spikes = 0, notified = 0, unnotifiable = 0, suppressed = 0;
    for (const acc of accounts) {
      const counts = await loadAccountWindowCounts(c, acc.accountId, now, winM, baseW);
      const baselineAvg = baseW > 0 ? counts.baseline / baseW : 0;
      const isSpike = counts.recent >= minRecent && counts.recent >= baselineAvg * multiplier;
      if (!isSpike) continue;
      spikes += 1;
      // Counted as a spike FIRST, then suppressed: `spikes` stays an honest count of what is
      // actually elevated right now, and `suppressed` says how much of it we chose not to repeat.
      // Collapsing the two would make a sustained spike look like it had stopped.
      if (await spikeAlreadyAnnounced(c, acc.accountId, now, renotifyM)) { suppressed += 1; continue; }
      const { rows: engRows } = await c.query<{ engagementId: string }>(
        `SELECT id AS "engagementId" FROM social_engagements
          WHERE client_id = $1 AND deleted_at IS NULL AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [acc.clientId],
      );
      const engagementId = engRows[0]?.engagementId;
      if (!engagementId) { unnotifiable += 1; continue; }
      await emitEvent(c, tenantId, "social_post_variant", acc.accountId, "social.inbox.spike_detected", {
        accountId: acc.accountId, network: acc.network, engagementId,
        recentCount: counts.recent, baselineAvgPerWindow: baselineAvg,
      });
      notified += 1;
    }
    return { accountsChecked: accounts.length, spikes, notified, unnotifiable, suppressed };
  });
}

export async function runInboxSlaGuard(now: Date = new Date()): Promise<{
  tenants: number; refreshed: number; breaches: number; notified: number; unnotifiable: number;
  spikes: number; spikeNotified: number; spikeUnnotifiable: number; spikeSuppressed: number;
  errors: number;
}> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let refreshed = 0, breaches = 0, notified = 0, unnotifiable = 0;
  let spikes = 0, spikeNotified = 0, spikeUnnotifiable = 0, spikeSuppressed = 0, errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      const sla = await runTenantSlaGuard(tenantId, now);
      refreshed += sla.refreshed; breaches += sla.breaches; notified += sla.notified; unnotifiable += sla.unnotifiable;
      const spike = await runTenantSpikeDetection(tenantId, now);
      spikes += spike.spikes; spikeNotified += spike.notified; spikeUnnotifiable += spike.unnotifiable;
      spikeSuppressed += spike.suppressed;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-INBOX-SLA-GUARD] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return {
    tenants: tenants.length, refreshed, breaches, notified, unnotifiable,
    spikes, spikeNotified, spikeUnnotifiable, spikeSuppressed, errors,
  };
}

/** Only started by main.ts when `config.social.triage.slaGuard.guardEnabled` is true — dark by
 *  default. Named `smm-inbox-sla-guard` per 0105's own comment on `ix_social_inbox_threads_sla`. */
export function startInboxSlaGuardLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runInboxSlaGuard();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-INBOX-SLA-GUARD] sweep run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-INBOX-SLA-GUARD] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

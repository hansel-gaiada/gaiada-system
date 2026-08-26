// SMM-26 follow-up — `runContentBriefSweep`: the v1.0 design's "weekly per opted-in engagement"
// scheduled sweep for the `smm-agent-content-brief` flow, closing the identity gap SMM-26's own
// evidence block named as a follow-up requiring an architect decision ("needs an architect decision
// on an automation service identity before a principal-less job can legitimately call WS8's
// per-principal-scoped RAG search" — docs/plans/smm-tracker.md).
//
// ── THE IDENTITY DECISION, AND THE REASONING THAT FORCED IT ───────────────────────────────────────
// `content-brief.ts#runContentBrief` already accepts `principalUserId: string | null`, and passing
// `null` already "works" today — `knowledge-client.ts#queryBrandKnowledge` degrades to `[]` for a
// null userId. That is NOT a legitimate answer for a WEEKLY, unattended, opted-in sweep: it would
// ship every agent-drafted post PERMANENTLY ungrounded in the client's own brand corpus, silently,
// forever — the exact failure this ticket exists to avoid, not a compromise to accept.
//
// The three alternatives named in SMM-26's own follow-up, and why each is wrong:
//   (a) borrow a human's identity — dishonest attribution (this module's own `actor_id NULL` /
//       `source='agent'` precedents exist PRECISELY to avoid this).
//   (b) bypass WS8's per-principal scope (call `/search` with a service token and no OBO envelope
//       at all) — this is the RAG search's own established CONTRACT (`knowledge-client.ts`'s header:
//       "the tenant pre-filter needs a resolvable caller identity via OBO"), and this ticket was
//       told explicitly not to widen it. Doing so would also make WS8 answer ANY tenant's corpus to
//       ANY caller holding the service token — a bigger blast radius than doing nothing.
//   (c) mint a DEDICATED automation principal (this file) — reuses the established pattern
//       (platform-nest/CLAUDE.md: "Automation/bot principals are deliberately rows in `users`"),
//       touches neither contract, and its reach is testable rather than assumed (see below).
//
// ── WHY THIS NEVER TOUCHES THE "assurance: low" RULE IT IS TOLD NOT TO EXCEPT ─────────────────────
// "Every automation principal is minted `assurance: 'low'` by construction" (platform-nest/CLAUDE.md)
// is mcp-hub's OWN rule, about ITS OWN `Principal.assurance` type (anonymous|low|verified,
// mcp-hub/src/principal.ts) — the type that gates the D14 impact suspend and which tools an
// automation/agent-origin MCP-hub caller may auto-execute. This sweep NEVER calls the mcp-hub. It
// is an in-process scheduled job exactly like `best-time-job.ts`/`inbox-triage-job.ts`, calling
// `runContentBrief` directly — no MCP tool call, no OBO envelope presented to the hub, no D14
// impact gate anywhere in this file. So there is no exception to carve: the rule this sweep must
// not except governs a system it never reaches.
//
// What THIS principal's `principalUserId` feeds is a COMPLETELY SEPARATE mechanism:
// platform-nest's OWN `/principal/resolve` (identity.controller.ts), which
// `knowledge-client.ts#queryBrandKnowledge` calls via a SELF-LINK it upserts on every call
// (`provider:'platform', external_id:userId`, verified immediately — the SAME mechanism a HUMAN
// caller's own userId already rides). That resolves to a DIFFERENT `Assurance` type
// (low|linked|high, src/rbac/principal.ts) via `assemblePrincipal(userId, "linked")` — "linked" is
// exactly what a verified identity_links row always resolves to, automation or human alike; nothing
// here elevates or special-cases it. WS8's own D4 ceiling (`assurance === "low"` → empty tenantSet,
// ai-agents/src/knowledge/service.ts) is about THIS resolver's "low" (unverified link), not about
// mcp-hub's "low" — the two types share a word, not a mechanism, and conflating them was the trap to
// avoid here.
//
// ── WHAT THIS PRINCIPAL CAN AND CANNOT SEE — BOUNDARIES TESTED, NOT INTENDED ──────────────────────
// It holds ZERO Cerbos role grants (`user_roles` — see `ensureContentBriefSweepPrincipal` below).
// It never calls `authorize()` (this file, like every other `*-job.ts` sweep, bypasses Cerbos
// entirely — `content-brief.ts`'s OWN header states `authorize()` is called ONLY from the
// controller). So even a future bug routing a Cerbos-gated call through this identity would be
// denied for lack of any grant — proven in content-brief-sweep-job.test.ts (P1).
//
// Its ONLY authorization surface is `company_memberships` — the ordinary "which tenants can this
// user's principal see" mechanism `assemblePrincipal` already uses for every human. It gets a row
// for a tenant ONLY once that tenant has >= 1 CURRENTLY opted-in engagement (JIT, idempotent), and
// LOSES it the moment that tenant no longer has any (see `reconcileContentBriefSweepMembership`) —
// proven in (P2)/(P3)/(P4): granting and revoking are both driven by the CURRENT opt-in set on
// every sweep tick, not a one-time grant that outlives the opt-in.
//
// ⚠ A REAL DEFECT THIS TICKET'S OWN TEST CAUGHT BEFORE SHIPPING (test (T1)): the FIRST draft
// computed "needed" membership from the DUE subset (opted-in AND past the cadence cutoff) rather
// than the full opted-in set. That revoked a tenant's membership the instant its one opted-in
// engagement had JUST been swept and was therefore no longer due — a fully healthy "nothing new to
// draft this week" tick would have stripped the tenant of the very membership it needs for NEXT
// week's tick, forcing a re-grant every cycle. Fixed by computing `optedInTenants` (unconditioned
// on timing) separately from `dueByTenant` (the due subset) — membership tracks "is this tenant
// still opted in at all", never "does it have something to draft RIGHT NOW".
//
// It carries NO `home_company_id` and no
// GLOBAL-scope Cerbos grant of any kind, so the "a global grant has no root" trap (rootCompanies
// only anchors via home_company_id or a membership, never invented) does not apply — this principal
// has memberships, and only memberships, exactly the shape that trap prescribes for a genuinely
// cross-tenant service identity rather than a single-company staff member.
//
// The coarse tenant-membership gate is ONE of two walls WS8 enforces; the fine one — which the
// membership gate does NOT narrow, and does not need to, because the SECOND wall already does —
// is the per-(tenant,client) ACL `scope` string `knowledge-client.ts#brandCorpusScope` computes
// SERVER-SIDE from the engagement's own resolved `clientId`, never client-supplied
// (`content-brief.ts`'s own header: "the property the leak test... drives end to end"). Even while
// this principal holds a tenant-wide membership, every `/search` call it makes still only ever asks
// for ONE specific client's own scope string — the same isolation `content-brief.ts`'s existing
// cross-client leak test already proves for the on-demand path, unchanged by this ticket.
//
// ── THE OPT-IN FLAG ────────────────────────────────────────────────────────────────────────────────
// `social_engagements.tool_scope.contentBrief.scheduledEnabled` (jsonb, additive — no migration for
// the key itself; 0105's `tool_scope` column is additive by design). Absence or any non-`true`
// value means NOT opted in — the OPPOSITE default from `ai.drafting` (which defaults ON), because
// this is an unattended, gateway-call-spending, weekly-recurring act rather than a per-request
// human ask. Settable today through the EXISTING generic `PATCH .../scope` endpoint
// (`social.controller.ts#setEngagementScope` — off-limits to this ticket, but its `mergeScope`
// already merges an unrecognized top-level group verbatim, so `{contentBrief:{scheduledEnabled:
// true}}` round-trips with zero controller change). Named gap: `validateScopePatch` (same
// off-limits file) adds no type check for this key, so a non-boolean value is silently ACCEPTED —
// but this file's own SQL read (`->> 'scheduledEnabled') = 'true'`) treats anything other than the
// literal `true` as "not opted in", which is the fail-safe direction.
//
// ── THE CADENCE, AND WHY A RESTART CANNOT DOUBLE-DRAFT A WEEK'S WORTH OF IDEAS ────────────────────
// `runContentBrief` has NO natural idempotency for the idea-creation half when called with no
// caller-supplied `ids` (each call is meant to draft FRESH content) — which is correct for one
// tick a week apart, and dangerous for two ticks minutes apart (e.g. two app restarts the same
// day). `social_engagements.content_brief_last_run_at` (migration
// 202608231830_social_content_brief_sweep_last_run.sql) is stamped after every ATTEMPT (drafted,
// refused, or a mid-tick disappearance — anything that is not a thrown error) and
// `loadOptedInEngagements` only selects engagements whose stamp is NULL or older than
// `config.social.contentBrief.weeklySweep.intervalMs` — so the design's own "weekly" cadence holds
// per-engagement regardless of how often the process restarts within that window.
//
// SHAPE mirrors `best-time-job.ts`/`inbox-triage-job.ts`: `withGlobal` for the tenant list,
// per-tenant `withTenants([tenantId])` + `declareSocialModuleScope` (recurring defect class #1 —
// EVERY query here self-declares), per-tenant AND per-engagement errors caught and logged so one
// bad row can never abort the sweep for anyone else. Dark by default via
// `config.social.contentBrief.weeklySweep.enabled` — a HARD gate (spends gateway calls per engagement),
// not a perf opt-in, same reasoning the search pull scheduler's own flag carries.
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { declareSocialModuleScope } from "./module-scope";
import { runContentBrief } from "./content-brief";

/** Deterministic, global-unique email — same `automation+<name>@gaiada.system` convention
 *  `seed/automation.ts` uses for n8n workflow accounts. This is NOT an n8n workflow (it is an
 *  in-process platform-nest sweep), but `users.kind='automation'` is still the right
 *  classification: PK-01's own definition is "a fixed, reviewable script" as opposed to a
 *  model-driven persona (`kind='bot'`) — this file's behavior is exactly that. */
export const CONTENT_BRIEF_SWEEP_PRINCIPAL_EMAIL = "automation+smm-content-brief-sweep@gaiada.system";

/** Idempotent find-or-create for the ONE platform-wide sweep principal. No Cerbos role grant, no
 *  `home_company_id`, no `company_memberships` at creation time — memberships are granted
 *  per-tenant, JIT, by `reconcileContentBriefSweepMembership` below, exactly as needed and no wider.
 *  Self-healing on every call (like `seed/automation.ts`'s own accounts) rather than requiring a
 *  separate seed step an operator could forget to run before enabling the sweep's config flag. */
export async function ensureContentBriefSweepPrincipal(): Promise<string> {
  const existing = await withGlobal((c) =>
    c.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [CONTENT_BRIEF_SWEEP_PRINCIPAL_EMAIL],
    ),
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const id = newId();
  await withGlobal((c) =>
    c.query(
      `INSERT INTO users (id, email, name, title, kind, origin_site)
       VALUES ($1, $2, $3, $4, 'automation', $5)
       ON CONFLICT (email) DO NOTHING`,
      [
        id,
        CONTENT_BRIEF_SWEEP_PRINCIPAL_EMAIL,
        "Automation — Social content-brief sweep",
        "Scheduled RAG-grounded content-brief drafting (SMM-26 follow-up)",
        config.originSite,
      ],
    ),
  );
  const row = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [CONTENT_BRIEF_SWEEP_PRINCIPAL_EMAIL]),
  );
  return row.rows[0].id;
}

/** Every tenant the principal is CURRENTLY an active member of, read via the SAME
 *  `principal_lookup` RLS policy `assemblePrincipal` (src/rbac/principal.ts) uses to discover a
 *  user's own tenants BEFORE any tenant context exists (0001_core.sql) — a plain `withTenants` call
 *  cannot do this (it needs to already know the tenant list, which is the very thing being asked). */
async function currentPrincipalTenants(principalUserId: string): Promise<Set<string>> {
  const rows = await withGlobal(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.principal_user_id', $1, true)", [principalUserId]);
      const res = await c.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM company_memberships WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [principalUserId],
      );
      await c.query("COMMIT");
      return res.rows;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
  return new Set(rows.map((r) => r.tenant_id));
}

/** Grants OR REACTIVATES — deliberately NOT `testing/fixtures.ts#addMembership`, whose own doc
 *  comment states it is "NOT retroactive on an existing row... never silently re-tags or
 *  re-activates one" (correct for a one-shot seed, wrong here: THIS principal's own membership
 *  must be able to come back once a tenant re-opts an engagement in after opting every one out). */
async function grantOrReactivateMembership(tenantId: string, principalUserId: string): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site, kind, status)
       VALUES ($1, $2, $3, $4, 'service', 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active', deleted_at = NULL, updated_at = now()`,
      [newId(), tenantId, principalUserId, config.originSite],
    ),
  );
}

/** Soft-revoke: the tenant no longer has any opted-in engagement, so the principal's coarse WS8
 *  tenant-set gate should no longer include it. Reversible by `grantOrReactivateMembership` above
 *  if the tenant opts an engagement back in later. */
async function revokeMembership(tenantId: string, principalUserId: string): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE company_memberships SET status = 'inactive', deleted_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
      [tenantId, principalUserId],
    ),
  );
}

/** Reconciles the principal's `company_memberships` to EXACTLY `neededTenantIds` — grants/
 *  reactivates whatever is missing, revokes whatever is no longer needed. Run on every sweep tick
 *  so the principal's reach tracks the LIVE opt-in set rather than a historical high-water mark —
 *  this is what keeps "no wider than what the engagement's own brief flow would legitimately read"
 *  true over time, not just at the moment a tenant first opts in. */
export async function reconcileContentBriefSweepMembership(
  principalUserId: string,
  neededTenantIds: readonly string[],
): Promise<{ granted: string[]; revoked: string[] }> {
  const needed = new Set(neededTenantIds);
  const current = await currentPrincipalTenants(principalUserId);
  const granted: string[] = [];
  const revoked: string[] = [];
  for (const tenantId of needed) {
    if (!current.has(tenantId)) {
      await grantOrReactivateMembership(tenantId, principalUserId);
      granted.push(tenantId);
    }
  }
  for (const tenantId of current) {
    if (!needed.has(tenantId)) {
      await revokeMembership(tenantId, principalUserId);
      revoked.push(tenantId);
    }
  }
  return { granted, revoked };
}

interface OptedInEngagementRow {
  id: string;
  lastRunAt: string | null;
}

/** ALL currently opted-in engagements for a tenant, regardless of whether they are DUE yet —
 *  `tool_scope.contentBrief.scheduledEnabled` is the literal boolean `true` (any other value,
 *  including a malformed non-boolean, is treated as NOT opted in — the fail-safe direction).
 *
 *  ⚠ DELIBERATELY UNCONDITIONED ON THE CADENCE CUTOFF. This is the set that answers "does this
 *  tenant have a standing reason for the sweep principal to hold membership" — an engagement that
 *  opted in but was already swept THIS week is still opted in; it must not cost the tenant its
 *  membership just because there is nothing new to draft this tick (`splitDue` below is what
 *  decides what actually gets PROCESSED this tick — a narrower, time-gated subset of this list). */
async function loadOptedInEngagements(tenantId: string): Promise<OptedInEngagementRow[]> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const { rows } = await c.query<OptedInEngagementRow>(
      `SELECT id, content_brief_last_run_at AS "lastRunAt" FROM social_engagements
        WHERE deleted_at IS NULL
          AND (tool_scope -> 'contentBrief' ->> 'scheduledEnabled') = 'true'`,
    );
    return rows;
  });
}

/** Of an already-opted-in list, which are DUE this tick — NULL `lastRunAt` (never attempted) or
 *  older than `cutoff`. */
function splitDue(rows: OptedInEngagementRow[], cutoff: Date): string[] {
  return rows
    .filter((r) => r.lastRunAt === null || new Date(r.lastRunAt) < cutoff)
    .map((r) => r.id);
}

async function stampContentBriefRun(tenantId: string, engagementId: string, when: Date): Promise<void> {
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    await c.query(`UPDATE social_engagements SET content_brief_last_run_at = $1 WHERE id = $2`, [when, engagementId]);
  });
}

export interface ContentBriefSweepResult {
  tenants: number;
  tenantsOptedIn: number;
  engagementsDue: number;
  drafted: number;
  refused: number;
  vanished: number;
  errors: number;
  membershipsGranted: string[];
  membershipsRevoked: string[];
}

/** One full sweep across every tenant. Mirrors `runBestTimePull`/`runMetricsPull` verbatim:
 *  `withGlobal` for the company list, per-tenant/per-engagement failures caught and logged so one
 *  bad row can never abort the rest. */
export async function runContentBriefSweep(now: Date = new Date()): Promise<ContentBriefSweepResult> {
  const principalUserId = await ensureContentBriefSweepPrincipal();
  const cutoff = new Date(now.getTime() - config.social.contentBrief.weeklySweep.intervalMs);

  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );

  // `optedInTenants` (ANY opted-in engagement, regardless of due-timing) drives MEMBERSHIP —
  // membership must survive a tenant's own opted-in engagement being freshly swept, or a fully
  // healthy "nothing new to draft this week" tick would revoke a tenant that never opted out.
  // `dueByTenant` (the DUE subset) drives what actually gets PROCESSED this tick. Conflating the
  // two was this ticket's own first defect, caught by (T1) below: a tenant's membership dropped the
  // moment its one opted-in engagement was no longer due, one tick after being correctly granted.
  const optedInTenants = new Set<string>();
  const dueByTenant = new Map<string, string[]>();
  let errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      const optedIn = await loadOptedInEngagements(tenantId);
      if (optedIn.length === 0) continue;
      optedInTenants.add(tenantId);
      const due = splitDue(optedIn, cutoff);
      if (due.length > 0) dueByTenant.set(tenantId, due);
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-CONTENT-BRIEF-SWEEP] tenant ${tenantId} read failed:`, (err as Error).message);
    }
  }

  const { granted, revoked } = await reconcileContentBriefSweepMembership(principalUserId, [...optedInTenants]);

  let drafted = 0;
  let refused = 0;
  let vanished = 0;
  let engagementsDue = 0;
  for (const [tenantId, engagementIds] of dueByTenant) {
    for (const engagementId of engagementIds) {
      engagementsDue += 1;
      try {
        const result = await runContentBrief(tenantId, engagementId, principalUserId, {});
        await stampContentBriefRun(tenantId, engagementId, now);
        if (result.kind === "ok") drafted += 1;
        else if (result.kind === "refuse") refused += 1;
        else vanished += 1; // not_found: deleted between the read above and this call
      } catch (err) {
        errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[SOCIAL-CONTENT-BRIEF-SWEEP] engagement ${engagementId} (tenant ${tenantId}) failed:`,
          (err as Error).message,
        );
      }
    }
  }

  return {
    tenants: tenants.length,
    tenantsOptedIn: optedInTenants.size,
    engagementsDue,
    drafted,
    refused,
    vanished,
    errors,
    membershipsGranted: granted,
    membershipsRevoked: revoked,
  };
}

/** Weekly (default) loop. Only started by `main.ts` when `config.social.contentBrief.weeklySweep.enabled`
 *  is true (dark by default — see this module's contract header for the exact lines to add). */
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

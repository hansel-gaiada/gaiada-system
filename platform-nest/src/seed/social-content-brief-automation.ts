// SMM-26 follow-up (docs/plans/smm-tracker.md) — the identity the "weekly per opted-in engagement"
// content-brief sweep needed and never had: a principal-less scheduled job cannot legitimately call
// WS8's per-principal-scoped `/search` (knowledge-client.ts's own header — the tenant pre-filter
// needs a resolvable caller identity via OBO). This seed mints that identity. The owner has
// authorised resolving the identity question by minting a dedicated automation principal, per
// `platform-nest/CLAUDE.md`'s own standing rule: "Automation/bot principals are deliberately rows in
// `users` — Cerbos authorizes *principals*, and a second principal table would fork every policy."
//
// ── ONE PRINCIPAL PER TENANT, NEVER ONE GLOBAL PRINCIPAL — TESTED, NOT ASSUMED ───────────────────
// WS8's own `/search` predicate (`ai-agents/src/knowledge/store.ts#search`, read directly, not
// inferred) is:
//   WHERE ... audience = 'public'
//         OR (audience = 'internal' AND tenant_id = ANY($1::uuid[]) AND (acl = '{}' OR $2 = ANY(acl)))
// `$1` (`ctx.tenantSet`) is `principal.companies` (`ai-agents/src/knowledge/service.ts#resolveEnvelope`
// -> `platform-nest`'s `/principal/resolve` -> `assemblePrincipal`, `src/rbac/principal.ts`) — the
// UNION of every ACTIVE `company_memberships` row (+ `client_contacts`) the resolved user holds, with
// NO further per-call restriction to whichever tenant the caller says it is asking on behalf of. And
// `acl = '{}'` — "readable by any member of the tenant" — is the DEFAULT for every INTERNAL-tier
// document (`docs/modules/knowledge/README.md`'s own table: clients, projects, tasks, meetings,
// reports, org structure, files), not only the social brand corpus `queryBrandKnowledge` asks for by
// `scope`. So a SINGLE global automation principal holding memberships in every opted-in tenant would,
// on ANY one tenant's sweep call, be a candidate to retrieve EVERY OTHER opted-in tenant's entire
// internal ERP corpus — the "automation identity that can read every tenant's corpus is worse than no
// sweep" failure this ticket was told to avoid. There is no `tenantId` parameter on `/search` at all
// that could narrow `ctx.tenantSet` back down per call — confirmed by reading `store.search()`'s own
// SQL, not assumed.
//
// The fix is structural, not a policy promise: each tenant gets its OWN `users` row, holding EXACTLY
// ONE active `company_memberships` row (kind='service') in that tenant alone. Its resolved
// `companies` (and so WS8's `callerTenantSet`) can therefore never contain a second tenant, BY
// CONSTRUCTION — proven directly in `social-content-brief-automation.test.ts` against a real
// `assemblePrincipal()` call, not merely argued here.
//
// `users.home_company_id` (the anchor `rootCompanies`/Cerbos `inRoot` reads — see
// `docs/plans/smm-tracker.md`'s "a global grant has no root" trap) is deliberately left NULL. This
// principal never goes through Cerbos (see below), so it has no root-gated rule to anchor; and
// `assemblePrincipal`'s `companies` field — the ONE thing WS8's tenant-set actually reads — is
// resolved from `company_memberships`, never from `home_company_id`, so setting it would change
// nothing this principal needs and would only invite a future root-gated check to treat it as staff
// anchored somewhere it has no business being anchored.
//
// ── WHY A DELIBERATE, OPERATOR-RUN SEED, NOT A SELF-PROVISIONING STEP INSIDE THE SWEEP ────────────
// `content-brief-job.ts` COULD mint this identity itself, lazily, the first tick after a tenant opts
// an engagement in. It deliberately does not: minting a principal is itself a blast-radius decision
// (a fresh identity gains standing read access to a tenant's ERP knowledge base the moment it exists
// and holds a membership), and cross-service authority in this program is never ambient — every scope
// grant is an explicit, visible act (this seat's own standing mandate). `content-brief-job.ts`
// therefore REFUSES, counted and never silent, any opted-in tenant whose principal this seed has not
// yet provisioned, rather than minting one mid-sweep. Provisioning is THIS file's job — idempotent,
// safe to re-run, run once per tenant after an operator has decided that tenant's engagements may be
// swept unattended. Same "give these people access" posture `seed:roster-access` already uses for
// human grants, applied here to a machine one.
//
// ── LEAST PRIVILEGE: NO ROLE, NO CERBOS GRANT, NO IDENTITY LINK SEEDED HERE ────────────────────────
// Unlike `seed:automation`'s n8n workflow accounts (which call Cerbos-gated mcp-hub tools and so need
// a scoped role), this principal never passes through Cerbos: `runContentBrief` is called IN-PROCESS
// by the scheduled job, never through `social.controller.ts`'s `authorize()` — the same "scheduled
// sweeps live in platform-nest as jobs, not routed through a permissioned endpoint" precedent
// `inbox-sync-job.ts`/`inbox-triage-job.ts`/`best-time-job.ts` already established (SMM-15/16/27's own
// tracker notes). Its ONLY function is to be a resolvable identity for WS8's OBO principal lookup, so
// it gets a `users` row + a membership and NOTHING else: no role grant, no permission-catalog entry,
// no Cerbos policy edit (`docs/PERMISSION-CONTRACT.md` untouched). Nor does this file seed an
// `identity_links` row: `knowledge-client.ts#queryBrandKnowledge`'s own `selfLinkUpsert(userId)`
// upserts `identity_links(provider='platform', external_id=userId)` LAZILY on every call it makes
// (existing SMM-19 code, unchanged) — the SAME mechanism a human caller's own userId already rides,
// so this principal needs nothing extra to be resolvable that a human isn't already given for free.
//
// Run per tenant, after that tenant has at least one engagement opting into the weekly sweep
// (`social_engagements.tool_scope.ai.autoWeeklyBrief = true`):
//   DATABASE_URL=... tsx src/seed/social-content-brief-automation.ts <tenantId>
import { newId, withGlobal, withTenants, closePool } from "../db";
import { migrate } from "../db/migrate";
import { config } from "../config";

/** Deterministic PER-TENANT email — see file header for why this MUST vary by tenant: `users.email`
 *  is globally unique (CLAUDE.md), so a tenant-invariant email would resolve every tenant to the
 *  SAME row, and that row's second `company_memberships` insert would be exactly the cross-tenant
 *  leak this file exists to avoid. Exported so the scheduled job can look the principal up by the
 *  SAME derivation without a second, driftable copy of the naming rule. */
export function contentBriefAutomationEmail(tenantId: string): string {
  return `automation+social-content-brief-${tenantId}@gaiada.system`;
}

async function findUserByEmail(email: string): Promise<string | null> {
  const { rows } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]));
  return rows[0]?.id ?? null;
}

/** Look up (never create) this tenant's content-brief automation principal. Used by
 *  `content-brief-job.ts` to REFUSE an opted-in tenant this seed has not yet provisioned, rather than
 *  minting one on the fly (see file header). `null` means "not provisioned for this tenant". */
export async function findContentBriefAutomationPrincipal(tenantId: string): Promise<string | null> {
  return findUserByEmail(contentBriefAutomationEmail(tenantId));
}

/** Idempotent AND self-healing, matching `seed:automation`'s own contract: re-running for a tenant
 *  that already has a principal creates nothing new, and (re)ensures the SINGLE membership row this
 *  principal's whole safety property rests on. Returns the principal's `userId` — pass this as
 *  `runContentBrief`'s `principalUserId` argument. */
export async function ensureContentBriefAutomationPrincipal(tenantId: string): Promise<string> {
  const email = contentBriefAutomationEmail(tenantId);
  let userId = await findUserByEmail(email);
  if (!userId) {
    const candidateId = newId();
    await withGlobal((c) =>
      c.query(
        `INSERT INTO users (id, email, name, title, origin_site) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING`,
        [candidateId, email, "Automation — Social content-brief sweep", "Automation service account", config.originSite],
      ),
    );
    // ON CONFLICT DO NOTHING can lose a race to a concurrent seed run for the SAME tenant — re-read
    // rather than trust candidateId, so two concurrent invocations converge on one row, not two.
    userId = await findUserByEmail(email);
    if (!userId) throw new Error(`social-content-brief-automation: failed to create or find ${email}`);
  }
  // kind='service': this is a workflow, not staff — the SAME `company_memberships.kind` discipline
  // `seed:automation`/`addMembership` use, so this principal never shows up as a colleague in a
  // people-shaped surface. Idempotent: ON CONFLICT DO NOTHING leaves an existing row (and its
  // status) alone rather than re-activating one an operator deliberately revoked.
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site, kind)
       VALUES ($1, $2, $3, $4, 'service')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [newId(), tenantId, userId, config.originSite],
    ),
  );
  return userId;
}

if (require.main === module) {
  (async () => {
    const tenantId = process.argv[2];
    if (!tenantId) {
      console.error("usage: tsx src/seed/social-content-brief-automation.ts <tenantId>");
      process.exit(1);
      return;
    }
    await migrate();
    const userId = await ensureContentBriefAutomationPrincipal(tenantId);
    console.log(`content-brief automation principal for tenant ${tenantId}: ${userId} (${contentBriefAutomationEmail(tenantId)})`);
    await closePool();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

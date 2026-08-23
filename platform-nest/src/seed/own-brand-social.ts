// First light on LinkedIn/YouTube (docs/runbooks/social-first-light-linkedin-youtube.md) needs a
// `clients` row to point `SOCIAL_OWN_BRAND_CLIENT_IDS` at, and an engagement to hang accounts off.
// Production has ZERO client rows — deliberately, since it holds real accounts and grants and nothing
// demo — so this creates exactly the two rows first light needs and nothing else.
//
// ── WHY A NEW NARROW SEED RATHER THAN `seed:agency` ─────────────────────────────────────────────
// `platform-nest/CLAUDE.md` is explicit: "Production is deliberately clean … so `seed:agency` — a full
// demo vertical — is the wrong tool for 'give these people access'." The same reasoning applies here:
// first light needs ONE own-brand client, not a demo agency with campaigns, deliverables and invoices.
// `seed:roster-access` is the precedent for a seed that does one narrow thing on a real estate.
//
// ── ⚠ THE RENAME TRAP APPLIES TO THIS FILE ─────────────────────────────────────────────────────
// Both helpers resolve BY NAME (`SELECT … WHERE name = $1`, else INSERT), which is the established
// seed idiom — and it means **renaming `OWN_BRAND_CLIENT_NAME` or `OWN_BRAND_ENGAGEMENT_NAME` later
// requires a migration**, exactly as `CLAUDE.md`'s own seed section warns. Changing a name here does
// NOT rename the row on an existing database; it creates a SECOND one and leaves the original holding
// all the history. Every test still passes, because `testing/setup.ts` gives each file a fresh
// database where the seed creates the row from nothing and the new name is simply the name. That is
// precisely how `Sanur Resort` → `Viceroy Bali` shipped and needed migration `202608230612` to fix.
//
// ── IDEMPOTENT, AND NON-DESTRUCTIVE ────────────────────────────────────────────────────────────
// Re-running is a true no-op: an existing row is returned untouched, never updated. That matters on a
// real estate — if someone has since set a contact, a status or a budget on these rows, a seed that
// "ensured" its own values would silently overwrite operator intent.
import { newId, withTenants, closePool } from "../db";
import { migrate } from "../db/migrate";
import { config } from "../config";

/** Resolved BY NAME — see the rename-trap note in this file's header before changing either. */
export const OWN_BRAND_CLIENT_NAME = "Gaiada";
export const OWN_BRAND_ENGAGEMENT_NAME = "Gaiada — Organic Social";

const SOCIAL_MODULE = { modules: ["social"] };

/** The own-brand `clients` row. `clients` is a CORE table (no `app_module_allowed` predicate), so a
 *  plain tenant-scoped transaction is correct here — no module scope needed or used. */
export async function ensureOwnBrandClient(tenantId: string): Promise<string> {
  return withTenants([tenantId], async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM clients WHERE name = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [OWN_BRAND_CLIENT_NAME],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const id = newId();
    await c.query(
      `INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1, $2, $3, $4)`,
      [id, tenantId, OWN_BRAND_CLIENT_NAME, config.originSite],
    );
    return id;
  });
}

/** The engagement social accounts hang off. `social_engagements` DOES carry `0105`'s third wall
 *  (`app_module_allowed('social')`), so this MUST pass `SOCIAL_MODULE`.
 *
 *  Worth being precise, because the wall does NOT behave the same way on both halves — I wrote this
 *  function without the scope and the failure taught me the difference:
 *    - the **INSERT** RAISES `new row violates row-level security policy for table
 *      "social_engagements"` — loud, immediate, impossible to miss;
 *    - the **SELECT** silently matches ZERO rows and raises nothing.
 *  So an unscoped version of this function fails loudly on a first run, but an unscoped READ
 *  elsewhere reports "no engagement exists" and looks like ordinary empty data. The lint
 *  (`npm run lint:withtenants`) exists because the second half is the dangerous one. */
export async function ensureOwnBrandEngagement(tenantId: string, clientId: string): Promise<string> {
  return withTenants([tenantId], async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM social_engagements
        WHERE client_id = $1 AND name = $2 AND deleted_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [clientId, OWN_BRAND_ENGAGEMENT_NAME],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const id = newId();
    await c.query(
      // `tool_scope '{}'` on purpose: an empty scope means "the module's own defaults apply", which is
      // what a fresh engagement should get. Inventing keys here would pin this engagement to whatever
      // the scope vocabulary happened to be today. `usage_budget_usd` comes from config rather than a
      // literal so it tracks `SOCIAL_DEFAULT_USAGE_BUDGET_USD` instead of drifting from it.
      `INSERT INTO social_engagements
         (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1, $2, $3, $4, 'active', '{}', $5, $6)`,
      [id, tenantId, clientId, OWN_BRAND_ENGAGEMENT_NAME, config.social.defaultUsageBudgetUsd, config.originSite],
    );
    return id;
  }, SOCIAL_MODULE);
}

export async function seedOwnBrandSocial(tenantId: string): Promise<{ clientId: string; engagementId: string }> {
  const clientId = await ensureOwnBrandClient(tenantId);
  const engagementId = await ensureOwnBrandEngagement(tenantId, clientId);
  return { clientId, engagementId };
}

if (require.main === module) {
  (async () => {
    const tenantId = process.argv[2];
    if (!tenantId) {
      console.error("usage: tsx src/seed/own-brand-social.ts <tenantId>");
      process.exit(1);
      return;
    }
    await migrate();
    const { clientId, engagementId } = await seedOwnBrandSocial(tenantId);
    console.log(`own-brand client:     ${clientId}  (${OWN_BRAND_CLIENT_NAME})`);
    console.log(`own-brand engagement: ${engagementId}  (${OWN_BRAND_ENGAGEMENT_NAME})`);
    console.log("");
    console.log("Paste the CLIENT id into .env (the compose passthrough is already wired):");
    console.log(`  SOCIAL_OWN_BRAND_CLIENT_IDS=${clientId}`);
    await closePool();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

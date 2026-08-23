// Give the holding owner `owner` on the companies that ALREADY EXIST — and create no companies.
//
// ⚠ WHY THIS IS URGENT RATHER THAN TIDY. IAM-16 closed the legacy admin door: since then the ONLY
// supported way to appoint someone to an elevated role is D-9's two-person appointment, which
// requires one `platform_admin` AND one `owner`. The live estate has 1 platform_admin and ZERO
// owners — so on production, nobody can be appointed to the elevated tier through any supported
// flow at all.
//
// That is precisely the failure the Phase-3 readiness assessment refused to ship ("closing the
// legacy door today would make appointing a SECOND platform_admin impossible"). It got shipped
// anyway because the arithmetic was checked in the REPO — where `seed:agency` grants Anthony
// `owner` — and not on the ESTATE, which has never run that seed. A seeded fixture is not a
// deployed principal.
//
// Break-glass still exists (seeds and direct DB access bypass the choke point entirely), so this is
// a lockout of the supported path, not of the estate. Fixing it is still the priority.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────
// It creates NO companies. `seed:agency` would also add Apéritif, CasCades, Pinstripe Bar, Akoya Spa
// and Bali Catering — five real businesses whose presence on the live estate is a separate decision
// with its own consequences (rollups, reporting, per-company grants). Owner decision 2026-08-23:
// grant on the three companies that exist, leave the backbone for later.
import { withGlobal, closePool } from "../db";
import { config } from "../config";
import { addMembership, grantRole } from "../testing/fixtures";

const OWNER_EMAIL = "anthony@gaiada.com";
const OWNER_NAME = "Anthony Syrowatka";
const HOLDING_NAME = "D & A Syrowatka";

export interface OwnerGrantResult {
  userId: string;
  userCreated: boolean;
  holdingId: string;
  granted: string[];
  alreadyHeld: string[];
  homeCompanySet: boolean;
}

export async function seedOwnerGrant(): Promise<OwnerGrantResult> {
  const site = config.originSite;

  const companies = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name`,
    ),
  );
  const holding = companies.rows.find((c) => c.name === HOLDING_NAME);
  if (!holding) {
    // Without the holding there is no root to anchor to, and `inRoot` would deny him everywhere.
    // Refuse rather than guess which company is the parent.
    throw new Error(
      `seedOwnerGrant: no company named "${HOLDING_NAME}". Refusing to guess the holding — ` +
        `rootCompanies is anchored from it and a wrong guess denies the owner on his own estate.`,
    );
  }

  const found = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [OWNER_EMAIL]),
  );
  let userId: string;
  let userCreated = false;
  if (found.rows[0]) {
    userId = found.rows[0].id;
  } else {
    const ins = await withGlobal((c) =>
      c.query<{ id: string }>(
        `INSERT INTO users (id, email, name, title, origin_site)
         VALUES (gen_random_uuid(), $1, $2, 'Owner', $3) RETURNING id`,
        [OWNER_EMAIL, OWNER_NAME, site],
      ),
    );
    userId = ins.rows[0].id;
    userCreated = true;
  }

  const roleRow = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name = 'owner'`),
  );
  if (!roleRow.rows[0]) {
    throw new Error("seedOwnerGrant: the `owner` role does not exist — run migrations (IAM-14) first");
  }
  const ownerRole = roleRow.rows[0].id;

  const granted: string[] = [];
  const alreadyHeld: string[] = [];

  for (const co of companies.rows) {
    const had = await withGlobal((c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_roles
          WHERE user_id = $1 AND role_id = $2 AND scope_type = 'company' AND scope_id = $3`,
        [userId, ownerRole, co.id],
      ),
    );
    // ⚠ PER COMPANY, never at global scope. A global `owner` grant would be a second platform tier,
    // which is exactly what D-7 deleted `group_executive` for — and `owner-role.db.test.ts` pins
    // that no owner grant exists outside company scope.
    await addMembership(co.id, userId);
    await grantRole(userId, ownerRole, "company", co.id);

    if (Number(had.rows[0].n) === 0) granted.push(co.name);
    else alreadyHeld.push(co.name);
  }

  // The holding is the home company, and this is load-bearing: MON-00a/00c anchor `rootCompanies`
  // from `users.home_company_id` FIRST. Without it the set resolves empty and every root-gated rule
  // denies him on his own estate — a correct fail-closed that models nobody.
  const upd = await withGlobal((c) =>
    c.query(`UPDATE users SET home_company_id = $1 WHERE id = $2 AND home_company_id IS DISTINCT FROM $1`, [
      holding.id,
      userId,
    ]),
  );

  return {
    userId,
    userCreated,
    holdingId: holding.id,
    granted,
    alreadyHeld,
    homeCompanySet: (upd.rowCount ?? 0) > 0,
  };
}

async function main(): Promise<void> {
  const r = await seedOwnerGrant();
  console.log(`owner user:        ${r.userId} ${r.userCreated ? "(created)" : "(already existed)"}`);
  console.log(`owner grants added: ${r.granted.length}`);
  for (const c of r.granted) console.log(`  + ${c}`);
  if (r.alreadyHeld.length) console.log(`already held:       ${r.alreadyHeld.join(", ")}`);
  console.log(`home company set:   ${r.homeCompanySet ? "yes (the holding)" : "already correct"}`);
  console.log(
    "\nD-9's two-person appointment (1 platform_admin + 1 owner) is now satisfiable on this estate.\n" +
      "NOTE: creates no companies — the Viceroy venues and Bali Catering remain a separate decision.",
  );
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();

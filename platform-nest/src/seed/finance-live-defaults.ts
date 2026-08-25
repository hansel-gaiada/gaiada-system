// FINANCE LIVE DEFAULTS — the three settings the live estate needs before anybody can keep books.
//
//   1. PKP status on each entity            (owner: "should be PKP because its a company")
//   2. a finance seat so the books are keepable  (owner: point it at hansel@gaiada.com for now)
//   3. the ownership edge                    (owner: "by default it should be Anthony 100%")
//
// ── EVERY ONE OF THESE IS A DEFAULT, NOT A DECISION ────────────────────────────────────────────
// All three are editable from the UI. This seed exists so a fresh live estate is not stuck in a
// state where nothing can be done at all — it is not the authority on any of these values, and it
// NEVER overwrites a value somebody has already set. Each write is guarded and reports
// `set` vs `already`; a second run changes nothing.
//
// ── ANTHONY GETS ONE ROW, NOT THREE ────────────────────────────────────────────────────────────
// The obvious reading of "Anthony 100%" is three rows, one per company. That is wrong here, and
// wrong in a way that would quietly misstate the cap table.
//
// `company_ownership.kind = 'holding'` confers **the company plus every descendant** through
// `finance_owner_company_ids()`. Both operating companies are children of D & A Syrowatka, so a
// single holding edge on the holding company already resolves to all three. Writing three
// shareholder rows instead would ALSO give him all three — but it would assert something false:
// that he holds the operating companies directly, rather than through the holding vehicle. The
// resolver would agree with either; the cap table would not, and a `shareholder` edge deliberately
// carries no group reach, so a later group total would be computed on a different basis.
//
// One edge. It says what is actually true.
//
// ── THE SEAT IS A STAND-IN AND IS REGISTERED AS ONE ────────────────────────────────────────────
// `hansel@gaiada.com` is a real superadmin standing in for two roles that have no named holder
// yet. That is recorded in `docs/PLACEHOLDER-PRINCIPALS.md` (P-01, P-02) — a grant made without
// that register entry is a defect. Note the SoD consequence spelled out there: while the
// accountant and the finance manager are the same account, segregation of duties is NOT in force.
//
// ⚠ This seed deliberately does NOT sign off any period. See finance-config.ts for why that
// matters more than it looks.
import { withTenants, withGlobal, closePool, newId } from "../db";

/** The holding company. A `holding` edge here reaches both operating companies. */
const HOLDING_COMPANY = "D & A Syrowatka";
const DEFAULT_OWNER_EMAIL = "anthony@gaiada.com";
const DEFAULT_SEAT_EMAIL = "hansel@gaiada.com";
/** The accountant must be able to POST, which `finance_staff` (read-only keys) cannot do. */
const SEAT_ROLE = "finance_manager";

export interface LiveDefaultsResult {
  pkp: Array<{ company: string; action: "set" | "already" }>;
  seat: Array<{ company: string; email: string; action: "granted" | "already" }>;
  ownership: { company: string; email: string; action: "created" | "already" | "skipped"; detail?: string };
}

async function resolveUser(email: string): Promise<{ id: string; name: string }> {
  const r = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE email = $1`, [email]),
  );
  if (!r.rows[0]) {
    throw new Error(
      `finance-live-defaults — no user with email "${email}". This seed deliberately does not ` +
        `CREATE users: inventing a principal in a live estate is how a fictional employee ends up ` +
        `holding a finance grant. Create the account first.`,
    );
  }
  return r.rows[0];
}

async function resolveCompany(name: string): Promise<{ id: string; name: string }> {
  const r = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE name = $1 AND deleted_at IS NULL LIMIT 1`,
      [name],
    ),
  );
  if (!r.rows[0]) throw new Error(`finance-live-defaults — no company named "${name}".`);
  return r.rows[0];
}

export async function seedFinanceLiveDefaults(opts: {
  companies: string[];
  seatEmail?: string;
  ownerEmail?: string;
  holdingCompany?: string;
}): Promise<LiveDefaultsResult> {
  const seatEmail = opts.seatEmail ?? DEFAULT_SEAT_EMAIL;
  const ownerEmail = opts.ownerEmail ?? DEFAULT_OWNER_EMAIL;
  const holdingName = opts.holdingCompany ?? HOLDING_COMPANY;

  const out: LiveDefaultsResult = { pkp: [], seat: [], ownership: { company: holdingName, email: ownerEmail, action: "skipped" } };

  const seatUser = await resolveUser(seatEmail);
  const role = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name = $1`, [SEAT_ROLE]),
  );
  if (!role.rows[0]) {
    throw new Error(`finance-live-defaults — global role "${SEAT_ROLE}" missing; run migrations first.`);
  }

  for (const name of opts.companies) {
    const co = await resolveCompany(name);

    // ── 1. PKP ────────────────────────────────────────────────────────────────────────────────
    // Guarded on `is_pkp IS DISTINCT FROM true` so a company an accountant has deliberately marked
    // non-PKP is never silently flipped back by a re-run.
    const pkp = await withTenants(
      [co.id],
      (c) =>
        c.query(
          `UPDATE finance_company_settings SET is_pkp = true, updated_at = now()
            WHERE tenant_id = $1 AND is_pkp IS DISTINCT FROM true
            RETURNING tenant_id`,
          [co.id],
        ),
      { modules: ["finance"] },
    );
    out.pkp.push({ company: co.name, action: pkp.rowCount === 1 ? "set" : "already" });

    // ── 2. The finance seat (stand-in — see PLACEHOLDER-PRINCIPALS.md P-01/P-02) ───────────────
    const grant = await withGlobal((c) =>
      c.query(
        `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id)
         VALUES ($1,$2,$3,'company',$4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [newId(), seatUser.id, role.rows[0].id, co.id],
      ),
    );
    // Membership goes through withTenants: company_memberships has FORCE RLS and an INSERT under
    // withGlobal fails the WITH CHECK outright (documented in finance-config.ts).
    await withTenants([co.id], (c) =>
      c.query(
        `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site, kind)
         VALUES ($1,$2,$3,'central','employee')
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [newId(), co.id, seatUser.id],
      ),
    );
    out.seat.push({ company: co.name, email: seatEmail, action: grant.rowCount === 1 ? "granted" : "already" });
  }

  // ── 3. Ownership: ONE holding edge on the holding company ────────────────────────────────────
  const holding = await resolveCompany(holdingName);
  const owner = await resolveUser(ownerEmail);
  const existing = await withTenants(
    [holding.id],
    (c) =>
      c.query<{ id: string; kind: string; stake_pct: string | null }>(
        `SELECT id, kind, stake_pct FROM company_ownership
          WHERE tenant_id = $1 AND holder_user_id = $2 AND deleted_at IS NULL AND effective_to IS NULL`,
        [holding.id, owner.id],
      ),
    { modules: ["finance"] },
  );
  if (existing.rows[0]) {
    out.ownership = {
      company: holding.name,
      email: ownerEmail,
      action: "already",
      detail: `${existing.rows[0].kind} ${existing.rows[0].stake_pct ?? "unknown"}%`,
    };
  } else {
    await withTenants(
      [holding.id],
      (c) =>
        c.query(
          `INSERT INTO company_ownership (id, tenant_id, holder_user_id, kind, stake_pct, notes)
           VALUES ($1,$2,$3,'holding',100,$4)`,
          [
            newId(),
            holding.id,
            owner.id,
            "Default seeded 2026-08-25 (owner ruling: Anthony 100%). A holding edge reaches all " +
              "descendant companies; editable from the UI.",
          ],
        ),
      { modules: ["finance"] },
    );
    out.ownership = { company: holding.name, email: ownerEmail, action: "created", detail: "holding 100%" };
  }

  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.filter((a) => a.startsWith(`--${n}=`)).map((a) => a.slice(n.length + 3));
  const companies = flag("company");
  if (companies.length === 0) {
    console.error('finance-live-defaults — pass at least one --company="Name".');
    process.exit(1);
  }
  const r = await seedFinanceLiveDefaults({
    companies,
    seatEmail: flag("seat-email")[0],
    ownerEmail: flag("owner-email")[0],
    holdingCompany: flag("holding")[0],
  });

  console.log("PKP status:");
  for (const p of r.pkp) console.log(`  ${p.company.padEnd(22)} ${p.action === "set" ? "set to PKP" : "already PKP"}`);
  console.log("Finance seat (STAND-IN — see docs/PLACEHOLDER-PRINCIPALS.md P-01/P-02):");
  for (const s of r.seat) console.log(`  ${s.company.padEnd(22)} ${SEAT_ROLE} -> ${s.email} (${s.action})`);
  console.log("Ownership:");
  console.log(
    `  ${r.ownership.company.padEnd(22)} ${r.ownership.email} ${r.ownership.action}` +
      (r.ownership.detail ? ` (${r.ownership.detail})` : ""),
  );
  console.log("");
  console.log("All three are DEFAULTS and are editable from the UI. This seed never overwrites a");
  console.log("value somebody has already set.");
  console.log("");
  console.log("⚠ The accountant and the finance manager are currently the SAME account, so");
  console.log("  segregation of duties is NOT in force. Acceptable while the books are empty;");
  console.log("  not acceptable once real transactions are posted. Retire the stand-in first.");
  await closePool();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

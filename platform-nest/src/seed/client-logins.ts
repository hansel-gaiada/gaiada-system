// Make the seeded client-portal logins actually usable, and give every client one.
//
// ⚠ THE ACCOUNTS ALREADY EXIST — THE PASSWORDS DO NOT. All four seeded contacts
// (ayu@/budi@nusacoffee, sari@kintamani, maya@ubudyoga) already have Keycloak accounts from an
// earlier `seed:portal-clients` run. That seed generates a RANDOM password per run and prints it
// once:
//
//     const PASSWORD = process.env.SEED_PORTAL_PASSWORD || `Portal-${randomBytes(9)...}`
//     // "A random password per run is the shape that cannot regress: there is nothing to leak"
//
// That is the right default for a seed. It also means nobody can log in as a client today, because
// the only copy of each password scrolled past in a terminal weeks ago. So this script re-sets them
// to a known value rather than creating anything.
//
// ⚠ PERMANENT, NOT TEMPORARY, AND THAT IS DELIBERATE — the opposite choice from `provision-roster`.
// `keycloak-admin.ts`'s own `setPassword` explains why: for an external client, Keycloak's forced
// UPDATE_PASSWORD screen is "an extra unexplained step immediately after they just chose a password
// on our own accept screen". Staff get `setPasswordTemporary` because a shared bootstrap string must
// not survive first use; a client portal demo login is a different case with a documented answer.
//
// ── ALSO ──────────────────────────────────────────────────────────────────────────────────────────
// · Bali Beach Resort has no usable contact — its only one is a `walk-…@example.invalid` test
//   artifact — so it gets a real contact + login, per owner decision (every client should be
//   viewable).
// · The two `@example.invalid` artifacts are REVOKED, not deleted: `client_contacts` carries an audit
//   trail (invited_by, invited_at, activated_at) and revocation is the lifecycle the schema models.
//   Deleting them would erase the record that an invite ever happened.
import { withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import {
  findUserByEmail as kcFind,
  createUser as kcCreate,
  setPassword as kcSetPassword,
  keycloakAdminConfigured,
  KeycloakUserExistsError,
} from "../core/keycloak-admin";

const AGENCY_NAME = "Gaia Digital Agency";
const MODULES = ["agency", "clients", "billing", "pm", "webdev"];

/** The password these logins end up with. Overridable; the default is fixed and known ON PURPOSE —
 *  the whole point is that somebody can sign in and look at the portal. These are `.test` addresses
 *  that can never receive mail, on seeded demo clients. */
const PASSWORD = process.env.SEED_PORTAL_PASSWORD || "Gaiada-123";

interface Target {
  client: string;
  email: string;
  name: string;
  capability: "signer" | "viewer";
  /** true = this contact does not exist yet and must be created (users + client_contacts). */
  create?: boolean;
}

const TARGETS: Target[] = [
  { client: "Nusa Coffee Co", email: "ayu@nusacoffee.test", name: "Ayu Pratama", capability: "signer" },
  { client: "Nusa Coffee Co", email: "budi@nusacoffee.test", name: "Budi Santoso", capability: "viewer" },
  { client: "Kintamani Roasters", email: "sari@kintamani.test", name: "Sari Dewi", capability: "signer" },
  { client: "Ubud Yoga Collective", email: "maya@ubudyoga.test", name: "Maya Wijaya", capability: "viewer" },
  // The one that does not exist yet.
  { client: "Bali Beach Resort", email: "wira@balibeach.test", name: "Wira Kusuma", capability: "signer", create: true },
];

const JUNK_CONTACT_PATTERN = "%@example.invalid";

/** Grant the global `client` role at this company, idempotently.
 *
 *  ⚠ WITHOUT THIS THE LOGIN WORKS AND THE PORTAL IS EMPTY — which is the worst shape of failure,
 *  because "I can sign in" reads as success. Verified live: `wira@balibeach.test` authenticated
 *  fine and every portal route answered
 *  `403 {"error":"not authorized: cerbos denied read on portal"}`, while the four pre-existing
 *  contacts returned a full overview. The ONLY difference between them was this row — none of the
 *  five has a `company_memberships` row, so a membership is not what portal access hangs on.
 *
 *  `seed:portal-clients` has always done this and says why ("the contact has a tenant but no role,
 *  and every portal action is denied"). This script created a contact without reading that, which
 *  is the same lesson as the rest of this cleanup: the seed that owns a shape knows something the
 *  new script does not.
 *
 *  Applied to EVERY target rather than only the created one, so a contact that predates this and
 *  is missing the grant gets repaired instead of staying quietly broken. */
async function grantClientRole(userId: string, tenantId: string): Promise<boolean> {
  return withGlobal(async (c) => {
    const role = await c.query<{ id: string }>(
      `SELECT id FROM roles WHERE company_id IS NULL AND name = 'client'`,
    );
    if (!role.rows[0]) return false; // seeded by migration 0072; absent means migrations are behind
    await c.query(
      `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id)
       VALUES (gen_random_uuid(), $1, $2, 'company', $3) ON CONFLICT DO NOTHING`,
      [userId, role.rows[0].id, tenantId],
    );
    return true;
  });
}

export interface ClientLoginsResult {
  dryRun: boolean;
  contactsCreated: string[];
  passwordsSet: string[];
  accountsCreated: string[];
  /** Contacts that hold the global `client` role after this run. A login without it reaches an
   *  empty portal, so this is reported rather than assumed. */
  roleGranted: string[];
  junkRevoked: number;
  failed: { email: string; reason: string }[];
}

export async function provisionClientLogins(opts: { dryRun: boolean }): Promise<ClientLoginsResult> {
  if (!keycloakAdminConfigured()) {
    throw new Error(
      "provisionClientLogins: the Keycloak admin client is not configured — refusing to report success " +
        "having set no passwords.",
    );
  }
  const out: ClientLoginsResult = {
    dryRun: opts.dryRun,
    contactsCreated: [],
    passwordsSet: [],
    accountsCreated: [],
    roleGranted: [],
    junkRevoked: 0,
    failed: [],
  };

  const t = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  if (!t.rows[0]) throw new Error(`provisionClientLogins: no company named "${AGENCY_NAME}"`);
  const tenantId = t.rows[0].id;

  const clients = await withTenants(
    [tenantId],
    (c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM clients WHERE tenant_id = $1`, [tenantId]),
    { modules: MODULES },
  );
  const clientId = new Map(clients.rows.map((r) => [r.name, r.id]));

  for (const target of TARGETS) {
    const cid = clientId.get(target.client);
    if (!cid) {
      out.failed.push({ email: target.email, reason: `client "${target.client}" not found` });
      continue;
    }
    try {
      // ── 1 · the ERP user row ────────────────────────────────────────────────────────────────────
      let userId: string;
      const existing = await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [target.email]),
      );
      if (existing.rows[0]) {
        userId = existing.rows[0].id;
      } else if (opts.dryRun) {
        out.contactsCreated.push(`${target.email} (would create user + contact)`);
        out.passwordsSet.push(`${target.email} (would set password)`);
        continue;
      } else {
        // `kind: 'client'` — PK-01's discriminator. A portal contact is NOT an employee, and getting
        // this wrong would put them in employee-facing reads.
        const ins = await withGlobal((c) =>
          c.query<{ id: string }>(
            `INSERT INTO users (id, email, name, title, kind, origin_site)
             VALUES (gen_random_uuid(), $1, $2, 'Client contact', 'client', $3) RETURNING id`,
            [target.email, target.name, config.originSite],
          ),
        );
        userId = ins.rows[0].id;
      }

      // ── 2 · the client_contacts row ─────────────────────────────────────────────────────────────
      const has = await withTenants(
        [tenantId],
        (c) =>
          c.query<{ id: string }>(
            `SELECT id FROM client_contacts
              WHERE tenant_id = $1 AND client_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
            [tenantId, cid, userId],
          ),
        { modules: MODULES },
      );
      if (!has.rows[0]) {
        if (opts.dryRun) out.contactsCreated.push(`${target.email} (would create contact)`);
        else {
          await withTenants(
            [tenantId],
            (c) =>
              c.query(
                `INSERT INTO client_contacts
                   (id, tenant_id, client_id, user_id, project_id, capability, status, invited_at, activated_at, origin_site)
                 VALUES (gen_random_uuid(), $1, $2, $3, NULL, $4, 'active', now(), now(), $5)`,
                [tenantId, cid, userId, target.capability, config.originSite],
              ),
            { modules: MODULES },
          );
          out.contactsCreated.push(target.email);
        }
      }

      // ── 3 · the global `client` role ─────────────────────────────────────────────────────────────
      // Before Keycloak on purpose: if the password step fails, the authz side is still correct and
      // a re-run only has to redo the password.
      if (opts.dryRun) {
        out.roleGranted.push(`${target.email} (would ensure client role)`);
      } else {
        const ok = await grantClientRole(userId, tenantId);
        if (!ok) {
          throw new Error(
            "the global `client` role does not exist (migration 0072 seeds it) — refusing to hand " +
              "out a login that would reach an empty portal",
          );
        }
        out.roleGranted.push(target.email);
      }

      // ── 4 · the Keycloak account + a KNOWN password ─────────────────────────────────────────────
      if (opts.dryRun) {
        const kc = await kcFind(target.email);
        out.passwordsSet.push(`${target.email} (${kc ? "account exists — would reset password" : "would create account"})`);
        continue;
      }
      let kcId: string | null = null;
      const found = await kcFind(target.email);
      if (found) kcId = found.id;
      else {
        try {
          kcId = await kcCreate({ email: target.email, firstName: target.name.split(" ")[0], lastName: target.name.split(" ").slice(1).join(" ") });
          out.accountsCreated.push(target.email);
        } catch (err) {
          // A 409 between the lookup and the create is a race, not a failure — the account exists,
          // which is the outcome we wanted.
          if (!(err instanceof KeycloakUserExistsError)) throw err;
          const again = await kcFind(target.email);
          kcId = again ? again.id : null;
        }
      }
      if (!kcId) throw new Error("could not resolve a Keycloak id");
      await kcSetPassword(kcId, PASSWORD);
      out.passwordsSet.push(target.email);
    } catch (err) {
      out.failed.push({ email: target.email, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── 5 · revoke the `.invalid` test artifacts ────────────────────────────────────────────────────
  const junk = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ id: string }>(
        `SELECT cc.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
          WHERE cc.tenant_id = $1 AND u.email LIKE $2 AND cc.status <> 'revoked' AND cc.deleted_at IS NULL`,
        [tenantId, JUNK_CONTACT_PATTERN],
      ),
    { modules: MODULES },
  );
  if (junk.rows.length && !opts.dryRun) {
    out.junkRevoked = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(
          `UPDATE client_contacts SET status = 'revoked', revoked_at = now(), updated_at = now()
            WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
          [tenantId, junk.rows.map((x) => x.id)],
        );
        return r.rowCount ?? 0;
      },
      { modules: MODULES },
    );
  } else {
    out.junkRevoked = junk.rows.length;
  }

  return out;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--confirm");
  const r = await provisionClientLogins({ dryRun });
  console.log(`contacts ${dryRun ? "to create" : "created"}: ${r.contactsCreated.length}`);
  for (const e of r.contactsCreated) console.log(`  + ${e}`);
  console.log(`Keycloak accounts ${dryRun ? "to create" : "created"}: ${r.accountsCreated.length}`);
  for (const e of r.accountsCreated) console.log(`  + ${e}`);
  console.log(`client role ${dryRun ? "to ensure" : "ensured"}: ${r.roleGranted.length}`);
  for (const e of r.roleGranted) console.log(`  * ${e}`);
  console.log(`passwords ${dryRun ? "to set" : "set"}: ${r.passwordsSet.length}`);
  for (const e of r.passwordsSet) console.log(`  = ${e}`);
  console.log(`junk contacts ${dryRun ? "to revoke" : "revoked"}: ${r.junkRevoked}`);
  if (r.failed.length) {
    console.log(`FAILED: ${r.failed.length}`);
    for (const f of r.failed) console.log(`  ! ${f.email} — ${f.reason}`);
    process.exitCode = 1;
  }
  if (dryRun) console.log("\nDRY RUN. Re-run with:  npm run seed:client-logins -- --confirm");
  else console.log("\nPassword is SEED_PORTAL_PASSWORD, or the documented default. Permanent, not temporary — see the file header.");
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();

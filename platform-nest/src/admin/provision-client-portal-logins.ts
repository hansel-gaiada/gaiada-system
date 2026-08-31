// Give every REAL client a portal login — one placeholder contact each, ready to be replaced with
// the client's own people at staging.
//
// ── WHY THIS EXISTS SEPARATELY FROM `seed/client-logins.ts` ────────────────────────────────────
// That script services a HARDCODED list of four demo contacts, all of which were retired on
// 2026-08-31 when the seed clients were removed. This one derives its targets FROM THE DATABASE, so
// it covers whatever clients actually exist and stays correct as the roster changes. Copying the
// old list and editing it would have gone stale the first time a client was added.
//
// ── THE FOUR STEPS, AND WHY THE ORDER MATTERS ──────────────────────────────────────────────────
//   1. `users` row with kind='client' — PK-01's discriminator. A portal contact is NOT an employee;
//      getting this wrong puts them in employee-facing reads.
//   2. `client_contacts` row binding user -> client.
//   3. The GLOBAL `client` role. `seed/client-logins.ts` learned this the hard way: without it the
//      contact "has a tenant but no role, and every portal action is denied" — a login that reaches
//      an empty portal and looks like a data bug. Granted BEFORE Keycloak on purpose, so that if the
//      password step fails the authz side is still correct and a re-run only redoes the password.
//   4. The Keycloak account and its password.
//
// ── CREDENTIAL POSTURE ─────────────────────────────────────────────────────────────────────────
// * Addresses are `portal@<slug>.test`. `.test` is reserved by RFC 2606 and can never route, so
//   these accounts cannot receive mail and cannot be mistaken for a real person's address. Using a
//   client's real domain would mean creating Keycloak accounts against addresses we do not own.
// * A DISTINCT random password per client, from `generateInitialPassword()`. One shared password
//   across 19 portals would mean one leak exposes every client's data.
// * Passwords are printed ONCE to stdout and never persisted by this script. Capture them into the
//   gitignored credentials file; they are not recoverable afterwards, only re-settable.
// * Non-temporary, matching `seed/client-logins.ts`'s documented reasoning: Keycloak's forced
//   UPDATE_PASSWORD screen is "an extra unexplained step" for an external client who has just been
//   handed a credential out of band.
//
// Idempotent: an existing user/contact/role is reused, and only the password is (re)set.
//
// Run:  docker exec <platform> node dist/admin/provision-client-portal-logins.js [--dry-run]

import { withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { insertGrantRow } from "./grant-write.service";
import {
  findUserByEmail as kcFind,
  createUser as kcCreate,
  setPassword as kcSetPassword,
  keycloakAdminConfigured,
  generateInitialPassword,
  KeycloakUserExistsError,
} from "../core/keycloak-admin";

const AGENCY_NAME = "Gaia Digital Agency";
const MODULES = ["agency", "clients", "invoice", "pm", "webdev"];

/** `Blossom Steakhouse` -> `blossom-steakhouse`. Diacritics are folded so `Apéritif Restaurant`
 *  yields `aperitif-restaurant` rather than an address with a non-ASCII character in it. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface Provisioned {
  client: string;
  email: string;
  password?: string;
  note: string;
}

export interface Result {
  dryRun: boolean;
  provisioned: Provisioned[];
  failed: { client: string; reason: string }[];
}

/** Routed through THE choke point rather than writing `user_roles` directly.
 *
 *  `seed/client-logins.ts` does the raw INSERT and is on the guard's TRUSTED allowlist; copying it
 *  here failed `user-roles-writer-guard.test.ts` with the IAM-SEC-05 message — "a NEW writer minting
 *  a role grant outside the one guarded path". Allowlisting this file would have been permitted (it
 *  is a CLI, not a request path), but the guard offers the choke point first and there is no reason
 *  to take the exemption: `insertGrantRow` also runs `assertGrantAllowed`, which the raw INSERT
 *  skips entirely.
 *
 *  `origin: "trusted_internal"` with a null actor is the documented shape for a non-request caller —
 *  GrantSpec states null `actorUserId` "is only legitimate for `trusted_internal`". */
async function grantClientRole(userId: string, tenantId: string): Promise<boolean> {
  return withGlobal(async (c) => {
    const role = await c.query<{ id: string }>(
      `SELECT id FROM roles WHERE company_id IS NULL AND name = 'client'`,
    );
    if (!role.rows[0]) return false;
    await insertGrantRow(c, {
      origin: "trusted_internal",
      targetUserId: userId,
      roleId: role.rows[0].id,
      scopeType: "company",
      scopeId: tenantId,
      actorUserId: null,
      tenantId,
      // `unique_columns`, not `untargeted`: scope_id is non-null here (company scope), so the
      // 4-column UNIQUE genuinely fires. `untargeted` exists for GLOBAL grants where scope_id
      // IS NULL and SQL NULL-inequality makes that constraint never match.
      onConflict: "unique_columns",
    });
    return true;
  });
}

export async function provisionAllClientPortalLogins(opts: { dryRun: boolean }): Promise<Result> {
  if (!opts.dryRun && !keycloakAdminConfigured()) {
    throw new Error(
      "the Keycloak admin client is not configured — refusing to report success having created no logins.",
    );
  }
  const out: Result = { dryRun: opts.dryRun, provisioned: [], failed: [] };

  const t = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  if (!t.rows[0]) throw new Error(`no company named "${AGENCY_NAME}"`);
  const tenantId = t.rows[0].id;

  // Every live client, read from the database rather than a list that would go stale.
  const clients = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ id: string; name: string }>(
        `SELECT id, name FROM clients WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY name`,
        [tenantId],
      ),
    { modules: MODULES },
  );

  for (const cl of clients.rows) {
    const email = `portal@${slugify(cl.name)}.test`;
    try {
      // 1 · ERP user
      let userId: string;
      const existing = await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]),
      );
      if (existing.rows[0]) {
        userId = existing.rows[0].id;
      } else if (opts.dryRun) {
        out.provisioned.push({ client: cl.name, email, note: "would create user + contact + role + account" });
        continue;
      } else {
        const ins = await withGlobal((c) =>
          c.query<{ id: string }>(
            `INSERT INTO users (id, email, name, title, kind, origin_site)
             VALUES (gen_random_uuid(), $1, $2, 'Client contact', 'client', $3) RETURNING id`,
            [email, `${cl.name} Portal`, config.originSite],
          ),
        );
        userId = ins.rows[0].id;
      }

      if (opts.dryRun) {
        out.provisioned.push({ client: cl.name, email, note: "would ensure contact + role + password" });
        continue;
      }

      // 2 · client_contacts
      const has = await withTenants(
        [tenantId],
        (c) =>
          c.query<{ id: string }>(
            `SELECT id FROM client_contacts
              WHERE tenant_id = $1 AND client_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
            [tenantId, cl.id, userId],
          ),
        { modules: MODULES },
      );
      if (!has.rows[0]) {
        await withTenants(
          [tenantId],
          (c) =>
            c.query(
              `INSERT INTO client_contacts
                 (id, tenant_id, client_id, user_id, project_id, capability, status, invited_at, activated_at, origin_site)
               VALUES (gen_random_uuid(), $1, $2, $3, NULL, 'signer', 'active', now(), now(), $4)`,
              [tenantId, cl.id, userId, config.originSite],
            ),
          { modules: MODULES },
        );
      }

      // 3 · the global `client` role — before Keycloak, deliberately.
      if (!(await grantClientRole(userId, tenantId))) {
        throw new Error(
          "the global `client` role does not exist (migration 0072 seeds it) — refusing to hand out " +
            "a login that would reach an empty portal",
        );
      }

      // 4 · Keycloak account + a distinct random password
      const password = generateInitialPassword();
      let kcId: string;
      const found = await kcFind(email);
      if (found) {
        kcId = found.id;
      } else {
        try {
          kcId = await kcCreate({ email, firstName: cl.name, lastName: "Portal" });
        } catch (e) {
          if (e instanceof KeycloakUserExistsError) {
            const again = await kcFind(email);
            if (!again) throw e;
            kcId = again.id;
          } else throw e;
        }
      }
      await kcSetPassword(kcId, password);

      out.provisioned.push({ client: cl.name, email, password, note: "ready" });
    } catch (e) {
      out.failed.push({ client: cl.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const res = await provisionAllClientPortalLogins({ dryRun });

  // Printed once. Nothing here writes a password anywhere; capture it now or re-run to re-set.
  console.log(`\n${dryRun ? "DRY RUN — " : ""}client portal logins (${res.provisioned.length})\n`);
  console.log("client".padEnd(24) + "email".padEnd(38) + "password");
  console.log("-".repeat(90));
  for (const p of res.provisioned) {
    console.log(p.client.padEnd(24) + p.email.padEnd(38) + (p.password ?? p.note));
  }
  if (res.failed.length) {
    console.error(`\n${res.failed.length} FAILED:`);
    for (const f of res.failed) console.error(`  ${f.client}: ${f.reason}`);
  }
  console.log(
    `\n${dryRun ? "Nothing was written." : "Passwords are shown ONCE and are not stored by this script."} ` +
      `Put them in the gitignored credentials file, never in the repo.`,
  );
  await closePool();
  process.exit(res.failed.length ? 1 : 0);
}

if (process.argv[1]?.includes("provision-client-portal-logins")) {
  void main();
}

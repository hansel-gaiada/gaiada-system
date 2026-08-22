// Give the real roster real LOGINS — Keycloak accounts for everyone in `roster.ts`.
//
// ⚠ THE GAP THIS CLOSES, STATED EXACTLY. `../CLAUDE.md`: "Only ~7 platform users have Keycloak
// accounts — a `users` row is not a login." Every seed in this directory writes `users` rows, which
// is what the ERP authorizes against, and NONE of them can produce a login. So seeding the roster
// makes 25 people appear throughout the app — org chart, tasks, HR, reports — while not one of them
// can sign in. This script is the other half, and it is separate from the seed on purpose:
//
//   · A seed writes to a database. This writes to an IDENTITY PROVIDER — a different system, with
//     different blast radius. `seed:agency` running in CI must never create real accounts.
//   · It is therefore opt-in (`npm run provision:roster`) and refuses to run without an explicit
//     confirmation flag, because the failure mode is "25 accounts on the live realm" and there is no
//     undo that also un-emails anyone.
//
// ── ON THE SHARED PASSWORD ────────────────────────────────────────────────────────────────────────
// The owner specified `Gaiada-123` for everyone. That is a reasonable bootstrap for getting a team
// into a system nobody has logged into yet, and it is the owner's call. It is also, plainly, a weak
// password that will be known to every person in the company and to anyone they tell — so this
// script sets it as a TEMPORARY credential, which makes Keycloak force a change at first login.
//
// That is a deliberate deviation from `core/keycloak-admin.ts`'s `setPassword()`, whose comment says
// `temporary: false` "on purpose" — correct for ITS caller, the IT reset-password flow, where an
// admin reads a generated password to someone over the phone and a forced reset would strand a user
// mid-support-call. Here the opposite is true: a shared known string SHOULD not survive first use.
// The password reaches its real strength the moment each person picks their own, and the seeded value
// stops being a credential at all.
//
// ⚠ hansel@gaiada.com IS TREATED DIFFERENTLY AND MUST BE. He already exists as the SSO superadmin,
// and the owner asked that he "can go either ways" — SSO or password. Overwriting his credential
// would break the one account that can currently administer the realm. So an EXISTING account is
// never re-credentialed by this script; only missing accounts are created.
import {
  keycloakAdminConfigured,
  findUserByEmail,
  createUser,
  setPasswordTemporary,
  KeycloakNotConfiguredError,
  KeycloakUserExistsError,
} from "../core/keycloak-admin";
import { STAFF } from "./roster";

/** The owner-specified bootstrap password. Not a secret — it is a shared, single-use string that
 *  Keycloak forces each person to replace. Overridable so a real rollout need not use it at all. */
const BOOTSTRAP_PASSWORD = process.env.ROSTER_BOOTSTRAP_PASSWORD ?? "Gaiada-123";

export interface ProvisionResult {
  created: string[];
  alreadyExisted: string[];
  failed: { email: string; reason: string }[];
}

/** Split a roster display name into Keycloak's first/last. Single-word names ("Reva", "Tini") get an
 *  empty surname rather than a duplicated one — a fabricated last name is data nobody can correct
 *  without knowing it was fabricated. */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? name, lastName: parts.slice(1).join(" ") };
}

export async function provisionRoster(opts: { dryRun: boolean }): Promise<ProvisionResult> {
  if (!keycloakAdminConfigured()) {
    // Refuse rather than report success having created nothing — a silent no-op here reads exactly
    // like "everyone already had an account", which is the wrong conclusion to hand an operator.
    // The error names which vars are missing rather than all four, so the fix is one step.
    const REQUIRED = [
      "KEYCLOAK_ADMIN_BASE_URL",
      "KEYCLOAK_ADMIN_REALM",
      "KEYCLOAK_ADMIN_CLIENT_ID",
      "KEYCLOAK_ADMIN_CLIENT_SECRET",
    ];
    throw new KeycloakNotConfiguredError(REQUIRED.filter((v) => !process.env[v]));
  }

  const result: ProvisionResult = { created: [], alreadyExisted: [], failed: [] };

  // Real staff only. The `fixture` level is the five `@gaiada-creative.test` seed actors plus the
  // group_executive placeholder — inventing IdP accounts on a domain the company does not own would
  // fail, and if it somehow succeeded it would be worse.
  const people = STAFF.filter((s) => s.level !== "fixture");

  for (const s of people) {
    try {
      const existing = await findUserByEmail(s.email);
      if (existing) {
        // Includes hansel@gaiada.com by design — see the header. An existing account keeps its
        // credential and its SSO federation untouched.
        result.alreadyExisted.push(s.email);
        continue;
      }
      if (opts.dryRun) {
        result.created.push(s.email);
        continue;
      }
      const { firstName, lastName } = splitName(s.name);
      // No `username`/`enabled` — createUser owns both: username IS the email in this realm, and it
      // creates enabled + email-verified. And no `password` either, though it accepts one: that path
      // sets a PERMANENT credential, which is the one thing a shared bootstrap string must not be.
      const id = await createUser({ email: s.email, firstName, lastName });
      // Temporary — Keycloak raises UPDATE_PASSWORD at first login. See the header for why this
      // differs from keycloak-admin's setPassword().
      await setPasswordTemporary(id, BOOTSTRAP_PASSWORD);
      result.created.push(s.email);
    } catch (err) {
      // A 409 between the lookup above and the create is a RACE, not a failure — the account exists,
      // which is the outcome we wanted. Recording it as failed would make a correct run look broken.
      if (err instanceof KeycloakUserExistsError) {
        result.alreadyExisted.push(s.email);
        continue;
      }
      // One bad row must not abandon the other 18 half-provisioned with no report of which.
      result.failed.push({ email: s.email, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--confirm");
  if (dryRun) {
    console.log(
      "DRY RUN — no accounts will be created. This writes to the IDENTITY PROVIDER, not a database,\n" +
        "so it requires --confirm. Re-run with:  npm run provision:roster -- --confirm\n",
    );
  }

  const r = await provisionRoster({ dryRun });
  console.log(`${dryRun ? "would create" : "created"}: ${r.created.length}`);
  for (const e of r.created) console.log(`  + ${e}`);
  console.log(`already had an account (left untouched): ${r.alreadyExisted.length}`);
  for (const e of r.alreadyExisted) console.log(`  = ${e}`);
  if (r.failed.length) {
    console.log(`FAILED: ${r.failed.length}`);
    for (const f of r.failed) console.log(`  ! ${f.email} — ${f.reason}`);
  }
  if (!dryRun && r.created.length) {
    console.log(
      "\nEach new account has a TEMPORARY password; Keycloak will force a change at first login.\n" +
        "A `users` row in the ERP is still what grants access — run seed:agency if you have not.",
    );
  }
  // A partial run is a failure, not a success with notes: exit non-zero so a CI/ops caller notices.
  if (r.failed.length) process.exitCode = 1;
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();


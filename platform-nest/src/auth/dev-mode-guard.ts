// Boot refusal for passwordless auth in a production runtime (fault register finding 04, 2026-09-08).
//
// ── WHAT `AUTH_MODE=dev` ACTUALLY IS ─────────────────────────────────────────────────────────────
// Not a "relaxed" mode. In dev mode `platform-ui/src/app/login/actions.ts` takes an email address,
// nothing else, resolves it through `/dev/user-by-email`, and seals a full session as that user.
// There is no password, no OTP, no second factor. Anyone who can reach the login page and guess a
// colleague's email address is that colleague.
//
// ── WHY A BOOT REFUSAL RATHER THAN A WARNING ─────────────────────────────────────────────────────
// The compose default now fails closed (`${PLATFORM_AUTH_MODE:-oidc}`) and `.env.example` ships
// `oidc`, which closes the accident. This guard closes the remaining case: someone EXPLICITLY sets
// `dev` on a real deployment — copying an old .env, debugging an auth problem and forgetting to
// revert. A warning does not help there, because the symptom of this misconfiguration is that
// everything works beautifully. There is no failing request to investigate; the ERP just quietly
// stops requiring credentials. So the process must refuse to serve rather than log about it.
//
// Mirrors the guard `platform-ui/next.config.ts` already applies to `DEMO_MODE=1`, deliberately:
// same shape, same reasoning, and that one is the precedent this repo already accepted.
//
// ── THE PRECONDITION IS PINNED, BECAUSE IT WAS NOT TRUE UNTIL TODAY ──────────────────────────────
// ⚠ `NODE_ENV` was EMPTY on the live platform container (verified 2026-09-08), and NOTHING in
// platform-nest's source read it. A guard written against `NODE_ENV === "production"` would
// therefore have shipped, looked responsible, and never once fired — the exact "green everywhere
// you look" failure class this codebase keeps paying for. The same change added
// `NODE_ENV: production` to the platform service in `infra/compose/docker-compose.vps.yml`.
//
// ⚠ THAT PRECONDITION IS NOT TEST-ENFORCED, AND YOU SHOULD KNOW IT. Pinning it from here would
// mean a platform-nest test reaching into `infra/`, which the root CLAUDE.md's "components stay
// separate projects" rule forbids, and no existing test crosses that boundary. So if someone
// deletes that compose line, THIS GUARD SILENTLY STOPS FIRING and nothing goes red.
// What still protects you in that case is the layer underneath: the compose default is
// `${PLATFORM_AUTH_MODE:-oidc}`, so an absent or empty value yields the safe mode regardless of
// this guard. Treat this function as the second line, never the first.
// If that trade is ever revisited, the right home is an infra-side lint wired into the
// `observability-lint` CI job, not a test in this component.
//
// The escape hatch is deliberately verbose and deliberately not a bare boolean: an operator who
// genuinely needs dev auth against a production-flagged runtime has to type something that reads
// like a bad idea, and it is greppable in an incident.

export const DEV_AUTH_ACK_ENV = "AUTH_MODE_DEV_ACK_NON_PRODUCTION";

export class PasswordlessAuthInProductionError extends Error {
  constructor() {
    super(
      "BOOT REFUSED: AUTH_MODE=dev with NODE_ENV=production.\n" +
        "  dev mode is a PASSWORDLESS login — the sign-in form accepts an email address and no\n" +
        "  credential, and issues a full session as that user. Serving this to real users would\n" +
        "  expose every record in the group behind a completely healthy-looking 200.\n" +
        "  Fix: set PLATFORM_AUTH_MODE=oidc (the compose default since 2026-09-08).\n" +
        `  If this is genuinely intended and not production, set ${DEV_AUTH_ACK_ENV}=1.`,
    );
    this.name = "PasswordlessAuthInProductionError";
  }
}

/**
 * Throws when a production-flagged runtime is configured for passwordless auth.
 *
 * Parameters default to the real environment so `assertAuthModeBootSafe()` at a call site behaves
 * exactly as production does; they exist ONLY so tests can drive every combination without
 * mutating `process.env` (config.ts is a module-scope object computed once at import time, so
 * reloading it per case is not available here).
 */
export function assertAuthModeBootSafe(
  authMode: string = process.env.AUTH_MODE ?? "dev",
  nodeEnv: string | undefined = process.env.NODE_ENV,
  ack: string | undefined = process.env[DEV_AUTH_ACK_ENV],
): void {
  if (authMode !== "dev") return;          // oidc / hybrid — nothing to refuse
  if (nodeEnv !== "production") return;    // local stack, tests, CI
  if (ack === "1") {
    // eslint-disable-next-line no-console
    console.warn(
      `[auth] ⚠ PASSWORDLESS AUTH IS ACTIVE in a NODE_ENV=production runtime, permitted only by ` +
        `${DEV_AUTH_ACK_ENV}=1. Every login accepts an email address with no credential.`,
    );
    return;
  }
  throw new PasswordlessAuthInProductionError();
}

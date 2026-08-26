// WSK-05 — env config. Zone B hard rule (webdesk-design.md §01/§03): zero Zone A credentials or
// hostnames anywhere in this project. Every value below is Zone B's own.
//
// Every field is a GETTER, not a value snapshotted at module-load time — deliberately. ES module
// `import` declarations are hoisted and evaluate their entire transitive graph (this file
// included) BEFORE the importing file's own top-level statements run, so a test helper that does
// `process.env.APP_DATABASE_URL = "..."` above an `import { buildApp } from "../src/app"` line
// still loses the race: by the time that assignment executes, this module has already been
// evaluated (via app -> app.module -> db.module -> config) with whatever was in `process.env` a
// moment earlier — in practice, nothing, which sends `pg` an empty connection string and it
// silently falls back to OS-default connection params ("role \"<os-user>\" does not exist" is
// what that looks like, and it is not an obviously env-related error message). Getters make every
// read live, which is what this ticket's own test suite needed to actually work.
//
// NOTE — two env vars this ticket NEEDS that do not exist yet in ../.env.example (out of scope to
// edit directly — .env.example is WSK-01's file; reported as a required change in WSK-05's
// report):
//   API_KEY_PEPPER              — sha256(key + pepper) at rest (§04's own DDL comment). Never in
//                                 the DB, never in git. Falls back to a fixed dev-only value ONLY
//                                 outside production, so a forgotten env var fails loud there
//                                 instead of silently hashing with a guessable pepper.
//   WEBDESK_READ_QUOTA_PER_MIN  — per-tenant content-read quota (reassessment §04, "Per-tenant
//                                 read quotas / noisy-neighbour limits", folded into WSK-05).
function requireInProd(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[webdesk:api] ${name} is not set — refusing to boot in production.`);
  }
  return devFallback;
}

export const config = {
  get nodeEnv() {
    return process.env.NODE_ENV ?? "development";
  },
  get port() {
    return Number(process.env.WEBDESK_API_INTERNAL_PORT ?? 3000);
  },

  get appDatabaseUrl() {
    return process.env.APP_DATABASE_URL ?? "";
  },
  get dbPoolMax() {
    return Number(process.env.WEBDESK_API_DB_POOL_MAX ?? 10);
  },

  get tenantGucName() {
    return process.env.TENANT_GUC_NAME ?? "webdesk.tenant_ctx";
  },

  get apiKeyPepper() {
    return requireInProd("API_KEY_PEPPER", "dev-only-insecure-pepper-do-not-use-in-prod");
  },

  // Fixed window, per tenant, content READS only (forms/media get their own limiters at
  // WSK-10/07 — this one exists so a single noisy tenant cannot exhaust the box for the others,
  // per §11a and the 2026-08-26 reassessment's WSK-05 amendment).
  get readQuotaPerMinute() {
    return Number(process.env.WEBDESK_READ_QUOTA_PER_MIN ?? 300);
  },
  get readQuotaWindowMs() {
    return Number(process.env.WEBDESK_READ_QUOTA_WINDOW_MS ?? 60_000);
  },
};

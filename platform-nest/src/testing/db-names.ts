// Database/role naming shared by the per-file harness (setup.ts) and the template builder
// (global-setup.ts). Factored out so the two can never disagree: global-setup runs in vitest's
// main process and setup.ts runs inside each worker, so a name computed by two copies of the same
// logic would drift silently — and the failure ("template does not exist") surfaces 292 times in
// beforeAll, pointing at nothing.
import { createHash } from "node:crypto";

export const APP_ROLE = "platform_app_test";
export const APP_PASSWORD = "test";

/** Scopes every name in this module to one RUNNER.
 *
 *  Names are derived from the test path alone, so two concurrent `vitest run` invocations against
 *  the same Postgres compute the SAME names, and the second one's `DROP DATABASE ... WITH (FORCE)`
 *  yanks the first one's schema mid-run. That bites two agents, two developers, or two CI jobs
 *  sharing one server. Set a distinct TEST_DB_PREFIX per concurrent runner to isolate them.
 *
 *  Lowercased because Postgres folds unquoted identifiers: a mixed-case prefix would be CREATEd as
 *  one name and connected to as another, which fails as an unhelpful "database does not exist"
 *  inside beforeAll — and vitest then reports the suite as *skipped* rather than failed. Silent
 *  skips are the worst outcome here, so normalize instead of trusting the caller. */
export function dbPrefix(): string {
  return (process.env.TEST_DB_PREFIX ?? "pgtest_f").toLowerCase().replace(/[^a-z0-9_]/g, "");
}

/** The once-per-run, already-migrated database every per-file database is copied from. */
export function templateDbName(): string {
  return `${dbPrefix()}_template`;
}

/** Deterministic per-test-file database name.
 *
 *  Deterministic on purpose: a crashed run's leftover database (possibly with a stuck backend) is
 *  dropped-and-recreated the next time that file runs, instead of accumulating a new throwaway
 *  database forever. The set of databases stays bounded at "one per test file" — 615 abandoned
 *  databases once exhausted Docker's 64MB /dev/shm. */
export function perFileDbName(testPath: string): string {
  const hash = createHash("sha1").update(testPath).digest("hex").slice(0, 20);
  return `${dbPrefix()}_${hash}`;
}

export function urlWithDb(baseUrl: string, database: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

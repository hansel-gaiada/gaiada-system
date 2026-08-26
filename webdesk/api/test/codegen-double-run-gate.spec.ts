// WSK-15 — exercises the ACTUAL CI gate binary (`generator/double-run-gate.mts`) as a real child
// process against the real throwaway Postgres, the same way CI would invoke it
// (`npm run codegen:gate -- --tenants ...`). Two things this suite proves that the in-process
// `codegen-determinism.spec.ts` cannot: (1) the gate script itself — argument parsing, process
// spawning, file diffing, exit codes — actually works end to end; (2) a NEGATIVE CONTROL: when the
// underlying composition genuinely changes between two generations, the artifacts genuinely
// differ byte-for-byte — proving the diff step is a real check, not a tautology that always
// passes because it never has anything to catch.
//
// Env vars: same real names as every other live-DB spec in this suite
// (`APP_DATABASE_URL`/`MIGRATE_DATABASE_URL`) — see ../README.md's WSK-15 runbook.
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55500/webdesk";
process.env.MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk";

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const GATE_SCRIPT = join(process.cwd(), "src", "codegen", "generator", "double-run-gate.mts");
const GENERATE_SINGLE_SCRIPT = join(process.cwd(), "src", "codegen", "generator", "generate-single.mts");

function runNodeTsx(script: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", env: process.env });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

async function seedTenant(pool: pg.Pool, slug: string, collections: Record<string, unknown>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.platform_ctx', 'true', true)`);
    const { rows } = await client.query(
      `INSERT INTO tenants (slug, company_ref, default_locale, locales) VALUES ($1, gen_random_uuid(), 'id-ID', ARRAY['id-ID']) RETURNING id`,
      [slug],
    );
    const tenantId = rows[0].id;
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.tenant_ctx', $1, true)`, [tenantId]);
    const { rows: siteRows } = await client.query(`INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [
      tenantId,
      slug,
    ]);
    for (const [key, schema] of Object.entries(collections)) {
      await client.query(`INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4)`, [
        tenantId,
        siteRows[0].id,
        key,
        JSON.stringify(schema),
      ]);
    }
    await client.query("COMMIT");
    return tenantId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function addCollection(pool: pg.Pool, tenantId: string, key: string, schema: unknown) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.tenant_ctx', $1, true)`, [tenantId]);
    const { rows: siteRows } = await client.query(`SELECT id FROM sites WHERE tenant_id=$1 LIMIT 1`, [tenantId]);
    await client.query(`INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4)`, [
      tenantId,
      siteRows[0].id,
      key,
      JSON.stringify(schema),
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

describe("double-run-gate.mts — real child-process invocation against a live DB", () => {
  const pool = new pg.Pool({ connectionString: process.env.MIGRATE_DATABASE_URL });

  it(
    "PASSES (exit 0) for a tenant whose composition does not change between the two spawned runs",
    async () => {
      const slug = `wsk15-gate-pass-${randomUUID().slice(0, 8)}`;
      await seedTenant(pool, slug, { article: { blocks: ["richText"] } });

      const result = runNodeTsx(GATE_SCRIPT, ["--tenants", slug]);
      expect(result.stdout).toContain("DETERMINISM GATE PASSED");
      expect(result.stdout).toContain("byte-identical across both runs");
      expect(result.status).toBe(0);
    },
    30_000,
  );

  it(
    "NEGATIVE CONTROL — generate-single.mts's own output genuinely differs when the composition genuinely changes between two calls (proves the diff step has something real to catch)",
    async () => {
      const slug = `wsk15-gate-negctrl-${randomUUID().slice(0, 8)}`;
      const tenantId = await seedTenant(pool, slug, { article: { blocks: ["richText"] } });

      const dir = mkdtempSync(join(tmpdir(), "wsk15-gate-negctrl-"));
      try {
        const runADir = join(dir, "run1");
        const runBDir = join(dir, "run2");

        const first = runNodeTsx(GENERATE_SINGLE_SCRIPT, ["--tenant", slug, "--out", runADir]);
        expect(first.status).toBe(0);

        // Genuinely change the composition between the two "runs" — this is the one thing this
        // suite's OTHER determinism tests never do (they always hold input constant).
        await addCollection(pool, tenantId, "case-study", { blocks: ["hero"] });

        const second = runNodeTsx(GENERATE_SINGLE_SCRIPT, ["--tenant", slug, "--out", runBDir]);
        expect(second.status).toBe(0);

        const openapiA = readFileSync(join(runADir, "openapi.v1.json"));
        const openapiB = readFileSync(join(runBDir, "openapi.v1.json"));
        expect(Buffer.compare(openapiA, openapiB)).not.toBe(0);

        const hashManifestA = readFileSync(join(runADir, "hash-manifest.json"));
        const hashManifestB = readFileSync(join(runBDir, "hash-manifest.json"));
        expect(Buffer.compare(hashManifestA, hashManifestB)).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "FAILS (exit 2) with a clear usage message when --tenants is omitted",
    async () => {
      const result = runNodeTsx(GATE_SCRIPT, []);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: double-run-gate.mts");
    },
    15_000,
  );
});

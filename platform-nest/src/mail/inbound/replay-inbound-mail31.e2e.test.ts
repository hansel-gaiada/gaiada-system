// MAIL-31 — demonstration harness for the `replay-inbound.mjs` fix, NOT a permanent contract test
// on the endpoint itself (that's `corpus.test.ts`'s job). This drives the ACTUAL script, over a real
// listening HTTP server, against a real Postgres — the same two "real" ingredients the script's own
// header says it adds over the in-process suite — so the demonstration is of the SCRIPT's behavior,
// not of a mock of it.
//
// This file proves the POSITIVE direction only: the FULL corpus (18 fixtures, including 06's
// intentional duplicate `provider_message_id`) passes cleanly — exit 0, a dedicated
// "DUPLICATE-FIXTURE DEDUP VERIFIED" line, and NO "THREADING BROKEN" anywhere in the output — and
// that an isolated `--only 06-...` run (the exact shape that used to false-negative) also passes.
//
// The NEGATIVE direction (a genuinely broken threading path must still fail loudly) is
// demonstrated separately, OUTSIDE this file: `intake.ts`'s INSERT is edited on disk to force a
// permanent zero-row outcome, `vitest run` on this same file is re-invoked as a FRESH process
// (so it imports the edited module from disk, not a cached one), and the edit is reverted
// afterward. That two-step is driven from the shell, not from inside a single `it()` — a source
// edit made mid-process would never be picked up by an already-imported module anyway. See the
// ticket report for the transcript of both runs.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { setStorageForTest, localStorage as localStorageBackend, type StorageBackend } from "../../core/storage";
import { setScannerForTest } from "./scanner";
import { resetInboundRateLimitForTest } from "./rate-limit";

const execFileAsync = promisify(execFile);
const TOKEN = "mail31-replay-script-token";
const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "replay-inbound.mjs");

function memoryStorage(): { backend: StorageBackend } {
  const files = new Map<string, Buffer>();
  return {
    backend: {
      async put(key, data) {
        files.set(key, data);
      },
      async get(key) {
        const b = files.get(key);
        if (!b) throw new Error(`missing ${key}`);
        return b;
      },
      async del(key) {
        files.delete(key);
      },
    },
  };
}

describe.skipIf(!TEST_URL)("MAIL-31 — replay-inbound.mjs script, driven for real (dev leg)", () => {
  let app: NestFastifyApplication;
  let tenantId: string;
  let databaseUrlForScript: string;

  const saved = {
    token: config.mail.inboundToken,
    signingKey: config.mail.inboundSigningKey,
    rate: config.mail.inboundRatePerMin,
    replyDomain: config.mail.replyDomain,
  };

  async function seedMail(toEmail: string): Promise<{ id: string; token: string }> {
    const id = newId();
    const token = newId().replace(/-/g, "");
    const entityId = newId();
    await adminPool().query(
      `INSERT INTO pipeline_runs (id, tenant_id, title, status, origin_site)
       VALUES ($1, $2, 'MAIL-31 replay-script run', 'delivery_active', 'test')`,
      [entityId, tenantId],
    );
    await adminPool().query(
      `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, payload, status,
                             entity_type, entity_id, reply_token, origin_site)
       VALUES ($1, 'notify', $2, $3, 'approval.actionable', 'Approval needed', '{}'::jsonb, 'sent',
               'pipeline_run', $4, $5, 'test')`,
      [id, tenantId, toEmail, entityId, token],
    );
    return { id, token };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.mail.inboundToken = TOKEN;
    config.mail.inboundSigningKey = "";
    config.mail.inboundRatePerMin = 0; // off — this run posts ~19 requests in a few seconds
    config.mail.replyDomain = "notify.gaiada.invalid";
    resetInboundRateLimitForTest();
    setScannerForTest(null);
    setStorageForTest(memoryStorage().backend);

    tenantId = await createCompany("MAIL-31 Replay Script Co");
    const recipient = await createUser("mail31-recipient@a.test");
    await addMembership(tenantId, recipient);

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });

    // The script needs a superuser-ish connection to read mail_messages/mail_log directly — the
    // SAME physical per-file test database `adminPool()` already talks to, rebuilt as a plain
    // connection string from `TEST_URL` + the database name `initTestDb()` just created (parsed
    // back out of the app-role URL `config.databaseUrl` now points at, since `perFileDbName()`
    // itself is private to testing/setup.ts).
    const dbName = new URL(config.databaseUrl).pathname.slice(1);
    const adminUrl = new URL(TEST_URL);
    adminUrl.pathname = `/${dbName}`;
    databaseUrlForScript = adminUrl.toString();
  }, 60_000);

  afterAll(async () => {
    Object.assign(config.mail, saved);
    setStorageForTest(localStorageBackend);
    await app.close();
    await teardownTestDb();
  });

  function baseUrl(): string {
    const addr = app.getHttpServer().address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async function runScript(extraArgs: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [SCRIPT, "--base", baseUrl(), "--token", TOKEN, "--database-url", databaseUrlForScript, ...extraArgs],
        { timeout: 30_000 },
      );
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("full corpus incl. the duplicate fixture: exits 0, verifies the dedupe, never says THREADING BROKEN", async () => {
    const mail = await seedMail("mail31-recipient@a.test");
    const result = await runScript(["--reply-token", mail.token]);

    expect(result.stdout).toContain("DUPLICATE-FIXTURE DEDUP VERIFIED");
    expect(result.stdout).not.toContain("THREADING BROKEN");
    expect(result.stdout).not.toContain("DUPLICATE-FIXTURE CHECK FAILED");
    expect(result.stdout).toMatch(/18\/18 cases returned the expected status/);
    expect(result.code).toBe(0);
  }, 30_000);

  it("--only the duplicate fixture, in isolation: still exits 0 (this is the exact false-negative MAIL-31 fixes)", async () => {
    const mail = await seedMail("mail31-recipient-only@a.test");
    const result = await runScript(["--reply-token", mail.token, "--only", "06-replayed-provider-id.json"]);

    expect(result.stdout).toContain("DUPLICATE-FIXTURE DEDUP VERIFIED");
    expect(result.stdout).not.toContain("THREADING BROKEN");
    expect(result.code).toBe(0);
  }, 30_000);
});

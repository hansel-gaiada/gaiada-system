// WSK-66 — WebDesk HIGH commands approved in the ERP and executed IN-BAND at decide().
//
// Everything real except Zone B itself: real Postgres (RLS, the migrated origin CHECK), real Cerbos
// (resource_webdesk_content_item.yaml, resource_webdev_provisioned_site.yaml,
// resource_automation_approval.yaml, all unmodified), the real NestJS app driven through
// `POST /api/:t/automation-approvals/:id/decide`, and the REAL egress client
// (`webdesk-control-client.ts`) over real mTLS sockets. Zone B is a STUB TLS server (a throwaway CA
// minted per run with openssl, the WSK-63b test's pattern) that VERIFIES what it receives: the WS4
// assertion (HMAC, expiry, command hash over params ∪ body), the editorial-assertion slot (WSK-40's
// header; a test-double signer stands in for the Ed25519 one), and WS4 single use. It keeps item state
// so the ambiguous-failure reconcile can READ it.
//
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise) and `openssl` on PATH.
//
// Done-when map (design §12 WSK-66):
//   1 → "origin CHECK" describe          4 → "egress failure" + "ambiguous" describes
//   2 → "maker ≠ checker" + "no publish"  5 → "tool_args edited after filing"
//   3 → "approve → one publish"          6 → "key.mint custody"
// Denial tests send VALID bodies and each is paired with an allowed control on the identical body.
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { assemblePrincipal, type Principal } from "../../rbac/principal";
import { newId, withTenants } from "../../db";
import { WebdeskControlClient } from "./webdesk-control-client";
import { computeCommandHash } from "./webdesk-ws4-assertion";
import {
  NOT_CONFIGURED_EDITORIAL_SIGNER,
  executeApprovedWebdeskCommand,
  fileWebdeskCommandApproval,
  isWebdeskApprovedCommandRequest,
  setWebdeskApprovedCommandDepsForTests,
  type EditorialAssertionRequest,
  type EditorialAssertionSigner,
  type WebdeskApprovedCommand,
} from "./webdesk-approved-command";

const live = !!TEST_URL && !!process.env.CERBOS_URL;

const WS4_KEY = "wsk66-ws4-hmac-key-5c1e9b7a2d4f";
const CLIENT_SECRET = "wsk66-kc-client-secret-8e2d1f";
const TENANT_SLUG = "gaiada";
const SITE_ID = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const ENV_ID = "1c7a2d3e-4f5b-4c6d-9e7f-8091a2b3c4d5";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MIGRATION_FILE = resolve(__dirname, "../../../migrations/202610101500_automation_approvals_origin_webdesk.sql");
/** Every origin admitted BEFORE WSK-66 (0016, 0028/0115 hr+iam, 202609010900 github, 202609040505 credential_reveal). */
const PRIOR_ORIGINS = ["automation", "agent", "hr", "iam", "github", "credential_reveal"];

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Throwaway PKI
// ══════════════════════════════════════════════════════════════════════════════════════════════════

let dir = "";
const pem = (name: string): Buffer => readFileSync(join(dir, name));
function openssl(...args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}
function makeCa(name: string, cn: string): void {
  openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  openssl("req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-days", "2", "-sha256",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", `${name}.crt`);
}
function issue(name: string, cn: string, caName: string, ext: string): void {
  openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  openssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-out", `${name}.csr`);
  writeFileSync(join(dir, `${name}.ext`), `${ext}\n`);
  openssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${caName}.crt`, "-CAkey", `${caName}.key`, "-CAcreateserial",
    "-days", "2", "-sha256", "-extfile", `${name}.ext`, "-out", `${name}.crt`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The stub Zone B: verifies, records, keeps item state
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface Ws4Verdict { ok: boolean; reason?: string; approvalId?: string; commandHash?: string; exp?: number }
interface Seen {
  method: string;
  path: string;
  command: string | null;
  args: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  ws4: Ws4Verdict | null;
  editorial: Record<string, unknown> | null;
  status: number | "dropped";
}
interface ItemState { publishedVersion: number | null; publishAt: string | null; unpublishAt: string | null }
type Mode = "ok" | "refuse-409" | "refuse-409-review" | "commit-then-drop" | "drop-no-commit";

interface ZoneB {
  server: https.Server;
  port: number;
  seen: Seen[];
  items: Map<string, ItemState>;
  usedApprovals: Set<string>;
  mintedKeys: string[];
  mode: Mode;
  dropAll: boolean;
  connections: number;
}

function verifyWs4(header: string | undefined, command: string, args: Record<string, unknown>): Ws4Verdict {
  if (!header) return { ok: false, reason: "ws4-missing" };
  const [payload, sig] = header.split(".");
  if (!payload || !sig) return { ok: false, reason: "ws4-malformed" };
  const expected = Buffer.from(createHmac("sha256", WS4_KEY).update(payload).digest("hex"));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "ws4-bad-signature" };
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { approvalId: string; commandHash: string; exp: number };
  if (!(claims.exp > Math.floor(Date.now() / 1000))) return { ok: false, reason: "ws4-expired" };
  if (claims.commandHash !== computeCommandHash(command, args)) return { ok: false, reason: "ws4-command-mismatch" };
  return { ok: true, approvalId: claims.approvalId, commandHash: claims.commandHash, exp: claims.exp };
}

function decodeEditorial(header: string | undefined): Record<string, unknown> | null {
  if (!header) return null;
  const parts = header.split(".");
  if (parts.length !== 3) return null;
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

function problem(res: http.ServerResponse, status: number, slug: string): void {
  res.writeHead(status, { "content-type": "application/problem+json" });
  res.end(JSON.stringify({ type: `https://webdesk.gaiada.online/errors/${slug}`, title: slug, status }));
}

async function startZoneB(): Promise<ZoneB> {
  const z = { seen: [], items: new Map(), usedApprovals: new Set(), mintedKeys: [], mode: "ok", dropAll: false, connections: 0 } as unknown as ZoneB;
  const server = https.createServer(
    { key: pem("server.key"), cert: pem("server.crt"), ca: pem("ca.crt"), requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const url = req.url ?? "";
        const content = /^\/control\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/content\/(publish|schedule)$/.exec(url);
        const keys = /^\/control\/v1\/tenants\/([^/]+)\/keys$/.exec(url);
        const itemGet = /^\/control\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/content\/items\/([^/]+)$/.exec(url);
        const rec: Seen = { method: req.method ?? "", path: url, command: null, args: {}, headers: req.headers, ws4: null, editorial: null, status: 0 };
        z.seen.push(rec);
        const answer = (status: number, json: unknown) => {
          rec.status = status;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(json));
        };
        const refuse = (status: number, slug: string) => {
          rec.status = status;
          problem(res, status, slug);
        };

        if (req.method === "GET" && itemGet) {
          const itemId = decodeURIComponent(itemGet[3]);
          const s = z.items.get(itemId) ?? { publishedVersion: null, publishAt: null, unpublishAt: null };
          answer(200, { item: { itemId, ...s } });
          return;
        }
        if (req.method === "POST" && (content || keys)) {
          const command = content ? `content.${content[3]}` : "key.mint";
          const params: Record<string, string> = content
            ? { tenantSlug: decodeURIComponent(content[1]), siteId: decodeURIComponent(content[2]) }
            : { tenantSlug: decodeURIComponent((keys as RegExpExecArray)[1]) };
          const args = { ...params, ...body };
          rec.command = command;
          rec.args = args;
          // Layer 4: HIGH ⇒ a valid WS4 assertion for exactly this command + args, used once.
          const ws4 = verifyWs4(req.headers["x-ws4-assertion"] as string | undefined, command, args);
          rec.ws4 = ws4;
          if (!ws4.ok) return refuse(403, ws4.reason ?? "ws4-invalid");
          if (z.usedApprovals.has(ws4.approvalId as string)) return refuse(403, "ws4-approval-replayed");
          // Layer 2e (content commands only — EDITORIAL_COMMANDS, design §3.1).
          if (content) {
            const ed = decodeEditorial(req.headers["x-webdesk-editorial-assertion"] as string | undefined);
            rec.editorial = ed;
            if (!ed) return refuse(401, "editorial-assertion-missing");
            if (ed.ten !== params.tenantSlug || ed.site !== params.siteId) return refuse(403, "editorial-assertion-scope-mismatch");
            if (ed.cmd !== command || ed.apr !== ws4.approvalId || ed.cmh !== computeCommandHash(command, args)) {
              return refuse(403, "editorial-assertion-command-mismatch");
            }
          }
          z.usedApprovals.add(ws4.approvalId as string);
          if (z.mode === "refuse-409") return refuse(409, "version-conflict");
          // M5-W2c: WebDesk's publish gate refuses inside its transaction (its WS4 claim rolls back with it).
          if (z.mode === "refuse-409-review") return refuse(409, "review-not-approved");
          if (z.mode === "drop-no-commit") {
            rec.status = "dropped";
            req.socket.destroy();
            return;
          }
          // Commit.
          if (keys) {
            const key = `wdk_live_${randomBytes(24).toString("hex")}`;
            z.mintedKeys.push(key);
            answer(201, { id: randomUUID(), key, scope: body.scope, envId: body.envId, tenantId: randomUUID(), createdAt: new Date().toISOString(), replayed: false });
            return;
          }
          const items = (body.items as Array<{ itemId: string; version: number }>) ?? [];
          const at = new Date().toISOString();
          for (const it of items) {
            const prev = z.items.get(it.itemId) ?? { publishedVersion: null, publishAt: null, unpublishAt: null };
            z.items.set(
              it.itemId,
              command === "content.publish"
                ? { ...prev, publishedVersion: it.version }
                : { ...prev, publishAt: (body.publishAt as string | null) ?? null, unpublishAt: (body.unpublishAt as string | null) ?? null },
            );
          }
          if (z.mode === "commit-then-drop") {
            rec.status = "dropped";
            req.socket.destroy();
            return;
          }
          answer(200, {
            [command === "content.publish" ? "published" : "scheduled"]: items.map((it) => ({ itemId: it.itemId, version: it.version, publishedAt: at })),
            replayed: false,
          });
          return;
        }
        refuse(404, "not-found");
      });
    },
  );
  server.on("connection", (socket: Socket) => {
    z.connections++;
    if (z.dropAll) socket.destroy();
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  z.server = server;
  z.port = (server.address() as AddressInfo).port;
  return z;
}

async function startTokenStub(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "eyJ-wsk66-access-token", expires_in: 300, token_type: "Bearer" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

// ── The editorial-assertion test double (WSK-40 ships the Ed25519 one) ───────────────────────────
const signerCalls: EditorialAssertionRequest[] = [];
const testSigner: EditorialAssertionSigner = {
  configured: true,
  sign(input) {
    signerCalls.push(input);
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    return `${b({ alg: "EdDSA", typ: "wd-editorial+jwt", kid: "wsk66-test" })}.${b({ ...input, iat: now, exp: now + 60, jti: randomUUID() })}.${Buffer.from("test-double-signature").toString("base64url")}`;
  },
};

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Suite
// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe.skipIf(!live)("WSK-66 — WebDesk HIGH commands executed in-band at decide()", () => {
  let app: NestFastifyApplication;
  let zoneB: ZoneB;
  let token: { server: http.Server; port: number };
  let client: WebdeskControlClient;
  let T: string;
  let adminA: string;
  let adminB: string;
  let editor: string;
  let editor2: string;
  let publisher: string;
  let manager: string;
  let member: string;
  const P: Record<string, Principal> = {};

  const posts = () => zoneB.seen.filter((s) => s.method === "POST");
  const gets = () => zoneB.seen.filter((s) => s.method === "GET");
  const item = () => randomUUID();

  async function principal(userId: string): Promise<Principal> {
    if (!P[userId]) {
      const p = await assemblePrincipal(userId, "high");
      if (!p) throw new Error(`could not assemble ${userId}`);
      P[userId] = p;
    }
    return P[userId];
  }

  async function file(
    as: string,
    command: WebdeskApprovedCommand,
    args: Record<string, unknown>,
    title = `${command} test`,
  ): Promise<string> {
    const { approvalId } = await fileWebdeskCommandApproval(await principal(as), T, {
      command,
      tenantSlug: TENANT_SLUG,
      siteId: SITE_ID,
      args,
      summary: { title },
    });
    return approvalId;
  }

  async function row(id: string) {
    const { rows } = await adminPool().query<{
      status: string; execution_status: string; execution_error: string | null;
      execution_result: { text?: string } | null; tool_args: Record<string, unknown>; origin: string;
      decided_by: string | null; executed_by: string | null; execution_attempts: number;
    }>(
      `SELECT status, execution_status, execution_error, execution_result, tool_args, origin, decided_by, executed_by, execution_attempts
         FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  const decide = (id: string, as: string, decision: "approved" | "rejected" = "approved") =>
    app.inject({ method: "POST", url: `/api/${T}/automation-approvals/${id}/decide`, headers: asUser(as), payload: { decision } });

  /** Simulate "decide() already flipped the row" for the direct-executor tests. */
  async function markApproved(id: string, decidedBy: string): Promise<void> {
    await adminPool().query(
      `UPDATE automation_approvals SET status = 'approved', decided_by = $2, decided_at = now(), execution_status = 'pending' WHERE id = $1`,
      [id, decidedBy],
    );
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsk66-pki-"));
    makeCa("ca", "wsk66-test-ca");
    issue("server", "control.webdesk.test", "ca", "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth");
    issue("client", "platform-nest-webdesk", "ca", "extendedKeyUsage=clientAuth");
    zoneB = await startZoneB();
    token = await startTokenStub();

    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    T = await createCompany("WSK-66 Co", ["webdev"]);
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(T, id);
      await grantRole(id, await createRole(role), "company", T);
      return id;
    };
    adminA = await mk("wsk66-admin-a@ex.test", "company_admin");
    adminB = await mk("wsk66-admin-b@ex.test", "company_admin");
    editor = await mk("wsk66-editor@ex.test", "webdev_staff");
    editor2 = await mk("wsk66-editor2@ex.test", "webdev_staff");
    publisher = await mk("wsk66-publisher@ex.test", "webdev_manager");
    manager = await mk("wsk66-manager@ex.test", "manager");
    member = await mk("wsk66-member@ex.test", "member");
    app = await buildApp();
  }, 120_000);

  beforeEach(() => {
    client = new WebdeskControlClient({
      baseUrl: `https://127.0.0.1:${zoneB.port}`,
      clientCertFile: join(dir, "client.crt"),
      clientKeyFile: join(dir, "client.key"),
      caFile: join(dir, "ca.crt"),
      tokenUrl: `http://127.0.0.1:${token.port}/token`,
      clientId: "webdesk-control",
      clientSecret: CLIENT_SECRET,
      ws4Key: WS4_KEY,
      retryAttempts: 2,
      retryBaseDelayMs: 1,
      timeoutMs: 5_000,
      breakerThreshold: 1000,
      sleep: async () => undefined,
    });
    setWebdeskApprovedCommandDepsForTests({ client, signer: testSigner });
    zoneB.seen.length = 0;
    zoneB.mode = "ok";
    zoneB.dropAll = false;
    zoneB.connections = 0;
    signerCalls.length = 0;
  });

  afterEach(() => {
    client.close();
    setWebdeskApprovedCommandDepsForTests(null);
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
    for (const s of [zoneB?.server, token?.server]) {
      if (!s) continue;
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 1 — the origin CHECK admits 'webdesk' and keeps every prior value", () => {
    it("the LIVE catalog definition admits every prior origin AND 'webdesk', and still refuses an unknown one", async () => {
      const { rows } = await adminPool().query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'automation_approvals'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%origin%' AND pg_get_constraintdef(oid) ILIKE '%automation%'`,
      );
      expect(rows).toHaveLength(1);
      for (const v of [...PRIOR_ORIGINS, "webdesk"]) expect(rows[0].def).toContain(`'${v}'`);

      // And the CHECK really admits each one (an INSERT per value, through the RLS-bound app role).
      for (const origin of [...PRIOR_ORIGINS, "webdesk"]) {
        await withTenants([T], (c) =>
          c.query(
            `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, origin_site)
             VALUES ($1, $2, 'wsk66-probe', 'probe', '{}', 'high', $3, $4, 'main')`,
            [newId(), T, adminA, origin],
          ),
        );
      }
      await expect(
        withTenants([T], (c) =>
          c.query(
            `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, origin_site)
             VALUES ($1, $2, 'wsk66-probe', 'probe', '{}', 'high', $3, 'not_an_origin', 'main')`,
            [newId(), T, adminA],
          ),
        ),
      ).rejects.toThrow(/automation_approvals_origin_check|check constraint/);
      await adminPool().query(`DELETE FROM automation_approvals WHERE workflow_id = 'wsk66-probe'`);
    });

    it("the migration UNIONS into whatever the catalog holds (the lost-value regression): a value no file ever typed survives a re-run", async () => {
      // Plant a value that exists ONLY in the catalog (as if a concurrent migration had added it),
      // drop 'webdesk', then run THIS migration file. A retyped list would lose 'wsk66_probe_value'.
      const c = await adminPool().connect();
      try {
        await c.query("BEGIN");
        const { rows } = await c.query<{ conname: string; def: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'automation_approvals'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%origin%' AND pg_get_constraintdef(oid) ILIKE '%automation%'`,
        );
        const before = [...rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]);
        const planted = [...before.filter((v) => v !== "webdesk"), "wsk66_probe_value"];
        await c.query(`ALTER TABLE automation_approvals DROP CONSTRAINT ${rows[0].conname}`);
        await c.query(
          `ALTER TABLE automation_approvals ADD CONSTRAINT ${rows[0].conname} CHECK (origin IN (${planted.map((v) => `'${v}'`).join(", ")})) NOT VALID`,
        );
        await c.query(readFileSync(MIGRATION_FILE, "utf8"));
        const after = await c.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'automation_approvals'::regclass AND conname = $1`,
          [rows[0].conname],
        );
        for (const v of [...planted, "webdesk"]) expect(after.rows[0].def, `lost '${v}'`).toContain(`'${v}'`);
        // Idempotent: a second run changes nothing.
        await c.query(readFileSync(MIGRATION_FILE, "utf8"));
        const again = await c.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'automation_approvals'::regclass AND conname = $1`,
          [rows[0].conname],
        );
        expect(again.rows[0].def).toBe(after.rows[0].def);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 3 — approve → exactly one Zone B publish with a valid WS4 + editorial assertion", () => {
    it("an editor's 2-item publish approved by a company_admin: one POST, WS4 hash = the stored tool_args, row executed", async () => {
      const items = [{ itemId: item(), version: 4 }, { itemId: item(), version: 2 }];
      const id = await file(editor, "content.publish", { items, note: "FAQ 3 fix" });
      expect(isWebdeskApprovedCommandRequest("webdesk", "content.publish")).toBe(true);
      const filed = await row(id);
      expect(filed).toMatchObject({ origin: "webdesk", status: "pending" });
      expect(filed.tool_args.rebuild).toEqual({ target: "staging", approvalId: id }); // R3, for WSK-60

      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      const body = r.json() as { status: string; webdesk: Record<string, unknown> };
      expect(body.status).toBe("approved");
      expect(body.webdesk).toMatchObject({ command: "content.publish", executionStatus: "executed", reconciled: false, selfPublish: false });

      expect(posts()).toHaveLength(1);
      const sent = posts()[0];
      expect(sent.path).toBe(`/control/v1/tenants/${TENANT_SLUG}/sites/${SITE_ID}/content/publish`);
      expect(sent.status).toBe(200);
      // The WS4 assertion verified on Zone B, for this approval, over exactly the stored args.
      const stored = (await row(id)).tool_args as { items: Array<{ itemId: string; version: number }>; note: string; commandHash: string };
      const expectedHash = computeCommandHash("content.publish", {
        tenantSlug: TENANT_SLUG,
        siteId: SITE_ID,
        items: stored.items.map(({ itemId, version }) => ({ itemId, version })),
        note: stored.note,
      });
      expect(sent.ws4).toMatchObject({ ok: true, approvalId: id, commandHash: expectedHash });
      expect(stored.commandHash).toBe(expectedHash);
      expect(sent.headers["idempotency-key"]).toBe(`ws4:${id}`);
      // The editorial slot: sub = decider, req = requester, apr = approval, cmh = the filed hash.
      expect(sent.editorial).toMatchObject({ sub: adminB, req: editor, apr: id, cmd: "content.publish", cmh: expectedHash, ten: TENANT_SLUG, site: SITE_ID, pk: "human" });

      const after = await row(id);
      expect(after).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null, executed_by: adminB, execution_attempts: 1 });
      expect(JSON.parse(after.execution_result?.text ?? "{}")).toMatchObject({ rebuild: { target: "staging", approvalId: id } });
      for (const it of items) expect(zoneB.items.get(it.itemId)?.publishedVersion).toBe(it.version);

      // Single use: a second decide is 404 and sends nothing.
      expect((await decide(id, adminB)).statusCode).toBe(404);
      expect(posts()).toHaveLength(1);
    });

    it("a rejection sends nothing and executes nothing", async () => {
      const id = await file(editor, "content.publish", { items: [{ itemId: item(), version: 1 }, { itemId: item(), version: 1 }] });
      const r = await decide(id, adminB, "rejected");
      expect(r.statusCode).toBe(200);
      expect(zoneB.seen).toHaveLength(0);
      expect(await row(id)).toMatchObject({ status: "rejected", execution_status: "not_applicable" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 2 — maker ≠ checker (Cerbos DENY), except R4's single-item self-publish", () => {
    it("🔴 requester decides their own MULTI-item publish → 403, zero Zone B calls, row stays pending; ✅ control: another admin approves the SAME row → executed", async () => {
      const id = await file(adminA, "content.publish", { items: [{ itemId: item(), version: 1 }, { itemId: item(), version: 3 }] });
      const denied = await decide(id, adminA);
      expect(denied.statusCode).toBe(403);
      expect(zoneB.seen).toHaveLength(0);
      expect(signerCalls).toHaveLength(0);
      expect(await row(id)).toMatchObject({ status: "pending", execution_status: "not_applicable" });

      const ok = await decide(id, adminB);
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { webdesk: { executionStatus: string } }).webdesk.executionStatus).toBe("executed");
      expect(posts()).toHaveLength(1);
    });

    it("✅ R4: a SINGLE-item self-publish executes (decider = requester)", async () => {
      const it1 = item();
      const id = await file(adminA, "content.publish", { items: [{ itemId: it1, version: 7 }] });
      const r = await decide(id, adminA);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { executionStatus: "executed", selfPublish: true } });
      expect(posts()).toHaveLength(1);
      expect(posts()[0].editorial).toMatchObject({ sub: adminA, req: adminA, apr: id });
      expect(zoneB.items.get(it1)?.publishedVersion).toBe(7);
    });

    it("🔴 R4 is publish-only: a single-item self-SCHEDULE → 403, zero calls; ✅ control: another admin → executed", async () => {
      const id = await file(adminA, "content.schedule", { items: [{ itemId: item(), version: 2 }], publishAt: "2099-11-01T00:00:00.000Z" });
      expect((await decide(id, adminA)).statusCode).toBe(403);
      expect(zoneB.seen).toHaveLength(0);
      const ok = await decide(id, adminB);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ webdesk: { command: "content.schedule", executionStatus: "executed" } });
      expect(posts()).toHaveLength(1);
      expect(posts()[0].path).toMatch(/\/content\/schedule$/);
    });

    it("🔴 deciders without the authority (webdev_manager: publish but no decide; webdev_staff; manager; member) → 403 each, zero calls; ✅ control: company_admin → executed", async () => {
      const id = await file(editor, "content.publish", { items: [{ itemId: item(), version: 1 }, { itemId: item(), version: 1 }] });
      for (const who of [publisher, editor2, manager, member]) {
        expect((await decide(id, who)).statusCode, `decider ${who}`).toBe(403);
      }
      expect(zoneB.seen).toHaveLength(0);
      expect(await row(id)).toMatchObject({ status: "pending" });
      expect((await decide(id, adminB)).statusCode).toBe(200);
      expect(posts()).toHaveLength(1);
    });

    it("🔴 THE PUBLISH GATE ITSELF (executor, as the decider): webdev_staff and manager hold no `publish` → 403, zero calls; ✅ control: company_admin on an identical-body twin → executed", async () => {
      const items = [{ itemId: item(), version: 5 }, { itemId: item(), version: 6 }];
      for (const who of [editor2, manager]) {
        const id = await file(editor, "content.publish", { items });
        await markApproved(id, who);
        const r = await row(id);
        await expect(executeApprovedWebdeskCommand(T, id, r.tool_args, editor, await principal(who))).rejects.toBeInstanceOf(ForbiddenException);
        expect(zoneB.seen).toHaveLength(0);
        expect((await row(id)).execution_error).toMatch(/^webdesk_denied: /);
      }
      const twin = await file(editor, "content.publish", { items });
      await markApproved(twin, adminB);
      const res = await executeApprovedWebdeskCommand(T, twin, (await row(twin)).tool_args, editor, await principal(adminB));
      expect(res.executionStatus).toBe("executed");
      expect(posts()).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 4 — egress failure: typed token, NO second attempt; ambiguous → reconcile by READING", () => {
    it("Zone B refuses (409) → row failed `webdesk_refused: 409 version-conflict`, exactly one POST, and neither re-decide nor /retry sends again", async () => {
      zoneB.mode = "refuse-409";
      const id = await file(editor, "content.publish", { items: [{ itemId: item(), version: 2 }, { itemId: item(), version: 2 }] });
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ status: "approved", webdesk: { executionStatus: "failed", error: "webdesk_refused: 409 version-conflict" } });
      expect(await row(id)).toMatchObject({ execution_status: "failed", execution_error: "webdesk_refused: 409 version-conflict" });
      expect(posts()).toHaveLength(1);

      zoneB.mode = "ok";
      expect((await decide(id, adminB)).statusCode).toBe(404);
      // D14-07's retry endpoint cannot re-drive a webdesk row: the D14 executor refuses its origin.
      const retry = await app.inject({ method: "POST", url: `/api/${T}/automation-approvals/${id}/retry`, headers: asUser(adminB) });
      expect(retry.statusCode).toBe(200);
      expect((await row(id)).execution_error).toMatch(/not_executable: origin 'webdesk' is not auto-executable/);
      expect(posts()).toHaveLength(1);
    });

    it("M5-W2c: WebDesk's review gate refuses (409 review-not-approved) → row failed `webdesk_refused: 409 review-not-approved`, one POST, no reconcile read, never resent", async () => {
      for (const command of ["content.publish", "content.schedule"] as const) {
        zoneB.mode = "refuse-409-review";
        const before = zoneB.seen.length;
        const args = command === "content.publish"
          ? { items: [{ itemId: item(), version: 3 }] }
          : { items: [{ itemId: item(), version: 3 }], publishAt: "2099-11-01T00:00:00.000Z" };
        const id = await file(editor, command, args);
        const r = await decide(id, adminB);
        expect(r.statusCode).toBe(200);
        expect(r.json()).toMatchObject({ status: "approved", webdesk: { executionStatus: "failed", error: "webdesk_refused: 409 review-not-approved" } });
        expect(await row(id)).toMatchObject({ execution_status: "failed", execution_error: "webdesk_refused: 409 review-not-approved" });
        const sent = zoneB.seen.slice(before);
        expect(sent.filter((s) => s.method === "POST")).toHaveLength(1);
        expect(sent.filter((s) => s.method === "GET")).toHaveLength(0); // a definitive refusal is not ambiguous: nothing is read back
        zoneB.mode = "ok";
        expect((await decide(id, adminB)).statusCode).toBe(404);
        expect(zoneB.seen.slice(before).filter((s) => s.method === "POST")).toHaveLength(1);
      }
    });

    it("transport failure before Zone B saw anything → `webdesk_unreachable`, zero requests reached Zone B", async () => {
      zoneB.dropAll = true;
      const id = await file(editor, "content.publish", { items: [{ itemId: item(), version: 1 }, { itemId: item(), version: 1 }] });
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect((r.json() as { webdesk: { error: string } }).webdesk.error).toMatch(/^webdesk_unreachable: /);
      expect(zoneB.connections).toBeGreaterThan(0);
      expect(zoneB.seen).toHaveLength(0);
      expect((await row(id)).execution_status).toBe("failed");
    });

    it("AMBIGUOUS: Zone B committed and the answer was lost → reconciled by READING item state → executed; still exactly one POST", async () => {
      zoneB.mode = "commit-then-drop";
      const items = [{ itemId: item(), version: 3 }, { itemId: item(), version: 9 }];
      const id = await file(editor, "content.publish", { items });
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { executionStatus: "executed", reconciled: true } });
      expect(posts()).toHaveLength(1);
      expect(gets().length).toBe(items.length);
      expect(gets().every((g) => g.headers["x-ws4-assertion"] === undefined)).toBe(true);
      expect(await row(id)).toMatchObject({ execution_status: "executed", execution_error: null });
      expect(JSON.parse((await row(id)).execution_result?.text ?? "{}")).toMatchObject({ reconciled: true });
    });

    it("AMBIGUOUS and NOT committed → the read shows the items unpublished → failed `webdesk_ambiguous`, nothing resent", async () => {
      zoneB.mode = "drop-no-commit";
      const id = await file(editor, "content.publish", { items: [{ itemId: item(), version: 3 }, { itemId: item(), version: 4 }] });
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect((r.json() as { webdesk: { error: string } }).webdesk.error).toMatch(/^webdesk_ambiguous: /);
      expect(posts()).toHaveLength(1);
      expect((await row(id)).execution_status).toBe("failed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 5 — tool_args edited after filing", () => {
    it("an item version edited in the stored row → Zone B 403 editorial-assertion-command-mismatch → row failed, nothing published", async () => {
      const target = item();
      const id = await file(editor, "content.publish", { items: [{ itemId: target, version: 3 }, { itemId: item(), version: 1 }] });
      // The edit (anyone with DB write, or a bug): v3 → v4, AFTER the human-visible filing.
      await adminPool().query(
        `UPDATE automation_approvals SET tool_args = jsonb_set(tool_args, '{items,0,version}', '4'::jsonb) WHERE id = $1`,
        [id],
      );
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ webdesk: { executionStatus: "failed", error: "webdesk_refused: 403 editorial-assertion-command-mismatch" } });
      expect(posts()).toHaveLength(1);
      // The WS4 assertion alone would NOT have caught it (it hashes the request as sent)…
      expect(posts()[0].ws4?.ok).toBe(true);
      // …the editorial `cmh`, bound to the FILED hash, did.
      expect(posts()[0].editorial?.cmh).toBe((await row(id)).tool_args.commandHash);
      expect(zoneB.items.get(target)).toBeUndefined();
      expect(await row(id)).toMatchObject({ execution_status: "failed", execution_error: "webdesk_refused: 403 editorial-assertion-command-mismatch" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("done-when 6 — key.mint: the plaintext exists only in the decide() response", () => {
    it("company_admin approves another admin's key.mint → one POST /keys (WS4, no editorial header); plaintext in the response ONLY", async () => {
      const id = await file(adminA, "key.mint", { envId: ENV_ID, scope: "read" });

      const captured: string[] = [];
      const outWrite = process.stdout.write.bind(process.stdout);
      const errWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return (outWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return (errWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;
      const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
        }),
      );
      let r: Awaited<ReturnType<typeof decide>>;
      try {
        r = await decide(id, adminB);
      } finally {
        process.stdout.write = outWrite as typeof process.stdout.write;
        process.stderr.write = errWrite as typeof process.stderr.write;
        consoleSpies.forEach((s) => s.mockRestore());
      }

      expect(r.statusCode).toBe(200);
      expect(zoneB.mintedKeys).toHaveLength(1);
      const plaintext = zoneB.mintedKeys[0];
      const body = r.json() as { webdesk: { command: string; executionStatus: string; plaintextOnce: string; apiKeyId: string } };
      expect(body.webdesk).toMatchObject({ command: "key.mint", executionStatus: "executed", plaintextOnce: plaintext, envId: ENV_ID, scope: "read" });
      expect(r.body.split(plaintext)).toHaveLength(2); // exactly once in the response

      expect(posts()).toHaveLength(1);
      expect(posts()[0].path).toBe(`/control/v1/tenants/${TENANT_SLUG}/keys`);
      expect(posts()[0].ws4).toMatchObject({ ok: true, approvalId: id, commandHash: computeCommandHash("key.mint", { tenantSlug: TENANT_SLUG, envId: ENV_ID, scope: "read" }) });
      expect(posts()[0].headers["x-webdesk-editorial-assertion"]).toBeUndefined();

      // The scans: automation_approvals, activities, the outbox, and every log line captured.
      const scan = async (table: string) =>
        (await adminPool().query<{ t: string | null }>(`SELECT string_agg(x::text, E'\\n') AS t FROM ${table} x`)).rows[0].t ?? "";
      const approvals = await scan("automation_approvals");
      const activities = await scan("activities");
      const outbox = await scan("outbox_events");
      expect(approvals).toContain(id); // the scan saw the row…
      expect(activities).toContain(body.webdesk.apiKeyId); // …and the key-id activity…
      expect(approvals).not.toContain(plaintext); // …and neither holds the secret.
      expect(activities).not.toContain(plaintext);
      expect(outbox).not.toContain(plaintext);
      expect(captured.join("\n")).not.toContain(plaintext);
      expect(await row(id)).toMatchObject({ execution_status: "executed" });
    });

    it("🔴 key.mint is never self-approvable → 403, zero calls; ✅ control: another admin → executed", async () => {
      const id = await file(adminA, "key.mint", { envId: ENV_ID, scope: "write" });
      expect((await decide(id, adminA)).statusCode).toBe(403);
      expect(zoneB.seen).toHaveLength(0);
      expect((await decide(id, adminB)).statusCode).toBe(200);
      expect(posts()).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("seams and fences", () => {
    it("the editorial signer seam (WSK-40): not configured → decide 503, row stays pending, zero calls; ✅ control with a signer → executed", async () => {
      setWebdeskApprovedCommandDepsForTests({ signer: NOT_CONFIGURED_EDITORIAL_SIGNER });
      const id = await file(editor, "content.publish", { items: [{ itemId: item(), version: 1 }, { itemId: item(), version: 2 }] });
      const r = await decide(id, adminB);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ reason: "webdesk_not_configured" });
      expect(zoneB.seen).toHaveLength(0);
      expect(await row(id)).toMatchObject({ status: "pending" });
      setWebdeskApprovedCommandDepsForTests({ signer: testSigner });
      expect((await decide(id, adminB)).statusCode).toBe(200);
      expect(posts()).toHaveLength(1);
    });

    it("a webdesk row naming a command OUTSIDE the closed allow-list → 400 on approve, zero calls", async () => {
      const id = newId();
      await withTenants([T], (c) =>
        c.query(
          `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, origin_site)
           VALUES ($1, $2, 'content.delete', 'webdesk.content.delete', $3, 'high', $4, 'webdesk', 'main')`,
          [id, T, JSON.stringify({ command: "content.delete", tenantSlug: TENANT_SLUG, siteId: SITE_ID }), editor],
        ),
      );
      expect(isWebdeskApprovedCommandRequest("webdesk", "content.delete")).toBe(false);
      expect((await decide(id, adminB)).statusCode).toBe(400);
      expect(zoneB.seen).toHaveLength(0);
      expect(await row(id)).toMatchObject({ status: "pending" });
    });

    it("filing: authorization runs BEFORE validation — a member is 403 with an INVALID body and with a valid one; an editor's invalid body is 400", async () => {
      const valid = { items: [{ itemId: item(), version: 1 }] };
      const invalid = { items: [{ itemId: "not-a-uuid", version: 0 }] };
      const call = async (as: string, args: Record<string, unknown>) =>
        fileWebdeskCommandApproval(await principal(as), T, { command: "content.publish", tenantSlug: TENANT_SLUG, siteId: SITE_ID, args, summary: { title: "t" } });
      await expect(call(member, invalid)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call(member, valid)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call(editor, invalid)).rejects.toBeInstanceOf(BadRequestException);
      await expect(call(editor, valid)).resolves.toMatchObject({ approvalId: expect.any(String) });
      // A body may not smuggle route params into the hashed args (design §3.2).
      await expect(call(editor, { ...valid, siteId: SITE_ID })).rejects.toBeInstanceOf(BadRequestException);
      expect(zoneB.seen).toHaveLength(0);
    });
  });
});

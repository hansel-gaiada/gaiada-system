// WSK-63b — the WebDesk control-channel egress client, driven against REAL sockets.
//
// No mocks of `https`: a throwaway CA (openssl, generated per run into a temp dir) issues a server
// cert for 127.0.0.1 and a client cert (CN platform-nest-webdesk); an in-process TLS server with
// `requestCert + rejectUnauthorized` stands in for host nginx + WebDesk, and a plain HTTP stub stands in
// for Keycloak's token endpoint. Needs `openssl` on PATH; no Postgres, no Cerbos, no Redis.
//
// What this file proves (done-when items 3–6 of WSK-63b; 1–2 live in webdesk-ws4-assertion.test.ts
// and webdesk/api/test/ws4-assertion-vectors.spec.ts):
//   * 50 concurrent calls ⇒ exactly ONE token request.
//   * 5 transport failures in 30 s open the breaker; while open, calls throw EditorialUnavailableError
//     with ZERO connections and ZERO token requests; half-open lets one probe through.
//   * No retry on ANY HTTP response.
//   * No secret in errors, `JSON.stringify(client)` or `util.inspect(client)`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { config } from "../../config";
import {
  EditorialUnavailableError,
  WebdeskControlClient,
  WebdeskControlNotConfiguredError,
  WebdeskControlTokenError,
  WebdeskControlTransportError,
  runProbeCli,
  type WebdeskControlClientOptions,
} from "./webdesk-control-client";
import { computeCommandHash } from "./webdesk-ws4-assertion";

const CLIENT_SECRET = "kc-client-secret-0f3e9a7c51d24b88";
const WS4_KEY = "ws4-hmac-key-9b1d6e2f7a4c4e0d";
const TOKEN_PREFIX = "eyJ-access-token-";

// ── Throwaway PKI ────────────────────────────────────────────────────────────────────────────────

let dir = "";
const pem = (name: string): Buffer => readFileSync(join(dir, name));

function openssl(...args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

function issue(name: string, cn: string, caName: string, ext: string): void {
  openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  openssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-out", `${name}.csr`);
  writeFileSync(join(dir, `${name}.ext`), `${ext}\n`);
  openssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${caName}.crt`, "-CAkey", `${caName}.key`, "-CAcreateserial",
    "-days", "2", "-sha256", "-extfile", `${name}.ext`, "-out", `${name}.crt`);
}

function makeCa(name: string, cn: string): void {
  openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  openssl("req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-days", "2", "-sha256",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", `${name}.crt`);
}

// ── Stand-in servers ─────────────────────────────────────────────────────────────────────────────

interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  authorized: boolean;
  peerCN: string | null;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

interface TlsStub {
  server: https.Server;
  port: number;
  seen: SeenRequest[];
  connections: number;
  /** When > 0, the next N TCP connections are destroyed before the TLS handshake. */
  dropNext: number;
  /** When true, EVERY TCP connection is destroyed before the TLS handshake. */
  dropAll: boolean;
  handler: Handler;
}

async function startTlsStub(certName: string, caName: string): Promise<TlsStub> {
  const stub = {} as TlsStub;
  stub.seen = [];
  stub.connections = 0;
  stub.dropNext = 0;
  stub.dropAll = false;
  stub.handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
  const server = https.createServer(
    { key: pem(`${certName}.key`), cert: pem(`${certName}.crt`), ca: pem(`${caName}.crt`), requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const sock = req.socket as import("node:tls").TLSSocket;
        const peer = sock.getPeerCertificate();
        stub.seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body,
          authorized: sock.authorized,
          peerCN: peer && peer.subject ? String(peer.subject.CN) : null,
        });
        stub.handler(req, res, body);
      });
    },
  );
  server.on("connection", (socket: Socket) => {
    stub.connections++;
    if (stub.dropAll || stub.dropNext > 0) {
      if (stub.dropNext > 0) stub.dropNext--;
      socket.destroy();
    }
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.server = server;
  stub.port = (server.address() as AddressInfo).port;
  return stub;
}

interface TokenStub {
  server: http.Server;
  port: number;
  requests: number;
  bodies: string[];
  mode: "ok" | "refuse-echo" | "no-token";
}

async function startTokenStub(): Promise<TokenStub> {
  const stub = { requests: 0, bodies: [], mode: "ok" } as unknown as TokenStub;
  stub.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      stub.requests++;
      const body = Buffer.concat(chunks).toString("utf8");
      stub.bodies.push(body);
      // Slow on purpose: concurrent callers must pile up on the single in-flight request.
      setTimeout(() => {
        if (stub.mode === "refuse-echo") {
          // A hostile/verbose IdP that quotes the request back, secret included.
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized_client", echoed: body }));
          return;
        }
        if (stub.mode === "no-token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ token_type: "Bearer" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `${TOKEN_PREFIX}${stub.requests}`, expires_in: 300, token_type: "Bearer" }));
      }, 40);
    });
  });
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", r));
  stub.port = (stub.server.address() as AddressInfo).port;
  return stub;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

let good: TlsStub;
let rogue: TlsStub;
let token: TokenStub;
const clients: WebdeskControlClient[] = [];

function makeClient(over: Partial<WebdeskControlClientOptions> = {}, port = good.port): WebdeskControlClient {
  const c = new WebdeskControlClient({
    baseUrl: `https://127.0.0.1:${port}`,
    clientCertFile: join(dir, "client.crt"),
    clientKeyFile: join(dir, "client.key"),
    caFile: join(dir, "ca.crt"),
    tokenUrl: `http://127.0.0.1:${token.port}/idp/realms/gaiada/protocol/openid-connect/token`,
    clientId: "webdesk-control",
    clientSecret: CLIENT_SECRET,
    ws4Key: WS4_KEY,
    retryAttempts: 3,
    retryBaseDelayMs: 1,
    timeoutMs: 5_000,
    sleep: async () => undefined,
    ...over,
  });
  clients.push(c);
  return c;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wsk63b-pki-"));
  makeCa("ca", "wsk63b-test-ca");
  issue("server", "control.webdesk.test", "ca", "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth");
  issue("client", "platform-nest-webdesk", "ca", "extendedKeyUsage=clientAuth");
  makeCa("rogueca", "wsk63b-rogue-ca");
  issue("rogue", "control.webdesk.test", "rogueca", "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth");
  good = await startTlsStub("server", "ca");
  rogue = await startTlsStub("rogue", "ca"); // presents a cert from a CA the client does NOT pin
  token = await startTokenStub();
}, 60_000);

afterEach(() => {
  while (clients.length) clients.pop()?.close();
  good.seen.length = 0;
  good.connections = 0;
  good.dropAll = false;
  good.dropNext = 0;
  good.handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
  token.mode = "ok";
});

afterAll(async () => {
  for (const s of [good?.server, rogue?.server, token?.server]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ── Layers 1 + 2 on the wire ─────────────────────────────────────────────────────────────────────

describe("WSK-63b control client — what goes on the wire", () => {
  it("presents the client cert (Layer 1) and a Keycloak bearer (Layer 2), and never the proxy-owned headers", async () => {
    const c = makeClient();
    const res = await c.getContract("acme");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(good.seen).toHaveLength(1);
    const seen = good.seen[0];
    expect(seen.authorized).toBe(true);
    expect(seen.peerCN).toBe("platform-nest-webdesk");
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("/control/v1/tenants/acme/contract");
    expect(seen.headers.authorization).toBe(`Bearer ${TOKEN_PREFIX}${token.requests}`);
    // nginx overwrites the first and adds the second; neither may originate in the ERP.
    expect(seen.headers["x-webdesk-mtls-cert-pem"]).toBeUndefined();
    expect(seen.headers["x-webdesk-control-gate"]).toBeUndefined();
    expect(seen.headers["x-ws4-assertion"]).toBeUndefined();
    // The token request is a client-credentials grant for the configured client.
    const form = new URLSearchParams(token.bodies[token.bodies.length - 1]);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("webdesk-control");
  });

  it("pins the SERVER to the configured CA: a server cert from another CA is refused, and not retried", async () => {
    const c = makeClient({}, rogue.port);
    const err = await c.getContract("acme").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebdeskControlTransportError);
    expect((err as WebdeskControlTransportError).attempts).toBe(1);
    expect((err as WebdeskControlTransportError).maybeDelivered).toBe(false);
    expect(rogue.seen).toHaveLength(0);
  });

  it("50 concurrent calls make exactly ONE token request (single-flight)", async () => {
    const c = makeClient();
    const before = token.requests;
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => c.getContract(`tenant-${i}`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(token.requests - before).toBe(1);
    expect(c.describe().tokenRequests).toBe(1);
    expect(good.seen).toHaveLength(50);
    const bearers = new Set(good.seen.map((s) => s.headers.authorization));
    expect(bearers.size).toBe(1);
    // ...and the cached token keeps serving afterwards.
    await c.getContract("after");
    expect(token.requests - before).toBe(1);
  });

  it("a token-endpoint refusal reaches every concurrent waiter once, and the next call asks again", async () => {
    const c = makeClient();
    token.mode = "refuse-echo";
    const before = token.requests;
    const errs = await Promise.all(Array.from({ length: 10 }, () => c.getContract("acme").catch((e: unknown) => e)));
    expect(errs.every((e) => e instanceof WebdeskControlTokenError)).toBe(true);
    expect(token.requests - before).toBe(1);
    expect(good.connections).toBe(0);
    token.mode = "ok";
    expect((await c.getContract("acme")).status).toBe(200);
    expect(token.requests - before).toBe(2);
  });

  it("a token response without access_token is a token error, not a call with 'Bearer undefined'", async () => {
    const c = makeClient();
    token.mode = "no-token";
    await expect(c.getContract("acme")).rejects.toBeInstanceOf(WebdeskControlTokenError);
    expect(good.seen).toHaveLength(0);
  });
});

// ── WS4 (Layer 4) on the wire ────────────────────────────────────────────────────────────────────

describe("WSK-63b control client — WS4 on a HIGH command", () => {
  it("mints x-ws4-assertion over exactly what WebDesk receives ({...params, ...parsed body})", async () => {
    const c = makeClient();
    const approvalId = "11111111-2222-4333-8444-555555555555";
    const body = { reason: "end of contract", when: new Date("2026-10-10T00:00:00Z"), skipped: undefined, opts: { z: 1, a: [2, 1] } };
    const res = await c.send({
      command: "tenant.archive",
      method: "POST",
      path: "/control/v1/tenants/:tenantSlug/archive",
      params: { tenantSlug: "acme co/ü" },
      body,
      idempotencyKey: "idem-wsk63b-0001",
      ws4: { approvalId },
    });
    expect(res.status).toBe(200);
    const seen = good.seen[0];
    expect(seen.url).toBe(`/control/v1/tenants/${encodeURIComponent("acme co/ü")}/archive`);
    expect(seen.headers["idempotency-key"]).toBe("idem-wsk63b-0001");
    expect(seen.headers["content-type"]).toBe("application/json");
    const header = String(seen.headers["x-ws4-assertion"]);
    const [payload, sig] = header.split(".");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { approvalId: string; commandHash: string; exp: number };
    expect(Object.keys(claims)).toEqual(["approvalId", "commandHash", "exp"]);
    expect(claims.approvalId).toBe(approvalId);
    // What WebDesk's guard hashes: the DECODED route param plus the PARSED body.
    const zoneBArgs = { tenantSlug: decodeURIComponent(seen.url.split("/")[4]), ...JSON.parse(seen.body) };
    expect(claims.commandHash).toBe(computeCommandHash("tenant.archive", zoneBArgs));
    const now = Math.floor(Date.now() / 1000);
    expect(claims.exp - now).toBeGreaterThan(50);
    expect(claims.exp - now).toBeLessThanOrEqual(60);

    // Cross-repo fixture: webdesk/api/test/ws4-assertion-vectors.spec.ts verifies THIS wire header
    // with WebDesk's real verifyWs4Signature when pointed at the file (WSK63B_WS4_FIXTURE_IN).
    const out = process.env.WSK63B_WS4_FIXTURE_OUT;
    if (out) {
      writeFileSync(out, JSON.stringify({ key: WS4_KEY, header, command: "tenant.archive", args: zoneBArgs, approvalId }));
    }
  });

  it("refuses request shapes that would make the hash disagree with WebDesk", async () => {
    const c = makeClient();
    const base = { command: "tenant.archive", method: "POST" as const, path: "/control/v1/tenants/:tenantSlug/archive" };
    await expect(c.send({ ...base, params: {} })).rejects.toThrow(/path param 'tenantSlug' is missing/);
    await expect(c.send({ ...base, params: { tenantSlug: "a", extra: "x" } })).rejects.toThrow(/not in the path template: extra/);
    await expect(c.send({ ...base, params: { tenantSlug: "a" }, body: [] as unknown as Record<string, unknown> })).rejects.toThrow(/plain JSON object/);
    await expect(c.send({ ...base, method: "GET", params: { tenantSlug: "a" }, ws4: { approvalId: "x" } })).rejects.toThrow(/WS4 assertion belongs on a write/);
    await expect(c.send({ ...base, path: "/v1/t/a", params: {} })).rejects.toThrow(/must start with \/control\//);
    await expect(c.send({ ...base, params: { tenantSlug: "a" }, idempotencyKey: "short" })).rejects.toThrow(/idempotencyKey/);
    expect(good.connections).toBe(0);
  });
});

// ── Retries ──────────────────────────────────────────────────────────────────────────────────────

describe("WSK-63b control client — retries: transport only", () => {
  it("never retries an HTTP response, whatever the status, and never counts one toward the breaker", async () => {
    const c = makeClient({ retryAttempts: 3 });
    const statuses = [400, 401, 403, 404, 409, 422, 429, 500, 501, 502, 503, 504];
    for (const status of statuses) {
      good.handler = (_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: `status ${status}` }));
      };
      const before = good.seen.length;
      const res = await c.getContract("acme");
      expect(res.status).toBe(status);
      expect((res.json as { message: string }).message).toBe(`status ${status}`);
      expect(good.seen.length - before, `status ${status} was resent`).toBe(1);
    }
    // 12 non-2xx answers, 0 transport failures: still closed.
    expect(c.describe().breaker).toBe("closed");
  });

  it("a 401 is returned as-is (no resend) and drops the cached token, so the NEXT call fetches a fresh one", async () => {
    const c = makeClient();
    await c.getContract("warm");
    const tokensBefore = c.describe().tokenRequests;
    good.handler = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "control-channel Layer 2 (service token) refused: token expired (exp claim)" }));
    };
    const seenBefore = good.seen.length;
    expect((await c.getContract("acme")).status).toBe(401);
    expect(good.seen.length - seenBefore).toBe(1);
    expect(c.describe().tokenRequests).toBe(tokensBefore);
    good.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    expect((await c.getContract("acme")).status).toBe(200);
    expect(c.describe().tokenRequests).toBe(tokensBefore + 1);
  });

  it("retries a transport failure that happened before the request was delivered (dropped before TLS)", async () => {
    const c2 = makeClient({ retryAttempts: 3 }); // fresh pool: every attempt is a new connection
    good.dropNext = 2;
    const conBefore = good.connections;
    const seenBefore = good.seen.length;
    const res = await c2.getContract("acme");
    expect(res.status).toBe(200);
    expect(good.connections - conBefore).toBe(3);
    expect(good.seen.length - seenBefore).toBe(1);
  });

  it("a WS4-bearing write that died AFTER delivery is NOT resent, and says it may have run", async () => {
    const c = makeClient({ retryAttempts: 3 });
    good.handler = (req) => req.socket.destroy(); // read the whole request, then kill the link
    const err = await c
      .send({
        command: "tenant.archive",
        method: "POST",
        path: "/control/v1/tenants/:tenantSlug/archive",
        params: { tenantSlug: "acme" },
        idempotencyKey: "idem-wsk63b-0002",
        ws4: { approvalId: "aaaaaaaa-0000-4000-8000-000000000001" },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebdeskControlTransportError);
    expect((err as WebdeskControlTransportError).maybeDelivered).toBe(true);
    expect((err as WebdeskControlTransportError).attempts).toBe(1);
    expect(good.seen).toHaveLength(1);
  });

  it("the same post-delivery failure IS retried for a GET, and for an idempotent write without WS4", async () => {
    const c = makeClient({ retryAttempts: 3 });
    let n = 0;
    good.handler = (req, res) => {
      n++;
      if (n === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    expect((await c.getContract("acme")).status).toBe(200);
    expect(good.seen).toHaveLength(2);

    const c2 = makeClient({ retryAttempts: 3 });
    n = 0;
    good.seen.length = 0;
    const res = await c2.send({
      command: "tenant.provision",
      method: "POST",
      path: "/control/v1/tenants",
      body: { slug: "acme", companyRef: "c-1" },
      idempotencyKey: "idem-wsk63b-0003",
    });
    expect(res.status).toBe(200);
    expect(good.seen).toHaveLength(2);
    expect(good.seen[0].headers["idempotency-key"]).toBe(good.seen[1].headers["idempotency-key"]);
  });
});

// ── Circuit breaker ──────────────────────────────────────────────────────────────────────────────

describe("WSK-63b control client — circuit breaker (5 transport failures / 30 s ⇒ open 30 s)", () => {
  it("opens after 5 failures and then short-circuits with EditorialUnavailableError and ZERO network I/O", async () => {
    let now = 1_000_000;
    // A fresh client: no pooled keep-alive socket that could dodge the outage.
    const c = makeClient({ retryAttempts: 1, now: () => now });
    good.dropAll = true;
    const conBefore = good.connections;
    const tokensBefore = token.requests;

    for (let i = 0; i < 5; i++) {
      now += 1_000;
      await expect(c.getContract("acme")).rejects.toBeInstanceOf(WebdeskControlTransportError);
    }
    expect(good.connections - conBefore).toBe(5);
    expect(token.requests - tokensBefore).toBe(1); // fetched once (first call), then cached
    expect(c.describe().breaker).toBe("open");

    // Open: no socket, no token request — 20 calls, zero I/O.
    const tokensAtOpen = token.requests;
    for (let i = 0; i < 20; i++) {
      const err = await c.getContract("acme").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EditorialUnavailableError);
      expect((err as EditorialUnavailableError).status).toBe(503);
    }
    expect(good.connections - conBefore).toBe(5);
    expect(token.requests).toBe(tokensAtOpen);

    // 29 s later: still open.
    now += 29_000;
    await expect(c.getContract("acme")).rejects.toBeInstanceOf(EditorialUnavailableError);
    expect(good.connections - conBefore).toBe(5);

    // 30 s after opening: ONE probe goes through; it fails, so the breaker re-opens at once.
    now += 1_000;
    await expect(c.getContract("acme")).rejects.toBeInstanceOf(WebdeskControlTransportError);
    expect(good.connections - conBefore).toBe(6);
    expect(c.describe().breaker).toBe("open");
    await expect(c.getContract("acme")).rejects.toBeInstanceOf(EditorialUnavailableError);
    expect(good.connections - conBefore).toBe(6);

    // The channel recovers; the next probe succeeds and closes the breaker.
    good.dropAll = false;
    now += 30_000;
    expect((await c.getContract("acme")).status).toBe(200);
    expect(c.describe().breaker).toBe("closed");
    expect((await c.getContract("acme")).status).toBe(200);
  });

  it("counts failures inside a rolling 30 s window: 4 old failures + 1 new one do not open it", async () => {
    let now = 5_000_000;
    const c = makeClient({ retryAttempts: 1, now: () => now });
    good.dropAll = true;
    for (let i = 0; i < 4; i++) {
      now += 100;
      await expect(c.getContract("acme")).rejects.toBeInstanceOf(WebdeskControlTransportError);
    }
    now += 30_001;
    await expect(c.getContract("acme")).rejects.toBeInstanceOf(WebdeskControlTransportError);
    expect(c.describe().breaker).toBe("closed");
    // Four more inside the window ⇒ five recent ⇒ open.
    for (let i = 0; i < 4; i++) {
      now += 100;
      await expect(c.getContract("acme")).rejects.toBeInstanceOf(WebdeskControlTransportError);
    }
    expect(c.describe().breaker).toBe("open");
  });

  it("counts each failed ATTEMPT, so a call's own retries can open it mid-call and stop there", async () => {
    let now = 9_000_000;
    const c = makeClient({ retryAttempts: 3, now: () => now });
    good.dropAll = true;
    const conBefore = good.connections;
    await expect(c.getContract("a")).rejects.toBeInstanceOf(WebdeskControlTransportError); // 3 failures
    now += 10;
    // Attempts 4 and 5 open it; the third attempt of this call is refused without I/O.
    await expect(c.getContract("b")).rejects.toBeInstanceOf(EditorialUnavailableError);
    expect(good.connections - conBefore).toBe(5);
  });
});

// ── Custody ──────────────────────────────────────────────────────────────────────────────────────

describe("WSK-63b control client — no secret leaves through errors, logs or serialization", () => {
  it("JSON.stringify and util.inspect reveal no secret, token or key material", async () => {
    const c = makeClient();
    await c.getContract("acme"); // a live token is now cached inside
    const liveToken = String(good.seen[0].headers.authorization).slice("Bearer ".length);
    const keyPem = readFileSync(join(dir, "client.key"), "utf8");
    const keyBody = keyPem.split("\n")[1];
    for (const rendered of [JSON.stringify(c), inspect(c, { depth: 10, showHidden: true })]) {
      expect(rendered).not.toContain(CLIENT_SECRET);
      expect(rendered).not.toContain(WS4_KEY);
      expect(rendered).not.toContain(liveToken);
      expect(rendered).not.toContain(keyBody);
    }
    expect(JSON.stringify(c)).toBe("{}");
    expect(JSON.stringify(c.describe())).not.toContain(CLIENT_SECRET);
  });

  it("a token endpoint that echoes the request (secret included) does not leak it into the error", async () => {
    const c = makeClient();
    token.mode = "refuse-echo";
    const err = (await c.getContract("acme").catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(WebdeskControlTokenError);
    const rendered = `${err.message}\n${err.stack}\n${JSON.stringify(err)}\n${inspect(err)}`;
    expect(rendered).not.toContain(CLIENT_SECRET);
    expect(rendered).toContain("HTTP 401");
  });

  it("transport errors carry no token, no WS4 key and no assertion", async () => {
    const c = makeClient({ retryAttempts: 1 });
    await c.getContract("warm");
    const liveToken = String(good.seen[0].headers.authorization).slice("Bearer ".length);
    good.handler = (req) => req.socket.destroy();
    const err = (await c
      .send({ command: "tenant.archive", method: "POST", path: "/control/v1/tenants/:tenantSlug/archive", params: { tenantSlug: "acme" }, ws4: { approvalId: "x-1" } })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(WebdeskControlTransportError);
    const assertion = String(good.seen[good.seen.length - 1].headers["x-ws4-assertion"]);
    const rendered = `${err.message}\n${err.stack}\n${JSON.stringify(err)}\n${inspect(err)}`;
    for (const secret of [liveToken, WS4_KEY, CLIENT_SECRET, assertion]) expect(rendered).not.toContain(secret);
  });
});

// ── Fail-closed configuration ────────────────────────────────────────────────────────────────────

describe("WSK-63b control client — fail-closed configuration", () => {
  const full = (): WebdeskControlClientOptions => ({
    baseUrl: `https://127.0.0.1:${good.port}`,
    clientCertFile: join(dir, "client.crt"),
    clientKeyFile: join(dir, "client.key"),
    caFile: join(dir, "ca.crt"),
    tokenUrl: `http://127.0.0.1:${token.port}/token`,
    clientId: "webdesk-control",
    clientSecret: CLIENT_SECRET,
    ws4Key: WS4_KEY,
  });

  it("names every missing variable and never guesses a default", () => {
    const err = (() => {
      try {
        new WebdeskControlClient({ ...full(), baseUrl: "", clientSecret: "", ws4Key: "" });
      } catch (e) {
        return e;
      }
    })() as WebdeskControlNotConfiguredError;
    expect(err).toBeInstanceOf(WebdeskControlNotConfiguredError);
    expect(err.status).toBe(503);
    expect(err.missing).toEqual(["WEBDESK_CONTROL_BASE_URL", "WEBDESK_CONTROL_CLIENT_SECRET", "WEBDESK_CONTROL_WS4_KEY"]);
  });

  it("refuses a plain-http base URL (it would silently drop Layer 1)", () => {
    expect(() => new WebdeskControlClient({ ...full(), baseUrl: `http://127.0.0.1:${good.port}` })).toThrow(/must be https/);
  });

  it("refuses a truncated PEM, a key that does not match the cert, and a cert from another CA — naming files, never contents", () => {
    writeFileSync(join(dir, "truncated.crt"), "-----BEGIN CERTIFICATE-----\n");
    const t = () => new WebdeskControlClient({ ...full(), clientCertFile: join(dir, "truncated.crt") });
    expect(t).toThrow(WebdeskControlNotConfiguredError);
    expect(t).toThrow(/truncated\.crt' is not a complete PEM/);

    const keyBody = readFileSync(join(dir, "server.key"), "utf8").split("\n")[1];
    let msg = "";
    try {
      new WebdeskControlClient({ ...full(), clientKeyFile: join(dir, "server.key") });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/does not match/);
    expect(msg).not.toContain(keyBody);

    expect(() => new WebdeskControlClient({ ...full(), caFile: join(dir, "rogueca.crt") })).toThrow(/not issued by the configured CA/);
    expect(() => new WebdeskControlClient({ ...full(), caFile: join(dir, "nope.crt") })).toThrow(/cannot be read \(ENOENT\)/);
  });
});

// ── The live probe CLI (the orchestrator's one command) ──────────────────────────────────────────

describe("WSK-63b live probe CLI", () => {
  const saved = { ...config.webdeskControl };
  afterEach(() => {
    Object.assign(config.webdeskControl, saved);
  });

  function pointConfigAtStubs(): void {
    Object.assign(config.webdeskControl, {
      baseUrl: `https://127.0.0.1:${good.port}`,
      clientCertFile: join(dir, "client.crt"),
      clientKeyFile: join(dir, "client.key"),
      caFile: join(dir, "ca.crt"),
      tokenUrl: `http://127.0.0.1:${token.port}/token`,
      clientId: "webdesk-control",
      clientSecret: CLIENT_SECRET,
      ws4Key: WS4_KEY,
    });
  }

  it("probe <slug>: one JSON line, exit 0 on a 2xx through all four layers, no secret printed", async () => {
    pointConfigAtStubs();
    const lines: string[] = [];
    const code = await runProbeCli(["probe", "acme"], (l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(out).toMatchObject({ probe: "contract.read", variant: "all-four-layers", ok: true, status: 200 });
    expect(lines[0]).not.toContain(CLIENT_SECRET);
    expect(lines[0]).not.toContain(TOKEN_PREFIX);
    expect(good.seen[good.seen.length - 1].url).toBe("/control/v1/tenants/acme/contract");
  });

  it("probe <slug> --without-client-cert: exit 0 because the server REFUSED it (Layer 1 negative control)", async () => {
    pointConfigAtStubs();
    const lines: string[] = [];
    const seenBefore = good.seen.length;
    const code = await runProbeCli(["probe", "acme", "--without-client-cert"], (l) => lines.push(l));
    expect(code).toBe(0);
    const out = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(out).toMatchObject({ variant: "without-client-cert", refused: true });
    expect(good.seen.length).toBe(seenBefore); // never reached the app
  });

  it("an unconfigured box answers with the missing variables and exit 1, not a crash", async () => {
    Object.assign(config.webdeskControl, { baseUrl: "", clientSecret: "" });
    const lines: string[] = [];
    expect(await runProbeCli(["probe", "acme"], (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toContain("WEBDESK_CONTROL_BASE_URL");
    expect(await runProbeCli([], () => undefined)).toBe(2);
  });
});

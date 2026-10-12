// WSK-63b — the ERP's egress client for the WebDesk control channel (the half WSK-23 never shipped).
// Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §11 (last paragraph), §12 WSK-63b.
// Rulings: webdesk-design-v2.md §14 WSK-D39 / D43 / D47; §03 (ONE A→B channel; no ERP secret ever
// sits on the internet-facing delivery surface).
//
// THE ONLY FILE IN THIS MODULE THAT TALKS TO WEBDESK. `egress-inventory.test.ts` lists it.
//
// ── THE FOUR LAYERS, AND WHICH ONES THIS FILE OWNS ───────────────────────────────────────────────
//   1. mTLS. `node:https.Agent({cert,key,ca,keepAlive,maxSockets:16})`, all three FILE-MOUNTED. The
//      CA pins the SERVER too: nothing here ever sets `rejectUnauthorized:false`. Host nginx
//      (`control.webdesk.internal`, WSK-63a) terminates TLS, verifies our cert and OVERWRITES
//      `x-webdesk-mtls-cert-pem`; it also adds the gate header. This client sends NEITHER header and
//      offers no way for a caller to add arbitrary headers, so a forged value cannot originate here.
//      (WSK-66 added ONE typed slot, `editorialAssertion` → `x-webdesk-editorial-assertion`, shape-
//      checked as a compact JWS; it is the design §5 Layer 2e credential, not a proxy header.)
//   2. A Keycloak client-credentials token (`webdesk-control` client), cached per process with
//      single-flight: 50 concurrent calls make exactly ONE token request (the
//      `core/keycloak-admin.ts` precedent, made per-instance instead of module-level).
//   3. Scopes. Decided by WebDesk from the token; nothing to do here.
//   4. WS4, for HIGH commands: `webdesk-ws4-assertion.ts`, byte-identical to WebDesk's verifier. The
//      hash covers `{...params, ...body}` exactly as WebDesk's guard sees them (that file's header).
//      M4 F1: v2 (Ed25519 JWS) when a WS4 signing key is configured (`ws4Signing`), else v1 (HMAC,
//      `ws4Key`). A kid that is set but whose key is unusable (`ws4SigningError`) makes every
//      WS4-bearing call answer 503 BEFORE any I/O; it never falls back to v1 silently.
//
// ── RETRIES: TRANSPORT ERRORS ONLY (the `contract-fetch-http.ts` / `provision-http.ts` doctrine) ──
// An HTTP response is an ANSWER, whatever its status, and is returned to the caller as data. It is
// never retried; that includes 401 (we drop the cached token so the NEXT call fetches a fresh one,
// but we do not resend) and 5xx. Transport failures are retried with backoff, but only when a
// resend cannot double an effect:
//   * the request provably never reached the far side (failed before it was fully written, or the
//     classic keep-alive race: ECONNRESET on a REUSED socket) → retried for any method;
//   * the request was fully written and then the link died (the AMBIGUOUS case) → retried only for
//     GET/HEAD, or for a write that carries an Idempotency-Key and NO WS4 assertion (WebDesk dedups
//     it). A WS4-bearing write is never resent after an ambiguous failure: its approval is
//     single-use, so the resend could only come back as a replay refusal that hides whether the
//     first one ran. It surfaces as `WebdeskControlTransportError` with `maybeDelivered: true`.
//   * TLS certificate errors are deterministic, so they are not retried (they still count below).
//
// ── CIRCUIT BREAKER (§11) ────────────────────────────────────────────────────────────────────────
// 5 transport failures (counted per attempt) within 30 s open it for 30 s. While open, every call
// throws `EditorialUnavailableError` BEFORE any I/O: no token request, no socket. After 30 s ONE
// probe call is let through (half-open); success closes it, failure re-opens it for another 30 s.
// HTTP answers never count as failures: a 503 from WebDesk is a reachable channel. That error drives
// the UI's "editorial unavailable" state.
//
// ── CUSTODY ──────────────────────────────────────────────────────────────────────────────────────
// Every secret and the TLS agent (whose options hold the private key) sit in `#private` fields, so
// `JSON.stringify(client)` and `util.inspect(client)` reveal nothing (`contract-fetch-http.ts`'s
// precedent: TS `private` is compile-time only). No error message echoes a response body from the
// token endpoint (it can quote the request, which holds the client secret), and every message passes
// `redact()`. This file logs breaker state changes only, never a header or a body.
//
// ── TENANCY ──────────────────────────────────────────────────────────────────────────────────────
// This client is a single service principal with NO ambient company scope. It never decides whether
// an actor may touch a WebDesk tenant: callers (the WSK-59 BFF, WSK-66's approved-command executor)
// authorize the actor against Cerbos for that tenant FIRST and pass the tenant explicitly as a path
// param. There is no "default tenant" here.
//
// ── THE LIVE PROBE (WSK-63b done-when item 7; run by the orchestrator once the box steps are done) ─
// Inside the running platform container (compiled to dist/):
//   node dist/modules/webdev/webdesk-control-client.js probe <tenantSlug>
//       → GET /control/v1/tenants/<tenantSlug>/contract through all four layers; prints one JSON
//         line; exit 0 iff a 2xx came back.
//   node dist/modules/webdev/webdesk-control-client.js probe <tenantSlug> --without-client-cert
//       → the same call with the CA but NO client cert; exit 0 iff it was REFUSED (TLS handshake
//         failure or a 4xx, i.e. Layer 1). Never prints a secret, a token or a header.
import * as https from "node:https";
import { readFileSync } from "node:fs";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { Logger } from "@nestjs/common";
import { config } from "../../config";
import { commandArgsAsZoneBSeesThem, loadWs4SigningKey, mintWs4ForCommand, type Ws4SigningKey } from "./webdesk-ws4-assertion";

type FetchImpl = typeof fetch;

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

/** Deployment state, not a caller error: a 503 naming what is missing. Never a half-attempt. */
export class WebdeskControlNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = "webdesk_control_not_configured";
  constructor(readonly missing: string[], detail?: string) {
    super(
      `WebDesk control channel is not configured${missing.length ? `: missing ${missing.join(", ")}` : ""}` +
        `${detail ? ` (${detail})` : ""}. See config.ts's webdeskControl block and infra/compose/.env.example.`,
    );
    this.name = "WebdeskControlNotConfiguredError";
  }
}

/** The breaker is open: the channel failed repeatedly and is being given time. No I/O was attempted. */
export class EditorialUnavailableError extends Error {
  readonly status = 503;
  readonly code = "editorial_unavailable";
  constructor(readonly retryAfterMs: number) {
    super(`WebDesk editorial channel is unavailable (circuit open); retry in ~${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "EditorialUnavailableError";
  }
}

/** DNS/TCP/TLS/timeout, after any retries this file allowed. 502: it arrived from across a boundary. */
export class WebdeskControlTransportError extends Error {
  readonly status = 502;
  readonly code = "webdesk_control_transport";
  constructor(
    message: string,
    readonly attempts: number,
    /** true when the last attempt was fully written before the link failed: it MAY have executed. */
    readonly maybeDelivered: boolean,
    readonly transportCode: string | null,
  ) {
    super(message);
    this.name = "WebdeskControlTransportError";
  }
}

/** The Keycloak token endpoint refused or answered unusably. Never carries its response body. */
export class WebdeskControlTokenError extends Error {
  readonly status = 502;
  readonly code = "webdesk_control_token";
  constructor(readonly httpStatus: number | null, detail: string) {
    super(`WebDesk control token request failed${httpStatus === null ? "" : ` (HTTP ${httpStatus})`}: ${detail}`);
    this.name = "WebdeskControlTokenError";
  }
}

// ── Public shapes ────────────────────────────────────────────────────────────────────────────────

export type WebdeskControlMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface WebdeskControlRequest {
  /** WebDesk's CommandName (`command-types.ts`), e.g. `contract.read`. Hashed into WS4. */
  command: string;
  method: WebdeskControlMethod;
  /** Route template with WebDesk's OWN param names, e.g. `/control/v1/tenants/:tenantSlug/contract`. */
  path: string;
  /** Every `:name` in `path`, and nothing else (a stray param would never reach WebDesk's
   *  `request.params`, and the WS4 hash would then disagree). */
  params?: Record<string, string>;
  /** Query string (reads only): WSK-59 added this for `tenant.list?companyRef=` (REQUIRED by Zone B) and
   *  the item-list filters. Values are strings, appended with `URLSearchParams` (so they are encoded, never
   *  concatenated). It is NOT part of the WS4/editorial command hash: Zone B hashes `{...params, ...body}`
   *  only (see `webdesk-ws4-assertion.ts`), so a query can never move a signature. A write may not carry one. */
  query?: Record<string, string>;
  /** JSON body (a plain object). Omitted ⇒ no body is sent. */
  body?: Record<string, unknown>;
  /** WebDesk requires one on mutating commands; also what makes an ambiguous write safe to resend. */
  idempotencyKey?: string;
  /** Present ⇒ an `x-ws4-assertion` is minted for this exact command + args (HIGH commands). */
  ws4?: { approvalId: string };
  /** WSK-66: the compact JWS for `x-webdesk-editorial-assertion` (design §5), already signed by the
   *  caller's `EditorialAssertionSigner` (WSK-40) over `commandArgsAsZoneBSeesThem(params, body)`.
   *  The ONE named header slot a caller may fill; there is still no way to add an arbitrary header,
   *  so the proxy-owned headers (`x-webdesk-mtls-cert-pem`, the gate header) cannot originate here.
   *  Only on writes, and redacted from every error message like the other credentials. */
  editorialAssertion?: string;
  /** M6-P4j: a read whose answer is raw bytes (a contract artifact), not JSON. Sends an any-type accept header instead of
   *  `application/json` and lifts the response cap from 8 MiB to `MAX_BINARY_RESPONSE_BYTES` for this call only.
   *  Reads only. A typed flag, not a header slot: there is still no way to add an arbitrary header. */
  binaryResponse?: boolean;
}

export interface WebdeskControlResponse {
  status: number;
  contentType: string | null;
  /** Parsed JSON when the response says JSON and parses; otherwise null. */
  json: unknown;
  bodyText: string;
  /** M6-P4j: the response body exactly as received (`bodyText` is its lossy UTF-8 decoding). Every response the
   *  real client returns carries it; it is optional in the type only so test doubles that predate it still compile. */
  bodyBytes?: Buffer;
}

export interface WebdeskControlClientOptions {
  baseUrl: string;
  clientCertFile: string;
  clientKeyFile: string;
  caFile: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  tokenScope?: string;
  /** v1 HMAC key (WEBDESK_CONTROL_WS4_KEY). May be empty once a v2 signing key is configured. */
  ws4Key: string;
  /** M4 F1: the v2 Ed25519 signing key. When present, every WS4 assertion is minted as v2. */
  ws4Signing?: Ws4SigningKey;
  /** M4 F1: why a configured v2 signing kid could not be honoured. Present → WS4-bearing calls answer 503. */
  ws4SigningError?: string;
  ws4TtlSec?: number;
  timeoutMs?: number;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  maxSockets?: number;
  breakerThreshold?: number;
  breakerWindowMs?: number;
  breakerOpenMs?: number;
  /** Test seams. Production passes none of these. `fetchImpl` is used for the TOKEN endpoint only. */
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** M6-P4j: the cap for a `binaryResponse` call; matches WebDesk's `MAX_CONTRACT_ARTIFACT_BYTES`. */
export const MAX_BINARY_RESPONSE_BYTES = 25 * 1024 * 1024;
const TOKEN_SKEW_MS = 30_000;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{8,200}$/;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Strip anything credential-shaped out of a string bound for an error or a log. */
function redact(text: string, secrets: ReadonlyArray<string | null | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

// ── TLS material ─────────────────────────────────────────────────────────────────────────────────

function readPemFile(envName: string, path: string, marker: RegExp): Buffer {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    throw new WebdeskControlNotConfiguredError([], `${envName}='${path}' cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  // Shape check, the WebDesk `validateCaPemShape` lesson: a truncated PEM must fail LOUDLY here, not
  // as a confusing handshake error later. The message names the file, never its contents.
  if (!marker.test(buf.toString("utf8"))) {
    throw new WebdeskControlNotConfiguredError([], `${envName}='${path}' is not a complete PEM (${buf.length} bytes)`);
  }
  return buf;
}

interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

function loadTlsMaterial(o: Pick<WebdeskControlClientOptions, "clientCertFile" | "clientKeyFile" | "caFile">): TlsMaterial {
  const cert = readPemFile("WEBDESK_CONTROL_CLIENT_CERT_FILE", o.clientCertFile, /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/);
  const key = readPemFile("WEBDESK_CONTROL_CLIENT_KEY_FILE", o.clientKeyFile, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/);
  const ca = readPemFile("WEBDESK_CONTROL_CA_FILE", o.caFile, /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/);
  try {
    const x509 = new X509Certificate(cert);
    const caX509 = new X509Certificate(ca);
    if (!x509.checkPrivateKey(createPrivateKey(key))) {
      throw new Error("client key does not match the client certificate");
    }
    if (!x509.checkIssued(caX509)) {
      throw new Error("client certificate was not issued by the configured CA");
    }
  } catch (err) {
    if (err instanceof WebdeskControlNotConfiguredError) throw err;
    // The crypto error text names a reason ("bad decrypt", "no start line"), never key bytes.
    throw new WebdeskControlNotConfiguredError([], `TLS material rejected: ${(err as Error).message}`);
  }
  return { cert, key, ca };
}

// ── Token cache (single-flight) ──────────────────────────────────────────────────────────────────

class ClientCredentialsTokenCache {
  readonly #tokenUrl: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #scope: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchImpl;
  readonly #now: () => number;
  #cached: { token: string; refreshAt: number } | null = null;
  #inFlight: Promise<string> | null = null;
  #requests = 0;

  constructor(o: { tokenUrl: string; clientId: string; clientSecret: string; scope: string; timeoutMs: number; fetchImpl: FetchImpl; now: () => number }) {
    this.#tokenUrl = o.tokenUrl;
    this.#clientId = o.clientId;
    this.#clientSecret = o.clientSecret;
    this.#scope = o.scope;
    this.#timeoutMs = o.timeoutMs;
    this.#fetch = o.fetchImpl;
    this.#now = o.now;
  }

  /** Token requests issued so far (observability + the single-flight proof). */
  get requestCount(): number {
    return this.#requests;
  }

  /** The current token, for redaction only. */
  get current(): string | null {
    return this.#cached?.token ?? null;
  }

  invalidate(): void {
    this.#cached = null;
  }

  get(): Promise<string> {
    if (this.#cached && this.#cached.refreshAt > this.#now()) return Promise.resolve(this.#cached.token);
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#fetchToken().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #fetchToken(): Promise<string> {
    this.#requests++;
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: this.#clientId, client_secret: this.#clientSecret });
    if (this.#scope) form.set("scope", this.#scope);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.#tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      throw new WebdeskControlTokenError(null, `token endpoint unreachable (${e.cause?.code ?? e.name})`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Deliberately does NOT echo the body: a token-endpoint error can quote the request, and the
      // request contains the client secret. The body is drained so the socket can be reused.
      await res.text().catch(() => "");
      throw new WebdeskControlTokenError(res.status, "token endpoint refused the client-credentials grant");
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new WebdeskControlTokenError(res.status, "response had no access_token");
    }
    const ttlMs = (typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60) * 1000;
    // Refresh early so a request never races its own token's death; a very short-lived token
    // refreshes at half-life instead of never being cacheable.
    const skew = Math.min(TOKEN_SKEW_MS, ttlMs / 2);
    this.#cached = { token: body.access_token, refreshAt: this.#now() + ttlMs - skew };
    return body.access_token;
  }
}

// ── Circuit breaker ──────────────────────────────────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half-open";

class CircuitBreaker {
  #state: BreakerState = "closed";
  #failures: number[] = [];
  #openUntil = 0;
  #probeInFlight = false;

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly openMs: number,
    private readonly now: () => number,
    private readonly onChange: (from: BreakerState, to: BreakerState) => void,
  ) {}

  get state(): BreakerState {
    return this.#state;
  }

  #set(to: BreakerState): void {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.onChange(from, to);
  }

  /** null ⇒ go ahead; a number ⇒ refused, retry after that many ms. Never performs I/O. */
  admit(): number | null {
    const now = this.now();
    if (this.#state === "open") {
      if (now < this.#openUntil) return this.#openUntil - now;
      this.#set("half-open");
    }
    if (this.#state === "half-open") {
      if (this.#probeInFlight) return Math.max(1, this.openMs);
      this.#probeInFlight = true;
    }
    return null;
  }

  /** The admitted attempt ended without touching the channel (e.g. the token request failed). */
  release(): void {
    this.#probeInFlight = false;
  }

  success(): void {
    this.#probeInFlight = false;
    if (this.#state !== "closed") {
      this.#failures = [];
      this.#set("closed");
    }
  }

  failure(): void {
    const now = this.now();
    this.#probeInFlight = false;
    if (this.#state === "half-open") {
      this.#open(now);
      return;
    }
    this.#failures = this.#failures.filter((t) => now - t < this.windowMs);
    this.#failures.push(now);
    if (this.#failures.length >= this.threshold) this.#open(now);
  }

  #open(now: number): void {
    this.#failures = [];
    this.#openUntil = now + this.openMs;
    this.#set("open");
  }
}

// ── One attempt ──────────────────────────────────────────────────────────────────────────────────

interface AttemptFailure {
  error: Error & { code?: string };
  /** The request was fully written before the failure: it MAY have executed. */
  delivered: boolean;
}

function isTlsCertificateError(code: string | undefined): boolean {
  if (!code) return false;
  return code.startsWith("ERR_TLS_") || /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code);
}

// ── The client ───────────────────────────────────────────────────────────────────────────────────

export class WebdeskControlClient {
  readonly #base: URL;
  readonly #agent: https.Agent;
  readonly #ca: Buffer;
  readonly #tokens: ClientCredentialsTokenCache;
  readonly #breaker: CircuitBreaker;
  readonly #clientSecret: string;
  readonly #ws4Key: string;
  readonly #ws4Signing: Ws4SigningKey | undefined;
  readonly #ws4SigningError: string | undefined;
  readonly #ws4TtlSec: number;
  readonly #timeoutMs: number;
  readonly #retryAttempts: number;
  readonly #retryBaseDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #logger = new Logger("WebdeskControlClient");

  constructor(o: WebdeskControlClientOptions) {
    const missing = [
      ...(o.baseUrl ? [] : ["WEBDESK_CONTROL_BASE_URL"]),
      ...(o.clientCertFile ? [] : ["WEBDESK_CONTROL_CLIENT_CERT_FILE"]),
      ...(o.clientKeyFile ? [] : ["WEBDESK_CONTROL_CLIENT_KEY_FILE"]),
      ...(o.caFile ? [] : ["WEBDESK_CONTROL_CA_FILE"]),
      ...(o.tokenUrl ? [] : ["WEBDESK_CONTROL_TOKEN_URL"]),
      ...(o.clientId ? [] : ["WEBDESK_CONTROL_CLIENT_ID"]),
      ...(o.clientSecret ? [] : ["WEBDESK_CONTROL_CLIENT_SECRET"]),
      // Either WS4 version satisfies Layer 4 (M4 F1). A set-but-unusable v2 kid also counts as configured
      // here: the channel stays up for reads and non-HIGH writes, and only WS4-bearing calls answer 503.
      ...(o.ws4Key || o.ws4Signing || o.ws4SigningError ? [] : ["WEBDESK_CONTROL_WS4_KEY"]),
    ];
    if (missing.length) throw new WebdeskControlNotConfiguredError(missing);

    let base: URL;
    try {
      base = new URL(o.baseUrl);
    } catch {
      throw new WebdeskControlNotConfiguredError([], "WEBDESK_CONTROL_BASE_URL is not a URL");
    }
    // mTLS is the whole point of Layer 1: a plain-http base URL would silently drop it.
    if (base.protocol !== "https:") {
      throw new WebdeskControlNotConfiguredError([], "WEBDESK_CONTROL_BASE_URL must be https:// (Layer 1 is mTLS)");
    }
    this.#base = base;

    const tls = loadTlsMaterial(o);
    this.#ca = tls.ca;
    this.#agent = new https.Agent({
      cert: tls.cert,
      key: tls.key,
      ca: tls.ca,
      keepAlive: true,
      maxSockets: o.maxSockets ?? 16,
      // Explicit, so no future refactor can "temporarily" turn server verification off.
      rejectUnauthorized: true,
    });

    this.#now = o.now ?? Date.now;
    this.#sleep = o.sleep ?? defaultSleep;
    this.#timeoutMs = o.timeoutMs ?? 15_000;
    this.#retryAttempts = Math.max(1, Math.floor(o.retryAttempts ?? 3));
    this.#retryBaseDelayMs = o.retryBaseDelayMs ?? 250;
    this.#clientSecret = o.clientSecret;
    this.#ws4Key = o.ws4Key;
    this.#ws4Signing = o.ws4Signing;
    this.#ws4SigningError = o.ws4SigningError;
    this.#ws4TtlSec = o.ws4TtlSec ?? 60;
    this.#tokens = new ClientCredentialsTokenCache({
      tokenUrl: o.tokenUrl,
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      scope: o.tokenScope ?? "",
      timeoutMs: this.#timeoutMs,
      fetchImpl: o.fetchImpl ?? fetch,
      now: this.#now,
    });
    this.#breaker = new CircuitBreaker(
      o.breakerThreshold ?? 5,
      o.breakerWindowMs ?? 30_000,
      o.breakerOpenMs ?? 30_000,
      this.#now,
      (from, to) => this.#logger.warn(`circuit ${from} -> ${to}`),
    );
  }

  /** Non-secret diagnostics. Safe to log. */
  describe(): { origin: string; breaker: BreakerState; tokenRequests: number } {
    return { origin: this.#base.origin, breaker: this.#breaker.state, tokenRequests: this.#tokens.requestCount };
  }

  /** Close idle keep-alive sockets (process shutdown, tests). */
  close(): void {
    this.#agent.destroy();
  }

  /** `GET /control/v1/tenants/:tenantSlug/contract` (contract.read, a read: no WS4). */
  getContract(tenantSlug: string): Promise<WebdeskControlResponse> {
    return this.send({
      command: "contract.read",
      method: "GET",
      path: "/control/v1/tenants/:tenantSlug/contract",
      params: { tenantSlug },
    });
  }

  /** M6-P4j (WSK-D81): `GET /control/v1/tenants/:tenantSlug/contract/:contractVersion/artifacts/:artifact`
   *  (still `contract.read`, a read: no WS4). The artifact's raw bytes are in `bodyBytes` of a 2xx answer.
   *  `artifact` is one of `openapi | sdkTs | sdkPhp | contractMd | blockLibrary`; WebDesk answers 400 otherwise. */
  getContractArtifact(tenantSlug: string, contractVersion: string, artifact: string): Promise<WebdeskControlResponse> {
    return this.send({
      command: "contract.read",
      method: "GET",
      path: "/control/v1/tenants/:tenantSlug/contract/:contractVersion/artifacts/:artifact",
      params: { tenantSlug, contractVersion, artifact },
      binaryResponse: true,
    });
  }

  /** Send one command over the channel. Resolves with ANY HTTP answer; rejects only with the four
   *  error classes above (or a programming error in the request shape). */
  async send(req: WebdeskControlRequest): Promise<WebdeskControlResponse> {
    const prepared = this.#prepare(req);
    if (req.ws4) {
      // M4 F1, before any I/O: a v2 kid was configured but its key is unusable. Never fall back to v1.
      if (this.#ws4SigningError !== undefined) throw new WebdeskControlNotConfiguredError([], `WS4 v2 signing key: ${this.#ws4SigningError}`);
      if (!this.#ws4Signing && !this.#ws4Key) throw new WebdeskControlNotConfiguredError(["WEBDESK_CONTROL_WS4_SIGNING_KID", "WEBDESK_CONTROL_WS4_KEY"]);
    }

    const refusedFor = this.#breaker.admit();
    if (refusedFor !== null) throw new EditorialUnavailableError(refusedFor);

    let token: string;
    try {
      token = await this.#tokens.get();
    } catch (err) {
      this.#breaker.release();
      throw err;
    }

    const headers: Record<string, string> = {
      accept: req.binaryResponse ? "*/*" : "application/json",
      authorization: `Bearer ${token}`,
    };
    if (prepared.bodyText !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(prepared.bodyText));
    } else if (req.method !== "GET" && req.method !== "HEAD") {
      headers["content-length"] = "0";
    }
    if (req.idempotencyKey !== undefined) headers["idempotency-key"] = req.idempotencyKey;
    if (req.ws4) {
      // Minted ONCE per logical call: a resend (when one is allowed at all) carries the same approval.
      headers["x-ws4-assertion"] = mintWs4ForCommand({
        key: this.#ws4Key,
        signing: this.#ws4Signing,
        approvalId: req.ws4.approvalId,
        command: req.command,
        args: prepared.args,
        nowSec: Math.floor(this.#now() / 1000),
        ttlSec: this.#ws4TtlSec,
      });
    }
    if (req.editorialAssertion !== undefined) headers["x-webdesk-editorial-assertion"] = req.editorialAssertion;

    const safeMethod = req.method === "GET" || req.method === "HEAD";
    // WSK-59: an editorial assertion carries a single-use `jti` that Zone B consumes on the FIRST delivery,
    // exactly like a WS4 approval. A resend after an ambiguous failure could only come back 401
    // `editorial-assertion-replayed`, which hides whether the first attempt landed. So it follows the WS4
    // rule: never resent once it may have been delivered (the caller reconciles by reading).
    const ambiguousIsSafe = safeMethod || (req.idempotencyKey !== undefined && !req.ws4 && req.editorialAssertion === undefined);

    let last: AttemptFailure | null = null;
    let attempt = 0;
    while (attempt < this.#retryAttempts) {
      if (attempt > 0) {
        const wait = this.#breaker.admit();
        if (wait !== null) throw new EditorialUnavailableError(wait);
      }
      attempt++;
      try {
        const res = await this.#attempt(req.method, prepared.url, headers, prepared.bodyText, req.binaryResponse ? MAX_BINARY_RESPONSE_BYTES : MAX_RESPONSE_BYTES);
        this.#breaker.success();
        // An answer, never retried. A 401 means our token died early (realm restart, key rotation):
        // drop it so the NEXT call fetches a fresh one.
        if (res.status === 401) this.#tokens.invalidate();
        return res;
      } catch (failure) {
        last = failure as AttemptFailure;
        this.#breaker.failure();
        const code = last.error.code;
        const retryable = !isTlsCertificateError(code) && (!last.delivered || ambiguousIsSafe);
        if (!retryable || attempt >= this.#retryAttempts) break;
        await this.#sleep(this.#retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    const f = last as AttemptFailure;
    const msg = redact(
      `webdesk-control ${req.command} (${req.method} ${req.path}) failed after ${attempt} attempt(s): ` +
        `${f.error.code ?? f.error.name}: ${f.error.message}`,
      [token, this.#tokens.current, this.#clientSecret, this.#ws4Key, headers["x-ws4-assertion"], headers["x-webdesk-editorial-assertion"]],
    );
    throw new WebdeskControlTransportError(msg, attempt, f.delivered, f.error.code ?? null);
  }

  #prepare(req: WebdeskControlRequest): { url: URL; args: Record<string, unknown>; bodyText: string | null } {
    if (!req.command) throw new Error("webdesk-control: command is required");
    if (!req.path.startsWith("/control/")) throw new Error("webdesk-control: path must start with /control/");
    if (req.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(req.idempotencyKey)) {
      throw new Error("webdesk-control: idempotencyKey must be 8..200 printable ASCII characters");
    }
    if (req.body !== undefined && (req.body === null || typeof req.body !== "object" || Array.isArray(req.body))) {
      throw new Error("webdesk-control: body must be a plain JSON object");
    }
    if (req.ws4 && (req.method === "GET" || req.method === "HEAD")) {
      throw new Error("webdesk-control: a WS4 assertion belongs on a write, not a read");
    }
    if (req.editorialAssertion !== undefined) {
      if (req.method === "GET" || req.method === "HEAD") {
        throw new Error("webdesk-control: an editorial assertion belongs on a write, not a read");
      }
      // A compact JWS is three base64url segments; anything else (a newline above all) would be a
      // header-injection vector, so it is refused before any I/O.
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/.test(req.editorialAssertion) || req.editorialAssertion.length > 8192) {
        throw new Error("webdesk-control: editorialAssertion must be a compact JWS");
      }
    }
    if (req.binaryResponse && req.method !== "GET") throw new Error("webdesk-control: a binary response belongs on a read, not a write");
    if (req.query !== undefined) {
      if (req.method !== "GET") throw new Error("webdesk-control: a query string belongs on a read, not a write");
      if (req.query === null || typeof req.query !== "object" || Array.isArray(req.query)) {
        throw new Error("webdesk-control: query must be a plain object of strings");
      }
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v !== "string") throw new Error(`webdesk-control: query value '${k}' must be a string`);
      }
    }
    const params = req.params ?? {};
    const used = new Set<string>();
    const path = req.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
      const v = params[name];
      if (typeof v !== "string" || v.length === 0) throw new Error(`webdesk-control: path param '${name}' is missing`);
      used.add(name);
      return encodeURIComponent(v);
    });
    const stray = Object.keys(params).filter((k) => !used.has(k));
    if (stray.length) throw new Error(`webdesk-control: params not in the path template: ${stray.join(", ")}`);

    const basePath = this.#base.pathname.replace(/\/+$/, "");
    const url = new URL(this.#base.origin);
    url.pathname = `${basePath}${path}`;
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const bodyText = req.body === undefined ? null : JSON.stringify(req.body);
    return { url, args: commandArgsAsZoneBSeesThem(params, req.body), bodyText };
  }

  #attempt(method: string, url: URL, headers: Record<string, string>, bodyText: string | null, maxResponseBytes: number): Promise<WebdeskControlResponse> {
    return new Promise<WebdeskControlResponse>((resolve, reject) => {
      let flushed = false;
      let settled = false;
      const fail = (error: Error & { code?: string }, delivered: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject({ error, delivered } satisfies AttemptFailure);
      };

      const req = https.request(url, { method, headers, agent: this.#agent }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxResponseBytes) {
            res.destroy(Object.assign(new Error(`response exceeded ${maxResponseBytes} bytes`), { code: "WEBDESK_CONTROL_RESPONSE_TOO_LARGE" }));
            return;
          }
          chunks.push(c);
        });
        res.on("error", (err: Error & { code?: string }) => fail(err, true));
        res.on("aborted", () => fail(Object.assign(new Error("response aborted"), { code: "ECONNRESET" }), true));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const bodyBytes = Buffer.concat(chunks);
          const bodyText = bodyBytes.toString("utf8");
          const contentType = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null;
          let json: unknown = null;
          if (contentType && /\bjson\b/i.test(contentType) && bodyText.length > 0) {
            try {
              json = JSON.parse(bodyText);
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, contentType, json, bodyText, bodyBytes });
        });
      });

      // One deadline for the whole exchange (connect + TLS + response), not just socket idleness.
      const timer = setTimeout(() => {
        req.destroy(Object.assign(new Error(`no complete answer within ${this.#timeoutMs}ms`), { code: "WEBDESK_CONTROL_TIMEOUT" }));
      }, this.#timeoutMs);

      // "Delivered" needs BOTH: the request fully handed to the socket ('finish') AND a completed TLS
      // handshake. 'finish' alone can fire while bytes merely sit in the buffer of a socket that is
      // still connecting; if the handshake never completed, the far side's app never saw a byte.
      let handshakeDone = false;
      req.on("socket", (socket) => {
        if (req.reusedSocket) handshakeDone = true;
        else socket.once("secureConnect", () => {
          handshakeDone = true;
        });
      });
      req.on("finish", () => {
        flushed = true;
      });
      req.on("error", (err: Error & { code?: string }) => {
        // The keep-alive race: the far side closed an idle pooled socket just as we reused it. The
        // request never reached a live connection, so it is treated as not delivered (Node's own
        // documented retry case for `request.reusedSocket`).
        const staleReuse = req.reusedSocket && err.code === "ECONNRESET";
        fail(err, flushed && handshakeDone && !staleReuse);
      });

      if (bodyText !== null) req.end(bodyText);
      else req.end();
    });
  }

  /**
   * The Layer-1 negative control for the live probe: the same contract read with the pinned CA but NO
   * client certificate, on a one-shot non-pooled connection. Expected outcome: refused.
   */
  async probeWithoutClientCert(tenantSlug: string): Promise<{ refused: boolean; detail: string; status: number | null }> {
    const { url } = this.#prepare({ command: "contract.read", method: "GET", path: "/control/v1/tenants/:tenantSlug/contract", params: { tenantSlug } });
    return new Promise((resolve) => {
      const req = https.request(url, { method: "GET", ca: this.#ca, agent: false, rejectUnauthorized: true, timeout: this.#timeoutMs }, (res) => {
        res.resume();
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ refused: status >= 400, detail: `HTTP ${status}`, status });
        });
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "WEBDESK_CONTROL_TIMEOUT" })));
      req.on("error", (err: Error & { code?: string }) => resolve({ refused: true, detail: `${err.code ?? err.name}: ${err.message}`, status: null }));
      req.end();
    });
  }
}

// ── Factory + process singleton ──────────────────────────────────────────────────────────────────

/** M4 F1: the v2 signing key from config, as client options. Read once, when the client is built. */
function ws4SigningFromConfig(keyFile: string, kid: string): Pick<WebdeskControlClientOptions, "ws4Signing" | "ws4SigningError"> {
  const loaded = loadWs4SigningKey({ keyFile, kid });
  const log = new Logger("WebdeskControlClient");
  if (loaded.state === "configured") {
    log.log(`WS4 assertions: v2 (EdDSA, kid ${loaded.signing.kid})`);
    return { ws4Signing: loaded.signing };
  }
  if (loaded.state === "invalid") {
    log.error(`WS4 v2 signing key NOT usable (${loaded.reason}); every WS4-bearing WebDesk call answers 503 unsent`);
    return { ws4SigningError: loaded.reason };
  }
  return {};
}

/** Build a client from `config.webdeskControl`, or throw `WebdeskControlNotConfiguredError`. */
export function createWebdeskControlClient(overrides: Partial<WebdeskControlClientOptions> = {}): WebdeskControlClient {
  const c = config.webdeskControl;
  return new WebdeskControlClient({
    baseUrl: c.baseUrl,
    clientCertFile: c.clientCertFile,
    clientKeyFile: c.clientKeyFile,
    caFile: c.caFile,
    tokenUrl: c.tokenUrl,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    tokenScope: c.tokenScope,
    ws4Key: c.ws4Key,
    ...ws4SigningFromConfig(c.ws4SigningKeyFile, c.ws4SigningKid),
    ws4TtlSec: c.ws4TtlSec,
    timeoutMs: c.timeoutMs,
    retryAttempts: c.retryAttempts,
    retryBaseDelayMs: c.retryBaseDelayMs,
    maxSockets: c.maxSockets,
    breakerThreshold: c.breakerThreshold,
    breakerWindowMs: c.breakerWindowMs,
    breakerOpenMs: c.breakerOpenMs,
    ...overrides,
  });
}

let singleton: WebdeskControlClient | null = null;

/** One client per process: one keep-alive pool, one token cache, one breaker. Lazy, so a box without
 *  the channel boots normally and only the calls that need it answer 503. */
export function getWebdeskControlClient(): WebdeskControlClient {
  if (!singleton) singleton = createWebdeskControlClient();
  return singleton;
}

/** Tests only. */
export function resetWebdeskControlClientForTests(): void {
  singleton?.close();
  singleton = null;
}

// ── CLI: the live probe (see the header) ─────────────────────────────────────────────────────────

export async function runProbeCli(argv: string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const [verb, tenantSlug, ...flags] = argv;
  if (verb !== "probe" || !tenantSlug) {
    out(JSON.stringify({ error: "usage: webdesk-control-client.js probe <tenantSlug> [--without-client-cert]" }));
    return 2;
  }
  const withoutCert = flags.includes("--without-client-cert");
  let client: WebdeskControlClient;
  try {
    client = createWebdeskControlClient({ retryAttempts: 1 });
  } catch (err) {
    out(JSON.stringify({ probe: "contract.read", ok: false, error: (err as Error).message }));
    return 1;
  }
  const started = Date.now();
  try {
    if (withoutCert) {
      const r = await client.probeWithoutClientCert(tenantSlug);
      out(JSON.stringify({
        probe: "contract.read", variant: "without-client-cert", expectation: "refused at Layer 1",
        target: client.describe().origin, refused: r.refused, status: r.status, detail: r.detail, durationMs: Date.now() - started,
      }));
      return r.refused ? 0 : 1;
    }
    const res = await client.getContract(tenantSlug);
    const msg = res.json && typeof res.json === "object" ? (res.json as Record<string, unknown>).message : undefined;
    out(JSON.stringify({
      probe: "contract.read", variant: "all-four-layers", target: client.describe().origin,
      ok: res.status >= 200 && res.status < 300, status: res.status,
      message: typeof msg === "string" ? msg.slice(0, 300) : undefined,
      bodyPreview: res.json === null ? res.bodyText.slice(0, 300) : undefined,
      tokenRequests: client.describe().tokenRequests, durationMs: Date.now() - started,
    }));
    return res.status >= 200 && res.status < 300 ? 0 : 1;
  } catch (err) {
    const e = err as Error & { code?: string };
    out(JSON.stringify({ probe: "contract.read", ok: false, error: e.name, code: e.code, message: e.message, durationMs: Date.now() - started }));
    return 1;
  } finally {
    client.close();
  }
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  void runProbeCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

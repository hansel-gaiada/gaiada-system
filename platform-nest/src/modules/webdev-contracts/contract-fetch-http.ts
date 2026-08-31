// WSK-19 — THE ONLY FILE IN `src/modules/webdev-contracts/` THAT TALKS OUTWARD.
// `egress-inventory.test.ts` (this directory's own copy) enforces that sentence statically.
//
// Design: docs/blueprints/webdesk-design.md §06 (the rail's Zone A end) + §03 (the A→B control
// channel this call rides, STUBBED — see `config.ts`'s `webdevControl` block header for exactly
// what is and is not implemented here).
//
// ── RETRY POLICY ─────────────────────────────────────────────────────────────────────────────────
// Same doctrine as `provision-http.ts`: transport failures (DNS/TCP/TLS/timeout) are retried with
// backoff; an HTTP response is never retried — a completed answer (even a 5xx) is data, not a
// reason to resend. `getContractBundle`/`downloadArtifact` are both read-only GETs, so unlike provision's
// create call there is no double-egress hazard here — retrying a GET is always safe — but the
// SAME "an HTTP answer is not a transport failure" distinction is kept for consistency and because
// a 5xx retried blindly against an internet-facing box under load is its own kind of harm.
import { config } from "../../config";
import {
  ContractControlNotConfiguredError, WebdevControlEgressError,
  type ContractBundleMeta, type WebdevControlProvider,
} from "./contract-fetch-provider";

type FetchImpl = typeof fetch;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Strip anything credential-shaped out of a string bound for a log, an error, or a notification. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Narrow, allowlist-shaped parse of the far side's response — an unrecognized shape is a thrown
 *  egress error, never a half-populated object silently passed on (the same discipline
 *  `provision-http.ts`'s `toProject()` applies). */
function toBundleMeta(raw: unknown): ContractBundleMeta | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return null;
  if (!isNonEmptyString(r.version) || !isNonEmptyString(r.vocabularyVersion)) return null;
  if (!isNonEmptyString(r.contentHash) || !isNonEmptyString(r.generatedAt)) return null;
  const bl = r.blockLibrary as Record<string, unknown> | undefined;
  if (!bl || !isNonEmptyString(bl.package) || !isNonEmptyString(bl.version) || !isNonEmptyString(bl.range)) {
    return null;
  }
  const art = r.artifacts as Record<string, unknown> | undefined;
  if (!art || !isNonEmptyString(art.sdkTsUrl) || !isNonEmptyString(art.openapiUrl) || !isNonEmptyString(art.contractMdUrl)) {
    return null;
  }
  const sdkPhpUrl = isNonEmptyString(art.sdkPhpUrl) ? art.sdkPhpUrl : null; // null until P6 (D-10)
  return {
    version: r.version,
    vocabularyVersion: r.vocabularyVersion,
    blockLibrary: { package: bl.package, version: bl.version, range: bl.range },
    artifacts: { sdkTsUrl: art.sdkTsUrl, sdkPhpUrl, openapiUrl: art.openapiUrl, contractMdUrl: art.contractMdUrl },
    contentHash: r.contentHash,
    generatedAt: r.generatedAt,
  };
}

export interface WebdevControlHttpDriverOptions {
  baseUrl: string;
  bearerToken: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  /** Test seam (the `provision-http.ts` / `token-endpoint-client.ts` precedent). Production passes
   *  nothing. */
  fetchImpl?: FetchImpl;
}

/** Build the driver from `config.webdevControl`, or throw `ContractControlNotConfiguredError`.
 *  FAIL-CLOSED IS THE POINT — see `config.ts`'s own header on this block. */
export function createWebdevControlHttpDriver(fetchImpl?: FetchImpl): WebdevControlProvider {
  const c = config.webdevControl;
  if (!c.baseUrl) throw new ContractControlNotConfiguredError();
  return new WebdevControlHttpDriver({
    baseUrl: c.baseUrl,
    bearerToken: c.bearerToken,
    timeoutMs: c.timeoutMs,
    retryAttempts: c.retryAttempts,
    retryBaseDelayMs: c.retryBaseDelayMs,
    fetchImpl,
  });
}

export class WebdevControlHttpDriver implements WebdevControlProvider {
  readonly key = "webdev-control" as const;

  // `#`-private per the same real-defect precedent `provision-http.ts` documents: TypeScript
  // `private` is compile-time only and would still let `JSON.stringify(driver)` emit the token.
  readonly #token: string;
  readonly #settings: Omit<WebdevControlHttpDriverOptions, "bearerToken" | "fetchImpl">;
  readonly #doFetch: FetchImpl;

  constructor(opts: WebdevControlHttpDriverOptions) {
    if (!opts.baseUrl) throw new ContractControlNotConfiguredError();
    this.#token = opts.bearerToken;
    this.#settings = {
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
      retryAttempts: opts.retryAttempts,
      retryBaseDelayMs: opts.retryBaseDelayMs,
    };
    this.#doFetch = opts.fetchImpl ?? fetch;
  }

  /** Test-only: repoint the driver at a different origin. Never called in production. */
  setBaseUrlForTests(baseUrl: string): void {
    this.#settings.baseUrl = baseUrl;
  }

  #url(path: string): string {
    return `${this.#settings.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async #get(url: string, opts: { authed: boolean }): Promise<{ status: number; bodyText: string }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.authed && this.#token) headers.authorization = `Bearer ${this.#token}`;

    let lastErr: unknown;
    const attempts = Math.max(1, this.#settings.retryAttempts);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#settings.timeoutMs);
      try {
        const res = await this.#doFetch(url, { method: "GET", headers, signal: controller.signal });
        const bodyText = await res.text();
        return { status: res.status, bodyText };
      } catch (err) {
        lastErr = err;
        if (attempt < attempts - 1) await sleep(this.#settings.retryBaseDelayMs * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new WebdevControlEgressError(redact(`webdev-control GET ${url} failed after ${attempts} attempt(s): ${msg}`, [this.#token]));
  }

  async getContractBundle(slug: string): Promise<ContractBundleMeta> {
    const { status, bodyText } = await this.#get(this.#url(`/control/v1/tenants/${encodeURIComponent(slug)}/contract`), { authed: true });
    if (status !== 200) {
      throw new WebdevControlEgressError(redact(`webdev-control contract read for "${slug}" returned ${status}: ${bodyText.slice(0, 200)}`, [this.#token]));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new WebdevControlEgressError(`webdev-control contract read for "${slug}" returned non-JSON`);
    }
    const meta = toBundleMeta(parsed);
    if (!meta) {
      throw new WebdevControlEgressError(`webdev-control contract read for "${slug}" returned an unrecognized shape`);
    }
    return meta;
  }

  async downloadArtifact(url: string): Promise<Buffer> {
    // Pre-signed URLs carry their own auth in the query string (§06) — no bearer token attached.
    let lastErr: unknown;
    const attempts = Math.max(1, this.#settings.retryAttempts);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#settings.timeoutMs);
      try {
        const res = await this.#doFetch(url, { method: "GET", signal: controller.signal });
        if (res.status !== 200) {
          throw new WebdevControlEgressError(`webdev-control artifact download returned ${res.status}`);
        }
        const arr = await res.arrayBuffer();
        return Buffer.from(arr);
      } catch (err) {
        if (err instanceof WebdevControlEgressError) throw err;
        lastErr = err;
        if (attempt < attempts - 1) await sleep(this.#settings.retryBaseDelayMs * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new WebdevControlEgressError(`webdev-control artifact download failed after ${attempts} attempt(s): ${msg}`);
  }
}

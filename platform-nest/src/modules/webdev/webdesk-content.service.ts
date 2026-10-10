// WSK-59 — the ERP's content BFF service for WebDesk (write-plane design §12 WSK-59, §6 publish, §10
// the "editorial unavailable" state). The Zone A half of the editor: every read and write the "Website"
// workspace (WSK-44), the MCP hub (agents, n8n) and the M1 importer (WSK-67) perform goes through THIS
// class, so a capability behaves identically under a human, under n8n and under an agent.
//
// Two classes, one file, on purpose:
//   * `WebdeskZoneB` — the egress seam. No authorization lives here. It owns the cross-company wall
//     (`resolveEditableSite`), the typed error mapping (breaker open → 503 `editorial_unavailable`, not
//     configured → 503 `webdesk_not_configured`, Zone B's typed 4xx passed through UNTOUCHED), and the
//     editorial-assertion + two-row-activity wrapper around every write.
//   * `WebdeskContentService` — the content use cases. Every public method takes a `ContentGate`, which
//     can only be produced by `authorizeContent()` (Cerbos, as the CALLER, module `webdev`). The
//     controller's first statement of every handler is that call, so authorization precedes ANY body
//     validation (the estate's "validation pre-empts authz" trap), and a caller that forgets it does not
//     compile (the same compile-time pattern design §3.1 uses for `EditorialPrincipal`).
//
// ── THE CROSS-COMPANY WALL (`resolveEditableSite`) ───────────────────────────────────────────────
// A WebDesk tenant carries `company_ref` = the ERP company that owns it. `tenant.list?companyRef=<ERP
// tenantId>` is filtered by that column IN SQL, so another company's tenant never leaves Zone B. A
// (tenantSlug, siteId) pair that is not in that answer is a uniform 404 `site_not_found`, whether the slug
// is unknown, the site belongs to another tenant, or the tenant belongs to another company: no existence
// oracle. The answer is cached 60 s per company (a miss older than 5 s refetches once, so a site that was
// provisioned a moment ago is not 404 for a minute). The caller's `tenantId` is the AuthGuard-validated
// route param, authorised against Cerbos for this company BEFORE this runs.
//
// ── ATTRIBUTES COME FROM ZONE B, NEVER FROM THE REQUEST (design §7) ──────────────────────────────
// An item-targeted write reads the item from Zone B (`item.get`) and authorises a SECOND time with
// `collectionKey`/`locale` taken from that read, then sends. (The generic first check has no attributes;
// no policy rule reads them yet, and the later writer/translator roles will.) `create` has no item to
// read: its `collectionKey` is the validated route param (`collection.get` proves it exists) and its
// `locale` is the body's, which Zone B itself validates against the tenant's locales.
//
// ── EVERY EGRESS WRITE WRITES TWO `activities` ROWS (GH-04's pattern) ────────────────────────────
// One BEFORE the call (`outcome:"attempted"`) so a crash leaves evidence, one AFTER (`succeeded` |
// `refused` | `failed`). The actor is the ERP user; the editorial assertion's `sub` is that same id, so
// the ERP ledger can resolve the opaque `sub` Zone B stores in `content_versions.created_by`. The rows
// carry identifiers and the typed outcome, never content values.
//
// ── DEGRADED, NEVER EMPTY ────────────────────────────────────────────────────────────────────────
// A failed read is a typed 503, never `[]` (an empty list is a claim). A write with no signer or no
// channel is a typed 503, never a silent failure: writes are refused BEFORE any ledger row, because
// nothing was attempted.
import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  BadGatewayException,
} from "@nestjs/common";
import { authorize, writeActivity } from "../../core/http";
import { withTenants } from "../../db";
import type { Principal } from "../../rbac/principal";
import {
  EditorialUnavailableError,
  WebdeskControlNotConfiguredError,
  WebdeskControlTokenError,
  WebdeskControlTransportError,
  type WebdeskControlClient,
  type WebdeskControlRequest,
  type WebdeskControlResponse,
} from "./webdesk-control-client";
import {
  EditorialSignerNotConfiguredError,
  fileWebdeskCommandApproval,
  getEditorialAssertionSigner,
  getWebdeskCommandControlClient,
  type WebdeskBffEditorialCommand,
} from "./webdesk-approved-command";
import { commandArgsAsZoneBSeesThem, computeCommandHash } from "./webdesk-ws4-assertion";

const logger = new Logger("WebdeskContent");

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Typed errors the BFF throws (shaped by the global HttpErrorFilter, except WebdeskProblem)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** A Zone B problem (RFC 9457) passed through UNTOUCHED: same status, same body, same `type` slug. The
 *  controller's `WebdeskProblemFilter` writes `body` verbatim as `application/problem+json`; the global
 *  filter would otherwise rename it to `{error}` and drop `issues`/`currentHeadVersion` (the estate's
 *  "an error shape quietly eating a contract field" trap, http-error.filter.ts). */
export class WebdeskProblem extends HttpException {
  constructor(status: number, readonly problem: Record<string, unknown>) {
    super(problem, status);
  }
}

/** The `type` slug of a Zone B problem (`…/errors/<slug>`), or null. */
export function problemSlug(problem: unknown): string | null {
  if (problem === null || typeof problem !== "object") return null;
  const t = (problem as Record<string, unknown>).type;
  if (typeof t !== "string") return null;
  const last = t.split("/").pop() ?? "";
  return /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(last) ? last : null;
}

/** A write that MAY have landed and whose outcome could not be established. 502, never success, never a plain
 *  failure: the caller re-reads (the item state) and retries with the SAME Idempotency-Key. */
export class AmbiguousWriteError extends HttpException {
  constructor(reason: string) {
    super({ message: "webdesk_ambiguous", reason }, 502);
  }
}

function editorialUnavailable(reason: string, extra?: string): ServiceUnavailableException {
  return new ServiceUnavailableException({ message: "editorial_unavailable", reason, ...(extra ? { detail: extra } : {}) });
}
function notConfigured(reason: string): ServiceUnavailableException {
  return new ServiceUnavailableException({ message: "webdesk_not_configured", reason });
}
function invalidRequest(detail: string): BadRequestException {
  return new BadRequestException({ message: `invalid_request: ${detail}`, reason: "invalid_request" });
}
function siteNotFound(): WebdeskProblem {
  // One answer for every way a site can be "not yours": unknown slug, another tenant's site, another
  // company's tenant, an archived tenant. No existence oracle. A PROBLEM DOCUMENT with the same `type` WebDesk
  // itself uses for an unknown site, so the UI has ONE not-found shape (`…/errors/site-not-found`).
  return new WebdeskProblem(404, {
    type: "https://webdesk.gaiada.online/errors/site-not-found",
    title: "Site not found",
    status: 404,
    detail: "No such site for this company.",
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The gate: authorization as the CALLER, first, as a type
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type ContentKind = "webdesk_content_item" | "webdesk_collection";
export type ContentAction = "read" | "create" | "update" | "request_publish" | "unpublish" | "delete" | "apply_schema";

/** Proof that Cerbos allowed `principal` to run `action` on `kind` in company `tenantId`. Its constructor
 *  is private: `authorizeContent()` is the only way to get one. */
export class ContentGate {
  private constructor(
    readonly principal: Principal,
    readonly tenantId: string,
    readonly kind: ContentKind,
    readonly action: ContentAction,
  ) {}

  /** @internal use `authorizeContent`. */
  static async open(principal: Principal, tenantId: string, kind: ContentKind, action: ContentAction): Promise<ContentGate> {
    await authorize(principal, { kind, tenantId, module: "webdev" }, action);
    return new ContentGate(principal, tenantId, kind, action);
  }

  /** A method that needs `webdesk_content_item:update` cannot be driven with a `read` gate. */
  require(kind: ContentKind, action: ContentAction): this {
    if (this.kind !== kind || this.action !== action) {
      throw new InternalServerErrorException(`webdesk content gate mismatch: opened ${this.kind}:${this.action}, needed ${kind}:${action}`);
    }
    return this;
  }
}

/** The FIRST statement of every handler (and of the importer's calls): Cerbos, as the caller, module `webdev`. */
export const authorizeContent = ContentGate.open;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Shapes
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export interface SiteRef {
  tenantSlug: string;
  siteId: string;
}

export interface ZoneBResult {
  status: number;
  body: unknown;
}

export interface WebdeskTenantEntry {
  slug: string;
  status: string;
  defaultLocale: string;
  locales: string[];
  sites: Array<{ siteId: string; name: string; kind: string; environments: unknown[] }>;
}

export interface EditableSite {
  tenant: WebdeskTenantEntry;
  site: WebdeskTenantEntry["sites"][number];
}

type Query = Record<string, string>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEM_RE = /^[\x21-\x7e]{8,200}$/;
const SITE_CACHE_TTL_MS = 60_000;
const SITE_CACHE_REFETCH_ON_MISS_MS = 5_000;
const ITEM_READ_CONCURRENCY = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strictBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(raw)) throw invalidRequest("the request body must be a JSON object");
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) throw invalidRequest(`unknown body key "${k}" (allowed: ${allowed.join(", ")})`);
  }
  return raw;
}

/** Only allow-listed, single-string query keys are forwarded: nothing the caller adds can reach Zone B. */
export function strictQuery(raw: unknown, allowed: readonly string[]): Query {
  const out: Query = {};
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) throw invalidRequest("malformed query string");
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.includes(k)) throw invalidRequest(`unknown query parameter "${k}" (allowed: ${allowed.join(", ") || "none"})`);
    if (typeof v !== "string") throw invalidRequest(`query parameter "${k}" must be given once, as a string`);
    out[k] = v;
  }
  return out;
}

export function idempotencyKeyOf(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === "") return randomUUID();
  if (!IDEM_RE.test(v)) throw invalidRequest("the Idempotency-Key header must be 8..200 printable ASCII characters");
  return v;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WebdeskZoneB — the egress seam (no authorization here)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export interface EgressWrite {
  /** Zone B's CommandName, hashed into the editorial assertion and recorded in the ledger. */
  command: WebdeskBffEditorialCommand | "schema.apply" | "site.provision";
  /** `webdesk.content.update` etc. */
  verb: string;
  method: "POST" | "PUT";
  path: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
  idempotencyKey: string;
  /** Present for the five editorial commands only (schema.apply and site.provision carry none: design §3.1). */
  editorial?: { tenantSlug: string; siteId: string };
  entity: { type: string; id: string | null };
  /** Non-secret identifiers copied onto both ledger rows. */
  ledger: Record<string, unknown>;
  /** After an AMBIGUOUS failure (the write may have landed): read Zone B and return the success body when the
   *  write provably landed, else null. Reads only; the write is never resent. */
  reconcile?: () => Promise<ZoneBResult | null>;
}

export class WebdeskZoneB {
  /** companyId → the company's WebDesk tenants (+ when it was read). */
  private readonly cache = new Map<string, { at: number; tenants: WebdeskTenantEntry[] }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Seed the wall's cache from an answer already in hand (the editor's first call is `listSites`). */
  primeSiteCache(companyId: string, tenants: WebdeskTenantEntry[]): void {
    this.cache.set(companyId, { at: this.now(), tenants });
  }

  /** Tests, and after a provisioning write. */
  clearSiteCache(companyId?: string): void {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  // ── transport ────────────────────────────────────────────────────────────────────────────────

  private client(): WebdeskControlClient {
    try {
      return getWebdeskCommandControlClient();
    } catch (err) {
      if (err instanceof WebdeskControlNotConfiguredError) throw notConfigured("control_channel_not_configured");
      throw err;
    }
  }

  /** Transport-level failures → typed 503s. The breaker being open is `editorial_unavailable` with no I/O. */
  private mapTransport(err: unknown, write: boolean): HttpException {
    if (err instanceof HttpException) return err;
    if (err instanceof EditorialUnavailableError) return editorialUnavailable("circuit_open");
    if (err instanceof WebdeskControlNotConfiguredError) return notConfigured("control_channel_not_configured");
    if (err instanceof EditorialSignerNotConfiguredError) return notConfigured("editorial_signer_not_configured");
    if (err instanceof WebdeskControlTransportError) {
      // A write that was fully written before the link died MAY have landed: say so, so the UI re-reads.
      if (write && err.maybeDelivered) return new AmbiguousWriteError("not_observed");
      return editorialUnavailable("webdesk_unreachable");
    }
    if (err instanceof WebdeskControlTokenError) return editorialUnavailable("webdesk_token_unavailable");
    logger.error(`unexpected egress failure: ${(err as Error)?.name ?? "error"}`);
    return new InternalServerErrorException("webdesk egress failed unexpectedly");
  }

  /** A Zone B answer → data (2xx) or the typed error the BFF throws. 4xx problems pass through UNTOUCHED. */
  settle(res: WebdeskControlResponse): ZoneBResult {
    if (res.status >= 200 && res.status < 300) {
      if (res.json === null || typeof res.json !== "object") {
        throw new BadGatewayException({ message: "webdesk_error", reason: "non_json_response" });
      }
      return { status: res.status, body: res.json };
    }
    const slug = problemSlug(res.json);
    const body = isPlainObject(res.json)
      ? res.json
      : { type: "https://webdesk.gaiada.online/errors/unknown", title: "WebDesk refused the request", status: res.status };
    // 401/403 from Zone B are OUR credentials or signing config being refused (a platform fault, not the
    // user's): never forward them, or the UI would read a 401 as "your session expired".
    if (res.status === 401 || res.status === 403) {
      // A replayed editorial assertion after a client-level resend means the first send may have landed.
      if (slug === "editorial-assertion-replayed") throw new AmbiguousWriteError("not_observed");
      throw new BadGatewayException({ message: "webdesk_refused", reason: slug ?? `http_${res.status}` });
    }
    if (res.status === 503) throw editorialUnavailable(slug ?? "webdesk_unavailable");
    if (res.status >= 500) throw new BadGatewayException({ message: "webdesk_error", reason: slug ?? `http_${res.status}` });
    throw new WebdeskProblem(res.status, body);
  }

  /** One read. Never audited (design §4). */
  async read(req: Omit<WebdeskControlRequest, "method" | "body" | "idempotencyKey" | "ws4" | "editorialAssertion">): Promise<ZoneBResult> {
    const client = this.client();
    let res: WebdeskControlResponse;
    try {
      res = await client.send({ ...req, method: "GET" });
    } catch (err) {
      throw this.mapTransport(err, false);
    }
    return this.settle(res);
  }

  /** One write: refuse when unconfigured, sign, ledger row, send, ledger row, map. */
  async write(principal: Principal, tenantId: string, w: EgressWrite): Promise<ZoneBResult> {
    const client = this.client();
    const userId = principal.userId;
    if (!userId) throw new ForbiddenException("not authorized: an authenticated user is required");

    // Config check BEFORE any ledger row: nothing is attempted when there is no signer.
    let editorialAssertion: string | undefined;
    if (w.editorial) {
      const signer = getEditorialAssertionSigner();
      if (!signer.configured) throw notConfigured("editorial_signer_not_configured");
      const editorialCmd = w.command as WebdeskBffEditorialCommand;
      try {
        editorialAssertion = await signer.sign({
          sub: userId,
          pk: principal.via?.agent ? "agent" : principal.via?.provider === "n8n" ? "automation" : "human",
          ...(principal.via?.agent ? { agt: principal.via.agent } : {}),
          ten: w.editorial.tenantSlug,
          site: w.editorial.siteId,
          cmd: editorialCmd,
          cmh: computeCommandHash(w.command, commandArgsAsZoneBSeesThem(w.params, w.body)),
        });
      } catch (err) {
        if (err instanceof EditorialSignerNotConfiguredError) throw notConfigured("editorial_signer_not_configured");
        logger.error(`editorial signer failed: ${(err as Error)?.name ?? "error"}`);
        throw notConfigured("editorial_signer_failed");
      }
    }

    const base = { command: w.command, idempotencyKey: w.idempotencyKey, ...w.ledger };
    // GH-04's two-row pattern: the ATTEMPT is on the ledger before the call.
    await writeActivity(tenantId, userId, w.verb, w.entity.type, w.entity.id, { ...base, outcome: "attempted" });

    let res: WebdeskControlResponse | null = null;
    let sendError: unknown = null;
    try {
      res = await client.send({
        command: w.command,
        method: w.method,
        path: w.path,
        params: w.params,
        body: w.body,
        idempotencyKey: w.idempotencyKey,
        ...(editorialAssertion !== undefined ? { editorialAssertion } : {}),
      });
    } catch (err) {
      sendError = err;
    }

    let outcome: ZoneBResult | null = null;
    let thrown: HttpException | null = null;
    let reconciled = false;
    if (sendError !== null) {
      thrown = this.mapTransport(sendError, true);
    } else {
      try {
        outcome = this.settle(res as WebdeskControlResponse);
      } catch (err) {
        thrown = err as HttpException;
      }
    }
    if (thrown instanceof AmbiguousWriteError && w.reconcile) {
      // The write may have landed. READ to find out (never resend): landed => the reconciled state,
      // anything else => stays a typed 502 webdesk_ambiguous.
      try {
        const landed = await w.reconcile();
        if (landed) {
          outcome = landed;
          thrown = null;
          reconciled = true;
        }
      } catch (err) {
        logger.warn(`${w.verb}: reconcile read failed (${(err as Error)?.name ?? "error"})`);
        thrown = new AmbiguousWriteError("reconcile_failed");
      }
    }

    const result = outcome ? (outcome.body as Record<string, unknown>) : null;
    const after = outcome
      ? {
          ...base,
          outcome: reconciled ? "reconciled" : "succeeded",
          status: outcome.status,
          ...(result && result.replayed === true ? { replayed: true } : {}),
          ...(result && isPlainObject(result.item) && typeof result.item.itemId === "string" ? { resultItemId: result.item.itemId } : {}),
          ...(result && isPlainObject(result.version) && typeof result.version.version === "number" ? { version: result.version.version } : {}),
        }
      : {
          ...base,
          outcome: thrown instanceof WebdeskProblem ? "refused" : thrown instanceof AmbiguousWriteError ? "ambiguous" : "failed",
          status: thrown?.getStatus() ?? null,
          ...(thrown instanceof WebdeskProblem ? { problem: problemSlug(thrown.problem) } : {}),
          ...(thrown && !(thrown instanceof WebdeskProblem) ? { error: errorToken(thrown) } : {}),
        };
    try {
      await writeActivity(tenantId, userId, w.verb, w.entity.type, w.entity.id, after);
    } catch (err) {
      // The write already happened (or was refused). A ledger failure must not turn that into a 500 that
      // invites a blind retry; the ATTEMPT row stays as evidence, and this is loud in the log.
      logger.error(`${w.verb}: the result ledger row could not be written (${(err as Error)?.message ?? "error"})`);
    }
    if (thrown) throw thrown;
    return outcome as ZoneBResult;
  }

  // ── the wall ─────────────────────────────────────────────────────────────────────────────────

  private async loadTenants(companyId: string): Promise<WebdeskTenantEntry[]> {
    const { body } = await this.read({
      command: "tenant.list",
      path: "/control/v1/tenants",
      query: { companyRef: companyId },
    });
    const tenants = isPlainObject(body) && Array.isArray(body.tenants) ? (body.tenants as WebdeskTenantEntry[]) : null;
    if (!tenants) throw new BadGatewayException({ message: "webdesk_error", reason: "tenant_list_shape" });
    this.cache.set(companyId, { at: this.now(), tenants });
    return tenants;
  }

  /** The company's tenants, from the cache when fresh. */
  async tenantsOf(companyId: string, opts: { fresh?: boolean } = {}): Promise<WebdeskTenantEntry[]> {
    const hit = this.cache.get(companyId);
    if (!opts.fresh && hit && this.now() - hit.at < SITE_CACHE_TTL_MS) return hit.tenants;
    return this.loadTenants(companyId);
  }

  /**
   * THE CROSS-COMPANY WALL. 404 unless `(tenantSlug, siteId)` is an ACTIVE tenant of THIS company
   * (`tenants.company_ref = companyId`, filtered in Zone B's SQL) that owns that site. Callers authorise
   * the actor for the company FIRST.
   */
  async resolveEditableSite(companyId: string, tenantSlug: string, siteId: string): Promise<EditableSite> {
    const find = (tenants: WebdeskTenantEntry[]): EditableSite | null => {
      const tenant = tenants.find((t) => t.slug === tenantSlug && t.status === "active");
      const site = tenant?.sites.find((s) => s.siteId === siteId);
      return tenant && site ? { tenant, site } : null;
    };
    const cached = this.cache.get(companyId);
    if (cached && this.now() - cached.at < SITE_CACHE_TTL_MS) {
      const hit = find(cached.tenants);
      if (hit) return hit;
      // A miss on a cached answer refetches once, but only when the answer is not brand new: a stream of
      // bad ids must not become a stream of Zone B calls.
      if (this.now() - cached.at < SITE_CACHE_REFETCH_ON_MISS_MS) throw siteNotFound();
    }
    const hit = find(await this.loadTenants(companyId));
    if (!hit) throw siteNotFound();
    return hit;
  }

  /** Like `resolveEditableSite`, for a tenant that may not have a site yet (provisioning the first one). */
  async resolveEditableTenant(companyId: string, tenantSlug: string): Promise<WebdeskTenantEntry> {
    const cached = this.cache.get(companyId);
    const find = (tenants: WebdeskTenantEntry[]) => tenants.find((t) => t.slug === tenantSlug && t.status === "active") ?? null;
    if (cached && this.now() - cached.at < SITE_CACHE_TTL_MS) {
      const hit = find(cached.tenants);
      if (hit) return hit;
      if (this.now() - cached.at < SITE_CACHE_REFETCH_ON_MISS_MS) throw siteNotFound();
    }
    const hit = find(await this.loadTenants(companyId));
    if (!hit) throw siteNotFound();
    return hit;
  }
}

function errorToken(err: HttpException): string {
  const r = err.getResponse() as { message?: unknown; reason?: unknown };
  const m = typeof r?.message === "string" ? r.message : err.message;
  return typeof r?.reason === "string" && r.reason !== m ? `${m}:${r.reason}` : m;
}

/** The process-wide egress seam (one wall cache, one set of tests' reset). */
export const webdeskZoneB = new WebdeskZoneB();

/** Module-level alias, per the design's signature. */
export function resolveEditableSite(companyId: string, tenantSlug: string, siteId: string): Promise<EditableSite> {
  return webdeskZoneB.resolveEditableSite(companyId, tenantSlug, siteId);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WebdeskContentService — the use cases
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const ITEM_PATH = "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId";

interface ItemAttrs {
  collectionKey: string;
  locale: string;
  deletedAt: string | null;
  contentHash: string | null;
  headVersion: number | null;
  publishedVersion: number | null;
}

/** `item.get`'s answer, narrowed to what reconciliation reads. */
interface RawItem {
  item: Record<string, unknown>;
  version: Record<string, unknown>;
  lint: unknown;
}

export class WebdeskContentService {
  constructor(private readonly zoneB: WebdeskZoneB = webdeskZoneB) {}

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  /** `GET …/content/sites`: the company's WebDesk tenants and sites (Zone B `tenant.list?companyRef`). */
  async listSites(gate: ContentGate): Promise<ZoneBResult> {
    gate.require("webdesk_collection", "read");
    const r = await this.zoneB.read({ command: "tenant.list", path: "/control/v1/tenants", query: { companyRef: gate.tenantId } });
    // Refresh the wall's cache from the same answer, so the editor's first click is warm.
    const tenants = isPlainObject(r.body) && Array.isArray(r.body.tenants) ? (r.body.tenants as WebdeskTenantEntry[]) : null;
    if (tenants) this.zoneB.primeSiteCache(gate.tenantId, tenants);
    return r;
  }

  async listCollections(gate: ContentGate, site: SiteRef): Promise<ZoneBResult> {
    gate.require("webdesk_collection", "read");
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    return this.zoneB.read({
      command: "collection.list",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
    });
  }

  async listItems(gate: ContentGate, site: SiteRef, collectionKey: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const { slug, ...query } = strictQuery(rawQuery, ["locale", "state", "q", "includeDeleted", "cursor", "limit", "slug"]);
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    const read = (q: Query) =>
      this.zoneB.read({
        command: "item.list",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key/items",
        params: { tenantSlug: site.tenantSlug, siteId: site.siteId, key: collectionKey },
        query: q,
      });
    if (slug === undefined) return read(query);

    // `?slug=` (the editor's by-slug open). WebDesk's item.list has no slug filter, only `q`, a substring match on
    // slug OR title, so this asks for `q=<slug>` at the page maximum and keeps the EXACT slug matches (all locales,
    // or the one `locale` asks for). It follows the cursor a few pages if the substring is common. The answer keeps
    // WebDesk's `page`: `hasMore:true` with no match means "not found YET", never "does not exist".
    if (slug === "" || slug.length > 200) throw invalidRequest("slug must be a non-empty string of at most 200 characters");
    if (query.q !== undefined) throw invalidRequest("slug and q cannot be combined");
    const matches: unknown[] = [];
    let page: unknown = { cursor: null, hasMore: false, limit: 100 };
    let cursor = query.cursor;
    for (let i = 0; i < 5; i++) {
      const r = await read({ ...query, q: slug, limit: "100", ...(cursor !== undefined ? { cursor } : {}) });
      const body = r.body as { items?: unknown[]; page?: { cursor: string | null; hasMore: boolean } };
      for (const it of body.items ?? []) if (isPlainObject(it) && it.slug === slug) matches.push(it);
      page = body.page ?? page;
      if (matches.length > 0 || !body.page?.hasMore || !body.page.cursor) break;
      cursor = body.page.cursor;
    }
    return { status: 200, body: { items: matches, page } };
  }

  async getItem(gate: ContentGate, site: SiteRef, itemId: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const query = strictQuery(rawQuery, ["version"]);
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    return this.zoneB.read({
      command: "item.get",
      path: ITEM_PATH,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      query,
    });
  }

  async listVersions(gate: ContentGate, site: SiteRef, itemId: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const query = strictQuery(rawQuery, ["cursor", "limit"]);
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    return this.zoneB.read({
      command: "item.versions",
      path: `${ITEM_PATH}/versions`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      query,
    });
  }

  async getVersion(gate: ContentGate, site: SiteRef, itemId: string, n: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    strictQuery(rawQuery, []);
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    return this.zoneB.read({
      command: "item.versionGet",
      path: `${ITEM_PATH}/versions/:n`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId, n },
    });
  }

  async listMedia(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const query = strictQuery(rawQuery, ["mime", "cursor", "limit"]);
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    return this.zoneB.read({
      command: "media.list",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/media",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      query,
    });
  }

  // ── writes: create ───────────────────────────────────────────────────────────────────────────

  async createItem(
    gate: ContentGate,
    site: SiteRef,
    collectionKey: string,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "create");
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    const b = strictBody(rawBody, ["collectionKey", "locale", "slug", "twinOf", "fields", "blocks", "seo", "note"]);
    // The route's collection is the authority. A body that names a different one is a mistake, not a redirect.
    if (b.collectionKey !== undefined && b.collectionKey !== collectionKey) {
      throw invalidRequest("collectionKey in the body does not match the collection in the path");
    }
    // The collection must exist on THIS site (a typed 404 `collection-not-found` passes through).
    await this.zoneB.read({
      command: "collection.get",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, key: collectionKey },
    });
    const locale = typeof b.locale === "string" ? b.locale : "";
    await authorize(gate.principal, { kind: "webdesk_content_item", tenantId: gate.tenantId, module: "webdev", collectionKey, locale }, "create");

    const { collectionKey: _drop, ...rest } = b;
    void _drop;
    return this.zoneB.write(gate.principal, gate.tenantId, {
      command: "content.create",
      verb: "webdesk.content.create",
      method: "POST",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      body: { collectionKey, ...rest },
      idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      entity: { type: "webdesk_content_item", id: null },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, collectionKey, locale: locale || null, slug: typeof b.slug === "string" ? b.slug : null },
      reconcile: this.reconcileCreate(site, collectionKey, gate.principal.userId as string, b.locale, b.slug),
    });
  }

  // ── writes on an existing item ───────────────────────────────────────────────────────────────

  /** Read the item from Zone B and authorise the ACTION with ITS collectionKey/locale (never the body's). */
  private async authorizeOnItem(
    gate: ContentGate,
    site: SiteRef,
    itemId: string,
    action: ContentAction,
    version?: string,
  ): Promise<ItemAttrs> {
    const attrs = await this.readItemAttrs(site, itemId, version);
    await authorize(
      gate.principal,
      { kind: "webdesk_content_item", tenantId: gate.tenantId, module: "webdev", id: itemId, collectionKey: attrs.collectionKey, locale: attrs.locale },
      action,
    );
    return attrs;
  }

  private async readItemAttrs(site: SiteRef, itemId: string, version?: string): Promise<ItemAttrs> {
    const { body } = await this.zoneB.read({
      command: "item.get",
      path: ITEM_PATH,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      ...(version !== undefined ? { query: { version } } : {}),
    });
    const item = isPlainObject(body) && isPlainObject(body.item) ? body.item : null;
    if (!item || typeof item.collectionKey !== "string" || typeof item.locale !== "string") {
      throw new BadGatewayException({ message: "webdesk_error", reason: "item_shape" });
    }
    const v = isPlainObject((body as Record<string, unknown>).version) ? ((body as Record<string, unknown>).version as Record<string, unknown>) : null;
    return {
      collectionKey: item.collectionKey,
      locale: item.locale,
      deletedAt: typeof item.deletedAt === "string" ? item.deletedAt : null,
      contentHash: v && typeof v.contentHash === "string" ? v.contentHash : null,
      headVersion: typeof item.headVersion === "number" ? item.headVersion : null,
      publishedVersion: typeof item.publishedVersion === "number" ? item.publishedVersion : null,
    };
  }

  private async rawItem(site: SiteRef, itemId: string, version?: string): Promise<RawItem> {
    const { body } = await this.zoneB.read({
      command: "item.get",
      path: ITEM_PATH,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      ...(version !== undefined ? { query: { version } } : {}),
    });
    if (!isPlainObject(body) || !isPlainObject(body.item) || !isPlainObject(body.version)) {
      throw new BadGatewayException({ message: "webdesk_error", reason: "item_shape" });
    }
    return { item: body.item, version: body.version, lint: body.lint };
  }

  // ── reconciliation after an AMBIGUOUS write (reads only; the write is never resent) ──────────

  /** update / restore landed iff the head moved to baseVersion+1 and its author is the caller; a restore
   *  must also have the source version's content hash. Anything else is "cannot tell" (null). */
  private reconcileEdit(site: SiteRef, itemId: string, sub: string, baseVersion: unknown, restoreFrom?: unknown) {
    return async (): Promise<ZoneBResult | null> => {
      if (typeof baseVersion !== "number") return null;
      const h = await this.rawItem(site, itemId);
      if (h.item.headVersion !== baseVersion + 1 || h.item.headCreatedBy !== sub) return null;
      if (restoreFrom !== undefined) {
        if (typeof restoreFrom !== "number") return null;
        const src = await this.rawItem(site, itemId, String(restoreFrom));
        if (typeof src.version.contentHash !== "string" || src.version.contentHash !== h.version.contentHash) return null;
      }
      return {
        status: 200,
        body: {
          item: h.item,
          version: { version: h.version.version, contentHash: h.version.contentHash, createdAt: h.version.createdAt },
          unchanged: false,
          lint: h.lint,
          replayed: false,
          reconciled: true,
        },
      };
    };
  }

  private reconcileState(site: SiteRef, itemId: string, landed: (item: Record<string, unknown>) => boolean) {
    return async (): Promise<ZoneBResult | null> => {
      const h = await this.rawItem(site, itemId);
      return landed(h.item) ? { status: 200, body: { item: h.item, replayed: false, reconciled: true } } : null;
    };
  }

  /** create landed iff an item with that slug+locale exists in the collection at head version 1, authored
   *  by the caller. (A slug someone ELSE created is "cannot tell", not success.) */
  private reconcileCreate(site: SiteRef, collectionKey: string, sub: string, locale: unknown, slug: unknown) {
    return async (): Promise<ZoneBResult | null> => {
      if (typeof locale !== "string" || typeof slug !== "string" || slug === "") return null;
      const { body } = await this.zoneB.read({
        command: "item.list",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key/items",
        params: { tenantSlug: site.tenantSlug, siteId: site.siteId, key: collectionKey },
        query: { locale, q: slug, limit: "100" },
      });
      const items = isPlainObject(body) && Array.isArray(body.items) ? body.items : [];
      const hit = items.find((i) => isPlainObject(i) && i.slug === slug && i.locale === locale);
      if (!isPlainObject(hit) || hit.headVersion !== 1 || hit.headCreatedBy !== sub || typeof hit.itemId !== "string") return null;
      const h = await this.rawItem(site, hit.itemId);
      return {
        status: 201,
        body: {
          item: h.item,
          version: { version: h.version.version, contentHash: h.version.contentHash, createdAt: h.version.createdAt },
          unchanged: false,
          lint: h.lint,
          replayed: false,
          reconciled: true,
        },
      };
    };
  }

  private async itemWrite(
    gate: ContentGate,
    site: SiteRef,
    itemId: string,
    action: "update" | "unpublish" | "delete",
    spec: {
      command: WebdeskBffEditorialCommand;
      method: "POST" | "PUT";
      suffix: string;
      allowed: readonly string[];
      rawBody: unknown;
      idempotencyKey: string;
      reconcile: (sub: string, body: Record<string, unknown>, before: ItemAttrs) => () => Promise<ZoneBResult | null>;
    },
  ): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", action);
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    const body = strictBody(spec.rawBody, spec.allowed);
    const attrs = await this.authorizeOnItem(gate, site, itemId, action);
    return this.zoneB.write(gate.principal, gate.tenantId, {
      command: spec.command,
      verb: `webdesk.${spec.command}`,
      method: spec.method,
      path: `${ITEM_PATH}${spec.suffix}`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      body,
      idempotencyKey: spec.idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      entity: { type: "webdesk_content_item", id: UUID_RE.test(itemId) ? itemId : null },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId, collectionKey: attrs.collectionKey, locale: attrs.locale },
      reconcile: spec.reconcile(gate.principal.userId as string, body, attrs),
    });
  }

  updateItem(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    return this.itemWrite(gate, site, itemId, "update", {
      command: "content.update",
      method: "PUT",
      suffix: "",
      allowed: ["baseVersion", "fields", "blocks", "seo", "note"],
      rawBody,
      idempotencyKey,
      reconcile: (sub, body) => this.reconcileEdit(site, itemId, sub, body.baseVersion),
    });
  }

  /** Restore is an UPDATE-class action (it appends a new draft version), design §3.1. */
  restoreVersion(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    return this.itemWrite(gate, site, itemId, "update", {
      command: "content.restoreVersion",
      method: "POST",
      suffix: "/restore",
      allowed: ["version", "baseVersion", "note"],
      rawBody,
      idempotencyKey,
      reconcile: (sub, body) => this.reconcileEdit(site, itemId, sub, body.baseVersion, body.version),
    });
  }

  unpublish(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    return this.itemWrite(gate, site, itemId, "unpublish", {
      command: "content.unpublish",
      method: "POST",
      suffix: "/unpublish",
      allowed: ["expectedPublishedVersion"],
      rawBody,
      idempotencyKey,
      // Landed iff it WAS live at the expected version (the pre-read) and is unpublished now.
      reconcile: (_sub, body, before) =>
        before.publishedVersion !== null && before.publishedVersion === body.expectedPublishedVersion
          ? this.reconcileState(site, itemId, (i) => i.publishedVersion === null && i.publishState === "unpublished")
          : async () => null,
    });
  }

  deleteItem(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    return this.itemWrite(gate, site, itemId, "delete", {
      command: "content.delete",
      method: "POST",
      suffix: "/delete",
      allowed: ["baseVersion"],
      rawBody,
      idempotencyKey,
      reconcile: (_sub, _body, before) =>
        before.deletedAt === null ? this.reconcileState(site, itemId, (i) => typeof i.deletedAt === "string") : async () => null,
    });
  }

  // ── publish requests: file ONE approval, never publish ───────────────────────────────────────

  /**
   * `POST …/publish-requests` → 202 `{approvalId}`. Publish is HIGH for every principal (WSK-D46): the BFF
   * never calls Zone B's publish. It reads each requested item version from Zone B (real
   * collection/locale for Cerbos, the content hash the approver is shown), then files exactly ONE WS4
   * approval through WSK-66's `fileWebdeskCommandApproval`. Executing it is `decide()`'s job, as the decider.
   */
  async requestPublish(gate: ContentGate, site: SiteRef, rawBody: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "request_publish");
    const editable = await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    const b = strictBody(rawBody, ["items", "publishAt", "unpublishAt", "note"]);
    const items = parsePublishItems(b.items);
    const publishAt = optInstant(b.publishAt, "publishAt");
    const unpublishAt = optInstant(b.unpublishAt, "unpublishAt");
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) {
      throw invalidRequest("note must be a string of at most 500 characters");
    }
    const scheduled = publishAt !== null || unpublishAt !== null;
    if (scheduled && b.note !== undefined) throw invalidRequest("a scheduled request takes no note");

    // Read every item at the requested version (bounded concurrency): proves it exists on THIS site and
    // is not deleted, and yields what Cerbos and the approver need. A typed 404/409 passes through.
    const reads = await mapPool(items, ITEM_READ_CONCURRENCY, (it) => this.readItemAttrs(site, it.itemId, String(it.version)));
    const pairs = new Map<string, { collectionKey: string; locale: string }>();
    const counts: Record<string, number> = {};
    reads.forEach((attrs, i) => {
      if (attrs.deletedAt !== null) {
        throw new WebdeskProblem(409, {
          type: "https://webdesk.gaiada.online/errors/item-deleted",
          title: "Item deleted",
          status: 409,
          detail: `Item ${items[i].itemId} is deleted and cannot be published.`,
        });
      }
      pairs.set(`${attrs.collectionKey}\u0000${attrs.locale}`, { collectionKey: attrs.collectionKey, locale: attrs.locale });
      counts[attrs.collectionKey] = (counts[attrs.collectionKey] ?? 0) + 1;
    });
    for (const p of pairs.values()) {
      await authorize(gate.principal, { kind: "webdesk_content_item", tenantId: gate.tenantId, module: "webdev", collectionKey: p.collectionKey, locale: p.locale }, "request_publish");
    }

    const wireItems = items.map((it, i) => ({ itemId: it.itemId, version: it.version, ...(reads[i].contentHash ? { contentHash: reads[i].contentHash as string } : {}) }));
    const n = items.length;
    const where = `${editable.tenant.slug}/${editable.site.name}`;
    const countText = Object.entries(counts).map(([k, c]) => `${k} ${c}`).join(", ");
    const title = scheduled
      ? `Schedule ${n} item${n === 1 ? "" : "s"} on ${where} (${countText})`
      : `Publish ${n} item${n === 1 ? "" : "s"} on ${where} (${countText}) and rebuild staging`;
    const command = scheduled ? "content.schedule" : "content.publish";
    const { approvalId } = await fileWebdeskCommandApproval(gate.principal, gate.tenantId, {
      command,
      tenantSlug: site.tenantSlug,
      siteId: site.siteId,
      args: scheduled
        ? { items: wireItems, publishAt, unpublishAt }
        : { items: wireItems, ...(b.note !== undefined ? { note: b.note as string } : {}) },
      summary: { title: title.length > 300 ? `${title.slice(0, 297)}...` : title, counts },
    });
    return { status: 202, body: { approvalId, command, itemCount: n } };
  }

  /**
   * `POST …/publish-requests/:approvalId/withdraw` → 200 `{approvalId, status:"cancelled"}`. The REQUESTER cancels
   * their own PENDING publish/schedule approval (the loan-withdraw precedent: `status='cancelled'`, which records
   * that nobody with authority refused it; `rejected` would). Cerbos: the same `request_publish` right that filed it.
   * Nothing is sent to WebDesk: the approval never executed. Another user's row is 403, a row that is not a publish
   * request for THIS site is 404 (no oracle across sites), and a row no longer pending is 409.
   */
  async withdrawPublishRequest(gate: ContentGate, site: SiteRef, approvalId: string): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "request_publish");
    await this.zoneB.resolveEditableSite(gate.tenantId, site.tenantSlug, site.siteId);
    const userId = gate.principal.userId as string;
    const notFound = (): HttpException => new NotFoundException({ message: "approval_not_found", reason: "approval_not_found" });
    if (!UUID_RE.test(approvalId)) throw notFound();

    const found = await withTenants([gate.tenantId], (c) =>
      c.query<{ status: string; requested_by: string | null; workflow_id: string; tool_args: Record<string, unknown> }>(
        `SELECT status, requested_by, workflow_id, tool_args FROM automation_approvals
          WHERE id = $1 AND origin = 'webdesk' AND deleted_at IS NULL`,
        [approvalId],
      ),
    );
    const row = found.rows[0];
    if (
      !row ||
      (row.workflow_id !== "content.publish" && row.workflow_id !== "content.schedule") ||
      row.tool_args?.tenantSlug !== site.tenantSlug ||
      row.tool_args?.siteId !== site.siteId
    ) {
      throw notFound();
    }
    if (row.requested_by !== userId) {
      throw new ForbiddenException("not authorized: only the requester may withdraw a publish request");
    }
    const conflict = (): HttpException =>
      new ConflictException({ message: "approval_not_pending: only a pending publish request can be withdrawn", reason: "approval_not_pending" });
    if (row.status !== "pending") throw conflict();

    // The guarded UPDATE is the single-use guarantee: a decider who approved a moment ago wins, and this is 409.
    const upd = await withTenants([gate.tenantId], (c) =>
      c.query(
        `UPDATE automation_approvals SET status = 'cancelled', decided_at = now(), updated_at = now()
          WHERE id = $1 AND origin = 'webdesk' AND status = 'pending' AND requested_by = $2 AND deleted_at IS NULL`,
        [approvalId, userId],
      ),
    );
    if (upd.rowCount === 0) throw conflict();
    await writeActivity(gate.tenantId, userId, "cancelled", "automation_approval", approvalId, {
      origin: "webdesk",
      workflowId: row.workflow_id,
      tenantSlug: site.tenantSlug,
      siteId: site.siteId,
      outcome: "withdrawn_by_requester",
    });
    return { status: 200, body: { approvalId, status: "cancelled" } };
  }
}

// ── small parsers ──────────────────────────────────────────────────────────────────────────────────

function parsePublishItems(raw: unknown): Array<{ itemId: string; version: number }> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 1000) throw invalidRequest("items must be an array of 1..1000 { itemId, version }");
  const seen = new Set<string>();
  return raw.map((e, i) => {
    if (!isPlainObject(e) || Object.keys(e).some((k) => k !== "itemId" && k !== "version")) {
      throw invalidRequest(`items[${i}] must be exactly { itemId, version }`);
    }
    if (typeof e.itemId !== "string" || !UUID_RE.test(e.itemId)) throw invalidRequest(`items[${i}].itemId must be a uuid`);
    if (typeof e.version !== "number" || !Number.isInteger(e.version) || e.version < 1) throw invalidRequest(`items[${i}].version must be a positive integer`);
    const key = e.itemId.toLowerCase();
    if (seen.has(key)) throw invalidRequest(`items[${i}].itemId is listed twice`);
    seen.add(key);
    return { itemId: e.itemId, version: e.version };
  });
}

function optInstant(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw invalidRequest(`${field} must be an ISO 8601 timestamp or null`);
  return v;
}

/** `Promise.all` with a ceiling; the first failure rejects and stops handing out work. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The process-wide service. WSK-67's importer imports THIS (and `authorizeContent`), not a second copy. */
export const webdeskContent = new WebdeskContentService();

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The WSK-31 control routes that are now REAL: `GET control/sites`, `POST control/sites`,
// `POST control/schema/apply`. Their controller authorizes against `webdev_provisioned_site`
// (`read` / `operate`, unchanged) FIRST; these take over from there: the same wall, the same typed
// errors, the same two ledger rows. Neither write is an editorial command (design §3.1: no editorial
// assertion), so neither needs the signer, only the channel.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** `GET control/sites`: the company's WebDesk tenants + sites (Zone B `tenant.list?companyRef`). */
export async function controlListSites(tenantId: string): Promise<ZoneBResult> {
  return webdeskZoneB.read({ command: "tenant.list", path: "/control/v1/tenants", query: { companyRef: tenantId } });
}

/** `POST control/schema/apply` body `{tenantSlug, siteId, collectionKey, schema}` (+ optional `Idempotency-Key`).
 *  Zone B validates the composition (422) and refuses a MAJOR change (409 `contract-major-change`): both pass through. */
export async function controlApplySchema(principal: Principal, tenantId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
  const b = strictBody(rawBody, ["tenantSlug", "siteId", "collectionKey", "schema"]);
  if (typeof b.tenantSlug !== "string" || typeof b.siteId !== "string" || typeof b.collectionKey !== "string" || b.collectionKey === "") {
    throw invalidRequest("tenantSlug, siteId and collectionKey are required strings");
  }
  if (!isPlainObject(b.schema)) throw invalidRequest("schema must be a JSON object (the collection's composition)");
  await webdeskZoneB.resolveEditableSite(tenantId, b.tenantSlug, b.siteId);
  return webdeskZoneB.write(principal, tenantId, {
    command: "schema.apply",
    verb: "webdesk.schema.apply",
    method: "POST",
    path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:collectionKey/schema/apply",
    params: { tenantSlug: b.tenantSlug, siteId: b.siteId, collectionKey: b.collectionKey },
    body: { schema: b.schema },
    idempotencyKey,
    entity: { type: "webdesk_site", id: UUID_RE.test(b.siteId) ? b.siteId : null },
    ledger: { tenantSlug: b.tenantSlug, siteId: b.siteId, collectionKey: b.collectionKey },
  });
}

/** `POST control/sites` body `{tenantSlug, kind, name}`: provisions a site on one of THIS company's tenants. */
export async function controlProvisionSite(principal: Principal, tenantId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
  const b = strictBody(rawBody, ["tenantSlug", "kind", "name"]);
  if (typeof b.tenantSlug !== "string" || typeof b.kind !== "string" || typeof b.name !== "string" || b.name === "") {
    throw invalidRequest("tenantSlug, kind and name are required strings");
  }
  await webdeskZoneB.resolveEditableTenant(tenantId, b.tenantSlug);
  try {
    return await webdeskZoneB.write(principal, tenantId, {
      command: "site.provision",
      verb: "webdesk.site.provision",
      method: "POST",
      path: "/control/v1/tenants/:tenantSlug/sites",
      params: { tenantSlug: b.tenantSlug },
      body: { kind: b.kind, name: b.name },
      idempotencyKey,
      entity: { type: "webdesk_site", id: null },
      ledger: { tenantSlug: b.tenantSlug, kind: b.kind },
    });
  } finally {
    // The wall's answer is stale the moment a site is added; the next call refetches.
    webdeskZoneB.clearSiteCache(tenantId);
  }
}

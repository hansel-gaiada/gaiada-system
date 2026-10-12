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
// ── THE TWO-PHASE GATE (M5-W1c; docs/plans/2026-10-11-m5-writers-room-design.md §2.3) ──────────────
// ContentGate -> SiteGate -> ItemGate. Attributes come from the ROUTE or from a ZONE B READ, never from a
// body or a query (PERMISSION-CONTRACT 27.2):
//   PHASE 1 (`ContentGate.openSite`, the controller's first statement): `webdesk_collection:read` on
//     {tenantId, module, siteId}. The site-level question every writers' room grant can answer.
//   PHASE 2 (inside each method, BEFORE any body or query validation): the REAL action, with `siteId` (the
//     route's, proven by the wall), `collectionKey`, `locale`, `ownerId` (= WebDesk's author), `reviewState` and
//     `published` taken from WebDesk's `item.get` (or, for `create`, the route key proven by `collection.get`,
//     the body's locale, and for a locale twin the SOURCE item's state). A method that writes sends through an
//     `ItemGate`, whose constructor is private and which only the WebDesk-read path can build.
// A principal that holds no writers' room grant (and is not delegating) is ALSO asked the old attribute-free
// question inside phase 1: for them it is exactly the old first statement, so a denied staff caller still sees
// no egress and no 404-before-403. It is never an allow path (it only ever denies earlier).
// `create` has no item to read: its `collectionKey` is the validated route param (`collection.get` proves it
// exists) and its `locale` is the body's, which Zone B itself validates against the tenant's locales.
//
// ── EVERY EGRESS WRITE WRITES TWO `activities` ROWS (GH-04's pattern) ────────────────────────────
// One BEFORE the call (`outcome:"attempted"`) so a crash leaves evidence, one AFTER (`succeeded` |
// `refused` | `failed`). The actor is the ERP user; the editorial assertion's `sub` is that same id, so
// the ERP ledger can resolve the opaque `sub` Zone B stores in `content_versions.created_by`. The rows
// carry identifiers and the typed outcome, never content values.
//
// ── A TAKEDOWN OF LIVE CONTENT MARKS STAGING STALE (WSK-60) ──────────────────────────────────────
// Staging is built from a PRODUCTION read key, so it keeps serving an item until the next rebuild. Every
// successful unpublish/delete whose pre-read showed a live version (`publishedVersion !== null`) records
// that (`noteStagingStale`), which is what raises the editor's stale-staging banner. A draft-only delete
// changes nothing staging serves, so it never does; and Zone B refuses to delete a live item anyway
// (409 item-is-live), so in practice only unpublish marks. The mark is BEST-EFFORT: the WebDesk write has
// already happened, so a failed mark is logged and never fails (or "rolls back") the editor's action.
// Scheduled takedowns (`content.schedule` with `unpublishAt`) take effect inside Zone B later and are not
// marked here.
//
// ── DEGRADED, NEVER EMPTY ────────────────────────────────────────────────────────────────────────
// A failed read is a typed 503, never `[]` (an empty list is a claim). A write with no signer or no
// channel is a typed 503, never a silent failure: writes are refused BEFORE any ledger row, because
// nothing was attempted.
import { createHash, randomUUID } from "node:crypto";
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
import { check, checkActions, type Resource } from "../../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../../rbac/principal";
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
import { noteStagingStale } from "./site-builds.service";
import { previewPageState, previewUrlFor, stagingOriginOf } from "./webdesk-preview";

const logger = new Logger("WebdeskContent");

/** What a takedown of live content calls (WSK-60). Swappable so a test can make the mark fail. */
let markStagingStale: (tenantId: string, siteId: string) => Promise<void> = noteStagingStale;

/** Tests: replace the stale-staging marker (null restores the real one). */
export function setStagingStaleMarkerForTests(fn: ((tenantId: string, siteId: string) => Promise<void>) | null): void {
  markStagingStale = fn ?? noteStagingStale;
}

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
export function notConfigured(reason: string): ServiceUnavailableException {
  return new ServiceUnavailableException({ message: "webdesk_not_configured", reason });
}
export function invalidRequest(detail: string): BadRequestException {
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

export type ContentKind = "webdesk_content_item" | "webdesk_collection" | "webdesk_media_asset";
/** `upload` is `webdesk_media_asset`'s (WSK-43b: minting an upload token). */
export type ContentAction = "read" | "create" | "update" | "request_publish" | "unpublish" | "delete" | "apply_schema" | "upload"
  // M5-W2d: the editorial review actions (`webdesk_content_item`), and `webdesk_collection:manage_editorial` (the policy).
  | "submit" | "comment" | "request_changes" | "seo_signoff" | "approve" | "assign" | "manage_editorial";

/**
 * WSK-49c — the CLIENT context a gate carries when it was opened for a client editor (the portal BFF). Absent on every
 * staff gate, and absent means exactly what it meant before WSK-49: nothing below changes for a staff call.
 *
 * `clientId` is the client record the editor acts for. It is fed to Cerbos as `resource.attr.clientId`, where the
 * `client_website_editor` derived role matches it against the principal's OWN grants (server-derived), so a URL id the
 * caller made up matches nothing. `assertOwnsSite` is the second half and is supplied by the portal service
 * (`webdesk-client-website.service.ts`): in the request's tenant it resolves the caller's portal scope
 * (`resolvePortalScope`: the URL's client must be one of the caller's own) and loads the site -> client link
 * (`webdesk_site_clients`); anything but "this site is linked to this client" is a uniform 404 site-not-found. It runs
 * BEFORE the cross-company wall, so a client never probes another client's site, nor another company's.
 */
export interface ClientGateContext {
  readonly clientId: string;
  assertOwnsSite(site: SiteRef): Promise<void>;
  /** A request filed under this gate notifies staff deciders ("approval requested") unless this is false (a single-item self-publish). */
  readonly notifyDeciders?: boolean;
}

/** The four writers' room roles (design D1): grants stored as data, each with scope rows. */
const EDITORIAL_ROLES: readonly string[] = ["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer", "webdesk_editor"];

/**
 * M5-W1c: does this principal hold a writers' room grant? True on the role name OR on scope rows, so an unusual
 * grant takes the slow, attribute-aware path rather than the attribute-free fast deny. Pure.
 */
export function holdsEditorialGrant(principal: Principal): boolean {
  return principal.roles.some((g) => EDITORIAL_ROLES.includes(g.role) || (Array.isArray(g.editorialScopes) && g.editorialScopes.length > 0));
}

/** Proof that Cerbos allowed `principal` to run `action` on `kind` in company `tenantId`. Its constructor
 *  is private: `authorizeContent()` (the importer, the legacy company-level entry), `ContentGate.openSite()` (the
 *  HTTP content routes, phase 1) or `ContentGate.openClient()` (client editors) are the only ways to get one. */
export class ContentGate {
  private constructor(
    readonly principal: Principal,
    readonly tenantId: string,
    readonly kind: ContentKind,
    readonly action: ContentAction,
    readonly client?: ClientGateContext,
    /** M5-W1c: set by `openSite` (phase 1 passed for THIS route site id). Absent on a legacy or client gate. */
    readonly siteId?: string,
    /** M5-W1c: set by `openSites` for a principal whose reach is per site (`GET sites` filters by Cerbos per site). */
    readonly perSite?: boolean,
  ) {}

  /** @internal use `authorizeContent`. The attribute-free, company-level gate: the importer's and the legacy entry. */
  static async open(principal: Principal, tenantId: string, kind: ContentKind, action: ContentAction): Promise<ContentGate> {
    await authorize(principal, { kind, tenantId, module: "webdev" }, action);
    return new ContentGate(principal, tenantId, kind, action);
  }

  /**
   * M5-W1c PHASE 1 (the controller's first statement): `webdesk_collection:read` on {tenantId, module, siteId}, with the
   * site id from the ROUTE. Every writers' room grant that covers the site answers yes; every staff tier answers as it
   * always did. The gate then names the action the handler INTENDS (`kind`, `action`), which phase 2 checks with the item's
   * real attributes before anything is validated or sent.
   *
   * The route's site id is not yet proven to be this company's here (the wall runs next, and 404s a foreign pair); that
   * is safe because a grant's scope rows are matched against `tenantId` too (`g.scopeId == resource.attr.tenantId`), so
   * a site id can only ever match a row of THIS company's grant. Phase 2 uses the wall's own `site.siteId`.
   */
  static async openSite(principal: Principal, tenantId: string, siteId: string, kind: ContentKind, action: ContentAction): Promise<SiteGate> {
    await authorize(principal, { kind: "webdesk_collection", tenantId, module: "webdev", siteId }, "read");
    // The old first statement, kept for a principal no writers' room rule can match (see the header): denial before
    // any egress, exactly as before. Skipped when the phase-1 question WAS that question, and for a delegated call (the
    // acting human may hold a grant the caller does not).
    if (!(kind === "webdesk_collection" && action === "read") && !principal.actFor && !holdsEditorialGrant(principal)) {
      await authorize(principal, { kind, tenantId, module: "webdev" }, action);
    }
    return new ContentGate(principal, tenantId, kind, action, undefined, siteId) as SiteGate;
  }

  /**
   * M5-W1c: the gate of `GET …/content/sites`, which names no site. A principal with no writers' room grant gets the old
   * company-level `webdesk_collection:read` (403 on a denial, before any egress). A principal that holds one (or that is
   * delegating) is filtered per site by `WebdeskContentService.listSites`, which asks Cerbos for each site and answers 403
   * when none is readable; no company-level question is asked of it, so a scoped writer leaves no spurious denial row.
   */
  static async openSites(principal: Principal, tenantId: string): Promise<ContentGate> {
    if (principal.actFor || holdsEditorialGrant(principal)) {
      return new ContentGate(principal, tenantId, "webdesk_collection", "read", undefined, undefined, true);
    }
    await authorize(principal, { kind: "webdesk_collection", tenantId, module: "webdev" }, "read");
    return new ContentGate(principal, tenantId, "webdesk_collection", "read");
  }

  /**
   * WSK-49c: the client editor's gate. Cerbos FIRST (the client-editor rules: the `client_website_editor` derived role
   * against `clientId`), exactly like `open`. The gate then carries the client so every later authorisation names the
   * same client, every egress write is signed with the client marker (`ce`), and the site wall asks the link first.
   */
  static async openClient(
    principal: Principal,
    tenantId: string,
    kind: ContentKind,
    action: ContentAction,
    client: ClientGateContext,
  ): Promise<ContentGate> {
    await authorize(principal, { kind, tenantId, module: "webdev", clientId: client.clientId }, action);
    return new ContentGate(principal, tenantId, kind, action, client);
  }

  /** A method that needs `webdesk_content_item:update` cannot be driven with a `read` gate. */
  require(kind: ContentKind, action: ContentAction): this {
    if (this.kind !== kind || this.action !== action) {
      throw new InternalServerErrorException(`webdesk content gate mismatch: opened ${this.kind}:${this.action}, needed ${kind}:${action}`);
    }
    return this;
  }

  /** The Cerbos resource attribute for any later authorisation made under this gate (`{}` for staff). */
  clientAttr(): { clientId?: string } {
    return this.client ? { clientId: this.client.clientId } : {};
  }

  /** The egress marker for a write made under this gate (`{}` for staff): the signed assertion gets `ce: true`. */
  egressClient(): { clientEditor?: { clientId: string } } {
    return this.client ? { clientEditor: { clientId: this.client.clientId } } : {};
  }

  /** The cross-company wall, preceded in client mode by the client -> site link (uniform 404 for a site that is not theirs). */
  async resolveSite(zoneB: WebdeskZoneB, site: SiteRef): Promise<EditableSite> {
    if (this.client) await this.client.assertOwnsSite(site);
    return zoneB.resolveEditableSite(this.tenantId, site.tenantSlug, site.siteId);
  }
}

/** M5-W1c: a `ContentGate` that passed PHASE 1 for `siteId` (`ContentGate.openSite`). */
export type SiteGate = ContentGate & { readonly siteId: string };

/** The importer's and the legacy company-level gate: Cerbos, as the caller, module `webdev`, no site attributes. */
export const authorizeContent = ContentGate.open;
/** M5-W1c PHASE 1 of every HTTP content route (the controller's first statement). */
export const authorizeSite = ContentGate.openSite;
/** M5-W1c: the gate of `GET …/content/sites`. */
export const authorizeSites = ContentGate.openSites;

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

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEM_RE = /^[\x21-\x7e]{8,200}$/;
const SITE_CACHE_TTL_MS = 60_000;
const SITE_CACHE_REFETCH_ON_MISS_MS = 5_000;
const ITEM_READ_CONCURRENCY = 8;
const REQUEST_STATUSES: readonly string[] = ["pending", "approved", "rejected", "cancelled", "all"];

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function strictBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
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
  command: WebdeskBffEditorialCommand | "schema.apply" | "site.provision" | "forms.define" | "tenant.provision" | "contract.regenerate";
  /** `webdesk.content.update` etc. */
  verb: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  params: Record<string, string>;
  /** Omitted for a body-less write (WSK-43b's `media.delete`): no body is sent, and Zone B hashes the params alone. */
  body?: Record<string, unknown>;
  idempotencyKey: string;
  /** Present for the editorial commands only (schema.apply, site.provision and forms.define carry none: design §3.1). */
  editorial?: { tenantSlug: string; siteId: string };
  /** WSK-49c: set only by a client-mode call. The editorial assertion then carries `ce: true` (WebDesk's client-editor
   *  marker, WSK-D59/D62), and both ledger rows say so. It only ever RESTRICTS what WebDesk accepts; a staff call omits it. */
  clientEditor?: { clientId: string };
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
          ...(w.clientEditor ? { ce: true } : {}),
        });
      } catch (err) {
        if (err instanceof EditorialSignerNotConfiguredError) throw notConfigured("editorial_signer_not_configured");
        logger.error(`editorial signer failed: ${(err as Error)?.name ?? "error"}`);
        throw notConfigured("editorial_signer_failed");
      }
    }

    const base = {
      command: w.command,
      idempotencyKey: w.idempotencyKey,
      ...w.ledger,
      ...(w.clientEditor ? { clientEditor: true, clientId: w.clientEditor.clientId } : {}),
    };
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

/** Module-private brand: a value carrying it was built from a WebDesk read (`parseItemAttrs`), nowhere else. */
const FROM_WEBDESK: unique symbol = Symbol("webdesk-read");

/** WebDesk's review states (`editorial_items.state`); anything else reads as "" and fails every rule closed. */
const REVIEW_STATES: readonly string[] = ["draft", "in_review", "changes_requested", "approved"];

/** One item as WebDesk's `item.get` reported it. Only `parseItemAttrs` builds one (the brand is module-private). */
interface ItemAttrs {
  readonly [FROM_WEBDESK]: true;
  collectionKey: string;
  locale: string;
  deletedAt: string | null;
  contentHash: string | null;
  headVersion: number | null;
  publishedVersion: number | null;
  /** M5-W1c: `editorial.authorSub`, the Cerbos `ownerId`. "" when WebDesk named none (a legacy item): nobody owns it. */
  ownerId: string;
  /** M5-W1c: `editorial.state`; "" when WebDesk sent no usable one (an older WebDesk): the review rules deny. */
  reviewState: string;
  /** M5-W1c: `publishedVersion !== null`. */
  published: boolean;
  /** M5-W2d: the item's title as WebDesk reported it (a notification names the item by it; never a body). */
  itemTitle: string | null;
  /** M5-W1c: `editorial.submittedVersion` (the version an approval would be about), when WebDesk sent one. */
  submittedVersion: number | null;
  /** M5-W1c: the creator (`created_by`) of the version this read selected, and of the head: the Cerbos `creatorId` of `approve`. */
  selectedCreatedBy: string | null;
  selectedVersion: number | null;
  headCreatedBy: string | null;
  /** M5-W2c: `item.get`'s `editorial` member, narrowed to what the publish request's early refusal reads.
   *  null when WebDesk sent none (a WebDesk older than M5-W2b) or an unusable one: no early refusal is
   *  possible then, and WebDesk's own gate still refuses at execution. */
  review: { required: boolean; approvedVersion: number | null } | null;
}

/** `collection.get` answered 200: the route's collection key exists on this site. Built only by `proveCollection`. */
interface CollectionProof {
  readonly [FROM_WEBDESK]: true;
  readonly collectionKey: string;
}

/** The actions `allowed` reports on an item (one Cerbos batch). `publish`/`schedule` are decide()-only and are not listed. */
export const ITEM_ALLOWED_ACTIONS = [
  "read", "update", "submit", "comment", "request_changes", "seo_signoff", "approve", "assign", "request_publish", "unpublish", "delete",
] as const;

/**
 * M5-W1c PHASE 2: proof that Cerbos allowed `gate`'s principal to run `action` on ONE item (or, for a `create`, on the
 * item about to exist) with attributes that came from the route and from WebDesk, never from a body or a query. The
 * constructor is private and its factories demand a value built from a WebDesk read (`ItemAttrs`, `CollectionProof`,
 * brands this module does not export), so a method that sends a write cannot be reached without the read and the check.
 */
export class ItemGate {
  private constructor(
    readonly gate: ContentGate,
    readonly site: SiteRef,
    readonly action: ContentAction,
    /** The item acted on; null for a `create`. */
    readonly itemId: string | null,
    readonly collectionKey: string,
    readonly locale: string,
    /** The WebDesk read behind the check (null for a `create`). */
    readonly attrs: ItemAttrs | null,
  ) {}

  /** The Cerbos resource, shared by the check and by `allowed` so the two can never disagree about an attribute. */
  static resourceOf(gate: ContentGate, siteId: string, itemId: string | null, a: { collectionKey: string; locale: string; ownerId?: string; reviewState?: string; published?: boolean; creatorId?: string }): Resource {
    return {
      kind: "webdesk_content_item",
      tenantId: gate.tenantId,
      module: "webdev",
      ...(itemId !== null ? { id: itemId } : {}),
      siteId,
      collectionKey: a.collectionKey,
      locale: a.locale,
      ...(a.ownerId !== undefined ? { ownerId: a.ownerId } : {}),
      ...(a.reviewState !== undefined ? { reviewState: a.reviewState } : {}),
      ...(a.published !== undefined ? { published: a.published } : {}),
      ...(a.creatorId !== undefined ? { creatorId: a.creatorId } : {}),
      ...gate.clientAttr(),
    };
  }

  /** @internal an existing item, from its `item.get`. `siteId` is the wall's own (`EditableSite.site.siteId`). */
  static async forItem(gate: ContentGate, site: SiteRef, siteId: string, itemId: string, action: ContentAction, attrs: ItemAttrs, creatorId?: string): Promise<ItemGate> {
    await authorize(gate.principal, ItemGate.resourceOf(gate, siteId, itemId, creatorId === undefined ? attrs : { ...attrs, creatorId }), action);
    return new ItemGate(gate, site, action, itemId, attrs.collectionKey, attrs.locale, attrs);
  }

  /**
   * @internal an item about to be created. `proof` is `collection.get` for the ROUTE's key; `locale` is the body's
   * (WebDesk validates it against the tenant's locales). For a locale twin `twin` is the SOURCE item's read, and the
   * review state and `published` describe the source (design 2.3); a fresh item carries neither.
   */
  static async forCreate(gate: ContentGate, site: SiteRef, siteId: string, proof: CollectionProof, locale: string, twin: ItemAttrs | null): Promise<ItemGate> {
    const twinOk = twin !== null && twin.collectionKey === proof.collectionKey;
    await authorize(
      gate.principal,
      ItemGate.resourceOf(gate, siteId, null, {
        collectionKey: proof.collectionKey,
        locale,
        ...(twinOk ? { reviewState: twin.reviewState, published: twin.published } : {}),
      }),
      "create",
    );
    return new ItemGate(gate, site, "create", null, proof.collectionKey, locale, null);
  }
}

/** `item.get`'s answer as the Cerbos attributes and the review facts the BFF reads. The ONLY constructor of `ItemAttrs`. */
function parseItemAttrs(body: unknown): ItemAttrs {
  const root = isPlainObject(body) ? body : {};
  const item = isPlainObject(root.item) ? root.item : null;
  if (!item || typeof item.collectionKey !== "string" || typeof item.locale !== "string") {
    throw new BadGatewayException({ message: "webdesk_error", reason: "item_shape" });
  }
  const v = isPlainObject(root.version) ? root.version : null;
  const ed = isPlainObject(root.editorial) ? root.editorial : null;
  const approved = ed?.approvedVersion;
  const submitted = ed?.submittedVersion;
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) ? x : null);
  return {
    [FROM_WEBDESK]: true,
    review:
      ed && typeof ed.reviewRequired === "boolean" && (approved === null || (typeof approved === "number" && Number.isInteger(approved)))
        ? { required: ed.reviewRequired, approvedVersion: approved as number | null }
        : null,
    collectionKey: item.collectionKey,
    locale: item.locale,
    deletedAt: typeof item.deletedAt === "string" ? item.deletedAt : null,
    contentHash: v && typeof v.contentHash === "string" ? v.contentHash : null,
    headVersion: typeof item.headVersion === "number" ? item.headVersion : null,
    publishedVersion: typeof item.publishedVersion === "number" ? item.publishedVersion : null,
    ownerId: ed && typeof ed.authorSub === "string" ? ed.authorSub : "",
    reviewState: ed && typeof ed.state === "string" && REVIEW_STATES.includes(ed.state) ? ed.state : "",
    published: typeof item.publishedVersion === "number",
    itemTitle: typeof item.title === "string" ? item.title.slice(0, 120) : null,
    submittedVersion: num(submitted),
    selectedCreatedBy: v && typeof v.createdBy === "string" ? v.createdBy : null,
    selectedVersion: v ? num(v.version) ?? num(v.n) : null,
    headCreatedBy: typeof item.headCreatedBy === "string" ? item.headCreatedBy : null,
  };
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
    if (!gate.perSite) return r;

    // M5-W1c: a principal whose reach is per site (a writers' room grant, or a delegated call) sees only the sites Cerbos
    // lets it read. The wall's cache above keeps the FULL answer (authorization is a separate question from "is this the
    // company's site"). Probes use `check`, not `authorize`, so the sites it may NOT read leave no denial rows.
    if (!tenants) throw new BadGatewayException({ message: "webdesk_error", reason: "tenant_list_shape" });
    const principal = gate.principal;
    if (await probeAllowed(principal, { kind: "webdesk_collection", tenantId: gate.tenantId, module: "webdev" }, "read")) {
      await authorize(principal, { kind: "webdesk_collection", tenantId: gate.tenantId, module: "webdev" }, "read");
      return r; // a company-level reader (a staff tier acting through a delegation): every site, as before
    }
    const siteIds = tenants.flatMap((t) => t.sites.map((s) => s.siteId));
    const verdicts = await mapPool(siteIds, ITEM_READ_CONCURRENCY, async (siteId) => ({
      siteId,
      ok: await probeAllowed(principal, { kind: "webdesk_collection", tenantId: gate.tenantId, module: "webdev", siteId }, "read"),
    }));
    const readable = new Set(verdicts.filter((v) => v.ok).map((v) => v.siteId));
    if (readable.size === 0) {
      // Nothing readable: the ordinary denial (and its audit row), never an empty list (an empty list is a claim).
      await authorize(principal, { kind: "webdesk_collection", tenantId: gate.tenantId, module: "webdev" }, "read");
      return r;
    }
    // The real check for one readable site: the session (D11) and the delegation's second look, with the usual audit.
    await authorize(principal, { kind: "webdesk_collection", tenantId: gate.tenantId, module: "webdev", siteId: [...readable][0] }, "read");
    const body = r.body as Record<string, unknown>;
    return {
      status: r.status,
      body: {
        ...body,
        tenants: tenants
          .map((t) => ({ ...t, sites: t.sites.filter((s) => readable.has(s.siteId)) }))
          .filter((t) => t.sites.length > 0),
      },
    };
  }

  async listCollections(gate: ContentGate, site: SiteRef): Promise<ZoneBResult> {
    gate.require("webdesk_collection", "read");
    await gate.resolveSite(this.zoneB, site);
    return this.zoneB.read({
      command: "collection.list",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
    });
  }

  async listItems(gate: ContentGate, site: SiteRef, collectionKey: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    // PHASE 2 (before the query is validated): reading a collection's items. `collectionKey` is the route's (WebDesk 404s
    // `collection-not-found` for one that does not exist, so a forged key reads nothing); no locale: reading is any-locale.
    await authorize(gate.principal, ItemGate.resourceOf(gate, editable.site.siteId, null, { collectionKey, locale: "" }), "read");
    const { slug, ...query } = strictQuery(rawQuery, ["locale", "state", "q", "includeDeleted", "cursor", "limit", "slug"]);
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
    const editable = await gate.resolveSite(this.zoneB, site);
    // PHASE 2 (before the query is validated): the item's HEAD is read for the attributes. The `version` query selects
    // which VERSION is returned, never an attribute, and is only forwarded after the check.
    const head = await this.readItemRaw(site, itemId);
    await ItemGate.forItem(gate, site, editable.site.siteId, itemId, "read", head.attrs);
    const query = strictQuery(rawQuery, ["version"]);
    const res = query.version === undefined ? head.result : (await this.readItemRaw(site, itemId, query.version)).result;
    // `allowed` is the staff editor's: a client editor's answer is its own portal contract and stays as it was.
    return gate.client ? res : this.withAllowed(gate, site, editable.site.siteId, itemId, head.attrs, res);
  }

  /**
   * M5-W1c: `allowed: { <action>: boolean }` on the item read, from ONE Cerbos batch (`checkActions`) on the SAME resource
   * the real handlers authorise (`ItemGate.resourceOf`): the UI follows it instead of guessing from bundles
   * (PERMISSION-CONTRACT 5). ADVISORY: each real action still runs its own check. Absent (never `false`) when Cerbos could
   * not answer or the call is delegated (a batch cannot intersect the acting human's rights), so an unknown is not a denial.
   * `approve`'s `creatorId` is the creator of the version an approval would be about (the SUBMITTED version): read from the
   * answer in hand, or from one more `item.get` when the submitted version is neither the one selected nor the head.
   */
  private async withAllowed(gate: ContentGate, site: SiteRef, siteId: string, itemId: string, attrs: ItemAttrs, res: ZoneBResult): Promise<ZoneBResult> {
    if (!isPlainObject(res.body) || gate.principal.actFor) return res;
    try {
      const creatorId = await this.approvalCreatorId(site, itemId, attrs);
      const got = await checkActions(
        gate.principal,
        ItemGate.resourceOf(gate, siteId, itemId, { collectionKey: attrs.collectionKey, locale: attrs.locale, ownerId: attrs.ownerId, reviewState: attrs.reviewState, published: attrs.published, creatorId }),
        ITEM_ALLOWED_ACTIONS,
      );
      return { status: res.status, body: { ...res.body, allowed: got } };
    } catch (err) {
      logger.warn(`item allowed unavailable: ${(err as Error).message}`);
      return res;
    }
  }

  /**
   * M5-W1c/W2d: the Cerbos `creatorId` of `approve`: the creator (`created_by`) of the version an approval would be about, i.e.
   * the SUBMITTED version of an item in review (design 2.3, 4.4), read from the answer in hand or from one more `item.get`.
   * "" when the item is not in review or WebDesk named no creator: the policy then denies (four eyes cannot be shown).
   */
  private async approvalCreatorId(site: SiteRef, itemId: string, attrs: ItemAttrs): Promise<string> {
    if (attrs.reviewState !== "in_review" || attrs.submittedVersion === null) return "";
    if (attrs.submittedVersion === attrs.selectedVersion && attrs.selectedCreatedBy) return attrs.selectedCreatedBy;
    if (attrs.submittedVersion === attrs.headVersion && attrs.headCreatedBy) return attrs.headCreatedBy;
    return (await this.readItemRaw(site, itemId, String(attrs.submittedVersion))).attrs.selectedCreatedBy ?? "";
  }

  /**
   * M5-W2d PHASE 2 of an editorial item command (`webdesk-editorial.service.ts`): the cross-company wall, then WebDesk's
   * `item.get`, then the REAL action with the item's attributes (`ownerId`, `reviewState`, `published`, collection and
   * locale from WebDesk; for `approve` also `creatorId`, the creator of the submitted version, never the body's).
   * Runs BEFORE the body is looked at, so a denied caller is 403 whatever it sent and nothing is written.
   */
  async openEditorialItem(gate: ContentGate, site: SiteRef, itemId: string, action: ContentAction): Promise<ItemGate> {
    const editable = await gate.resolveSite(this.zoneB, site);
    const { attrs } = await this.readItemRaw(site, itemId);
    const creatorId = action === "approve" ? await this.approvalCreatorId(site, itemId, attrs) : undefined;
    return ItemGate.forItem(gate, site, editable.site.siteId, itemId, action, attrs, creatorId);
  }

  async listVersions(gate: ContentGate, site: SiteRef, itemId: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    await ItemGate.forItem(gate, site, editable.site.siteId, itemId, "read", (await this.readItemRaw(site, itemId)).attrs); // PHASE 2
    const query = strictQuery(rawQuery, ["cursor", "limit"]);
    return this.zoneB.read({
      command: "item.versions",
      path: `${ITEM_PATH}/versions`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      query,
    });
  }

  async getVersion(gate: ContentGate, site: SiteRef, itemId: string, n: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    await ItemGate.forItem(gate, site, editable.site.siteId, itemId, "read", (await this.readItemRaw(site, itemId)).attrs); // PHASE 2
    strictQuery(rawQuery, []);
    return this.zoneB.read({
      command: "item.versionGet",
      path: `${ITEM_PATH}/versions/:n`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId, n },
    });
  }

  // The media library's reads and writes (`media.list` and the rest) moved to `webdesk-media.service.ts` in
  // WSK-43b, authorised as `webdesk_media_asset` rather than `webdesk_content_item:read`.

  // ── writes: create ───────────────────────────────────────────────────────────────────────────

  async createItem(
    gate: ContentGate,
    site: SiteRef,
    collectionKey: string,
    rawBody: unknown,
    idempotencyKey: string,
  ): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "create");
    const editable = await gate.resolveSite(this.zoneB, site);
    // PHASE 2, before the body is validated. The collection must exist on THIS site (a typed 404 `collection-not-found`
    // passes through): that proves the ROUTE's key. The locale is the body's, read leniently (WebDesk validates it
    // against the tenant's locales, and a body that is not an object yields "" and is refused below). For a locale twin
    // the SOURCE item is read from WebDesk and its review state and `published` are what the check sees (design 2.3); the
    // body only names which source. Nothing else the body carries (siteId, collectionKey, ownerId, reviewState...) is read.
    const proof = await this.proveCollection(site, collectionKey);
    const raw = isPlainObject(rawBody) ? rawBody : {};
    const twinId = typeof raw.twinOf === "string" && UUID_RE.test(raw.twinOf) ? raw.twinOf.toLowerCase() : null;
    // (Only a principal a writers' room rule can match, or a delegated call, has any use for the source's state: the
    // staff tiers read neither attribute, so for them the read would be an egress call that changes no decision.)
    const twinMatters = twinId !== null && (holdsEditorialGrant(gate.principal) || gate.principal.actFor !== undefined);
    const twin = twinMatters ? (await this.readItemRaw(site, twinId as string)).attrs : null;
    const itemGate = await ItemGate.forCreate(gate, site, editable.site.siteId, proof, typeof raw.locale === "string" ? raw.locale : "", twin);

    const b = strictBody(rawBody, ["collectionKey", "locale", "slug", "twinOf", "fields", "blocks", "seo", "note"]);
    // The route's collection is the authority. A body that names a different one is a mistake, not a redirect.
    if (b.collectionKey !== undefined && b.collectionKey !== collectionKey) {
      throw invalidRequest("collectionKey in the body does not match the collection in the path");
    }
    return this.sendCreate(itemGate, b, idempotencyKey);
  }

  /** `collection.get`: the route's collection key exists on this site. The only builder of a `CollectionProof`. */
  private async proveCollection(site: SiteRef, collectionKey: string): Promise<CollectionProof> {
    await this.zoneB.read({
      command: "collection.get",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, key: collectionKey },
    });
    return { [FROM_WEBDESK]: true, collectionKey };
  }

  /** The create write. Needs an `ItemGate` (phase 2 passed for this collection and locale). */
  private sendCreate(g: ItemGate, b: Record<string, unknown>, idempotencyKey: string): Promise<ZoneBResult> {
    const { gate, site, collectionKey } = g;
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
      ...gate.egressClient(),
      entity: { type: "webdesk_content_item", id: null },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, collectionKey, locale: g.locale || null, slug: typeof b.slug === "string" ? b.slug : null },
      reconcile: this.reconcileCreate(site, collectionKey, gate.principal.userId as string, b.locale, b.slug),
    });
  }

  // ── writes on an existing item ───────────────────────────────────────────────────────────────

  /** PHASE 2 for an existing item: read it from Zone B, authorise the ACTION with ITS attributes (never the body's or the query's). */
  private async openItemGate(gate: ContentGate, site: SiteRef, editable: EditableSite, itemId: string, action: ContentAction): Promise<ItemGate> {
    const { attrs } = await this.readItemRaw(site, itemId);
    return ItemGate.forItem(gate, site, editable.site.siteId, itemId, action, attrs);
  }

  /** `item.get` (the head, or `version`): the answer as it came, and the Cerbos attributes and review facts read from it. */
  private async readItemRaw(site: SiteRef, itemId: string, version?: string): Promise<{ result: ZoneBResult; attrs: ItemAttrs }> {
    const result = await this.zoneB.read({
      command: "item.get",
      path: ITEM_PATH,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      ...(version !== undefined ? { query: { version } } : {}),
    });
    return { result, attrs: parseItemAttrs(result.body) };
  }

  private async readItemAttrs(site: SiteRef, itemId: string, version?: string): Promise<ItemAttrs> {
    return (await this.readItemRaw(site, itemId, version)).attrs;
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
    const editable = await gate.resolveSite(this.zoneB, site);
    // PHASE 2 first (the item read and the real action), THEN the body: a denied caller is 403 whatever it sent.
    const itemGate = await this.openItemGate(gate, site, editable, itemId, action);
    const body = strictBody(spec.rawBody, spec.allowed);
    return this.sendItemWrite(itemGate, body, spec);
  }

  /** An existing item's write. Needs an `ItemGate`: the WebDesk read and the check cannot be skipped to reach it. */
  private async sendItemWrite(
    g: ItemGate,
    body: Record<string, unknown>,
    spec: { command: WebdeskBffEditorialCommand; method: "POST" | "PUT"; suffix: string; idempotencyKey: string; reconcile: (sub: string, body: Record<string, unknown>, before: ItemAttrs) => () => Promise<ZoneBResult | null> },
  ): Promise<ZoneBResult> {
    const { gate, site, action } = g;
    const itemId = g.itemId as string;
    const attrs = g.attrs as ItemAttrs;
    const result = await this.zoneB.write(gate.principal, gate.tenantId, {
      command: spec.command,
      verb: `webdesk.${spec.command}`,
      method: spec.method,
      path: `${ITEM_PATH}${spec.suffix}`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      body,
      idempotencyKey: spec.idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      ...gate.egressClient(),
      entity: { type: "webdesk_content_item", id: UUID_RE.test(itemId) ? itemId : null },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId, collectionKey: attrs.collectionKey, locale: attrs.locale },
      reconcile: spec.reconcile(gate.principal.userId as string, body, attrs),
    });
    // Reached only on success (a plain 2xx, a replay, or a reconciled ambiguous write): every failure threw above.
    if ((action === "unpublish" || action === "delete") && attrs.publishedVersion !== null) {
      await this.noteTakedown(gate.tenantId, site.siteId, spec.command);
    }
    return result;
  }

  /** WSK-60, best-effort (see the header): the takedown already happened in Zone B, so a failed mark is logged, never thrown. */
  private async noteTakedown(tenantId: string, siteId: string, command: string): Promise<void> {
    try {
      // The build-status route reads the mark under the lowercased site id; write it under the same one.
      await markStagingStale(tenantId, siteId.toLowerCase());
    } catch (err) {
      logger.error(
        `${command}: staging could not be marked stale (${(err as Error)?.message ?? "error"}); ` +
          "the editor will not show the stale-staging banner until the next rebuild",
      );
    }
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

  // ── preview: mint a one-time capability link to a DRAFT ─────────────────────────────────────
  //
  // `POST …/items/:itemId/preview` body `{ version? }` -> 200 `{ previewUrl, expiresAt, version }`.
  //
  // A preview link DISCLOSES AN UNPUBLISHED DRAFT to whoever holds it, so it is authorised as the item's existing
  // `update` action (never `read`): the same people who may change the draft may share it. No new Cerbos action.
  // Zone B's `content.previewToken` is MEDIUM and editorial, so it signs and ledgers like the other writes.
  //
  // ORDER (each step is a refusal that mints NOTHING):
  //   gate (the controller's first statement, M5-W1c phase 1) -> the cross-company wall (404) -> the item read from
  //   Zone B and `update` authorised with its real attributes (phase 2: a denied caller is 403 whatever it sent, and
  //   triggers no probe of the site) -> body -> the site's staging base (409 `preview_not_configured`) -> the site's
  //   `/preview/` page exists (409 `preview_page_missing`; 502 `preview_site_unreachable` when that cannot be told) ->
  //   a requested version exists (404 `version-not-found`) -> mint.
  //
  // THE TOKEN IS A ONE-TIME SECRET. It is in Zone B's response and in the returned `previewUrl`'s FRAGMENT
  // (`<staging>/preview/#t=<token>`; a fragment is never sent to a server or in a Referer), and nowhere else:
  // not the ledger rows (they carry identifiers and the outcome), not a log line, not an error message.
  // A replay of the same Idempotency-Key is Zone B's 409 `idempotency-response-withheld` (it never stores the
  // token), so a caller that needs another link mints again under a NEW key.
  async previewItem(gate: ContentGate, site: SiteRef, itemId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "update");
    const editable = await gate.resolveSite(this.zoneB, site);
    const itemGate = await this.openItemGate(gate, site, editable, itemId, "update"); // PHASE 2, before the body
    const b = strictBody(rawBody === undefined || rawBody === null ? {} : rawBody, ["version"]);
    let version: number | undefined;
    if (b.version !== undefined && b.version !== null) {
      if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1 || b.version > 2_147_483_647) {
        throw invalidRequest("version must be an integer >= 1 (omit it to preview the item's head version)");
      }
      version = b.version;
    }

    const origin = stagingOriginOf(editable.site);
    if (origin === null) {
      throw new ConflictException({ message: "Preview isn't set up for this site yet", reason: "preview_not_configured" });
    }
    const page = await previewPageState(origin);
    if (page === "missing") {
      throw new ConflictException({ message: "This site doesn't have a preview page yet", reason: "preview_page_missing" });
    }
    if (page === "unknown") {
      throw new BadGatewayException({ message: "The site didn't answer, so a preview link can't be made right now", reason: "preview_site_unreachable" });
    }

    // A requested version must exist (404 `version-not-found` passes through). Attributes were settled by the head read above.
    const attrs = version === undefined ? (itemGate.attrs as ItemAttrs) : await this.readItemAttrs(site, itemId, String(version));
    if (attrs.deletedAt !== null) {
      throw new WebdeskProblem(409, {
        type: "https://webdesk.gaiada.online/errors/item-deleted",
        title: "Item deleted",
        status: 409,
        detail: "This item has been deleted, so there is nothing to preview.",
      });
    }

    const minted = await this.zoneB.write(gate.principal, gate.tenantId, {
      command: "content.previewToken",
      verb: "webdesk.content.previewToken",
      method: "POST",
      path: `${ITEM_PATH}/preview-token`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId },
      body: version === undefined ? {} : { version },
      idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      ...gate.egressClient(),
      entity: { type: "webdesk_content_item", id: UUID_RE.test(itemId) ? itemId : null },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, itemId, collectionKey: attrs.collectionKey, locale: attrs.locale, requestedVersion: version ?? null },
      // No `reconcile`: a mint that may have landed leaves nothing to read back (the token is shown once and never
      // stored), so an ambiguous answer is the typed 502 `webdesk_ambiguous` and the caller simply mints again.
    });
    const r = minted.body as Record<string, unknown>;
    if (typeof r.token !== "string" || r.token === "" || typeof r.expiresAt !== "string" || typeof r.version !== "number") {
      // Name the shape, never the value: the body may hold the token.
      throw new BadGatewayException({ message: "webdesk_error", reason: "preview_shape" });
    }
    return { status: 200, body: { previewUrl: previewUrlFor(origin, r.token), expiresAt: r.expiresAt, version: r.version } };
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
    const editable = await gate.resolveSite(this.zoneB, site);
    // PHASE 2, before the body is validated: the items the body NAMES are read from WebDesk (the body only selects which
    // items; every attribute comes from the read) and `request_publish` is checked for each distinct (collection, locale,
    // author, review state, live) tuple. A body that names no readable item (malformed) is checked at site level, which a
    // staff tier passes and a scoped editor (whose rules need a collection) does not: 403 before the 400.
    const refs = lenientPublishRefs(rawBody);
    const preReads = await mapPool(refs, ITEM_READ_CONCURRENCY, (it) => this.readItemAttrs(site, it.itemId, String(it.version)));
    const itemResources = await this.authorizePublishTuples(gate, editable.site.siteId, preReads);
    const b = strictBody(rawBody, ["items", "publishAt", "unpublishAt", "note"]);
    const items = parsePublishItems(b.items);
    const publishAt = optInstant(b.publishAt, "publishAt");
    const unpublishAt = optInstant(b.unpublishAt, "unpublishAt");
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) {
      throw invalidRequest("note must be a string of at most 500 characters");
    }
    const scheduled = publishAt !== null || unpublishAt !== null;
    if (scheduled && b.note !== undefined) throw invalidRequest("a scheduled request takes no note");
    if (scheduled && gate.client) {
      // WSK-49c, defence in depth: the portal service already refuses a scheduled request, and WebDesk would too
      // (`content.schedule` is not on a client's allow-list), but this method must not file one under a client gate.
      throw new WebdeskProblem(403, {
        type: "https://webdesk.gaiada.online/errors/client-command-not-allowed",
        title: "Command not allowed for a client editor",
        status: 403,
        detail: "A client editor may not run content.schedule. Nothing was filed.",
      });
    }

    // Read every item at the requested version (bounded concurrency): proves it exists on THIS site and
    // is not deleted, and yields what Cerbos and the approver need. A typed 404/409 passes through.
    const preRead = new Map(refs.map((r, i) => [r.itemId.toLowerCase(), { version: r.version, attrs: preReads[i] }]));
    const reads = await mapPool(items, ITEM_READ_CONCURRENCY, async (it) => {
      const hit = preRead.get(it.itemId.toLowerCase());
      return hit && hit.version === it.version ? hit.attrs : this.readItemAttrs(site, it.itemId, String(it.version));
    });
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
      counts[attrs.collectionKey] = (counts[attrs.collectionKey] ?? 0) + 1;
    });
    // M5-W2c — the EARLY refusal (writers' room design 4.5): on a review-required collection only the exact approved
    // version can go live, and WebDesk refuses anything else inside the publish transaction. Saying so here, with
    // WebDesk's own problem, spares the publisher an approval that could only fail. AFTER authorization (a caller
    // who may not request a publish learns nothing about review state). A takedown-only schedule puts nothing live,
    // so it is not gated. Advisory only: WebDesk's gate is the authority (the review state can still move between
    // this read and the execution, and the M1 importer files approvals without passing here).
    if (publishAt !== null || !scheduled) {
      const refused = reads.flatMap((attrs, i) =>
        attrs.review?.required === true && attrs.review.approvedVersion !== items[i].version
          ? [{ itemIndex: i, itemId: items[i].itemId, version: items[i].version, approvedVersion: attrs.review.approvedVersion }]
          : [],
      );
      if (refused.length > 0) throw reviewNotApproved(refused);
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
      ...(gate.client ? { client: { clientId: gate.client.clientId, notifyDeciders: gate.client.notifyDeciders } } : {}),
      // The filer's own defence-in-depth check asks about the SAME attribute-carrying resources phase 2 did (a scoped editor
      // is matched by site/collection/locale, which the attribute-free resource lacks). Empty = absent there.
      itemResources,
    });
    return { status: 202, body: { approvalId, command, itemCount: n } };
  }

  /**
   * `request_publish` for each distinct tuple of attributes among `reads` (bounded concurrency); with no reads, at site level.
   * Returns the resources it asked about (empty for the site-level ask), which the filing function re-uses for its own check.
   */
  private async authorizePublishTuples(gate: ContentGate, siteId: string, reads: readonly ItemAttrs[]): Promise<Resource[]> {
    if (reads.length === 0) {
      await authorize(gate.principal, ItemGate.resourceOf(gate, siteId, null, { collectionKey: "", locale: "" }), "request_publish");
      return [];
    }
    const tuples = new Map<string, ItemAttrs>();
    for (const a of reads) tuples.set(JSON.stringify([a.collectionKey, a.locale, a.ownerId, a.reviewState, a.published]), a);
    const resources = [...tuples.values()].map((a) =>
      ItemGate.resourceOf(gate, siteId, null, { collectionKey: a.collectionKey, locale: a.locale, ownerId: a.ownerId, reviewState: a.reviewState, published: a.published }),
    );
    await mapPool(resources, ITEM_READ_CONCURRENCY, (r) => authorize(gate.principal, r, "request_publish"));
    return resources;
  }

  /**
   * `GET …/publish-requests[?status=pending|approved|rejected|cancelled|all]` (default `pending`) →
   * `{requests:[{approvalId, status, createdAt, itemIds, items:[{itemId,version}], executionStatus}]}`: the CALLER'S OWN publish/schedule
   * approvals for THIS site, newest first, at most 100. WSK-44b: the editor's "pending request after reload" read.
   * `GET /api/:t/automation-approvals?origin=webdesk` needs `automation_approval:read` (company_admin/manager only),
   * so a `webdev_staff` editor got 403 on it and could not see the request they had filed. This is authorised as
   * the SAME right that filed it (`webdesk_content_item:request_publish`), behind the same cross-company wall, and
   * can only ever return rows where `requested_by` is the caller: it widens nothing (no other user's request, no
   * other origin, no other site is reachable). `executionStatus` is the approval's `execution_status` column.
   */
  async listOwnPublishRequests(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "request_publish");
    const query = strictQuery(rawQuery, ["status"]);
    const status = query.status ?? "pending";
    if (!REQUEST_STATUSES.includes(status)) {
      throw invalidRequest(`status must be one of ${REQUEST_STATUSES.join(", ")}`);
    }
    await gate.resolveSite(this.zoneB, site);
    const params: unknown[] = [gate.principal.userId, site.tenantSlug, site.siteId];
    if (status !== "all") params.push(status);
    const found = await withTenants([gate.tenantId], (c) =>
      c.query<{ id: string; status: string; created_at: Date | string; execution_status: string | null; tool_args: Record<string, unknown> | null }>(
        `SELECT id, status, created_at, execution_status, tool_args FROM automation_approvals
          WHERE origin = 'webdesk' AND deleted_at IS NULL AND requested_by = $1
            AND workflow_id IN ('content.publish', 'content.schedule')
            AND tool_args->>'tenantSlug' = $2 AND tool_args->>'siteId' = $3
            ${status !== "all" ? "AND status = $4" : ""}
          ORDER BY created_at DESC, id DESC LIMIT 100`,
        params,
      ),
    );
    const requests = found.rows.map((r) => {
      const items = Array.isArray(r.tool_args?.items) ? (r.tool_args?.items as unknown[]) : [];
      return {
        approvalId: r.id,
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
        itemIds: items.flatMap((i) => (isPlainObject(i) && typeof i.itemId === "string" ? [i.itemId] : [])),
        items: items.flatMap((i) =>
          isPlainObject(i) && typeof i.itemId === "string" && typeof i.version === "number" && Number.isInteger(i.version) && i.version > 0
            ? [{ itemId: i.itemId, version: i.version }]
            : [],
        ),
        executionStatus: r.execution_status ?? null,
      };
    });
    return { status: 200, body: { requests } };
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
    await gate.resolveSite(this.zoneB, site);
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

/** WebDesk's 409 `review-not-approved` (M5-W2c), restated by the BFF for the early refusal: the SAME problem type and
 *  members WebDesk answers with (`items[{itemIndex,itemId,version,approvedVersion}]`, `total`), so the editor, the MCP
 *  tool and a failed approval row all name one slug. */
function reviewNotApproved(refused: Array<{ itemIndex: number; itemId: string; version: number; approvedVersion: number | null }>): WebdeskProblem {
  const n = refused.length;
  return new WebdeskProblem(409, {
    type: "https://webdesk.gaiada.online/errors/review-not-approved",
    title: "Review not approved",
    status: 409,
    detail:
      `Editorial review is required for ${n === 1 ? "this item's collection" : "these items' collections"}, and ` +
      `${n === 1 ? "the version asked for is not the approved version" : `${n} of the versions asked for are not the approved versions`}. ` +
      "Only the exact approved version can be published. No approval was filed.",
    items: refused.slice(0, 50),
    total: n,
  });
}

// ── small parsers ──────────────────────────────────────────────────────────────────────────────────

export function parsePublishItems(raw: unknown): Array<{ itemId: string; version: number }> {
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

/** The `{itemId, version}` pairs a publish-request body names, read LENIENTLY (malformed entries skipped, duplicates dropped, at most 1000):
 *  only used to know which items to read for phase 2. The strict parse (`parsePublishItems`) still decides whether the body is valid. */
function lenientPublishRefs(raw: unknown): Array<{ itemId: string; version: number }> {
  if (!isPlainObject(raw) || !Array.isArray(raw.items)) return [];
  const seen = new Set<string>();
  const out: Array<{ itemId: string; version: number }> = [];
  for (const e of raw.items.slice(0, 1000)) {
    if (!isPlainObject(e) || typeof e.itemId !== "string" || !UUID_RE.test(e.itemId)) continue;
    if (typeof e.version !== "number" || !Number.isInteger(e.version) || e.version < 1) continue;
    const key = e.itemId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ itemId: e.itemId, version: e.version });
  }
  return out;
}

/** Does Cerbos allow `principal` (and, on a delegated call, the human it acts for) `action` on `resource`? Writes no audit row. */
export async function probeAllowed(principal: Principal, resource: Resource, action: string): Promise<boolean> {
  if (!(await check(principal, resource, action)).allow) return false;
  if (principal.actFor && principal.actFor.userId !== principal.userId) {
    const human = await assemblePrincipal(principal.actFor.userId, principal.assurance);
    if (!human) return false;
    return (await check({ ...human, via: principal.via }, resource, action)).allow;
  }
  return true;
}

/** `Promise.all` with a ceiling; the first failure rejects and stops handing out work. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

/**
 * M6-P4c: `POST control/contract/regenerate` body `{slug?}` (+ optional `Idempotency-Key`). Files WebDesk's
 * `contract.regenerate` (M6-P4r-b): queues a fresh contract-codegen run, after which the ERP mirrors the new
 * `latest.json` through `contracts/refresh`. MEDIUM on WebDesk (no WS4); on the ERP it is `impact:"medium"`,
 * so an unattended caller (n8n, an agent) SUSPENDS into a D14 approval and is re-driven as itself on approval
 * (`registerWebdeskContractExecutableApprovals`), while an attended human runs it directly. The controller
 * has already authorised `operate` on `webdev_provisioned_site`.
 *
 *   * `slug` given: ONE tenant, which must be an ACTIVE tenant of THIS company (the wall: anything else is
 *     the uniform 404 `site-not-found`). Zone B's typed answers pass through, as for every control write.
 *   * `slug` omitted: every active tenant of THIS company, one per-tenant command each. Deliberately NOT
 *     WebDesk's platform-wide `POST /control/v1/contract/regenerate`: that one regenerates every company's
 *     tenants, and a company-scoped principal must not cause effects in another company. A tenant whose
 *     command fails is reported as `failed` with a typed token; the others still run.
 * The response is `{scope: "tenant"|"company", tenants: [{tenantSlug, outcome: "queued"|"failed", replayed?, enqueue?, error?}]}`.
 * An empty `tenants` for scope `company` is a fact (the company has no active tenant), never a degraded read:
 * a failed tenant list is a typed 503.
 */
export async function controlRegenerateContract(
  principal: Principal,
  tenantId: string,
  rawBody: unknown,
  idempotencyKey: string,
): Promise<ZoneBResult> {
  const b = rawBody === undefined || rawBody === null ? {} : strictBody(rawBody, ["slug"]);
  if (b.slug !== undefined && (typeof b.slug !== "string" || b.slug === "")) throw invalidRequest("slug must be a non-empty string when given");
  const one = typeof b.slug === "string" ? b.slug : null;
  const slugs = one !== null
    ? [(await webdeskZoneB.resolveEditableTenant(tenantId, one)).slug]
    : (await webdeskZoneB.tenantsOf(tenantId, { fresh: true })).filter((t) => t.status === "active").map((t) => t.slug);

  const tenants: Array<Record<string, unknown>> = [];
  for (const slug of slugs) {
    // One tenant: the caller's key as-is. Company scope: a per-tenant key derived from it (same caller key
    // => same per-tenant keys, so a retried company call is a replay on every tenant, never a second run).
    const key = one !== null ? idempotencyKey : `regen-${createHash("sha256").update(`${idempotencyKey}:${slug}`).digest("hex")}`;
    try {
      const r = await webdeskZoneB.write(principal, tenantId, {
        command: "contract.regenerate",
        verb: "webdesk.contract.regenerate",
        method: "POST",
        path: "/control/v1/tenants/:tenantSlug/contract/regenerate",
        params: { tenantSlug: slug },
        idempotencyKey: key,
        entity: { type: "webdesk_tenant", id: null },
        ledger: { tenantSlug: slug, scope: one !== null ? "tenant" : "company" },
      });
      const body = isPlainObject(r.body) ? r.body : {};
      tenants.push({
        tenantSlug: slug,
        outcome: "queued",
        replayed: body.replayed === true,
        ...(isPlainObject(body.enqueue) ? { enqueue: body.enqueue } : {}),
      });
    } catch (err) {
      if (one !== null) throw err;
      const error = err instanceof WebdeskProblem
        ? `webdesk_refused: ${err.getStatus()} ${problemSlug(err.problem) ?? "unknown"}`
        : err instanceof HttpException
          ? errorToken(err)
          : `webdesk_error: ${(err as Error)?.name ?? "unknown"}`;
      tenants.push({ tenantSlug: slug, outcome: "failed", error });
    }
  }
  return { status: 200, body: { scope: one !== null ? "tenant" : "company", tenants } };
}

/**
 * `POST control/sites/:siteId/keys` body `{tenantSlug, envId, scope}`: FILES one key.mint approval (HIGH, WS4)
 * and answers `{approvalId}`. It never mints. WSK-66's executor mints at decide(), as the DECIDER (a key mint
 * is never self-approvable), and the plaintext appears ONCE, in that decide response; it is never stored,
 * ledgered or logged on this side. The controller has already authorized `promote` on
 * `webdev_provisioned_site`; the filer authorizes it again (it is also the importer's entry point).
 *
 * The environment must be one of THIS site's, read from the wall's own answer, so an approval can only name a
 * real target and its title tells the approver which one ("production read key"). One open request per
 * (site, environment, scope): filing again returns the pending request's id, with `alreadyPending: true`,
 * instead of queueing a second mint (the rebuild-requests rule; two simultaneous first filings can still
 * both land).
 */
export async function controlRequestKeyMint(
  principal: Principal,
  tenantId: string,
  siteIdParam: string,
  rawBody: unknown,
): Promise<{ approvalId: string; alreadyPending?: true }> {
  const b = strictBody(rawBody, ["tenantSlug", "envId", "scope"]);
  if (typeof b.tenantSlug !== "string" || b.tenantSlug === "") throw invalidRequest("tenantSlug is a required string");
  if (typeof b.envId !== "string" || !UUID_RE.test(b.envId)) throw invalidRequest("envId must be a uuid");
  if (b.scope !== "read" && b.scope !== "write") throw invalidRequest('scope must be "read" or "write"');
  const scope = b.scope;
  const envId = b.envId.toLowerCase();

  const { site } = await webdeskZoneB.resolveEditableSite(tenantId, b.tenantSlug, siteIdParam);
  const env = site.environments.find(
    (e): e is { envId: string; name?: unknown } => isPlainObject(e) && typeof e.envId === "string" && e.envId.toLowerCase() === envId,
  );
  if (!env) {
    throw new WebdeskProblem(404, {
      type: "https://webdesk.gaiada.online/errors/environment-not-found",
      title: "Environment not found",
      status: 404,
      detail: "No such environment on this site.",
    });
  }
  const envName = typeof env.name === "string" && env.name !== "" ? env.name : "environment";
  const siteId = site.siteId.toLowerCase();

  const open = await withTenants([tenantId], async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM automation_approvals
        WHERE tenant_id = $1 AND origin = 'webdesk' AND workflow_id = 'key.mint'
          AND status = 'pending' AND deleted_at IS NULL
          AND tool_args->>'siteId' = $2 AND tool_args->>'envId' = $3 AND tool_args->>'scope' = $4
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, siteId, envId, scope],
    );
    return r.rows[0] ?? null;
  });
  // `alreadyPending` lets a caller say "already requested" instead of "request filed" (additive: absent on a new filing).
  if (open) return { approvalId: open.id, alreadyPending: true };

  return fileWebdeskCommandApproval(principal, tenantId, {
    command: "key.mint",
    tenantSlug: b.tenantSlug,
    siteId,
    args: { envId, scope },
    summary: { title: `Mint a ${envName} ${scope} API key for ${b.tenantSlug} (site "${site.name}")` },
  });
}

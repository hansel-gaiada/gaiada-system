// M5-V3-e — the ERP caller of WebDesk's `consent.status` control read (design 2026-10-12 §4.3, D5; WebDesk side V3-a:
// webdesk/api/src/control/consent/*). Consent is proven by WebDesk's consent log, never by the browser.
//
//   POST /control/v1/tenants/:tenantSlug/consent/status  {siteSlug, consentIds: uuid[1..100]}
//     -> 200 {statuses:[{consentId, analytics, marketing, action, noticeVersion, recordedAt}]}
//   The LATEST record per id for that site; an id with no record is OMITTED (no proof). Registry: impact `read`,
//   scope `webdesk:read`, no audit row. It is a POST only because the id list is a body; it changes nothing.
//
// TRANSPORT. No new egress: the existing ERP->WebDesk control channel (mTLS + Keycloak client credentials), via the
// webdev module's seam, loaded lazily so search keeps no static dependency on webdev (webdev already imports search;
// indexnow-webdesk.ts does the same). No request is made from this file directly.
//
// THE CROSS-COMPANY WALL. A search property is matched to a WebDesk tenant by its domain, among the tenants WebDesk
// lists for THIS company only (`tenant.list?companyRef=`, filtered in WebDesk's SQL; the same wall the Website
// workspace and L4 use). Exactly one active tenant must carry the domain on one of its sites' environments; none or
// several is `site_unresolved` (a configuration fault, never read as "no consent").
//
// FAILURE IS NEVER AN ANSWER. Every failure is a typed ConsentStatusError, and a malformed 200 is `bad_response`
// for the WHOLE call: the caller must never read a broken answer as "absent" (absent leads to forgetting a person).
// `analytics` must be exactly `true` to count as consent (D5 / §9 trap 6: an `update` with analytics:false is a
// withdrawal, so callers key on `analytics`, never on `action`).

export const CONSENT_STATUS_BATCH = 100;
const STATUS_PATH = "/control/v1/tenants/:tenantSlug/consent/status";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConsentStatusErrorKind = "not_configured" | "unreachable" | "rejected" | "site_unresolved" | "bad_response";

export class ConsentStatusError extends Error {
  readonly kind: ConsentStatusErrorKind;
  constructor(kind: ConsentStatusErrorKind, message: string) {
    super(message);
    this.name = "ConsentStatusError";
    this.kind = kind;
  }
}

export interface ConsentStatusEntry {
  consentId: string; // lower-case
  analytics: boolean;
  marketing: boolean;
  action: string;
  noticeVersion: string;
  recordedAt: string;
}

/** What the visitor jobs need. The default talks to WebDesk; tests pass a fake. */
export interface ConsentReader {
  /** The WebDesk tenant (site) slug of this company that serves `domain`. Throws ConsentStatusError. */
  resolveSiteSlug(companyId: string, domain: string): Promise<string>;
  /** Latest record per id (absent ids are absent from the map). Any number of ids; batched by 100. Throws ConsentStatusError. */
  statuses(companyId: string, siteSlug: string, consentIds: readonly string[]): Promise<Map<string, ConsentStatusEntry>>;
}

export interface TenantLike { slug: string; status?: string; sites?: Array<{ status?: string; environments?: unknown[] }> }

/** The raw seams under the default reader (tests replace them; production loads the webdev seam). */
export interface ConsentTransport {
  tenantsOf(companyId: string): Promise<TenantLike[]>;
  send(req: { siteSlug: string; consentIds: string[] }): Promise<{ status: number; json: unknown }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `www.Example.com.` -> `example.com`. */
export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** The single active tenant of the company serving `domain`, or a typed `site_unresolved`. */
export function pickTenantForDomain(tenants: readonly TenantLike[], domain: string): string {
  const want = normalizeHost(domain);
  if (!want) throw new ConsentStatusError("site_unresolved", "the property has no domain");
  const slugs = new Set<string>();
  for (const t of tenants) {
    if (!t || typeof t.slug !== "string" || (t.status !== undefined && t.status !== "active")) continue;
    for (const site of t.sites ?? []) {
      if (site.status !== undefined && site.status !== "active") continue;
      for (const env of site.environments ?? []) {
        if (isObj(env) && typeof env.domain === "string" && normalizeHost(env.domain) === want) slugs.add(t.slug);
      }
    }
  }
  if (slugs.size !== 1) {
    throw new ConsentStatusError("site_unresolved", slugs.size === 0
      ? "no WebDesk site of this company serves the property's domain"
      : "more than one WebDesk site of this company serves the property's domain");
  }
  return [...slugs][0]!;
}

/** A 200 body -> entries. Strict: anything off-contract fails the whole call (never read as "absent"). */
export function parseConsentStatusBody(json: unknown, requested: ReadonlySet<string>): ConsentStatusEntry[] {
  if (!isObj(json) || !Array.isArray(json.statuses)) throw new ConsentStatusError("bad_response", "consent.status: no statuses array");
  const seen = new Set<string>();
  const out: ConsentStatusEntry[] = [];
  for (const s of json.statuses) {
    if (!isObj(s) || typeof s.consentId !== "string" || !UUID_RE.test(s.consentId)) {
      throw new ConsentStatusError("bad_response", "consent.status: an entry has no valid consentId");
    }
    const id = s.consentId.toLowerCase();
    if (!requested.has(id)) throw new ConsentStatusError("bad_response", "consent.status: an entry was not asked for");
    if (seen.has(id)) throw new ConsentStatusError("bad_response", "consent.status: an id appears twice");
    if (typeof s.analytics !== "boolean" || typeof s.marketing !== "boolean" || typeof s.action !== "string") {
      throw new ConsentStatusError("bad_response", "consent.status: an entry is not the contract shape");
    }
    seen.add(id);
    out.push({
      consentId: id, analytics: s.analytics, marketing: s.marketing, action: s.action,
      noticeVersion: typeof s.noticeVersion === "string" ? s.noticeVersion : "",
      recordedAt: typeof s.recordedAt === "string" ? s.recordedAt : "",
    });
  }
  return out;
}

function statusError(status: number): ConsentStatusError {
  if (status === 401 || status === 403) return new ConsentStatusError("rejected", `WebDesk refused the control credential (HTTP ${status})`);
  if (status === 404) return new ConsentStatusError("site_unresolved", "WebDesk does not know this site (HTTP 404)");
  if (status >= 500) return new ConsentStatusError("unreachable", `WebDesk answered HTTP ${status}`);
  return new ConsentStatusError("bad_response", `WebDesk answered HTTP ${status}`);
}

/** Any thrown transport/seam error -> typed. `not_configured` only when the channel says so; everything else is
 *  `unreachable` (an outage is never a statement about anybody's consent). */
export function mapTransportError(err: unknown): ConsentStatusError {
  if (err instanceof ConsentStatusError) return err;
  const e = err as { code?: unknown; getResponse?: () => unknown };
  if (e?.code === "webdesk_control_not_configured") return new ConsentStatusError("not_configured", "the WebDesk control channel is not configured");
  const resp = typeof e?.getResponse === "function" ? e.getResponse() : null;
  if (isObj(resp) && resp.message === "webdesk_not_configured") return new ConsentStatusError("not_configured", "the WebDesk control channel is not configured");
  return new ConsentStatusError("unreachable", "WebDesk control channel failed");
}

/** The production transport: the webdev module's control-channel seam, loaded lazily. */
export function webdeskConsentTransport(): ConsentTransport {
  return {
    async tenantsOf(companyId) {
      const { webdeskZoneB } = await import("../webdev/webdesk-content.service");
      return webdeskZoneB.tenantsOf(companyId);
    },
    async send(req) {
      const { getWebdeskCommandControlClient } = await import("../webdev/webdesk-approved-command");
      const client = getWebdeskCommandControlClient();
      const res = await client.send({
        command: "consent.status",
        method: "POST",
        path: STATUS_PATH,
        params: { tenantSlug: req.siteSlug },
        body: { siteSlug: req.siteSlug, consentIds: req.consentIds },
      });
      return { status: res.status, json: res.json };
    },
  };
}

export function createConsentReader(transport: ConsentTransport = webdeskConsentTransport()): ConsentReader {
  return {
    async resolveSiteSlug(companyId, domain) {
      let tenants: TenantLike[];
      try {
        tenants = await transport.tenantsOf(companyId);
      } catch (err) {
        throw mapTransportError(err);
      }
      return pickTenantForDomain(Array.isArray(tenants) ? tenants : [], domain);
    },
    async statuses(_companyId, siteSlug, consentIds) {
      const ids = [...new Set(consentIds.filter((x) => UUID_RE.test(x)).map((x) => x.toLowerCase()))];
      const out = new Map<string, ConsentStatusEntry>();
      for (let i = 0; i < ids.length; i += CONSENT_STATUS_BATCH) {
        const batch = ids.slice(i, i + CONSENT_STATUS_BATCH);
        let res: { status: number; json: unknown };
        try {
          res = await transport.send({ siteSlug, consentIds: batch });
        } catch (err) {
          throw mapTransportError(err);
        }
        if (res.status !== 200) throw statusError(res.status);
        for (const e of parseConsentStatusBody(res.json, new Set(batch))) out.set(e.consentId, e);
      }
      return out;
    },
  };
}

/** Consent, exactly as D5 defines it: a record exists AND its latest `analytics` is literally true. */
export function hasAnalyticsConsent(entry: ConsentStatusEntry | undefined): boolean {
  return entry !== undefined && entry.analytics === true;
}

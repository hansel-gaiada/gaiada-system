// SMM-05 — the Postiz driver: HTTP + JSON, and nothing else.
//
// ── THE CONTAINMENT LINE, IN CODE ───────────────────────────────────────────────────────────────
// This file has exactly three imports, all of them ours. There is no `postiz` package dependency,
// no shared type, no generated client, no Prisma model, no import of anything from the licence
// zone. That is not a stylistic preference — it is invariant 1 of design §06 and §11's security
// argument in the same breath ("the licence boundary and the security boundary coincide"), and
// since the SMM-04b retarget the licence zone is a different MACHINE, which makes the property
// easier to demonstrate rather than harder. It is enforced mechanically by
// `npm run lint:postiz-deps` (a CI gate) and again by containment.test.ts, because an invariant
// that is only written down is an invariant that erodes.
//
// ── WHAT IS VERIFIED AND WHAT IS NOT — read this before trusting a route below ──────────────────
// The SMM-04 spike drove a real, running Postiz (report §6). These are the facts it established at
// the wire, and they are the ones the contract tests pin:
//   ✅ `GET  /api/public/v1/integrations`  → 200 `[]` with a valid org key
//   ✅ `GET  /api/public/v1/posts`         → 401 `{"msg":"No API Key found"}` with no key
//   ✅ `POST /api/public/v1/posts` naming an unknown channel → 400
//        `{"message":"Integration with id nonexistent-channel not found"}` — i.e. there is NO path
//        to a publish without a channel that already belongs to the org
//   ✅ `POST /api/public/v1/integration-trigger/:id` exists, and is gated on an upstream `@Tool`
//        decorator which the TikTok provider does NOT carry
//   ✅ There is NO comments/messages controller anywhere in the 22-route `/public/v1` surface, and
//        `GET /public/posts/{id}/comments` (note: no `/v1/`) is a DECOY — internal team notes on a
//        draft, not social comments
//   ✅ There is NO org-creation route. An org is minted by the runbook's one-shot registration
//        ceremony on the VPS, by a human. Hence `createOrg` refusing `capability_unsupported`.
//
// Everything marked ⚠UNVERIFIED in `POSTIZ_ROUTES` and in the request/response mappers below was
// reasoned from the spike's route inventory and Postiz's public API documentation, but NOT driven
// against a live engine — no app credential exists yet (OQ-1 in flight) and, per SMM-04b, nothing
// has been deployed to either host. They are collected in ONE table on purpose: when SMM-07 first
// drives a live engine, correcting them is a single edit in a single place rather than a hunt
// through a file. Do not spread a second copy of a route string anywhere.
//
// ── TIMEOUTS ────────────────────────────────────────────────────────────────────────────────────
// Three classes, per addendum §A4l §4: read 30s, media upload 120s, and a connect budget of 5s that
// is CARRIED BUT NOT INDEPENDENTLY ENFORCED — global `fetch` has no connect-phase deadline without
// an undici Agent, and this project takes no direct undici dependency. Stated plainly rather than
// quietly conflated; the practical effect is that a black-holed connection is caught by the read
// deadline instead of the connect one. The estate has already shipped a 30s default against a real
// 31-40s round trip (the n8n dispatcher, reported unreachable AFTER the run was created), which is
// why these are explicit values and not defaults.
import { config } from "../../../config";
import type { QuotaSnapshot } from "../media-rules";
import {
  OrgHandle,
  SocialPublisherError,
  type DailyMetrics,
  type DateRange,
  type IntegrationState,
  type OrgVerification,
  type PostMetrics,
  type PostStatus,
  type PublishOp,
  type PublisherCapability,
  type SocialPublisher,
  type VariantDispatch,
} from "./types";

/** THE ONE PLACE a Postiz route string may appear. See the header for what is verified. */
export const POSTIZ_ROUTES = {
  integrations: "/integrations",            // ✅ verified live
  posts: "/posts",                          // ✅ verified live (GET list + POST create)
  postById: (id: string) => `/posts/${encodeURIComponent(id)}`,          // ⚠UNVERIFIED (DELETE)
  upload: "/upload",                                                      // ⚠UNVERIFIED
  analytics: (integrationId: string) => `/analytics/${encodeURIComponent(integrationId)}`, // ⚠UNVERIFIED
  integrationTrigger: (id: string) => `/integration-trigger/${encodeURIComponent(id)}`,    // ✅ route exists; payload ⚠UNVERIFIED
} as const;

/** X is the only metered network in v1 (design §05, OQ-2). Published figures, to re-verify before
 *  `networks.x` is ever enabled for a client — and note that the whole point of keeping it disabled
 *  is that a $0 publish path is what keeps `social.publishPost` eligible for the D14 executable-
 *  approval registry, whose doctrine permanently bars money-spending tools (addendum D-14). */
export const X_POST_USD = 0.015;
export const X_POST_WITH_LINK_USD = 0.20;

export interface PostizDriverOptions {
  baseUrl: string;
  apiPrefix: string;
  readTimeoutMs: number;
  uploadTimeoutMs: number;
  connectTimeoutMs: number;
  /** Non-empty ⇒ the driver advertises `quota_probe` and asks the engine for a live limit. Empty ⇒
   *  it does not, and the registry records "unknown" rather than a number. See config.ts. */
  quotaProbeTool: string;
  /** Injected in tests so no real socket is ever opened. */
  fetchImpl?: typeof fetch;
}

/** Capabilities this driver advertises. The two absences are the SMM-04 findings, not omissions:
 *   - `org_create`: no such route exists; an org is a human runbook ceremony on the VPS.
 *   - `inbox_read`/`inbox_reply`: Postiz has ZERO inbound engagement surface, for ANY network
 *     (spike §8b). This is what makes `social_accounts.capabilities.comments` false even on
 *     Instagram, where Meta's API genuinely offers comments — and it is why P2 (SMM-15..18) has
 *     nothing behind this port to call. */
const POSTIZ_CAPABILITIES: PublisherCapability[] = [
  "org_verify", "connect_url", "integrations", "schedule", "cancel",
  "post_status", "account_metrics", "post_metrics", "media_upload",
];

export function createPostizDriver(opts: PostizDriverOptions): SocialPublisher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const root = `${opts.baseUrl.replace(/\/$/, "")}${opts.apiPrefix}`;
  const capabilities = new Set<PublisherCapability>(POSTIZ_CAPABILITIES);
  if (opts.quotaProbeTool) capabilities.add("quota_probe");

  /** The one outbound call. Stateless per call: the key comes off the handle, is used for this
   *  request, and is never retained. */
  async function call<T>(
    org: OrgHandle,
    path: string,
    init: { method: string; body?: unknown; timeoutMs?: number; form?: FormData },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? opts.readTimeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method: init.method,
        headers: {
          // Custody split (b). The key goes on the wire (inside the tunnel) and nowhere else — not
          // into a span attribute, not into an error message, not into a log field.
          Authorization: org.secret(),
          ...(init.form ? {} : { "Content-Type": "application/json" }),
        },
        body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
        signal: controller.signal,
      });
    } catch (err) {
      // A downed tunnel, a dead host, an abort. Loud and typed — never a silent empty result, and
      // never "fixed" by falling back to a public address (addendum §A4l §7).
      throw new SocialPublisherError(
        "publisher_unreachable",
        `publisher did not answer ${init.method} ${path}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // The upstream STATUS is carried; the upstream BODY is not re-thrown verbatim into our
      // surfaces. An engine error string is content from the licence zone and we have no reason to
      // republish it into a console, a tool result or an audit line.
      throw new SocialPublisherError(
        "publisher_http_error",
        `publisher answered HTTP ${res.status} for ${init.method} ${path}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SocialPublisherError("publisher_http_error", `publisher returned non-JSON for ${init.method} ${path}`, res.status);
    }
  }

  return {
    key: "postiz",
    capabilities,

    async createOrg(): Promise<{ orgId: string; apiKeyRef: string }> {
      // See the file header. There is no org-creation route in the 22-route public surface; the only
      // way to mint one is the runbook's bootstrap ceremony (flip SOCIAL_POSTIZ_DISABLE_REGISTRATION
      // false, POST /api/auth/register exactly once, flip it back, verify the door is shut). That
      // ceremony is a deliberate, audited human act ON THE LICENCE-ZONE HOST, and giving the ERP an
      // HTTP path to trigger it would mean either forking the engine or leaving its registration
      // door open — the second of which is a containment invariant, not a preference.
      throw new SocialPublisherError(
        "capability_unsupported",
        "the Postiz driver cannot create an organization: no such route exists on its public API. "
        + "Create the org with the one-shot registration ceremony in infra/runbooks/deploy-vps.md "
        + "(section 'Bootstrap, in order', step 6), then provision the mapping with its org id.",
      );
    },

    async verifyOrg(org: OrgHandle): Promise<OrgVerification> {
      // The cheapest authenticated read the engine has, and the exact call the spike drove.
      const rows = await call<unknown[]>(org, POSTIZ_ROUTES.integrations, { method: "GET" });
      return { ok: true, integrationCount: Array.isArray(rows) ? rows.length : 0 };
    },

    async connectUrl(org: OrgHandle, network, redirect): Promise<string> {
      // ⚠UNVERIFIED end to end. SMM-07 owns proving the OAuth round trip, and it must ALSO honour
      // spike §7: Postiz builds its redirect_uri as `${FRONTEND_URL}/integrations/social/<provider>`,
      // which is a Postiz FRONTEND page — serving it breaks containment invariant 5. The preferred
      // design points FRONTEND_URL at a path platform-ui serves and hands the code back over the
      // tunnel, so the engine is never exposed at the edge at all.
      const res = await call<{ url?: string }>(
        org,
        `/integrations/social/${encodeURIComponent(network)}?redirectUrl=${encodeURIComponent(redirect)}`,
        { method: "GET" },
      );
      if (!res?.url) {
        throw new SocialPublisherError("publisher_http_error", `publisher returned no connect url for ${network}`);
      }
      return res.url;
    },

    async listIntegrations(org: OrgHandle): Promise<IntegrationState[]> {
      const rows = await call<unknown>(org, POSTIZ_ROUTES.integrations, { method: "GET" });
      return normalizeIntegrations(rows);
    },

    async getQuota(org: OrgHandle, integration: IntegrationState): Promise<QuotaSnapshot | undefined> {
      // ⚠ THE RULE THIS METHOD EXISTS FOR (addendum §A4f item 1): the cap is READ FROM THE ACCOUNT,
      // never synthesized. Meta's current doc says 100 posts/24h in one place and 50 in another,
      // and the "25" this programme carried since 2026-07-23 appears nowhere in it — asking
      // `GET /<IG_ID>/content_publishing_limit` sidesteps the contradiction entirely, because the
      // account's own answer is the only one that binds.
      //
      // We cannot call Graph directly: custody split (c) keeps the network token INSIDE the engine
      // and it is never copied out. So the probe must ride Postiz's generic passthrough
      // (`POST /public/v1/integration-trigger/:id`), which upstream gates on a `@Tool` decorator —
      // and the spike proved the TikTok provider carries none. Whether Instagram's does is
      // UNVERIFIED, so the tool NAME is configuration, the capability is only advertised when it is
      // set, and ANY failure returns `undefined` (= "we do not know") rather than throwing. An
      // unknown quota is a `quota_unknown` warning in media-rules.ts; a fabricated one would be a
      // silent lie the composer would act on.
      if (!opts.quotaProbeTool) return undefined;
      if (integration.network !== "instagram") return undefined;
      if (!integration.networkAccountId) return undefined;
      try {
        const res = await call<{ quota?: unknown; data?: unknown }>(
          org,
          POSTIZ_ROUTES.integrationTrigger(integration.id),
          { method: "POST", body: { tool: opts.quotaProbeTool, data: {} } },
        );
        return parseContentPublishingLimit(res);
      } catch {
        // Deliberately swallowed: a probe the engine cannot carry is an expected outcome of a
        // documented upstream gap, not an incident. The caller records `probe_unavailable`.
        return undefined;
      }
    },

    async schedulePost(org: OrgHandle, req: VariantDispatch): Promise<{ providerPostId: string }> {
      // D-6, enforced structurally at the last possible layer. SMM-09 owns the gate; this assertion
      // exists so a caller that forgot it cannot reach a live network by omission. The approvalId
      // itself is NEVER sent upstream — the licence zone has no business seeing our approval trail.
      if (!req.approvalId) {
        throw new SocialPublisherError(
          "approval_required",
          "publisher refused a dispatch with no one-shot approval id (design D-6): approved content only",
        );
      }
      const body = {
        type: req.scheduledAt ? "schedule" : "now",
        date: req.scheduledAt ?? new Date().toISOString(),
        // ⚠UNVERIFIED envelope shape beyond what the spike drove (it proved an unknown channel is
        // refused 400, i.e. the `integration.id` field is real and load-bearing).
        posts: [
          {
            integration: { id: req.integrationId },
            value: [
              {
                content: req.body,
                image: (req.media ?? []).map((m) => ({ id: m.id, ...(m.url ? { path: m.url } : {}) })),
              },
              ...(req.firstComment ? [{ content: req.firstComment }] : []),
            ],
            settings: req.settings ?? {},
          },
        ],
      };
      const res = await call<unknown>(org, POSTIZ_ROUTES.posts, { method: "POST", body });
      const id = extractPostId(res);
      if (!id) {
        // An ambiguous publish outcome. §11's "no auto-retry of ambiguous publish failures" is what
        // stops this becoming a double-post, and §A4l §4 notes it stopped being theoretical the
        // moment the call started crossing a host boundary. Refuse loudly; never retry here.
        throw new SocialPublisherError(
          "publisher_http_error",
          "publisher accepted the dispatch but returned no post id — outcome AMBIGUOUS, not retried "
          + "(design §11: a blind re-dispatch is how one approval becomes two public posts)",
        );
      }
      return { providerPostId: id };
    },

    async cancelPost(org: OrgHandle, providerPostId: string): Promise<void> {
      await call<void>(org, POSTIZ_ROUTES.postById(providerPostId), { method: "DELETE" });
    },

    async getPostStatus(org: OrgHandle, providerPostIds: string[], range?: DateRange): Promise<PostStatus[]> {
      // BATCHED over a window, not a per-id loop (addendum §A4l §4): `GET /public/v1/posts` takes a
      // date range, so one authenticated call per (org, window) covers the sweep and the 2.6 ms hop
      // amortises to nothing. A per-post loop would make the cadence a cost decision instead of the
      // freshness decision it is.
      const qs = range ? `?startDate=${encodeURIComponent(range.from)}&endDate=${encodeURIComponent(range.to)}` : "";
      const rows = await call<unknown>(org, `${POSTIZ_ROUTES.posts}${qs}`, { method: "GET" });
      const wanted = new Set(providerPostIds);
      return normalizePosts(rows).filter((p) => wanted.size === 0 || wanted.has(p.providerPostId));
    },

    async uploadMedia(org: OrgHandle, file): Promise<{ id: string; url?: string }> {
      // The one call whose duration changed by more than milliseconds when the engine moved hosts,
      // and the one the runbook's MTU trap silently black-holes (wg default 1420 over a 1460 MTU:
      // small requests all succeed, megabyte uploads vanish). Hence its own 120s class.
      const form = new FormData();
      form.append("file", new Blob([file.bytes as unknown as BlobPart], { type: file.contentType }), file.filename);
      const res = await call<unknown>(org, POSTIZ_ROUTES.upload, {
        method: "POST", form, timeoutMs: opts.uploadTimeoutMs,
      });
      const id = extractMediaId(res);
      if (!id) throw new SocialPublisherError("publisher_http_error", "publisher returned no media id for an upload");
      return { id, url: extractMediaUrl(res) };
    },

    async getAccountMetrics(org: OrgHandle, integrationId: string, range: DateRange): Promise<DailyMetrics[]> {
      const rows = await call<unknown>(
        org,
        `${POSTIZ_ROUTES.analytics(integrationId)}?startDate=${encodeURIComponent(range.from)}&endDate=${encodeURIComponent(range.to)}`,
        { method: "GET" },
      );
      return normalizeDailyMetrics(rows);
    },

    async getPostMetrics(org: OrgHandle, providerPostIds: string[]): Promise<PostMetrics[]> {
      // Postiz surfaces per-post engagement only as AGGREGATE counters on its analytics payloads —
      // counts, never content, never an id, never a reply verb (spike §8b). That is enough for
      // SMM-23's reporting and is emphatically NOT an inbox.
      const out: PostMetrics[] = [];
      for (const id of providerPostIds) {
        const row = await call<unknown>(org, `${POSTIZ_ROUTES.postById(id)}`, { method: "GET" });
        out.push(normalizePostMetrics(id, row));
      }
      return out;
    },

    // listComments / sendReply are DELIBERATELY ABSENT — see types.ts's header item (a) and
    // capabilities.ts. Postiz has no inbound engagement capability for any network; a method here
    // that threw would read as a bug, while an absent one is a capability fact the registry mirrors
    // and the console can explain.

    estimateCostUsd(op: PublishOp): number {
      if (op.network !== "x") return 0;
      const per = op.hasLink ? X_POST_WITH_LINK_USD : X_POST_USD;
      return per * (op.items ?? 1);
    },
  };
}

// ── Response normalizers ────────────────────────────────────────────────────────────────────────
// All ⚠UNVERIFIED beyond the shapes the spike drove, and all deliberately TOLERANT: they accept a
// couple of plausible field spellings and return a partial shape rather than throwing. Reasoning:
// a strict parser against an unverified envelope turns a cosmetic upstream rename into a total
// outage of the registry sync, and the registry's job is to mirror what it can see. What they must
// never do is INVENT a value — an absent field stays absent (see media-rules.ts's "unknown is not
// zero" doctrine, and note that a missing field and a null read identically here, which is the
// documented estate-wide trap).

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function normalizeIntegrations(raw: unknown): IntegrationState[] {
  const rows = Array.isArray(raw) ? raw : (Array.isArray(asRecord(raw).integrations) ? asRecord(raw).integrations as unknown[] : []);
  const out: IntegrationState[] = [];
  for (const r of rows) {
    const rec = asRecord(r);
    const id = str(rec.id);
    // `providerIdentifier` is Postiz's own name for the network on an integration row.
    const network = str(rec.providerIdentifier) ?? str(rec.provider) ?? str(rec.identifier);
    if (!id || !network) continue; // a row we cannot key is skipped, never guessed at
    out.push({
      id,
      network: network.toLowerCase(),
      handle: str(rec.profile) ?? str(rec.username) ?? str(rec.name) ?? id,
      displayName: str(rec.name),
      disabled: rec.disabled === true,
      refreshNeeded: rec.refreshNeeded === true || rec.inBetweenSteps === true,
      error: str(rec.error) ?? str(rec.lastError),
      networkAccountId: str(rec.internalId) ?? str(rec.providerId) ?? str(rec.accountId),
    });
  }
  return out;
}

/** `GET /<IG_ID>/content_publishing_limit` returns a `data[0]` with `quota_usage` and `config.quota_total`.
 *  Whatever wrapper the engine puts around it, the two numbers are what we want — and if either is
 *  absent we return `undefined` (unknown), never a default. */
export function parseContentPublishingLimit(raw: unknown): QuotaSnapshot | undefined {
  const rec = asRecord(raw);
  const payload = asRecord(rec.data ?? rec.quota ?? rec.result ?? rec);
  const arr = Array.isArray(payload.data) ? payload.data as unknown[] : (Array.isArray(rec.data) ? rec.data as unknown[] : []);
  const first = asRecord(arr[0] ?? payload);
  const used = num(first.quota_usage);
  const cap = num(asRecord(first.config).quota_total) ?? num(first.quota_total);
  if (used === undefined || cap === undefined) return undefined;
  return { igPosts24h: { used, cap } };
}

export function extractPostId(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    const first = asRecord(raw[0]);
    return str(first.postId) ?? str(first.id);
  }
  const rec = asRecord(raw);
  if (Array.isArray(rec.posts)) {
    const first = asRecord((rec.posts as unknown[])[0]);
    return str(first.postId) ?? str(first.id);
  }
  return str(rec.postId) ?? str(rec.id);
}

function extractMediaId(raw: unknown): string | undefined {
  const rec = asRecord(raw);
  return str(rec.id) ?? str(rec.mediaId);
}
function extractMediaUrl(raw: unknown): string | undefined {
  const rec = asRecord(raw);
  return str(rec.path) ?? str(rec.url);
}

const POST_STATE: Record<string, PostStatus["state"]> = {
  QUEUE: "queued", PENDING: "queued", DRAFT: "queued",
  PUBLISHING: "publishing",
  PUBLISHED: "published",
  ERROR: "failed", FAILED: "failed",
  CANCELLED: "cancelled", CANCELED: "cancelled",
};

export function normalizePosts(raw: unknown): PostStatus[] {
  const rows = Array.isArray(raw) ? raw : (Array.isArray(asRecord(raw).posts) ? asRecord(raw).posts as unknown[] : []);
  const out: PostStatus[] = [];
  for (const r of rows) {
    const rec = asRecord(r);
    const id = str(rec.id) ?? str(rec.postId);
    if (!id) continue;
    const state = POST_STATE[String(rec.state ?? rec.status ?? "").toUpperCase()] ?? "unknown";
    out.push({
      providerPostId: id,
      state,
      publishedUrl: str(rec.releaseURL) ?? str(rec.publishedUrl) ?? str(rec.url),
      publishedAt: str(rec.publishDate) ?? str(rec.publishedAt),
      error: str(rec.error),
    });
  }
  return out;
}

export function normalizeDailyMetrics(raw: unknown): DailyMetrics[] {
  const rows = Array.isArray(raw) ? raw : (Array.isArray(asRecord(raw).data) ? asRecord(raw).data as unknown[] : []);
  const out: DailyMetrics[] = [];
  for (const r of rows) {
    const rec = asRecord(r);
    const date = str(rec.date) ?? str(rec.day);
    if (!date) continue;
    out.push({
      date: date.slice(0, 10),
      followers: num(rec.followers),
      impressions: num(rec.impressions),
      reach: num(rec.reach),
      engagements: num(rec.engagements) ?? num(rec.engagement),
      linkClicks: num(rec.clicks) ?? num(rec.linkClicks),
      videoViews: num(rec.videoViews) ?? num(rec.views),
      raw: rec,
    });
  }
  return out;
}

export function normalizePostMetrics(providerPostId: string, raw: unknown): PostMetrics {
  const rec = asRecord(raw);
  const m = asRecord(rec.statistics ?? rec.metrics ?? rec);
  return {
    providerPostId,
    impressions: num(m.impressions),
    likes: num(m.likes),
    // AGGREGATE COUNT ONLY. This is the `comment_count`-shaped field the spike found in Postiz's
    // analytics calls, and mistaking it for inbox coverage is the exact trap §8b names: it is a
    // number, never a body, never an author, never an id, and it can never be replied to.
    comments: num(m.comments) ?? num(m.comment_count),
    shares: num(m.shares),
    saves: num(m.saves),
    videoViews: num(m.videoViews) ?? num(m.views),
    clicks: num(m.clicks),
  };
}

/** Build the driver from config, or return null when this deployment has no publisher. Null is a
 *  SUPPORTED outcome (see config.ts): nothing is registered, every publisher path refuses
 *  `publisher_not_configured`, and every read the module serves is unaffected. */
export function createPostizDriverFromConfig(): SocialPublisher | null {
  const p = config.social.publisher;
  if (!p.baseUrl) return null;
  return createPostizDriver({
    baseUrl: p.baseUrl,
    apiPrefix: p.apiPrefix,
    readTimeoutMs: p.readTimeoutMs,
    uploadTimeoutMs: p.uploadTimeoutMs,
    connectTimeoutMs: p.connectTimeoutMs,
    quotaProbeTool: p.quotaProbeTool,
  });
}

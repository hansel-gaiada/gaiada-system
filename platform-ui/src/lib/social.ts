// Social-media (SMM) BFF client — the typed surface the `social-media` department console
// (SMM-11) renders from. Reads live here (server-only, via `platformFetch`); writes live in the
// sibling `lib/socialActions.ts` ("use server"). Pure types/constants live in
// `lib/socialShared.ts` and are re-exported below — split for the identical reason
// `searchMarketing.ts`/`searchMarketingShared.ts` already split: THIS file imports
// `lib/platform.ts` (`"server-only"`), so a client component that needs even a single VALUE
// export from here (not just a type) fails the Next.js build with "You're importing a component
// that needs server-only". Import from `lib/socialShared.ts` directly in client code; server code
// can keep importing from here. Together the three files ARE "the canonical typed client for the
// §19 surface" this ticket asks for — split across the boundaries Next.js actually enforces, not
// one file.
//
// BFF CONTRACT (platform-nest `modules/social/social.controller.ts`, mounted at
// /api/:t/modules/social/*, behind AuthGuard + ModuleEnabledGuard("social")). Built today —
// SMM-01/02/08 landed. Verified against the CONTROLLER SOURCE directly (docs/FRONTEND-BFF-
// CONTRACT.md §19 describes the same surface but the controller is what actually ships; where the
// two disagree the controller wins — see the discrepancies called out inline below):
//   GET           engagements                          -> SocialEngagement[]        (?clientId=&status=)
//   POST          engagements                           -> {id,created}              (idempotent on caller id)
//   GET           engagements/:id                        -> SocialEngagementDetail   (404 if absent)
//   PATCH         engagements/:id                        -> {ok:true}                (name/status/projectId/ownerId/dates only)
//   DELETE        engagements/:id                        -> {ok:true}                (soft delete)
//   GET           engagements/:id/scope                  -> EngagementScope          (defaults merged under stored value)
//   PATCH         engagements/:id/scope                  -> ScopePatchResult         (its own permission: set_scope)
//   GET           brand-profiles/:clientId                -> SocialBrandProfile      (404 if absent)
//   PATCH         brand-profiles/:clientId                -> {ok:true}               (upsert; partial patch does not erase siblings)
//   GET           campaigns                               -> SocialCampaign[]        (?engagementId=)
//   POST          campaigns                               -> {id,created}
//   GET           kpi-targets                             -> SocialKpiTarget[]       (?engagementId=)
//   POST          kpi-targets                             -> {id,created}
//   GET           posts                                   -> SocialPost[]            (?engagementId=&status=) — variant roll-up included, no N+1
//   POST          posts                                   -> {id,created}            (idempotent on caller id)
//   GET           posts/:id                                -> SocialPostDetail        (post + full variants, 404 if absent)
//   PATCH         posts/:id                                -> {ok:true}
//   DELETE        posts/:id                                -> {ok:true}               (refuses post_has_live_variants)
//   POST          posts/:id/variants                       -> CreateVariantResult     (validation+argsSha256+cost travel back with the 201)
//   PATCH         variants/:id                              -> UpdateVariantResult     (edit invalidates approval — see approvalInvalidated)
//   DELETE        variants/:id                              -> {ok:true}               (refuses variant_is_live)
//   GET           variants/:id/validation                   -> VariantValidationResult (computed FRESH, not the stored column)
//   POST          posts/import-native                       -> {id,created}            (bookkeeping only; never settable via POST posts)
//   GET           accounts                                   -> {accounts: SocialAccount[]} (SMM-05; ?clientId=&status=) — the connector registry, incl. live `quota`
//   GET           variants/:id/publish-preconditions          -> PublishPreconditionResult (SMM-09 dry run; verdict is DATA on a 200, never thrown)
//
// ── CONTRACT DISCREPANCIES FOUND WHILE BUILDING THIS (backend wins; §19 is reconciled here) ──────
// 1. §19 documents `PATCH engagements/:id/scope` as returning `{toolScope, usageBudgetUsd,
//    warnings[]}` without qualification. The CONTROLLER (social.controller.ts `setScope`) actually
//    returns `usageBudgetUsd: budget` where `budget` is the RAW REQUEST FIELD
//    (`body?.usageBudgetUsd`), not the persisted value — so a scope-only PATCH (no budget in the
//    body) answers `usageBudgetUsd: undefined`, even though the row's real budget is unchanged
//    (COALESCE keeps it). `ScopePatchResult.usageBudgetUsd` is typed `number | undefined` to say so
//    honestly; callers that need the PERSISTED budget after a scope-only patch must re-read
//    `getEngagementScope`, never trust this response for that field. Reported to the backend owner
//    (SMM-02/09) as a fix candidate — not changed here per this ticket's "frontend only" constraint.
// 2. UPDATE (SMM-12): `GET .../accounts` now EXISTS — SMM-05 shipped `listAccounts` (this file's
//    own header was written before that landed and said otherwise; corrected here rather than
//    left stale, since a wrong "no UI consumer yet"/"doesn't exist" comment is exactly the kind of
//    drift the root guide calls out). SMM-12 (calendar + composer quota strips) is its first
//    consumer, below. "Add a network" on the Composer's post-detail page still has no control —
//    that needs an account-CONNECT flow (SMM-07, still unbuilt), not just a listing — so
//    `composer/[postId]/page.tsx`'s `BackendPending` stands; only the READ side of the gap closes
//    here.
import { platformFetch, PlatformError } from "./platform";
import { EMPTY_TOOL_SCOPE } from "./socialShared";
import type {
  Guarded, SocialEngagement, SocialEngagementDetail, EngagementScope, SocialBrandProfile,
  SocialCampaign, SocialKpiTarget, SocialPost, SocialPostStatus, SocialPostDetail,
  VariantValidationResult, SocialAccount, PublishPreconditionResult,
} from "./socialShared";

export * from "./socialShared";

// ── the honesty contract: 403 must never fold into an empty state ─────────────────────────────────
//
// The client portal shipped exactly this bug once (`lib/portal-data.ts`'s own header): collapsing
// a Cerbos DENIAL (403) into the same `[]`/`null` an ABSENT module or entity degrades to (404) told
// a denied viewer "nothing here yet," which reads as "your access is fine, there's just no data" —
// the wrong claim entirely. `ModuleEnabledGuard` 404s when the company hasn't enabled `social`
// (or no ACTIVE service_assignment serves it) — that IS a legitimate "nothing to show here," same
// disposition as every other module in this codebase. `authorize()` 403s on a real Cerbos denial —
// that is NEVER "empty," and every reader below says so via the `forbidden` flag rather than
// swallowing it. A 500/network failure is left to throw into the route's error boundary — same
// rule portal-data.ts states: a backend outage rendering as a quiet empty calendar is the worst
// available outcome, not a safe default.
async function readGuarded<T>(p: Promise<T>, fallback: T): Promise<Guarded<T>> {
  try {
    return { data: await p, forbidden: false };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return { data: fallback, forbidden: false };
    if (e instanceof PlatformError && e.status === 403) return { data: fallback, forbidden: true };
    throw e;
  }
}

/** Single-resource GETs must yield an object or nothing — a 200 carrying the wrong SHAPE (e.g. an
 *  array) is the dangerous case searchMarketing.ts's own header describes: truthy, so a `!x`
 *  guard sails past it and the first property access crashes the page. Same defensive coercion. */
function asObject<T>(v: unknown): T | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
}
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

const base = (t: string) => `/api/${t}/modules/social`;

// ── engagements ──────────────────────────────────────────────────────────────────────────────────

export const listEngagements = async (
  u: string, t: string, params?: { clientId?: string; status?: string },
): Promise<Guarded<SocialEngagement[]>> => {
  const qs = new URLSearchParams();
  if (params?.clientId) qs.set("clientId", params.clientId);
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/engagements${suffix}`, u), []);
  return { ...r, data: asArray<SocialEngagement>(r.data) };
};

export const getEngagement = async (u: string, t: string, id: string): Promise<Guarded<SocialEngagementDetail | null>> => {
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/engagements/${id}`, u), null);
  return { ...r, data: asObject<SocialEngagementDetail>(r.data) };
};

const EMPTY_SCOPE: EngagementScope = { toolScope: EMPTY_TOOL_SCOPE, usageBudgetUsd: 0 };

export const getEngagementScope = async (u: string, t: string, engagementId: string): Promise<Guarded<EngagementScope>> => {
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/engagements/${engagementId}/scope`, u), EMPTY_SCOPE);
  return { ...r, data: asObject<EngagementScope>(r.data) ?? EMPTY_SCOPE };
};

// ── brand profiles ───────────────────────────────────────────────────────────────────────────────

export const getBrandProfile = async (u: string, t: string, clientId: string): Promise<Guarded<SocialBrandProfile | null>> => {
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/brand-profiles/${clientId}`, u), null);
  return { ...r, data: asObject<SocialBrandProfile>(r.data) };
};

// ── campaigns / kpi targets ──────────────────────────────────────────────────────────────────────

export const listCampaigns = async (u: string, t: string, engagementId?: string): Promise<Guarded<SocialCampaign[]>> => {
  const suffix = engagementId ? `?engagementId=${encodeURIComponent(engagementId)}` : "";
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/campaigns${suffix}`, u), []);
  return { ...r, data: asArray<SocialCampaign>(r.data) };
};

export const listKpiTargets = async (u: string, t: string, engagementId?: string): Promise<Guarded<SocialKpiTarget[]>> => {
  const suffix = engagementId ? `?engagementId=${encodeURIComponent(engagementId)}` : "";
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/kpi-targets${suffix}`, u), []);
  return { ...r, data: asArray<SocialKpiTarget>(r.data) };
};

// ── posts (the calendar as data) ─────────────────────────────────────────────────────────────────

export const listPosts = async (
  u: string, t: string, params?: { engagementId?: string; status?: SocialPostStatus },
): Promise<Guarded<SocialPost[]>> => {
  const qs = new URLSearchParams();
  if (params?.engagementId) qs.set("engagementId", params.engagementId);
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/posts${suffix}`, u), []);
  return { ...r, data: asArray<SocialPost>(r.data) };
};

export const getPost = async (u: string, t: string, postId: string): Promise<Guarded<SocialPostDetail | null>> => {
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/posts/${postId}`, u), null);
  return { ...r, data: asObject<SocialPostDetail>(r.data) };
};

export const getVariantValidation = async (u: string, t: string, variantId: string): Promise<Guarded<VariantValidationResult | null>> => {
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/variants/${variantId}/validation`, u), null);
  return { ...r, data: asObject<VariantValidationResult>(r.data) };
};

// ── accounts (SMM-05 registry — quota strips' data source, SMM-12) ─────────────────────────────────

/** The controller wraps the array in `{accounts: [...]}` (unlike every other list route here, which
 *  returns a bare array) — unwrap it explicitly rather than assuming the shape, per this file's own
 *  "a 200 carrying the wrong SHAPE" defensive-coercion rule. DEMO_MODE's generic GET fallback
 *  returns a bare `[]` for any unmatched path (no social account fixture exists yet), which is
 *  neither an object nor `{accounts:[...]}` — `asArray` on `.accounts` of a non-object safely
 *  degrades to `[]` rather than throwing. */
export const listAccounts = async (
  u: string, t: string, params?: { clientId?: string; status?: string },
): Promise<Guarded<SocialAccount[]>> => {
  const qs = new URLSearchParams();
  if (params?.clientId) qs.set("clientId", params.clientId);
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/accounts${suffix}`, u), { accounts: [] });
  const obj = asObject<{ accounts: unknown }>(r.data);
  return { ...r, data: asArray<SocialAccount>(obj?.accounts) };
};

// ── the publish gate's dry run (SMM-09), read from the Composer (SMM-12) ───────────────────────────

/** `evaluatePublishPrecondition`'s dry run for ONE variant, read-tier (`social_post`/`read`) —
 *  asking whether a publish WOULD be allowed is not publishing. A missing variant is a 404 (the
 *  controller's own comment: folding it into the verdict body would make "no such variant"
 *  indistinguishable from "exists and is currently blocked"), which `readGuarded` turns into the
 *  `null` fallback here — the caller must render that as "can't check" separately from an actual
 *  `ok:false` verdict. */
export const getPublishPreconditions = async (
  u: string, t: string, variantId: string,
): Promise<Guarded<PublishPreconditionResult | null>> => {
  const r = await readGuarded(platformFetch<unknown>(`${base(t)}/variants/${variantId}/publish-preconditions`, u), null);
  return { ...r, data: asObject<PublishPreconditionResult>(r.data) };
};

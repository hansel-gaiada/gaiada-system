// SMM-05 — the driver registry, and the OTel-instrumented call seam every publisher operation
// goes through (design §05 driver rules).
//
// Mirrors modules/search/providers/registry.ts's shape deliberately: a process-level Map that
// starts EMPTY, so with no driver registered every publisher-touching path fails closed at the
// registry (`publisher_not_configured`) rather than silently no-op'ing against a phantom engine.
// main.ts registers the real Postiz driver at bootstrap behind the base-URL check
// (`wireSocialPublisher`); tests register the mock.
//
// ── WHY THE SPAN LIVES HERE AND NOT IN THE DRIVER ───────────────────────────────────────────────
// Design §05 requires every request/response to be OTel-annotated with network / org / op /
// cost_usd. Putting that in the driver would mean re-implementing it in the Mixpost driver, and
// "the second driver forgot to instrument" is a silent observability hole nobody notices until an
// incident. `invokePublisher` wraps ANY driver, so the contract is a property of the PORT rather
// than of one implementation — and callers get the refusal-to-status mapping for free too.
import { trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { config } from "../../../config";
import type { Network } from "../media-rules";
import type { OrgHandle, PublisherCapability, PublisherKey, SocialPublisher } from "./types";
import { SocialPublisherError } from "./types";

const publishers = new Map<PublisherKey, SocialPublisher>();
const tracer = trace.getTracer("social.publisher");

export function registerPublisher(p: SocialPublisher): void {
  publishers.set(p.key, p);
}

/** Test seam — drop all registrations (each suite registers exactly the driver it exercises). */
export function resetPublishers(): void {
  publishers.clear();
}

export function getPublisher(key: PublisherKey): SocialPublisher | undefined {
  return publishers.get(key);
}

/** Resolve the driver a `social_publisher_orgs` row names (0105's `driver` column: 'postiz' |
 *  'mixpost'). Honor-or-refuse, exactly like the search registry's explicit-provider path: a row
 *  that names a driver this deployment does not run REFUSES rather than quietly using the other
 *  one. Substituting a publishing engine under an operator is never a helpful default. */
export function resolvePublisher(driver: string): SocialPublisher {
  const p = publishers.get(driver as PublisherKey);
  if (!p) {
    // SMM-38c — `direct`'s registration must not flip this heuristic. `resolvePublisher` is called
    // ONLY with `org.driver` (0105's `social_publisher_orgs.driver` CHECK admits only
    // 'postiz'|'mixpost' — 'direct' is never written to that column, see types.ts's header), so
    // "is anything configured" means "is any driver OTHER THAN `direct` registered", not "is the
    // registry non-empty". Without this carve-out, registering `direct` the moment it earned a real
    // capability (this phase) would have silently turned every Postiz-unconfigured deployment's
    // honest `publisher_not_configured` into a confusing `unknown_publisher` — exactly the
    // live-behaviour change `boot.ts`'s own header named as forbidden. `direct` is only ever reached
    // by NAME through `resolvePublisherForCapability` below, never through this function.
    const anyNonDirectRegistered = [...publishers.keys()].some((k) => k !== "direct");
    if (!anyNonDirectRegistered) {
      throw new SocialPublisherError(
        "publisher_not_configured",
        "no social publisher is configured in this deployment (SOCIAL_POSTIZ_BASE_URL unset) — "
        + "publishing and connector sync are unavailable; every other social capability is unaffected",
      );
    }
    throw new SocialPublisherError("unknown_publisher", `social publisher driver '${driver}' is not registered`);
  }
  return p;
}

/** SMM-38/38a→38b (design addendum §PD) — the per-(network, capability) switch. A NEW dimension laid
 *  ON TOP of `resolvePublisher`'s existing per-ORG resolution; it does not replace it.
 *
 *  ── THE KEY IS (network, capability), NOT capability ALONE — 38b's correction to 38a's shape ────
 *  38a shipped this keyed on `capability` only. That was wrong: 38e's exit criterion is a
 *  PER-NETWORK split (LinkedIn + YouTube move to `direct`; Postiz keeps IG/FB/TikTok), and the P2
 *  inbox needs per-capability granularity WITHIN a network too ("LinkedIn comments via `direct`,
 *  LinkedIn publish via `postiz`" is a real, expected config, not a hypothetical). A capability-only
 *  key cannot express either shape on its own — flipping `schedule` for LinkedIn would have flipped
 *  it for every other network's `schedule` too. 38b widens the key before any override is ever set in
 *  a real deployment (the tracker's own record: this switch has never been called from a live path
 *  and `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS` has never been set anywhere), so the correction costs
 *  nothing in migration and changes no live behaviour.
 *
 *  ── MOST SPECIFIC WINS ───────────────────────────────────────────────────────────────────────────
 *  `config.social.publisher.capabilityDrivers` is a flat map keyed by ONE of three string shapes,
 *  checked in this exact order:
 *    1. `${network}:${capability}`  — exact match, e.g. `"linkedin:schedule"`
 *    2. `${network}:*`              — every capability on that one network, e.g. `"linkedin:*"`
 *    3. `*:${capability}`           — one capability across every network, e.g. `"*:inbox_read"`
 *  There is deliberately no `*:*` — that would just be a global default no one asked for, and the
 *  existing per-org `driver` column is already that default.
 *
 *  ── WHY THIS IS STILL INERT BY CONSTRUCTION ─────────────────────────────────────────────────────
 *  The map is EMPTY by default. With no entry matching any of the three key shapes for a given
 *  (network, capability) pair, this function falls straight through to `resolvePublisher(orgDriver)`
 *  — the EXACT call every existing caller already makes via `provisioning.ts`'s `openOrg`. That
 *  equivalence, not an "if disabled, skip" branch, is what keeps this a no-op with the shipped
 *  default config, for every (network, capability, org) triple, in every deployment.
 *
 *  ── THE PER-ORG REFUSAL PROPERTY IS PRESERVED AT THE NEW DIMENSION ──────────────────────────────
 *  `resolvePublisher`'s own header names the rule: a name that does not resolve REFUSES rather than
 *  quietly substituting a different engine. An override that names a driver this deployment does not
 *  run throws `unknown_publisher` — it never falls back to the org's own driver, which would be
 *  exactly the silent-substitution `resolvePublisher` was written to forbid, just moved one layer up.
 *
 *  ── NOT YET CALLED FROM ANY LIVE PATH ───────────────────────────────────────────────────────────
 *  `provisioning.ts`'s `openOrg` still calls `resolvePublisher(org.driver)` directly. Routing
 *  different capabilities of ONE call to different drivers is real surgery on those call sites —
 *  38c/38d's job, once `direct` has a capability worth routing to. This function ships the switch
 *  itself, proven correct in isolation by the tests directly below, without touching a live call
 *  path. */
export function resolvePublisherForCapability(
  orgDriver: string,
  network: Network,
  capability: PublisherCapability,
): SocialPublisher {
  const overrides = config.social.publisher.capabilityDrivers;
  const override = overrides[`${network}:${capability}`] ?? overrides[`${network}:*`] ?? overrides[`*:${capability}`];
  if (!override) return resolvePublisher(orgDriver);
  const p = publishers.get(override as PublisherKey);
  if (!p) {
    throw new SocialPublisherError(
      "unknown_publisher",
      `social publisher driver '${override}' (configured for network '${network}' capability `
      + `'${capability}' via SOCIAL_PUBLISHER_CAPABILITY_DRIVERS) is not registered`,
    );
  }
  return p;
}

export interface PublisherSpanContext {
  op: string;
  /** Opaque upstream org id — safe on a span (it names a mapping, never a credential). */
  org?: OrgHandle | string;
  network?: string;
  /** Metered spend this call is expected to incur. 0 for everything except X (design §05). */
  costUsd?: number;
  /** Extra attributes; must never carry a key, a token, a caption body or a tenant's PII. */
  extra?: Attributes;
}

/** THE instrumented call seam. Every driver method is invoked through this — see the file header.
 *
 *  It also normalizes failures: a driver may throw a `SocialPublisherError` (already typed) or a
 *  raw transport error (an aborted fetch, a DNS failure, a downed WireGuard tunnel). The raw ones
 *  become `publisher_unreachable`, because that is what they mean to a caller and because an
 *  untyped Error escaping a module is a body-less 500 in this codebase — the same bug four times
 *  over, per platform-nest/CLAUDE.md. */
export async function invokePublisher<T>(ctx: PublisherSpanContext, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`social.publisher.${ctx.op}`, async (span) => {
    const orgId = typeof ctx.org === "string" ? ctx.org : ctx.org?.orgId;
    try {
      const result = await fn();
      span.setAttributes({
        "social.op": ctx.op,
        ...(orgId ? { "social.org": orgId } : {}),
        ...(ctx.network ? { "social.network": ctx.network } : {}),
        "social.cost_usd": ctx.costUsd ?? 0,
        ...(ctx.extra ?? {}),
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const typed = err instanceof SocialPublisherError
        ? err
        : new SocialPublisherError(
          "publisher_unreachable",
          `social publisher '${ctx.op}' did not complete: ${(err as Error).message}`,
        );
      span.setAttributes({
        "social.op": ctx.op,
        ...(orgId ? { "social.org": orgId } : {}),
        ...(ctx.network ? { "social.network": ctx.network } : {}),
        "social.cost_usd": ctx.costUsd ?? 0,
        "social.refusal": typed.code,
      });
      span.recordException(typed);
      span.setStatus({ code: SpanStatusCode.ERROR, message: typed.message });
      throw typed;
    } finally {
      span.end();
    }
  });
}

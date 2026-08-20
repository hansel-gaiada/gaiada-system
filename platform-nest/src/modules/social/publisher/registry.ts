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
    if (publishers.size === 0) {
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

/** SMM-38/38a (design addendum §PD) — the per-capability switch. A NEW dimension laid ON TOP of
 *  `resolvePublisher`'s existing per-ORG resolution; it does not replace it.
 *
 *  ── WHY THIS IS INERT BY CONSTRUCTION ────────────────────────────────────────────────────────────
 *  `config.social.publisher.capabilityDrivers` is a per-capability override map, EMPTY by default.
 *  With no entry for `capability`, this function falls straight through to `resolvePublisher(orgDriver)`
 *  — the EXACT call every existing caller already makes via `provisioning.ts`'s `openOrg`. So until an
 *  operator sets an override, `resolvePublisherForCapability(org.driver, cap)` and
 *  `resolvePublisher(org.driver)` return the identical driver for the identical reason, for every
 *  capability, for every org, in every deployment. That equivalence — not an "if disabled, skip"
 *  branch — is what makes 38a a no-op: there is no flag guarding this function off, because with the
 *  shipped default config it computes nothing a caller could not already reach.
 *
 *  ── THE PER-ORG REFUSAL PROPERTY IS PRESERVED AT BOTH DIMENSIONS ────────────────────────────────
 *  `resolvePublisher`'s own header names the rule: a name that does not resolve REFUSES rather than
 *  quietly substituting a different engine. That rule is untouched (this function does not change
 *  `resolvePublisher` at all) and it is repeated at the new dimension: an override that names a
 *  driver this deployment does not run throws `unknown_publisher` — it never falls back to the org's
 *  own driver, which would be exactly the silent-substitution `resolvePublisher` was written to
 *  forbid, just moved one layer up.
 *
 *  ── NOT YET CALLED FROM ANY LIVE PATH ───────────────────────────────────────────────────────────
 *  `provisioning.ts`'s `openOrg` still calls `resolvePublisher(org.driver)` directly — a single
 *  driver resolved once per call site and reused across whichever capabilities that call site
 *  happens to exercise (e.g. `syncConnectorRegistry` calls `listIntegrations` then `getQuota` on the
 *  SAME resolved driver). Routing different capabilities of ONE call to different drivers is real
 *  surgery on those call sites — 38b+'s job, once `direct` has a capability worth routing to. 38a
 *  ships the switch itself, proven correct in isolation by the shared contract suite and by the
 *  tests directly below, without touching a live call path. */
export function resolvePublisherForCapability(orgDriver: string, capability: PublisherCapability): SocialPublisher {
  const override = config.social.publisher.capabilityDrivers[capability];
  if (!override) return resolvePublisher(orgDriver);
  const p = publishers.get(override as PublisherKey);
  if (!p) {
    throw new SocialPublisherError(
      "unknown_publisher",
      `social publisher driver '${override}' (configured for capability '${capability}' via `
      + "SOCIAL_PUBLISHER_CAPABILITY_DRIVERS) is not registered",
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

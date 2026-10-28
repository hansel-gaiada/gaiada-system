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
import {
  SIMULATED_PUBLISHER_KEY, SOCIAL_SIMULATION_ENV, SOCIAL_SIMULATION_REFUSAL, isSimulatedPublisher,
  isSocialSimulationEnabled, publisherProvenanceViolation,
} from "./simulation";

const publishers = new Map<PublisherKey, SocialPublisher>();
const tracer = trace.getTracer("social.publisher");

/** SCP-Sa — every registration is provenance-checked against what is ALREADY registered (simulation.ts's
 *  `publisherProvenanceViolation`): a simulator under a real key, a real engine under 'simulated', or the simulator with
 *  the switch off THROWS here, at the call that would have created it — the SM-33 "boot error, never a warning" doctrine
 *  applied at the one place a driver can enter the registry, so a test or a later refactor cannot assemble a forbidden
 *  registry by calling this function in a different order than boot does. SCP-Sa2 (owner ruling SCP-D9): a real engine
 *  beside the simulator is no longer forbidden here; the account's kind keeps their traffic apart (simulation.ts). */
export function registerPublisher(p: SocialPublisher): void {
  const candidate = [...[...publishers.values()].filter((x) => x.key !== p.key), p];
  const violation = publisherProvenanceViolation(candidate, isSocialSimulationEnabled());
  if (violation) {
    throw new Error(`[social] BOOT ERROR: refusing to register publisher '${p.key}': ${violation} (SCP-Sa)`);
  }
  publishers.set(p.key, p);
}

/** SCP-Sa2 — which REAL publishing engine this process runs, for `GET /health`'s `socialPublisher` (no URL, no key):
 *  'postiz' or 'mixpost' when one is registered, else 'none'. `direct` and the simulator are not engines in this sense
 *  (`direct` is always registered and inert without a grant; the simulator has its own `socialSimulation` field). */
export function realPublisherKey(): "postiz" | "mixpost" | "none" {
  for (const key of ["postiz", "mixpost"] as const) {
    const p = publishers.get(key);
    if (p && !isSimulatedPublisher(p)) return key;
  }
  return "none";
}

/** Test seam — drop all registrations (each suite registers exactly the driver it exercises). */
export function resetPublishers(): void {
  publishers.clear();
}

/** SCP-Sa — every registered driver, for boot's object-level provenance re-check. A copy: callers cannot mutate the map. */
export function listPublishers(): SocialPublisher[] {
  return [...publishers.values()];
}

/** Look a driver up by key. SCP-Sa: NEVER the simulator. A caller that names a key from config or a row
 *  (`SOCIAL_PUBLISHER_DRIVER`, `social_publisher_orgs.driver`) must not be able to land on it by typing its name;
 *  `resolveSimulatedPublisher` below is the only way to reach it. */
export function getPublisher(key: PublisherKey): SocialPublisher | undefined {
  const p = publishers.get(key);
  return p && isSimulatedPublisher(p) ? undefined : p;
}

/** SCP-Sa — THE ONE ROAD TO THE SIMULATOR. Called only by `provisioning.ts#resolveDispatchOrgHandle`, the status
 *  sweep (`post-status-sync-job.ts`) and the metrics sweep (`metrics-job.ts`), and only for an account whose
 *  `social_accounts.simulated` is true. The opposite direction is fenced too (SCP-Sa2): a real path refuses a simulated
 *  account (`simulation.ts#realPublisherRefusal`), so neither driver ever serves the other kind (SCP-Sc's
 *  `isSimulatedPublisherAvailable` below asks it too, but returns only a yes or no and never the driver). Refuses:
 *  - `simulation_disabled` when the switch is off or no simulator is registered (an operator switched it off while
 *    simulated rows remain: they stop publishing, they do not fall through to a real engine);
 *  - `capability_unsupported` for a capability the simulator does not simulate (inbox, metrics until SCP-Sd), so a
 *    caller never gets a driver it would then call a missing method on.
 *  Never falls back to any other driver. */
export function resolveSimulatedPublisher(capability?: PublisherCapability): SocialPublisher {
  const p = publishers.get(SIMULATED_PUBLISHER_KEY);
  if (!isSocialSimulationEnabled() || !p || !isSimulatedPublisher(p)) {
    throw new SocialPublisherError(
      SOCIAL_SIMULATION_REFUSAL.disabled,
      `this account is simulated, and the social simulator is not running (${SOCIAL_SIMULATION_ENV} is off): a `
      + "simulated account never publishes through a real engine",
    );
  }
  if (capability && !p.capabilities.has(capability)) {
    throw new SocialPublisherError(
      "capability_unsupported",
      `the social simulator does not simulate '${capability}'`,
    );
  }
  return p;
}

/** SCP-Sc — "could a simulated account's variant be dispatched right now?", asked through `resolveSimulatedPublisher` so the
 *  switch and the registration are judged by the ONE rule and never by a copy of it. Answers a boolean and never the
 *  driver, so it is not a way to the simulator: `pipeline-data.ts`'s `publisherAvailable` (the `schedule_publisher` guard)
 *  is its only caller. Never throws. */
export function isSimulatedPublisherAvailable(capability: PublisherCapability = "schedule"): boolean {
  try {
    resolveSimulatedPublisher(capability);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the driver a `social_publisher_orgs` row names (0105's `driver` column: 'postiz' |
 *  'mixpost'). Honor-or-refuse, exactly like the search registry's explicit-provider path: a row
 *  that names a driver this deployment does not run REFUSES rather than quietly using the other
 *  one. Substituting a publishing engine under an operator is never a helpful default.
 *
 *  SCP-Sa: the simulator is never resolved by name here (see `getPublisher`), and its registration does not count as
 *  "something is configured" (see the heuristic below), so a Postiz-shaped call under the switch keeps its honest
 *  `publisher_not_configured`. */
export function resolvePublisher(driver: string): SocialPublisher {
  const named = publishers.get(driver as PublisherKey);
  const p = named && !isSimulatedPublisher(named) ? named : undefined;
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
    // SCP-Sa: the simulator is excluded for the same reason `direct` is — it is never reached through this function, so
    // its presence must not turn an honest `publisher_not_configured` into `unknown_publisher`.
    const anyNonDirectRegistered = [...publishers.keys()].some((k) => k !== "direct" && k !== SIMULATED_PUBLISHER_KEY);
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
 *  ── CALLED FROM A LIVE PATH AS OF 38e ────────────────────────────────────────────────────────────
 *  Stale note, corrected 2026-08-21 (this codebase's own "a stale comment beats the code" defect
 *  class — see the tracker's recurring-defect-classes §4b): this function is no longer isolation-only.
 *  `provisioning.ts#resolveDispatchOrgHandle` (38e) calls it for `dispatch.ts`'s two
 *  capability-switchable operations (`media_upload`/`schedule`); `provisioning.ts#openOrg` still
 *  calls `resolvePublisher(org.driver)` directly for every OTHER caller (`verify`,
 *  `syncConnectorRegistry`, `initiateAccountConnect`), which is correct — those never need a
 *  (network, capability) split. See `coversNetworkCapability`'s own doc just below for the
 *  gap-closure pass (2026-08-21) that made an override this function resolves also SAFE to actually
 *  call, not merely resolvable. */
export function resolvePublisherForCapability(
  orgDriver: string,
  network: Network,
  capability: PublisherCapability,
): SocialPublisher {
  const overrides = config.social.publisher.capabilityDrivers;
  const override = overrides[`${network}:${capability}`] ?? overrides[`${network}:*`] ?? overrides[`*:${capability}`];
  if (!override) return resolvePublisher(orgDriver);
  // SCP-Sa — an override can never name the simulator. `*:schedule=simulated` would route EVERY account, real ones
  // included, to a driver that reports a publish that never happened. Refused as `unknown_publisher` (the name does
  // not resolve through this door), and boot refuses such a value outright (boot.ts).
  const named = publishers.get(override as PublisherKey);
  const p = named && !isSimulatedPublisher(named) && override !== SIMULATED_PUBLISHER_KEY ? named : undefined;
  if (!p) {
    throw new SocialPublisherError(
      "unknown_publisher",
      `social publisher driver '${override}' (configured for network '${network}' capability `
      + `'${capability}' via SOCIAL_PUBLISHER_CAPABILITY_DRIVERS) is not registered`,
    );
  }
  // ── SMM-38, gap-closure pass (2026-08-21) — the override-safety gap, closed HERE ─────────────
  // Before this pass, naming a REGISTERED driver was the only bar an override had to clear — a
  // config value could name a (network, capability) pair the resolved driver would refuse the
  // instant it was actually called (`youtube:schedule=direct`: `direct` never implements a schedule
  // step for YouTube, by design — its publish terminates at `uploadMedia` instead, see
  // `isUploadTerminalFor`'s own doc). That let a doomed dispatch travel all the way to the network
  // hop before failing, which is exactly the "refuse late" shape this codebase's own D-12 doctrine
  // forbids.
  //
  // `coversNetworkCapability` (types.ts) is DATA the driver itself declares — the same "a driver
  // that declares what it can serve beats a list someone must keep in sync" precedent
  // `DIRECT_CAPABILITIES` / `capabilities.ts`'s three-reasons model already set for this module. A
  // future network or capability this driver grows needs exactly ONE new entry, on the driver's own
  // map (`direct.ts#NETWORK_CAPABILITIES`) — never a second list here, in `config.ts`, or anywhere
  // else that could silently drift out of sync with the driver's real behaviour.
  //
  // Absent method ⇒ this driver makes no per-network distinction at all (Postiz's/the mock's real
  // shape: one flat capability set, every network alike) — nothing to refuse, and this branch is a
  // pure no-op for every deployment that has never registered anything but `postiz`/the mock, which
  // is every deployment today.
  if (p.coversNetworkCapability && !p.coversNetworkCapability(network, capability)) {
    throw new SocialPublisherError(
      "capability_unsupported",
      `social publisher driver '${p.key}' does not cover network '${network}' for capability `
      + `'${capability}' (configured via SOCIAL_PUBLISHER_CAPABILITY_DRIVERS) — refused before any `
      + "network call was attempted, not after one",
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

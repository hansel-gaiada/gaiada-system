// SCP-Sa — the social simulator's switch, its marks and its RUNTIME fences. The boot fences are in boot.ts; the
// simulator itself is simulated-driver.ts. This file is the leaf both of them, the registry, provisioning and the two
// OAuth connect flows import, so it imports nothing from them (no cycle) and owns no I/O.
//
// ── WHAT IS BEING REVERSED, AND WHY IT IS STILL SAFE ───────────────────────────────────────────────────────────────
// Until SCP-Sa this module had a standing rule, written in mock-driver.ts's and boot.ts's headers: no simulator, under
// any flag. "A simulated publish would be a post that never appeared on a client's account while our calendar said it
// did — worse than an outage, because it is silent." The owner reversed it for the dev-review stage (plan SCP-D1:
// "we need to simulate everything to see if its working"; SCP-D3: a labelled simulator, flag-gated, off before real
// data). The hazard did not go away, so the reversal is fenced on every side the hazard can reach:
//
//   1. ONE SWITCH, OFF BY DEFAULT. `SOCIAL_SIMULATION_ENABLED` (config.ts), read at CALL time through
//      `isSocialSimulationEnabled()` below, never cached, so no stale copy can disagree with it.
//   2. ONE ROAD IN. A variant reaches the simulator only when its ACCOUNT carries `social_accounts.simulated = true`
//      (`provisioning.ts#resolveDispatchOrgHandle`). The org `driver` column cannot name it (0105's CHECK), no
//      capability override can name it, and `resolvePublisher`/`getPublisher` refuse it by name (registry.ts).
//   3. NEVER BESIDE ANYTHING REAL. With the switch on, boot refuses (an ERROR that aborts startup, the SM-33 doctrine)
//      when a real publisher is usable or ANY non-simulated account exists, in any tenant (boot.ts). A real account
//      connected after boot is refused at RUNTIME by every path that creates or connects one
//      (`assertRealAccountWriteAllowed` below, called by provisioning.ts, linkedin-oauth.ts, youtube-oauth.ts and the
//      portal seed). So "the switch is on" and "this ERP holds a real account" cannot both be true.
//   4. NEVER WITHOUT THE SWITCH. With it off the simulator is never registered (`registry.ts#registerPublisher` refuses
//      a simulated driver outright), and nothing may write a `simulated = true` account or variant
//      (`assertSimulatedWriteAllowed`). The simulator re-checks the switch on every call as well.
//   5. NEVER AROUND THE APPROVAL. The simulator publishes only a variant that holds a DECIDED publish approval
//      (BFF §63.10: it "never mints or decides one itself"), through the SAME `dispatch.ts` path a real publish takes,
//      and refuses any variant whose account is not simulated even if every fence above had slipped.
//   6. ALWAYS LABELLED. Its URLs live under `https://simulated.invalid/` (`.invalid` is reserved by RFC 2606 and can
//      never resolve), the variant is stamped `simulated = true`, and the switch shows in `GET /health` and in a boot
//      warning line on every start (`[social:simulation-enabled]`).
//
// Before the ERP holds real client data the switch goes OFF and the simulated rows are purged (plan §5, "Before real
// clients use the portal"). With the switch off and simulated rows still present nothing breaks and nothing publishes:
// a simulated account's variant refuses `simulation_disabled` at dispatch.
import { config } from "../../../config";
import { OrgHandle, SocialPublisherError, type PublisherKey, type SocialPublisher } from "./types";

/** The environment variable, named once so every refusal message names it the same way. */
export const SOCIAL_SIMULATION_ENV = "SOCIAL_SIMULATION_ENABLED";

/** The simulator's registry key. Never a value of `social_publisher_orgs.driver` (0105's CHECK admits postiz|mixpost). */
export const SIMULATED_PUBLISHER_KEY: PublisherKey = "simulated";

/** The origin every simulated URL lives under. `.invalid` is reserved (RFC 2606): it can never resolve, so a simulated
 *  link opened by mistake goes nowhere instead of to somebody's real page. */
export const SIMULATED_URL_ORIGIN = "https://simulated.invalid";

/** A caption containing this fails through the normal failed-post path (plan §5). Case-sensitive, matched literally. */
export const SIMULATE_FAIL_KEYWORD = "[simulate-fail]";

/** Every refusal this ticket adds. The codes are `SocialPublisherError` codes, so `publisher-error.filter.ts` renders
 *  them as `{error, code}` and `dispatch.ts` records them on a failed variant as `<code>: <message>`. */
export const SOCIAL_SIMULATION_REFUSAL = {
  /** Switch ON, and this path would create or connect a REAL account (409). */
  realAccountRefused: "simulation_real_account_refused",
  /** Switch OFF, and this path would write a simulated row or call the simulator (409). */
  disabled: "simulation_disabled",
  /** The simulator was handed a variant whose account is not simulated (409). */
  accountNotSimulated: "simulated_account_required",
  /** The simulator found no decided publish approval for the variant (409). */
  approvalNotDecided: "simulated_approval_not_decided",
  /** The `[simulate-fail]` keyword: the simulated engine refuses (502, the "engine answered badly" family). */
  simulatedFailure: "simulated_publish_failed",
} as const;

/** THE switch, read at call time. Never cache this: a test flips `config.socialSimulationEnabled`, and an operator's
 *  restart with the env var removed must take effect on the very next call. */
export function isSocialSimulationEnabled(): boolean {
  return config.socialSimulationEnabled === true;
}

/** Is THIS driver the simulator? Structural, not `instanceof` and not by key (the SM-33 `isSimulatedProvider` shape):
 *  provenance follows the object that would do the publishing. Anything unmarked is REAL. */
export function isSimulatedPublisher(p: Pick<SocialPublisher, "key"> | null | undefined): boolean {
  return (p as { simulated?: unknown } | null | undefined)?.simulated === true;
}

/** RUNTIME fence 3 (header): refuse a REAL account write while the switch is on. Called FIRST by every path that
 *  creates or connects a `social_accounts` row; `where` names the path in the message so an operator can see which door
 *  was knocked on. Throws a typed 409. */
export function assertRealAccountWriteAllowed(where: string): void {
  const refusal = realAccountWriteRefusal(where);
  if (refusal) throw new SocialPublisherError(refusal.reason, refusal.detail);
}

/** The non-throwing form, for the connect READINESS checks (they answer `{ok:false, reason, detail}` to a read and must
 *  never throw for an ordinary "not now"). `null` when the write is allowed. */
export function realAccountWriteRefusal(
  where: string,
): { ok: false; reason: "simulation_real_account_refused"; detail: string } | null {
  if (!isSocialSimulationEnabled()) return null;
  return {
    ok: false,
    reason: SOCIAL_SIMULATION_REFUSAL.realAccountRefused,
    detail: `${where}: refused because ${SOCIAL_SIMULATION_ENV} is on. While the social simulator runs, this ERP may `
      + "hold only simulated accounts (plan SCP-D3): a real account beside the simulator is the 'post that never "
      + "appeared while our calendar said it did' hazard. Turn the simulator off before connecting a real account.",
  };
}

/** RUNTIME fence 4 (header): refuse to write a SIMULATED account or variant while the switch is off. Called by the
 *  dispatch stamp before it marks a variant simulated, and owed by SCP-Sb's seed before it writes a simulated account. */
export function assertSimulatedWriteAllowed(where: string): void {
  if (isSocialSimulationEnabled()) return;
  throw new SocialPublisherError(
    SOCIAL_SIMULATION_REFUSAL.disabled,
    `${where}: refused because ${SOCIAL_SIMULATION_ENV} is off. A simulated social row may be written only while the `
    + "simulator is switched on (plan SCP-D3).",
  );
}

/** The org handle the simulator is called with. It carries OUR tenant and account ids instead of an upstream key,
 *  because the simulator is not across the AGPL line (types.ts rule 4 is about the licence zone; the simulator is
 *  in-process and must read our own rows to refuse honestly). The key is the empty string: there is no credential,
 *  and `secret()` never has anything to leak. `accountId` is null for the status read, which works on provider ids. */
export class SimulatedOrgHandle extends OrgHandle {
  constructor(
    readonly tenantId: string,
    readonly accountId: string | null,
    publisherOrgId: string,
  ) {
    super(publisherOrgId, "simulated", "");
  }

  override toString(): string {
    return `SimulatedOrgHandle(${this.publisherOrgId})`;
  }
}

/** The object-level re-verification boot runs after registration (the SM-33 `assertProvenance` shape), also run by
 *  `registry.ts#registerPublisher` on every single registration. Returns the first violation, or null. Pure.
 *
 *  - a driver's MARKER must match its KEY: the simulator registers only as 'simulated', and nothing marked real may
 *    take that key (a real engine filed under 'simulated' would publish for real behind a SIMULATED chip; a simulator
 *    filed under 'postiz' would mark real clients' posts published that never went out);
 *  - with the switch OFF no simulated driver may be registered at all;
 *  - with the switch ON no real ENGINE ('postiz', 'mixpost') may be registered beside it. 'direct' may stay registered:
 *    it is inert unless an override routes to it or a live OAuth grant exists, and boot refuses both. */
export function publisherProvenanceViolation(
  drivers: ReadonlyArray<Pick<SocialPublisher, "key">>,
  simulationEnabled: boolean,
): string | null {
  for (const d of drivers) {
    const marked = isSimulatedPublisher(d);
    if (marked !== (d.key === SIMULATED_PUBLISHER_KEY)) {
      return `driver '${d.key}' carries simulated=${marked}: the simulator registers only under the key `
        + `'${SIMULATED_PUBLISHER_KEY}', and only the simulator may take that key`;
    }
    if (marked && !simulationEnabled) {
      return `driver '${d.key}' is the social simulator, but ${SOCIAL_SIMULATION_ENV} is off`;
    }
    if (simulationEnabled && (d.key === "postiz" || d.key === "mixpost")) {
      return `driver '${d.key}' is a real publishing engine, and ${SOCIAL_SIMULATION_ENV} is on: the simulator and a `
        + "real engine are never registered together";
    }
  }
  return null;
}

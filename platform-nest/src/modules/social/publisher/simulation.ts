// SCP-Sa / SCP-Sa2 — the social simulator's switch, its marks and its RUNTIME fences. The boot fences are in boot.ts; the
// simulator itself is simulated-driver.ts; the database half of "one kind" is migration 202610280100_social_account_kind.
// This file is the leaf both of them, the registry, provisioning, the two OAuth connect flows and the sweeps import, so it
// imports nothing from them (no cycle) and owns no I/O.
//
// ── WHAT IS BEING REVERSED, AND WHY IT IS STILL SAFE ───────────────────────────────────────────────────────────────
// Until SCP-Sa this module had a standing rule, written in mock-driver.ts's and boot.ts's headers: no simulator, under
// any flag. "A simulated publish would be a post that never appeared on a client's account while our calendar said it
// did — worse than an outage, because it is silent." The owner reversed it for the dev-review stage (plan SCP-D1:
// "we need to simulate everything to see if its working"; SCP-D3: a labelled simulator, flag-gated, off before real
// data). SCP-Sa then kept the simulator and anything real strictly apart ("never both"). The owner ruled again (SCP-D9,
// 2026-10-28): "use simulator with postiz. so we can know if its working or not at the same time". The simulator and a
// real Postiz now run SIDE BY SIDE: a simulated account publishes through the simulator, a real account through Postiz.
// The hazard did not go away, so the containment moved from "never both" to "NEVER MIXED", fenced on every side:
//
//   1. ONE SWITCH, OFF BY DEFAULT. `SOCIAL_SIMULATION_ENABLED` (config.ts), read at CALL time through
//      `isSocialSimulationEnabled()` below, never cached, so no stale copy can disagree with it.
//   2. ONE ROAD IN. A variant reaches the simulator only when its ACCOUNT carries `social_accounts.simulated = true`
//      (`provisioning.ts#resolveDispatchOrgHandle`, the status and metrics sweeps). The org `driver` column cannot name it
//      (0105's CHECK), no capability override can name it (refused at boot, switch on or off), and
//      `resolvePublisher`/`getPublisher` refuse it by name (registry.ts).
//   3. EVERY ACCOUNT IS EXACTLY ONE KIND, IN THE DATABASE (SCP-Sa2). `social_accounts_kind_ck`: a simulated row carries a
//      `simulated:` integration id and no `connected_by`; a real row never carries a `simulated:` id. The kind never
//      changes once a row has been used (`trg_social_accounts_kind_guard`), and no OAuth grant names a simulated account
//      (`trg_social_oauth_tokens_real_account_only`). Boot re-checks both (belt over the CHECK, for a row from before it).
//      Every path that writes a REAL account (provisioning.ts sync and connect, the two OAuth flows, the portal seed)
//      writes no mark and no `simulated:` id (`assertRealIntegrationId` below), and none of their upserts can land on a
//      simulated row (`... DO UPDATE ... WHERE social_accounts.simulated = false`): a real connect on a handle a simulated
//      account holds refuses `simulated_account_on_real_publisher` instead of converting it.
//   4. EACH DRIVER REFUSES THE OTHER KIND (SCP-Sa2). The simulator refuses a variant whose account is not simulated (its own
//      guard reads our rows: `simulated_account_required`). THE REVERSE FENCE: every real path that is about to hand a
//      variant or an account to a real engine (the dispatch resolver's real branch, the status sweep's real groups and the
//      webhook intake, the metrics sweep's real halves, dispatch.ts's TikTok creator-info probe) asks
//      `realPublisherRefusal` below and refuses `simulated_account_on_real_publisher` for a simulated account, a
//      `simulated:` integration id or a `simulated:` provider post id (the simulator's own mint), even if the routing
//      upstream had slipped. Two independent signals, tied together by the CHECK in 3.
//   5. NEVER WITHOUT THE SWITCH. With it off the simulator is never registered (`registry.ts#registerPublisher` refuses
//      a simulated driver outright), and nothing may write a `simulated = true` account or variant
//      (`assertSimulatedWriteAllowed`). The simulator re-checks the switch on every call as well. A simulated account's
//      variant then refuses `simulation_disabled`; it never falls through to a real engine.
//   6. NEVER AROUND THE APPROVAL. The simulator publishes only a variant that holds a DECIDED publish approval
//      (BFF §63.10: it "never mints or decides one itself"), through the SAME `dispatch.ts` path a real publish takes.
//   7. ALWAYS LABELLED. Its URLs live under `https://simulated.invalid/` (`.invalid` is reserved by RFC 2606 and can
//      never resolve), the variant is stamped `simulated = true`, and the switch shows in `GET /health` (`socialSimulation`,
//      beside `socialPublisher`, so an operator sees both are on) and in a boot warning line on every start
//      (`[social:simulation-enabled]`).
//
// What SCP-Sa2 REMOVED, deliberately and only this: boot no longer refuses the switch beside a configured Postiz, a
// capability override that names a REAL driver, a live OAuth grant or a real account; the connect paths no longer refuse
// a real account while the switch is on (`simulation_real_account_refused` is gone); and a real engine may be registered
// beside the simulator. Each of those encoded "never both". Nothing that encoded "never mixed" was weakened.
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

/** SCP-Sa2 — the prefix that belongs to simulated rows alone: a simulated account's integration id
 *  (`simulated:<network>`, SCP-Sb's seed) and every provider post id the simulator mints
 *  (`simulated:<network>:<publishAtMs>:<uuid>`). `social_accounts_kind_ck` ties it to `simulated = true`, which is what
 *  lets the reverse fence use it as a second, independent signal of the kind. Case-sensitive, like the CHECK's LIKE. */
export const SIMULATED_ID_PREFIX = "simulated:";

/** A caption containing this fails through the normal failed-post path (plan §5). Case-sensitive, matched literally. */
export const SIMULATE_FAIL_KEYWORD = "[simulate-fail]";

/** Every refusal the simulator's containment adds. The codes are `SocialPublisherError` codes, so
 *  `publisher-error.filter.ts` renders them as `{error, code}` and `dispatch.ts` records them on a failed variant as
 *  `<code>: <message>`. */
export const SOCIAL_SIMULATION_REFUSAL = {
  /** Switch OFF, and this path would write a simulated row or call the simulator (409). */
  disabled: "simulation_disabled",
  /** The simulator was handed a variant whose account is not simulated (409). */
  accountNotSimulated: "simulated_account_required",
  /** SCP-Sa2 — THE REVERSE FENCE: a real path was handed a simulated account, a `simulated:` integration id or a
   *  `simulated:` provider post id (409). Also a real write that would land on a simulated row. */
  simulatedOnRealPublisher: "simulated_account_on_real_publisher",
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

/** Does this id carry the simulated prefix? Null/undefined/empty never does. */
export function isSimulatedId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(SIMULATED_ID_PREFIX);
}

/** What a real path knows about the variant or account it is about to hand to a real engine. Every field is optional:
 *  a caller passes what it has read, and each one that is present is checked. */
export interface RealPublisherTarget {
  /** `social_accounts.simulated` as the caller read it. */
  simulated?: boolean | null;
  /** `social_accounts.postiz_integration_id`. */
  integrationId?: string | null;
  /** `social_post_variants.provider_post_id`. */
  providerPostId?: string | null;
}

/** RUNTIME fence 4 (header), THE REVERSE FENCE, non-throwing: the refusal a real path must make before handing `t` to a
 *  real engine, or null when `t` is plainly real. `where` names the path, so an operator can see which door was knocked
 *  on. Pure. A sweep uses this form to refuse one row and carry on with the rest; a single-target path throws it. */
export function realPublisherRefusal(where: string, t: RealPublisherTarget): SocialPublisherError | null {
  const why = t.simulated === true ? "its account is simulated"
    : isSimulatedId(t.integrationId) ? `its integration id '${t.integrationId}' is a simulated account's`
    : isSimulatedId(t.providerPostId) ? "its provider post id was minted by the social simulator"
    : null;
  if (!why) return null;
  return new SocialPublisherError(
    SOCIAL_SIMULATION_REFUSAL.simulatedOnRealPublisher,
    `${where}: refused because ${why}. A simulated account is served only by the social simulator, never by a real `
    + "engine (owner ruling SCP-D9: the simulator runs beside Postiz, and the two are never mixed).",
  );
}

/** The throwing form of `realPublisherRefusal`. */
export function assertRealPublisherTarget(where: string, t: RealPublisherTarget): void {
  const refusal = realPublisherRefusal(where, t);
  if (refusal) throw refusal;
}

/** RUNTIME fence 3 (header): a path that writes a REAL account's integration id refuses a `simulated:` one. The CHECK
 *  would refuse the row anyway; this names the path and answers a typed 409 instead of a constraint error. Null/empty
 *  passes (a pending account has none). */
export function assertRealIntegrationId(where: string, integrationId: string | null | undefined): void {
  if (!isSimulatedId(integrationId)) return;
  throw new SocialPublisherError(
    SOCIAL_SIMULATION_REFUSAL.simulatedOnRealPublisher,
    `${where}: refused to write the integration id '${integrationId}' on a real account: the '${SIMULATED_ID_PREFIX}' `
    + "prefix belongs to simulated accounts alone (social_accounts_kind_ck, SCP-D9)",
  );
}

/** The typed refusal a REAL account writer makes when its upsert met a SIMULATED row on the same (client, network,
 *  handle) key and therefore wrote nothing (`... DO UPDATE ... WHERE social_accounts.simulated = false`). */
export function realWriteOnSimulatedRow(where: string, network: string, handle: string): SocialPublisherError {
  return new SocialPublisherError(
    SOCIAL_SIMULATION_REFUSAL.simulatedOnRealPublisher,
    `${where}: the ${network} handle '${handle}' belongs to a simulated account of this client; a real account is never `
    + "written onto a simulated one (SCP-D9). Remove the simulated account first (DELETE .../simulated-accounts) or use "
    + "another handle.",
  );
}

/** RUNTIME fence 5 (header): refuse to write a SIMULATED account or variant while the switch is off. Called by the
 *  dispatch stamp before it marks a variant simulated, and by SCP-Sb's seed before it writes a simulated account. */
export function assertSimulatedWriteAllowed(where: string): void {
  if (isSocialSimulationEnabled()) return;
  throw new SocialPublisherError(
    SOCIAL_SIMULATION_REFUSAL.disabled,
    `${where}: refused because ${SOCIAL_SIMULATION_ENV} is off. A simulated social row may be written only while the `
    + "simulator is switched on (plan SCP-D3).",
  );
}

/** SCP-Sa2 — the account-kind rule as SQL, ONE copy for boot (`boot.ts#readSocialSimulationDbFacts`) and the operator
 *  script (`seed/social-simulation-prepare.ts`), so the two can never count different things. A row breaks the rule when
 *  it is simulated without a `simulated:` integration id or with a `connected_by`, or real with a `simulated:` id: the
 *  exact negation of `social_accounts_kind_ck`. Expects the table aliased `a`.
 *
 *  TWO-VALUED ON PURPOSE: `NULL LIKE '...'` is NULL, so a bare `NOT a.simulated AND a.postiz_integration_id LIKE ...` is
 *  NULL (not false) for a real account with no integration id, and the whole predicate would answer NULL for the most
 *  common real shape. In a WHERE that happens to read as "no violation", but a predicate that answers "unknown" for a
 *  valid row is not the negation of the CHECK, and any caller that SELECTs it (or NOTs it) would be misled. Every LIKE
 *  is wrapped in COALESCE(..., false), so this answers true or false for every row (pinned on a shape matrix, NULLs
 *  included, by social-account-kind-migration.db.test.ts M7). `a.simulated` is NOT NULL (202610271600). */
export const ACCOUNT_KIND_VIOLATION_SQL = `(
  (a.simulated AND (a.postiz_integration_id IS NULL
                    OR NOT COALESCE(a.postiz_integration_id LIKE '${SIMULATED_ID_PREFIX}%', false)
                    OR a.connected_by IS NOT NULL))
  OR (NOT a.simulated AND COALESCE(a.postiz_integration_id LIKE '${SIMULATED_ID_PREFIX}%', false))
)`;

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
 *  - with the switch OFF no simulated driver may be registered at all.
 *  SCP-Sa2 removed the third rule ("with the switch ON no real engine beside it"): the owner ruled the two run side by
 *  side (SCP-D9). What keeps them apart now is the account's kind (header fences 2-4), not an empty registry. */
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
  }
  return null;
}

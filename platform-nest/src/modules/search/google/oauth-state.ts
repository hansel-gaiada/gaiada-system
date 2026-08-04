// Compatibility shim AND search's adapter onto the shared state machine (WD-23A-1).
//
// The machine itself moved to `core/google-oauth/state.ts`. This file exists for two reasons, and the
// second is the interesting one:
//
// 1. Re-export, so every existing importer (`search.controller.ts`, `search-google-oauth.controller.ts`,
//    the sandbox + adversarial probes) resolves unchanged.
//
// 2. TRANSLATE search's vocabulary into the core one. Search thinks in `clientId` (the agency's client
//    whose Google account is being linked) and `propertyId` (the `search_properties` row to bind).
//    Core thinks in `ownerKind`/`ownerId` — mirroring `integration_connections` — and an opaque
//    `bindTargetId`. Doing that translation HERE rather than editing every search call site is what
//    keeps the AC honest: not one search assertion changes, because search's own API did not.
//
// Search rows are always `ownerKind: 'client'` and always stamped `module: 'search'`. That stamp is
// what preserves migration 0060's `app_module_allowed('search')` wall now that the table is shared —
// the policy reads the row's `module`, so a tenant without search enabled still reads zero search rows.
import {
  createAuthorizationState as coreCreateAuthorizationState,
  consumeAuthorizationState as coreConsumeAuthorizationState,
  type CreatedAuthorizationState,
  type ConsumedAuthorizationState as CoreConsumedAuthorizationState,
  type ConsumeExpectations,
} from "../../../core/google-oauth/state";
import {
  attachConnectionToState as coreAttachConnectionToState,
  pruneExpiredAuthorizationStates as corePruneExpiredAuthorizationStates,
} from "../../../core/google-oauth/state";
import type { GoogleProvider } from "../../../core/google-oauth/registry";
import { GoogleOAuthStateError } from "../../../core/google-oauth/errors";

export {
  GOOGLE_PROVIDERS,
  isGoogleProvider,
} from "../../../core/google-oauth/registry";
export type { GoogleProvider, GoogleOwnerKind } from "../../../core/google-oauth/registry";
export {
  generateCodeVerifier,
  codeChallengeFor,
  signStateToken,
  parseStateToken,
  type ParsedStateToken,
  type CreatedAuthorizationState,
  type ConsumeExpectations,
} from "../../../core/google-oauth/state";

/** Search's three providers — the shared union minus the core-only ones. Lives here, with search's
 *  adapter, because it is search's vocabulary; `oauth.ts` re-exports it for existing importers. */
export type SearchGoogleProvider = Exclude<GoogleProvider, "google_drive">;

/** Validate a provider at a SEARCH request boundary.
 *
 *  `isGoogleProvider` deliberately admits every provider the shared machine supports, which now includes
 *  `google_drive`. Search must NOT accept that — it has no scopes, no property-binding column and no
 *  Cerbos resource for it — so a Drive value on a search route is a bad request, not core being helpful.
 *  This guard is what stops the union widening from leaking sideways into search. */
export function isSearchGoogleProvider(v: string): v is SearchGoogleProvider {
  return v === "google_search_console" || v === "google_analytics" || v === "google_ads";
}

/** Search's own module name, stamped on every row it mints. Named rather than inlined so the two call
 *  sites below cannot drift from each other. */
export const SEARCH_MODULE = "search";

/** Search's input shape, unchanged from before the promotion. */
export interface CreateAuthorizationStateInput {
  tenantId: string;
  clientId: string;
  propertyId?: string | null;
  provider: GoogleProvider;
  redirectUri: string;
  scopes: string[];
  authorizeUrl: string;
  createdBy: string | null;
}

/** Search's view of a consumed row — still `clientId`/`propertyId`, mapped back from the core shape. */
export interface ConsumedAuthorizationState
  extends Omit<CoreConsumedAuthorizationState, "ownerKind" | "ownerId" | "bindTargetId" | "module" | "provider"> {
  clientId: string;
  propertyId: string | null;
  /** Narrowed: a row search minted can only be one of search's providers, and the consume path below
   *  PROVES it rather than asserting it, so nothing downstream has to re-check. */
  provider: SearchGoogleProvider;
}

export async function createAuthorizationState(
  input: CreateAuthorizationStateInput,
): Promise<CreatedAuthorizationState> {
  return coreCreateAuthorizationState({
    tenantId: input.tenantId,
    ownerKind: "client",
    ownerId: input.clientId,
    bindTargetId: input.propertyId ?? null,
    module: SEARCH_MODULE,
    provider: input.provider,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    authorizeUrl: input.authorizeUrl,
    createdBy: input.createdBy,
  });
}

export async function consumeAuthorizationState(
  stateToken: string,
  // REQUIRED, exactly as core requires it. Not made optional here: the expectations carry the
  // anti-login-CSRF caller binding (attack A1), so an accidental call without them must not compile.
  expectations: ConsumeExpectations,
): Promise<ConsumedAuthorizationState> {
  // SEARCH_MODULE is declared here, not left to the caller: without it the UPDATE matches zero rows and
  // every search callback would report `unknown_or_expired` — the wall doing its job against its owner.
  const row = await coreConsumeAuthorizationState(stateToken, { ...expectations, module: SEARCH_MODULE });
  // Prove, do not assume. The shared table can now hold core-surface rows (e.g. google_drive), and this
  // adapter's whole contract is that what it returns is a SEARCH row. A mismatch here would mean a
  // signed state minted for another surface was presented to a search callback — the same class of
  // confusion the provider expectation guards against, so it fails the same coarse way.
  if (!isSearchGoogleProvider(row.provider)) {
    throw new GoogleOAuthStateError("provider_mismatch");
  }
  const { ownerId, bindTargetId, ownerKind: _ownerKind, module: _module, ...rest } = row;
  // `ownerKind`/`module` are dropped rather than surfaced: search has exactly one of each, so exposing
  // them would invite a call site to branch on a value that is constant here.
  void _ownerKind;
  void _module;
  return { ...rest, provider: row.provider, clientId: ownerId, propertyId: bindTargetId };
}

/** Search's wrappers, declaring the module scope its own rows require. */
export async function attachConnectionToState(
  tenantId: string,
  stateId: string,
  connectionId: string,
): Promise<void> {
  return coreAttachConnectionToState(tenantId, stateId, connectionId, SEARCH_MODULE);
}

export async function pruneExpiredAuthorizationStates(tenantId: string): Promise<number> {
  return corePruneExpiredAuthorizationStates(tenantId, SEARCH_MODULE);
}

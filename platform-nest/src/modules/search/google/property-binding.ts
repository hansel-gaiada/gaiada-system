// WD-23A-1 — search's registrations against the shared Google surface registry, plus the property
// binding that is the reason search needs a post-link hook at all.
//
// This file is where `search_properties`, `PROPERTY_BINDING_COLUMN` and the search Cerbos resource stay
// AFTER the OAuth machinery moved to core. Core must not know that a `bind_target_id` is sometimes a
// search property id — that meaning is delegated back here through `onLinked`.
import { registerGoogleSurface } from "../../../core/google-oauth/registry";
import { bindPropertyConnection, DEFAULT_SCOPES } from "./oauth";
import type { SearchGoogleProvider } from "./oauth-state";

/** The Cerbos check the search callback has always run AFTER the state signature verifies — kept as a
 *  declared field so the shared callback still performs it. Documented in
 *  search-google-oauth.controller.ts's header as defence-in-depth: it refuses a principal whose role was
 *  revoked *after* they started the flow. Dropping it during the move would have been a silent
 *  regression, which is why the registry carries it rather than the flow hard-coding one module's kind. */
const SEARCH_AUTHZ = { kind: "resource_search_property", action: "update" } as const;

const SEARCH_PROVIDERS: SearchGoogleProvider[] = [
  "google_search_console",
  "google_analytics",
  "google_ads",
];

/** Register all three search surfaces. Idempotent (the registry keys by provider), so importing this
 *  module twice — which tests do — is harmless. */
export function registerSearchGoogleSurfaces(): void {
  for (const provider of SEARCH_PROVIDERS) {
    registerGoogleSurface({
      provider,
      // STAMPED, not assumed: this is what preserves migration 0060's `app_module_allowed('search')`
      // wall now that the table is shared. The policy gates on the row's own `module`.
      module: "search",
      scopes: DEFAULT_SCOPES[provider],
      authz: SEARCH_AUTHZ,
      // A search connection belongs to the agency's CLIENT whose Google account it is.
      ownerKind: "client",
      onLinked: async ({ tenantId, bindTargetId, provider: p, connectionId }) => {
        // No bind target means the connection was established without a property to attach it to,
        // which is legitimate — the Connections tab can bind it later.
        if (!bindTargetId) return;
        // Failure here is deliberately swallowed by the CALLER's existing try/catch semantics: the
        // credential is already linked and sealed, and the binding is re-issuable from the Connections
        // tab. Throwing would lose a good credential over a re-doable step.
        await bindPropertyConnection(tenantId, bindTargetId, p as SearchGoogleProvider, connectionId);
      },
    });
  }
}

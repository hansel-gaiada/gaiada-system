// WD-23A-1 — the Google SURFACE registry.
//
// One hardened OAuth state machine now serves several surfaces (search's GSC/GA4/Ads, webdev's Drive),
// and the things that genuinely differ between them are declared here rather than branched on inside
// the flow. That is what lets `core/` own the flow without importing anything from `modules/`.
//
// WHY `authz` IS A FIELD AND NOT A HARD-CODED CHECK — the subtle part the re-spec under-specified:
// the search callback runs a surface-specific Cerbos check AFTER the state signature verifies
// (`resource_search_property` + `update`), documented there as defence-in-depth: it refuses a principal
// whose role was revoked *after* they started the flow. A shared callback cannot hard-code one
// module's resource kind, and simply dropping the check would silently delete that protection during a
// refactor — the worst kind of regression, because nothing fails. So each surface declares it.
//
// WHY `module` IS A FIELD: migration 0060's RLS policy hard-coded `app_module_allowed('search')` — the
// module wall lives in the TABLE, not in `authorize()` (which is Cerbos-only and knows nothing about
// module-enablement). A shared table cannot hard-code one module's name, and dropping the gate would
// remove that wall from search's flow. Instead the surface's `module` is STAMPED on the row and the
// policy gates per-row: named module => must be enabled for the tenant; NULL => a core surface with no
// module gate. Search keeps byte-equivalent protection; Drive needs none.
import type { PoolClient } from "pg";

/** Every provider the shared state machine can hold a request for. */
export const GOOGLE_PROVIDERS = [
  "google_search_console",
  "google_analytics",
  "google_ads",
  "google_drive",
] as const;
export type GoogleProvider = (typeof GOOGLE_PROVIDERS)[number];

export function isGoogleProvider(v: string): v is GoogleProvider {
  return (GOOGLE_PROVIDERS as readonly string[]).includes(v);
}

/** Who the resulting credential belongs to. Mirrors `integration_connections.owner_kind` exactly, so
 *  the state row and the vault row it produces describe ownership identically. */
export type GoogleOwnerKind = "user" | "company" | "client";

export interface GoogleSurface {
  provider: GoogleProvider;
  /** Stamped onto the state row -> the per-row RLS module gate. NULL for a core surface. */
  module: string | null;
  /** Default scopes requested for this surface. */
  scopes: string[];
  /** Post-signature defence-in-depth authorization check (see the header). */
  authz: { kind: string; action: string };
  ownerKind: GoogleOwnerKind;
  /** Optional post-link hook, e.g. search binding the connection to a `search_properties` row. This is
   *  how module-specific meaning for `bind_target_id` stays inside the module that owns it. */
  onLinked?: (args: {
    tenantId: string;
    bindTargetId: string | null;
    provider: GoogleProvider;
    connectionId: string;
    client: PoolClient;
  }) => Promise<void>;
}

const SURFACES = new Map<GoogleProvider, GoogleSurface>();

/** Register a surface. Idempotent by provider so a module imported twice (tests do this) does not
 *  throw; last registration wins, which also lets a test override a hook deliberately. */
export function registerGoogleSurface(surface: GoogleSurface): void {
  SURFACES.set(surface.provider, surface);
}

/** The surface for a provider, or null when nothing has registered it.
 *
 *  Returns null rather than throwing so the CALLER decides the refusal: the callback turns it into a
 *  typed state failure (an unknown provider is indistinguishable from a forged one, and must not leak
 *  which of the two it was), while boot-time code can treat it as a wiring error. */
export function googleSurfaceFor(provider: string): GoogleSurface | null {
  return isGoogleProvider(provider) ? SURFACES.get(provider) ?? null : null;
}

/** Registered providers — for diagnostics and tests, never for authorization decisions. */
export function registeredGoogleProviders(): GoogleProvider[] {
  return [...SURFACES.keys()];
}

/** Test-only: drop every registration so a suite can assert the unregistered-provider path. */
export function resetGoogleSurfaces(): void {
  SURFACES.clear();
}

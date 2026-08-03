import "server-only";
// Per-company module enablement, for surfaces that must say "this module is off" instead of
// rendering an empty page.
//
// WHY THIS EXISTS: `companies.enabled_modules` gates real endpoints — platform-nest's
// ModuleEnabledGuard 404s every route of a disabled module. Nothing in this UI read that flag
// outside the settings page, so disabling a module produced pages that still looked live and
// simply had no data: indistinguishable from "a company with no clients yet". The fix is to make
// unavailability LEGIBLE, not invisible — see ModuleDisabled.
//
// FAIL-OPEN by design. `moduleGate()` returns a gate that only ever reports "off" when the backend
// positively said so. If the endpoint is missing (older build), errors, or the caller has no
// company context, every module reads as enabled — a false "module disabled" panel would hide a
// working page, which is strictly worse than the empty-page problem this replaces.
import { platformFetch, PlatformError } from "./platform";

export interface ModuleGate {
  /** True unless the backend positively reported this key as disabled for the company. */
  isEnabled: (moduleKey: string) => boolean;
  /** The effective set, or null when enablement could not be determined (→ everything passes). */
  enabled: string[] | null;
}

const OPEN_GATE: ModuleGate = { isEnabled: () => true, enabled: null };

/**
 * Effective module set for `tenantId`: the company's own `enabled_modules` UNION anything served
 * to it by an active service assignment. The backend computes it with the same helper its guard
 * uses (`enabledModuleKeys`), so this can never disagree with what the API will allow.
 */
export async function moduleGate(userId: string, tenantId: string | null): Promise<ModuleGate> {
  if (!tenantId) return OPEN_GATE;
  try {
    const res = await platformFetch<{ enabled: string[] }>(`/api/${tenantId}/modules-enabled`, userId);
    // Shape-check, don't coerce: a missing/odd `enabled` must read as UNKNOWN (fail open), never as
    // "no modules". Coercing to [] here would dark every gated section against any responder that
    // returns a different shape — e.g. a generic empty-list default.
    if (!Array.isArray(res?.enabled)) return OPEN_GATE;
    const enabled = res.enabled;
    return { enabled, isEnabled: (key) => enabled.includes(key) };
  } catch (e) {
    // 404/405: backend predates the endpoint. 403: no membership — the page's own reads will fail
    // with a real authorization state, which is more accurate than a module message. Anything
    // else: don't let a metadata read take a page down.
    if (e instanceof PlatformError) return OPEN_GATE;
    throw e;
  }
}

/**
 * Section-layout convenience: is `moduleKey` on for the ACTIVE company? Resolves session + active
 * tenant itself so a layout needs one line and no extra plumbing. Fail-open on a missing session
 * (the layout's own `redirect("/login")` is the right handler for that, not a module panel).
 */
export async function isModuleOnForActiveCompany(moduleKey: string): Promise<boolean> {
  const { getSessionUserId } = await import("./session-server");
  const userId = await getSessionUserId();
  if (!userId) return true;
  const { getMe } = await import("./platform");
  const { getActiveTenant } = await import("./tenant");
  const me = await getMe(userId).catch(() => null);
  if (!me) return true;
  const gate = await moduleGate(userId, await getActiveTenant(me));
  return gate.isEnabled(moduleKey);
}

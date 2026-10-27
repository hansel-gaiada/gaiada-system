// M5-W1f — which shell a signed-in person belongs in, and how the contributor fence's refusal is recognised.
//
// PURE and client-safe (no `server-only`, no `platform.ts` import): the layouts, the tests and the components all read it.
//
// THE THREE SHELLS. `(app)` is the staff workspace, `(portal)` is the client portal, `(contributor)` is the freelance writer's own screens.
// A contributor (`me.kind === "contributor"`, set by the server) goes to `/contributor` from BOTH of the others: they hold writers' room role
// rows, so without the kind they would read as staff. Staff and client routing is exactly what it was: `shellFor` returns "portal" only for
// `isClientOnly`, "staff" for everyone else.
//
// THE FENCE REFUSES `/api/me` TOO. The backend lets a contributor through only at a real `assurance: "high"` (W1d), and `/api/me` is
// inside that rule. Until W1g's Keycloak setup lands no real login reaches high, so for a contributor `getMe` itself answers 403
// `contributor_route_forbidden`, and the layouts never learn `kind`. Only a contributor is ever refused this way (the fence leaves every
// other kind untouched), so that exact answer is itself the proof of who is asking: `contributorFenceReason` recognises it and the layouts
// route the person to `/contributor`, where the shell says "Your two-step sign-in isn't set up yet" instead of a blank or broken screen.
import { isClientOnly, isContributor } from "./rbac";
import type { Me } from "./platform";

export const CONTRIBUTOR_HOME = "/contributor";
/** The public page a contributor's invite link opens (the backend's `acceptPath` is `/contributor-invite/<token>`). NOT `/invite`, the client's. */
export const CONTRIBUTOR_INVITE_BASE = "/contributor-invite";

export type Shell = "contributor" | "portal" | "staff";

export function shellFor(me: Me): Shell {
  if (isContributor(me)) return "contributor";
  if (isClientOnly(me)) return "portal";
  return "staff";
}

export type FenceReason = "assurance_high_required" | "route_not_open_to_contributors";

const FENCE_ERROR = "contributor_route_forbidden";
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The fence's refusal, from a thrown `PlatformError` (duck-typed: `status`, `message`, `reason`, `body`), or null for anything else.
 * A 403 whose error is `contributor_route_forbidden` and whose `reason` is one of the two documented ones. An unknown `reason` is still the
 * fence (so it is never mistaken for "no access"), reported as `route_not_open_to_contributors`.
 */
export function contributorFenceReason(e: unknown): FenceReason | null {
  if (!isRec(e) || e.status !== 403) return null;
  const body = isRec(e.body) ? e.body : null;
  const error = body && typeof body.error === "string" ? body.error : typeof e.message === "string" ? e.message : "";
  if (error !== FENCE_ERROR) return null;
  const reason = typeof e.reason === "string" ? e.reason : body && typeof body.reason === "string" ? body.reason : "";
  return reason === "assurance_high_required" ? "assurance_high_required" : "route_not_open_to_contributors";
}

/** The same refusal read from a `WdResult` (`forbidden` carries the fence's reason in `slug`, see `resultFromError`). */
export function fenceReasonOfResult(r: { kind: string; slug?: string; reason?: string }): FenceReason | null {
  if (r.kind !== "forbidden") return null;
  if (r.slug === "assurance_high_required") return "assurance_high_required";
  if (r.reason === FENCE_ERROR) return r.slug === "assurance_high_required" ? "assurance_high_required" : "route_not_open_to_contributors";
  return null;
}

export const ASSURANCE_NOTICE_TITLE = "Your two-step sign-in isn't set up yet";
export const ASSURANCE_NOTICE_BODY =
  "You can sign in, but the writers' room only opens once your two-step sign-in (an authenticator app code) is set up and used for this sign-in. " +
  "Nothing is wrong with your assignments: they are simply not shown until then. Use the link in your invitation to finish the setup, then sign out and sign in again. " +
  "If you have already done that, ask the person who invited you.";

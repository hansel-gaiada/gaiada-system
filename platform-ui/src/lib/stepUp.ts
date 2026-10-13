// PV5-14 / owner ruling PV-D40 — the SIMULATED second factor, UI side (dev stage only). Pure and client-safe: the
// wire shapes of `GET /api/auth/step-up` and `POST /api/auth/step-up/simulate` (BFF §1), the one refusal code that
// names assurance, and the words. The fetches live in `stepUpActions.ts`.
//
// Wording rule (PV-D40): this is never called MFA or a real second factor. It is a SIMULATED second factor, for the
// dev stage, and every surface says so.

/** `GET /api/auth/step-up`. The route 404s while the server flag is off; the action turns that into `null`. */
export interface StepUpStatus {
  /** The caller may simulate now: flag on, an interactive staff sign-in bound to an IdP session, a store. */
  available: boolean;
  /** Why not, when `available` is false (a machine code, e.g. `step_up_staff_only`, `session_unbound`). */
  reason?: string;
  /** The session is at high assurance now (a real or a simulated second factor). */
  active: boolean;
  /** The high assurance above is the simulated one. */
  simulated: boolean;
  /** When the simulated second factor ends (ISO), else null. */
  expiresAt: string | null;
  assurance: "low" | "linked" | "high";
  ttlSeconds: number;
}

/** `POST /api/auth/step-up/simulate` -> 200. */
export interface StepUpSimulated {
  active: boolean;
  simulated: true;
  expiresAt: string;
  assurance: "low" | "linked" | "high";
  assuranceSource: "simulated";
}

/** The 403 `reason` the platform sends when ONLY the assurance tier stands in the way (and the flag is on). */
export const ASSURANCE_REQUIRED = "assurance_required";

export function isAssuranceRefusal(reason: string | null | undefined): boolean {
  return reason === ASSURANCE_REQUIRED;
}

export const STEP_UP_TEXT = {
  needs: "This action needs a second factor",
  button: "Simulate second factor (dev stage)",
  explain:
    "Dev stage only: no authenticator is checked. It holds for 15 minutes, on this sign-in only, and is recorded in the activity log.",
  unavailable: "Sign in with a second factor to continue.",
} as const;

/** "HH:MM" in the viewer's own clock. Empty for an unparseable value. */
export function hhmm(iso: string, locale?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString(locale ?? [], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** The header badge's words, or null when there is nothing to show (no expiry, unparseable, or already over). */
export function simulatedBadgeText(expiresAt: string | null | undefined, now: number = Date.now(), locale?: string): string | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t) || t <= now) return null;
  return `Second factor simulated until ${hhmm(expiresAt, locale)}`;
}

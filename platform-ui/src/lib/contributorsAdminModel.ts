// M5-W1f: the staff side of freelance contributors (BFF contract section 27, "Freelance contributors"): types, the valid-until rule and the
// words for every refusal. PURE and client-safe; the reads and writes are in `contributorsAdminActions.ts`.
import { isOutcomeUnknown, type WdResult } from "./webdeskContentModel";

export type ContributorStatus = "invited" | "active" | "ended";

export interface ContributorRow {
  contributorId: string;
  userId: string;
  name: string | null;
  email: string | null;
  status: ContributorStatus;
  /** Active and unexpired: what the principal honours. */
  live: boolean;
  validUntil: string;
  sponsorUserId: string | null;
  invitedAt: string;
  activatedAt: string | null;
  endedAt: string | null;
  hasAccount: boolean;
}

/** What an invite returns. `acceptUrl` is built by the action from `acceptPath` and is shown ONCE: the backend keeps only a hash of the token. */
export interface ContributorInvited {
  contributor: ContributorRow;
  acceptUrl: string;
  expiresAt: string;
  account: string;
}

export interface ContributorEnded {
  userId: string;
  changed: boolean;
  idpDisabled: boolean;
  keptLoginForOtherEngagements: boolean;
  revokedGrantCount: number;
}

export const MAX_ENGAGEMENT_DAYS = 180;
const DAY_MS = 86_400_000;

export type ValidUntil = { ok: true; iso: string } | { ok: false; message: string };

/** The valid-until day from the form (YYYY-MM-DD, a UTC day) as the instant the engagement ends: the END of that UTC day. It must be in the
 *  future and at most 180 days ahead (the server checks the same, as 400 `invalid_request`). */
export function validUntilFromDay(day: string, now: number = Date.now()): ValidUntil {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, message: "Choose the date the engagement ends." };
  const iso = `${day}T23:59:59.000Z`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { ok: false, message: "That date is not valid." };
  if (t <= now) return { ok: false, message: "The end date has to be in the future." };
  if (t > now + MAX_ENGAGEMENT_DAYS * DAY_MS) return { ok: false, message: `An engagement can last at most ${MAX_ENGAGEMENT_DAYS} days. Choose an earlier date; you can invite again later.` };
  return { ok: true, iso };
}

/** The latest day the form offers (UTC, YYYY-MM-DD): a whole day inside the limit. */
export function maxValidUntilDay(now: number = Date.now()): string {
  return new Date(now + (MAX_ENGAGEMENT_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validEmail = (s: string): boolean => EMAIL_RE.test(s.trim()) && s.trim().length <= 254;

const REFUSAL_WORDS: Record<string, string> = {
  contributor_conversion_refused: "That address already belongs to a staff member, a client contact, a grant holder, an automation or an inactive account, so it can't become a freelance contributor. Use a different address.",
  contributor_already_active: "That person is already an active contributor here. End their engagement first if you need to change it.",
  self_invite_forbidden: "You can't invite yourself.",
  keycloak_admin_not_configured: "Sign-in accounts can't be created yet because the identity service isn't set up for this deployment. Nothing was changed.",
  contributor_not_found: "That person has no engagement in this company.",
};

/** One sentence for a refused or failed invite / end / list. */
export function contributorRefusalCopy(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string {
  if (isOutcomeUnknown(r)) return "We couldn't confirm whether that went through. Reload the list to see what happened before you try again.";
  const token = r.kind === "conflict" ? r.slug : r.kind === "invalid" ? (r.slug ?? null) : r.kind === "not_found" ? r.slug : r.kind === "unavailable" ? r.reason : null;
  if (token && REFUSAL_WORDS[token]) return REFUSAL_WORDS[token];
  switch (r.kind) {
    case "forbidden": return "You can't manage freelance contributors here. Only a publisher (a company admin, an owner or a Web Dev manager) can.";
    case "not_found": return "That person has no engagement in this company.";
    case "not_enabled": return r.reason === "module_disabled" ? "The Web Dev module is switched off for this company." : "Freelance contributors aren't available on this deployment yet.";
    case "invalid": return r.message || "That request wasn't accepted.";
    case "conflict": return r.message;
    case "unavailable":
      if (r.code === "contract_drift") return `The server answered with something unexpected (${r.reason}). Nothing was assumed to have changed.`;
      return "The website service can't be reached right now. Nothing was changed.";
  }
}

export const statusWords = (c: ContributorRow): string =>
  c.status === "ended" ? "Ended" : c.status === "invited" ? "Invited, not yet accepted" : c.live ? "Active" : "Expired";

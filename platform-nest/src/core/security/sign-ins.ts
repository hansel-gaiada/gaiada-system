// DW-7h (FRONTEND-BFF-CONTRACT §52.6) — turns Keycloak's events into this company's sign-in read. Pure: the route does the
// I/O (the events, then the users and memberships they name) and hands the lookups in.
//
// WHO AN EVENT IS ABOUT. Keycloak knows an account by its own user id (`userId`) and by the name typed (`details.username`,
// which in this realm is the email, `loginWithEmailAllowed`). The ERP knows a person by `users.idp_subject` (the Keycloak
// id, set at the first login) or `identity_links` (set when IT provisions the account), else by email: the same order
// `auth/oidc.ts` provisionUser() uses to find a person. An event whose id or name matches an ERP user is about that user;
// it is listed only if that user is a member of THIS company. A failed sign-in that matches nobody is an UNKNOWN account:
// it is counted (and feeds the address alert) but its typed name is never returned, because a mistyped password lands in
// that field often enough that echoing it would put credentials on a screen.
import type { KeycloakEvent } from "../keycloak-admin";
import type { FailedSignIn } from "./security-alerts";

export type SignInType = "sign_in" | "failed" | "sign_out";

export interface SignInEvent {
  at: string;
  type: SignInType;
  userId: string | null;
  email: string | null;
  ip: string | null;
  error: string | null;
}

export interface SignInSummary {
  signIns: number;
  failed: number;
  /** Members only. */
  failedByAccount: Array<{ userId: string; email: string | null; count: number }>;
  /** Members and unknown accounts together: an address trying many names is the thing to see. */
  failedByIp: Array<{ ip: string; count: number }>;
}

export interface SignInLookups {
  /** Keycloak user id -> ERP user. Built from `users.idp_subject` and `identity_links`. */
  byKeycloakId: Map<string, { id: string; email: string }>;
  /** Lower-cased email -> ERP user. */
  byEmail: Map<string, { id: string; email: string }>;
  /** ERP user ids that are members of this company. */
  memberIds: Set<string>;
}

export interface MappedSignIns {
  /** Newest first, members of this company only, at most `limit`. */
  events: SignInEvent[];
  summary: SignInSummary;
  unknownAccounts: { failed: number };
  /** Every failed sign-in that is about a member or an unknown account, for the alert rules. */
  failed: FailedSignIn[];
}

export const SIGN_IN_LIST_LIMIT = 500;
const TOP = 10;

const TYPE: Record<string, SignInType> = { LOGIN: "sign_in", LOGIN_ERROR: "failed", LOGOUT: "sign_out" };

export function mapSignInEvents(
  events: KeycloakEvent[],
  lookups: SignInLookups,
  opts: { sinceMs: number; limit?: number },
): MappedSignIns {
  const out: SignInEvent[] = [];
  const failed: FailedSignIn[] = [];
  const byAccount = new Map<string, { email: string | null; count: number }>();
  const byIp = new Map<string, number>();
  let signIns = 0;
  let failedMembers = 0;
  let unknownFailed = 0;

  for (const e of [...events].sort((a, b) => b.time - a.time)) {
    if (e.time < opts.sinceMs) continue;
    const type = TYPE[e.type];
    if (!type) continue;
    const user =
      (e.userId ? lookups.byKeycloakId.get(e.userId) : undefined) ??
      (e.username ? lookups.byEmail.get(e.username.toLowerCase()) : undefined);

    if (user) {
      if (!lookups.memberIds.has(user.id)) continue; // somebody else's staff
      out.push({
        at: new Date(e.time).toISOString(), type, userId: user.id, email: user.email, ip: e.ipAddress,
        error: type === "failed" ? e.error : null,
      });
      if (type === "sign_in") signIns++;
      if (type === "failed") {
        failedMembers++;
        const cur = byAccount.get(user.id);
        if (cur) cur.count++;
        else byAccount.set(user.id, { email: user.email, count: 1 });
        failed.push({ atMs: e.time, ip: e.ipAddress, userId: user.id, email: user.email });
        if (e.ipAddress) byIp.set(e.ipAddress, (byIp.get(e.ipAddress) ?? 0) + 1);
      }
    } else if (type === "failed") {
      unknownFailed++;
      failed.push({ atMs: e.time, ip: e.ipAddress, userId: null, email: null });
      if (e.ipAddress) byIp.set(e.ipAddress, (byIp.get(e.ipAddress) ?? 0) + 1);
    }
  }

  const ranked = <T extends { count: number }>(rows: T[]) => rows.sort((a, b) => b.count - a.count).slice(0, TOP);
  return {
    events: out.slice(0, opts.limit ?? SIGN_IN_LIST_LIMIT),
    summary: {
      signIns,
      failed: failedMembers,
      failedByAccount: ranked([...byAccount].map(([userId, v]) => ({ userId, email: v.email, count: v.count }))),
      failedByIp: ranked([...byIp].map(([ip, count]) => ({ ip, count }))),
    },
    unknownAccounts: { failed: unknownFailed },
    failed,
  };
}

/** Event types the sign-in read needs. A realm that records some events but not these would read as "no failures". */
export const REQUIRED_EVENT_TYPES = ["LOGIN", "LOGIN_ERROR", "LOGOUT"] as const;

/** The needed types an explicit `enabledEventTypes` list leaves out. An empty list means Keycloak's own default set, which is
 *  not the same as "none": it is not judged here. */
export function missingEventTypes(enabled: string[]): string[] {
  if (enabled.length === 0) return [];
  return REQUIRED_EVENT_TYPES.filter((t) => !enabled.includes(t));
}

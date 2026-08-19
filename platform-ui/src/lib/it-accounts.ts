import "server-only";
// P2-14 — the IT accounts data layer: who still needs a login, whose leaver login is still enabled.
//
// BFF CONTRACT (BUILT — P2-13, `platform-nest/src/admin/it-accounts.controller.ts`; the contract rows
// are in docs/FRONTEND-BFF-CONTRACT.md's IT-accounts section):
//   GET  /api/:t/it/accounts                              -> { accounts: AccountRow[] }
//   POST /api/:t/it/accounts/:userId/provision            -> { keycloakId, initialPassword, adopted }
//   POST /api/:t/it/accounts/:userId/disable              -> { ok, alreadyDisabled }
//   POST /api/:t/it/accounts/:userId/enable               -> { ok, alreadyEnabled }
//   POST /api/:t/it/accounts/:userId/reset-password       -> { ok, initialPassword }
//
// ⚠ THIS READER DOES **NOT** DEGRADE TO AN EMPTY LIST, and that is the one way it differs from every
// other reader in this codebase (lib/it.ts, lib/admin.ts and friends all return `[]` on 403/404 so a
// page can ship ahead of its backend).
//
// An empty accounts list asserts "everyone has a login". The backend refuses with a typed 503 rather
// than saying that while it cannot see Keycloak, and swallowing that into `[]` here would undo the
// refusal at the last hop — the console would render a reassuring empty worklist over an unknown
// estate. So `listAccounts` returns a DISCRIMINATED result and the page must handle `unavailable`
// explicitly; there is no shape it can accidentally treat as "all clear".
import { platformFetch, PlatformError } from "./platform";

/** Server-computed. Do NOT re-derive `actionable` in the UI: two implementations of "needs attention"
 *  drift, and the direction they drift in is a leaver the console quietly stops flagging. */
export type AccountState = "missing" | "enabled" | "disabled" | "leaver_still_enabled" | "unverified_link";

export interface AccountRow {
  userId: string;
  email: string;
  name: string;
  employmentStatus: string | null;
  keycloakId: string | null;
  enabled: boolean | null;
  emailVerified: boolean | null;
  linked: boolean;
  linkVerified: boolean;
  state: AccountState;
  actionable: boolean;
}

export type AccountsResult =
  | { kind: "ok"; accounts: AccountRow[] }
  /** The backend cannot see Keycloak (503) — NOT the same as "no findings". */
  | { kind: "unavailable"; reason: string }
  /** 403: the viewer may not read this worklist. */
  | { kind: "forbidden" };

export async function listAccounts(userId: string, tenantId: string): Promise<AccountsResult> {
  try {
    const res = await platformFetch<{ accounts: AccountRow[] }>(`/api/${tenantId}/it/accounts`, userId);
    return { kind: "ok", accounts: res.accounts ?? [] };
  } catch (err) {
    if (err instanceof PlatformError) {
      if (err.status === 403) return { kind: "forbidden" };
      // 503 = unconfigured admin client, 502 = upstream Keycloak failure. Both mean "cannot see", and
      // the distinction between our wiring and their outage is already in the message the backend sent.
      if (err.status === 503 || err.status === 502) {
        return { kind: "unavailable", reason: err.message };
      }
    }
    // Anything else is also a can't-see, deliberately: there is no error class here whose right
    // rendering is an empty worklist.
    return { kind: "unavailable", reason: (err as Error)?.message ?? "unknown error" };
  }
}

/** Human-readable labels + the one-line reason each state needs acting on. */
export const STATE_LABEL: Record<AccountState, string> = {
  missing: "No login",
  leaver_still_enabled: "Leaver still enabled",
  unverified_link: "Link unverified",
  disabled: "Disabled",
  enabled: "Active",
};

export const STATE_HINT: Record<AccountState, string> = {
  missing: "Staff member with no account in the identity provider. Provision one.",
  leaver_still_enabled: "This person's employment has ended and their login still works. Disable it.",
  unverified_link: "The account exists but this person has never signed in to prove control of it.",
  disabled: "The login is disabled.",
  enabled: "Account exists, enabled, and the link is verified.",
};

/** Severity ordering for the table. `leaver_still_enabled` first because it is the only state that is a
 *  security finding rather than an onboarding chore. */
const STATE_RANK: Record<AccountState, number> = {
  leaver_still_enabled: 0,
  missing: 1,
  unverified_link: 2,
  disabled: 3,
  enabled: 4,
};

export function sortByUrgency(rows: AccountRow[]): AccountRow[] {
  return [...rows].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name),
  );
}

export interface AccountsSummary {
  total: number;
  actionable: number;
  missing: number;
  leaversStillEnabled: number;
  unverified: number;
}

export function summarize(rows: AccountRow[]): AccountsSummary {
  return {
    total: rows.length,
    actionable: rows.filter((r) => r.actionable).length,
    missing: rows.filter((r) => r.state === "missing").length,
    leaversStillEnabled: rows.filter((r) => r.state === "leaver_still_enabled").length,
    unverified: rows.filter((r) => r.state === "unverified_link").length,
  };
}

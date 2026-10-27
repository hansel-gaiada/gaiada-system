// SCP-Sb (BFF §63.1 file 8, §63.16; plan §5): the client page's simulated-account line, as PURE functions (no server-only import, so a client component and a test can use
// them). The server's routes are `POST|DELETE engagements/:engagementId/simulated-accounts` (social_engagement · plan: the four approvers); the readers and the action
// are `socialSimulatedAccounts-data.ts` and `socialSimulatedAccountsActions.ts`.
import { asSocialAccount, type SocialAccount } from "./socialShared";

/** The three networks the simulator seeds, in the server's order. */
export const SIMULATED_NETWORKS = ["instagram", "facebook", "tiktok"] as const;

/** The seeded networks this client has no live account on yet (an account of ANY kind counts: the server refuses to seed beside a real one). */
export function networksMissingAccount(accounts: readonly Pick<SocialAccount, "network">[]): string[] {
  return SIMULATED_NETWORKS.filter((n) => !accounts.some((a) => a.network === n));
}

/** One account of the answer to the seed: `created` is true only when this call put the account into the pipeline. */
export interface SeededAccountView { id: string; network: string; handle: string; created: boolean; networkEnabled: boolean }

/** Reads the seed's answer `{accounts: [...]}`; a row of the wrong shape is dropped, never invented. */
export function asSeedAnswer(raw: unknown): SeededAccountView[] {
  const list = raw !== null && typeof raw === "object" ? (raw as { accounts?: unknown }).accounts : null;
  if (!Array.isArray(list)) return [];
  const out: SeededAccountView[] = [];
  for (const r of list) {
    if (r === null || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.network !== "string" || typeof o.handle !== "string") continue;
    out.push({ id: o.id, network: o.network, handle: o.handle, created: o.created === true, networkEnabled: o.networkEnabled !== false });
  }
  return out;
}

/** The accounts of `GET accounts?clientId=`, normalised. */
export const asClientAccounts = (raw: unknown): SocialAccount[] => {
  const list = raw !== null && typeof raw === "object" ? (raw as { accounts?: unknown }).accounts : null;
  return Array.isArray(list) ? list.map(asSocialAccount) : [];
};

/** The words for each refusal of the seed, by the contract's own code. */
export function seedRefusalText(code: string): string {
  switch (code) {
    case "not_a_social_approver": return "Only the Social Media head, the GM, the owner or the platform administrator can seed simulated accounts.";
    case "simulation_disabled": return "The social simulator is switched off on this server, so no simulated account can be seeded.";
    case "account_exists_not_simulated": return "This client already has a real account on one of these networks. A simulated account never sits beside a real one.";
    case "publisher_org_not_active": return "This client's publisher organisation is suspended or deleted, so nothing can be seeded under it.";
    case "engagement_not_found": return "This client was not found. The link may be out of date.";
    case "invalid_field": case "unknown_field": return "The request was not understood.";
    case "session_expired": return "Session expired. Sign in again.";
    default: return "The simulated accounts could not be seeded just now.";
  }
}

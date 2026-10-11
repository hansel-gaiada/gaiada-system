import type { PortalProfile } from "@/lib/portal";

// PV2-07 - pure, client-safe grouping for the portal's Projects and People pages. Kept out of the pages so
// the rules are unit-tested: `finished` is the server's word (never re-derived from `status`), and an older
// backend that omits `side` or `finished` degrades to the safe reading (client / active).

/** Active vs Past, split on the server-sent `finished` flag. Undefined counts as active. */
export function splitProjects<T extends { finished?: boolean }>(projects: T[]): { active: T[]; past: T[] } {
  const active: T[] = [];
  const past: T[] = [];
  for (const p of projects) (p.finished === true ? past : active).push(p);
  return { active, past };
}

export type PortalContact = PortalProfile["contacts"][number];
export type AccountManagerLine = { clientId: string; clientName: string; name: string; email: string };

export interface PeopleGroups {
  yourPeople: PortalContact[];
  accountManagers: AccountManagerLine[];
  onOurSide: PortalContact[];
}

/** Three People groups. A missing `side` is the client's own person; a client without a manager yields no line. */
export function groupPeople(profile: Pick<PortalProfile, "clients" | "contacts">): PeopleGroups {
  return {
    yourPeople: profile.contacts.filter((c) => c.side !== "provider"),
    onOurSide: profile.contacts.filter((c) => c.side === "provider"),
    accountManagers: profile.clients.flatMap((c) =>
      c.accountManager ? [{ clientId: c.id, clientName: c.name, name: c.accountManager.name, email: c.accountManager.email }] : [],
    ),
  };
}

/** Plain-words access for a contact: what they may do, and how far it reaches. */
export function describeAccess(c: Pick<PortalContact, "capability" | "projectId">): { capability: string; scope: string } {
  return {
    // `admin` implies signer (WSK-D60 amendment, owner ruling 2026-10-11): an admin can always sign.
    capability: c.capability === "admin" ? "Admin, can sign" : c.capability === "signer" ? "Can sign" : "View only",
    scope: c.projectId ? "One project" : "Whole account",
  };
}

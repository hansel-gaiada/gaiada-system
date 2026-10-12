// W0-5 — the CLIENT-SAFE half of the client-contact module: types, labels and pure helpers.
//
// SPLIT FROM clientContacts.ts BY NECESSITY. That module imports `platformFetch`, and
// `lib/platform.ts` begins with `import "server-only"`. A client component may `import type` from such
// a module (types are erased), but ANY value import — a label map, a helper — pulls it into the client
// bundle and fails the build with "You're importing a component that needs server-only". `tsc` and
// vitest both pass in that state; only `next build`'s webpack pass catches it, so the split is
// load-bearing and should not be collapsed back.
// `admin` (WSK-49f, WSK-D60 amended 2026-10-11) sits beside signer/viewer in the one column, is assigned
// only by Gaiada staff, and IMPLIES signer: everywhere a signer is tested an admin passes too.
export type ContactCapability = "admin" | "signer" | "viewer";
export type ContactStatus = "invited" | "active" | "revoked";

export interface ClientContact {
  id: string;
  clientId: string;
  userId: string;
  /** null = the contact covers the whole client (every project), per D-1. */
  projectId: string | null;
  capability: ContactCapability;
  status: ContactStatus;
  email: string;
  name: string | null;
  invitedAt: string;
  activatedAt: string | null;
  /** A boolean, never a credential — the same discipline the connections vault applies with `hasToken`. */
  hasAccount: boolean;
  /** PV3-07: the portal People area lists this contact to the client's contacts (false once revoked). */
  clientVisible?: boolean;
}

export const CAPABILITY_LABEL: Record<ContactCapability, string> = {
  admin: "Admin: can sign off and give website access",
  signer: "Can sign off",
  viewer: "Can view only",
};

export const STATUS_LABEL: Record<ContactStatus, string> = {
  invited: "Invited",
  active: "Active",
  revoked: "Revoked",
};

/** What a contact can actually be asked to do. Mirrors the API's own rule rather than re-deriving it:
 *  only an ACTIVE signer (an admin implies signer) may countersign, because a signature from an account that was never activated
 *  (or has been revoked) is not a signature. */
export function canCountersign(c: ClientContact): boolean {
  return c.status === "active" && (c.capability === "signer" || c.capability === "admin");
}

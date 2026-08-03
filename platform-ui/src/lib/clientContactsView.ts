// W0-5 — the CLIENT-SAFE half of the client-contact module: types, labels and pure helpers.
//
// SPLIT FROM clientContacts.ts BY NECESSITY. That module imports `platformFetch`, and
// `lib/platform.ts` begins with `import "server-only"`. A client component may `import type` from such
// a module (types are erased), but ANY value import — a label map, a helper — pulls it into the client
// bundle and fails the build with "You're importing a component that needs server-only". `tsc` and
// vitest both pass in that state; only `next build`'s webpack pass catches it, so the split is
// load-bearing and should not be collapsed back.
export type ContactCapability = "signer" | "viewer";
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
}

export const CAPABILITY_LABEL: Record<ContactCapability, string> = {
  signer: "Can sign off",
  viewer: "Can view only",
};

export const STATUS_LABEL: Record<ContactStatus, string> = {
  invited: "Invited",
  active: "Active",
  revoked: "Revoked",
};

/** What a contact can actually be asked to do. Mirrors the API's own rule rather than re-deriving it:
 *  only an ACTIVE signer may countersign, because a signature from an account that was never activated
 *  (or has been revoked) is not a signature. */
export function canCountersign(c: ClientContact): boolean {
  return c.status === "active" && c.capability === "signer";
}

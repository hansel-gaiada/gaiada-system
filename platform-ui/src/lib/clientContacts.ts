import { platformFetch } from "./platform";
import type { ClientContact } from "./clientContactsView";

// W0-5 — the PM-facing client-contact READS (server-only; see clientContactsView.ts for the
// client-safe types/labels and why they are a separate module).
//
// BFF contract, canonical here:
//   GET  /api/:t/clients/:clientId/contacts   -> ClientContact[]
//   POST /api/:t/clients/:clientId/contacts   -> { contact, invite:{ token, expiresAt, acceptPath } }
//   POST /api/:t/client-contacts/:id/revoke   -> { id, status, idpDisabled, idpError, ... }
//
// There is no endpoint that returns a contact's password or re-reads an invite token: the raw token
// exists only in the ONE response that mints it (the API stores a sha256), so a lost link means
// issuing a new invite rather than looking the old one up.
export type { ClientContact };

/** Degrades to [] rather than throwing: a client detail page must still render if this one panel's
 *  read fails or the caller lacks the read grant — the same posture the other lib modules use. */
export async function listClientContacts(
  userId: string,
  tenant: string,
  clientId: string,
): Promise<ClientContact[]> {
  try {
    return await platformFetch<ClientContact[]>(`/api/${tenant}/clients/${clientId}/contacts`, userId);
  } catch {
    return [];
  }
}

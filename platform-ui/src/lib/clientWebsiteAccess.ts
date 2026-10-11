import "server-only";
import { platformFetch, PlatformError } from "./platform";
import {
  parseWebsiteAccessList,
  type WebsiteAccessReadResult,
} from "./clientWebsiteAccessView";

// WSK-49f — the website-access READERS (server-only; the client-safe half is clientWebsiteAccessView.ts).
//
//   GET /api/:t/clients/:clientId/website-access                  STAFF   (client_contact . read)
//   GET /api/:t/portal/clients/:clientId/website-access           PORTAL  (a client admin of THAT client)
//
// Both answer `{clientId, role, contacts:[{contactId, userId, name, email, capability, status, isAdmin,
// websiteEditor}]}` — client-wide, non-revoked contacts only (a project-scoped row is not eligible and
// is not listed). docs/FRONTEND-BFF-CONTRACT.md §16i.
//
// THREE answers, never an empty list that means "I could not tell" (readiness criterion 5):
//   ok          the read succeeded; an empty `contacts` is evidence of emptiness
//   forbidden   403 — the viewer may not read this (staff: render read-only; portal: hide the section)
//   unavailable anything else, including a body that is not the documented shape

async function read(path: string, userId: string): Promise<WebsiteAccessReadResult> {
  try {
    const list = parseWebsiteAccessList(await platformFetch<unknown>(path, userId));
    if (!list) return { kind: "unavailable", reason: "The server answered in a shape this page does not recognise." };
    return { kind: "ok", contacts: list.contacts };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 403) return { kind: "forbidden" };
      return { kind: "unavailable", reason: e.message };
    }
    return { kind: "unavailable", reason: (e as Error)?.message ?? "unknown error" };
  }
}

/** Staff: who holds website access for this client. `tenant` is the staff active company. */
export function getStaffWebsiteAccess(userId: string, tenant: string, clientId: string): Promise<WebsiteAccessReadResult> {
  return read(`/api/${tenant}/clients/${clientId}/website-access`, userId);
}

/** Portal: a client admin's colleagues. `tenant` MUST come from the portal's own resolver
 *  (`getActivePortalCompany`), never the staff one. A 403 means "not an admin here": the caller hides. */
export function getPortalWebsiteAccess(userId: string, tenant: string, clientId: string): Promise<WebsiteAccessReadResult> {
  return read(`/api/${tenant}/portal/clients/${clientId}/website-access`, userId);
}

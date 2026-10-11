import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getMe, type Me } from "./platform";
import { getSessionUserId } from "./session-server";
import { pickPortalCompany, type PortalCompany } from "./portal-company-pick";
import { readHostCookie, setHostCookie, HOST_COOKIES } from "./cookieNames";

// PV2-05 — the ONE place the client portal decides which company it is showing. Every portal page,
// the portal layout and `portalActions.ts` resolve through `getActivePortalCompany`; a guard test
// (`portal-company.guard.test.ts`) fails if any of them reaches for the staff resolver instead.
//
// It uses its OWN cookie, not the staff `gaiada_tenant`: a Viceroy employee's workspace choice must
// not change which company their portal shows, or the reverse. And it reads `me.clientOf` only, never
// `me.companies`, which mixes memberships with client contacts.
// (`HOST_COOKIES.portalTenant`: `__Host-gaiada_portal_tenant` in production, see lib/cookieNames.ts.)

/** Companies the caller is an active client contact of. */
export function getPortalCompanies(me: Me): { companyId: string; companyName: string }[] {
  return me.clientOf ?? [];
}

export async function getActivePortalCompany(me: Me): Promise<PortalCompany | null> {
  const jar = await cookies();
  return pickPortalCompany(getPortalCompanies(me), readHostCookie(jar, HOST_COOKIES.portalTenant));
}

/** Server action behind the header switch. An id that is not in the caller's `clientOf` sets no
 *  cookie; the redirect still happens. */
export async function switchPortalCompany(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("tenantId") ?? "");
  const userId = await getSessionUserId();
  if (userId) {
    const me = await getMe(userId).catch(() => null);
    if (me && getPortalCompanies(me).some((c) => c.companyId === id)) {
      const jar = await cookies();
      setHostCookie(jar, HOST_COOKIES.portalTenant, id);
    }
  }
  redirect("/portal");
}

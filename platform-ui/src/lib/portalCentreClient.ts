"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readHostCookie, setHostCookie, HOST_COOKIES } from "./cookieNames";

// The portal's Company tab has NO client id in its URL (`/portal/company/[[...section]]` per the
// plan) — a client contact with several clients (rare, but the plan explicitly asks for the
// switcher) picks one and it is remembered server-side, same shape as `tenant.ts`'s active-company
// cookie: pick, persist, redirect. Kept in its own file (not `clientCentre-data.ts`/`Actions.ts`)
// because it is portal-only cookie plumbing, not a `platformFetch` reader or a PATCH action.
// Cookie: `HOST_COOKIES.portalClient` (`__Host-gaiada_portal_client` in production, lib/cookieNames.ts).

export async function getActivePortalClient(scope: Array<{ clientId: string }>): Promise<string | null> {
  if (scope.length === 0) return null;
  const jar = await cookies();
  const raw = readHostCookie(jar, HOST_COOKIES.portalClient);
  if (raw && scope.some((s) => s.clientId === raw)) return raw;
  return scope[0].clientId;
}

export async function switchPortalClient(formData: FormData): Promise<void> {
  const id = String(formData.get("clientId") ?? "");
  const jar = await cookies();
  setHostCookie(jar, HOST_COOKIES.portalClient, id);
  redirect("/portal/company");
}

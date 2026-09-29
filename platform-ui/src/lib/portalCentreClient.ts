"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// The portal's Company tab has NO client id in its URL (`/portal/company/[[...section]]` per the
// plan) — a client contact with several clients (rare, but the plan explicitly asks for the
// switcher) picks one and it is remembered server-side, same shape as `tenant.ts`'s active-company
// cookie: pick, persist, redirect. Kept in its own file (not `clientCentre-data.ts`/`Actions.ts`)
// because it is portal-only cookie plumbing, not a `platformFetch` reader or a PATCH action.
const COOKIE = "gaiada_portal_client";

export async function getActivePortalClient(scope: Array<{ clientId: string }>): Promise<string | null> {
  if (scope.length === 0) return null;
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw && scope.some((s) => s.clientId === raw)) return raw;
  return scope[0].clientId;
}

export async function switchPortalClient(formData: FormData): Promise<void> {
  const id = String(formData.get("clientId") ?? "");
  const jar = await cookies();
  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  redirect("/portal/company");
}

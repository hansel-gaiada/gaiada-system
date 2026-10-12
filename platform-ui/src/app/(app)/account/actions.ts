"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { clearHostCookie, HOST_COOKIES } from "@/lib/cookieNames";
import { endIdpSession } from "@/lib/idpLogout";
import { getPrefs, writePrefs, type Density, type Theme, type Width } from "@/lib/prefs";
import { getSession } from "@/lib/session-server";

export async function logout(): Promise<void> {
  // Read before the clear: the refresh token is what ends the Keycloak session.
  const session = await getSession();
  const jar = await cookies();
  // Through the helper, not a bare `maxAge: 0`: in production the cookie is `__Host-gaiada_session`,
  // and a clear without `Secure` + `Path=/` is ignored by the browser — logout would silently fail.
  clearHostCookie(jar, HOST_COOKIES.session);
  // Also end the SSO session, or /auth/login signs straight back in (B0 sweep). Fail-soft: the ERP cookie is
  // already cleared whatever Keycloak answers.
  if (session?.mode === "oidc" && session.refreshToken) await endIdpSession(session.refreshToken);
  redirect("/login");
}

export async function savePrefs(formData: FormData): Promise<void> {
  const density = (String(formData.get("density")) === "compact" ? "compact" : "comfortable") as Density;
  const width = (String(formData.get("width")) === "wide" ? "wide" : "standard") as Width;
  const rawTheme = String(formData.get("theme"));
  const theme = (rawTheme === "light" || rawTheme === "dark" ? rawTheme : "auto") as Theme;
  // This form has no field for the assistant rail's collapse flag or the Office camera zoom
  // (those are set from their own surfaces, via `lib/prefsActions.ts`) — read the current cookie
  // first so saving density/width/theme here never stomps either back to its default.
  const current = await getPrefs();
  await writePrefs({ density, width, theme, assistantRailCollapsed: current.assistantRailCollapsed, officeZoom: current.officeZoom });
  // Applied on the shell — refresh the whole app so the new density takes hold.
  revalidatePath("/", "layout");
}

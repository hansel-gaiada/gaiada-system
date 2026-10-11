"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { clearHostCookie, HOST_COOKIES } from "@/lib/cookieNames";
import { getPrefs, writePrefs, type Density, type Theme, type Width } from "@/lib/prefs";

export async function logout(): Promise<void> {
  const jar = await cookies();
  // Through the helper, not a bare `maxAge: 0`: in production the cookie is `__Host-gaiada_session`,
  // and a clear without `Secure` + `Path=/` is ignored by the browser — logout would silently fail.
  clearHostCookie(jar, HOST_COOKIES.session);
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

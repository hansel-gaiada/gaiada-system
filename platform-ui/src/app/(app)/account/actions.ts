"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
// SESSION_COOKIE is exported from lib/session (not session-server, which is
// the request-context half) — mirrors src/app/login/actions.ts.
import { SESSION_COOKIE } from "@/lib/session";
import { getPrefs, writePrefs, type Density, type Theme, type Width } from "@/lib/prefs";

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  redirect("/login");
}

export async function savePrefs(formData: FormData): Promise<void> {
  const density = (String(formData.get("density")) === "compact" ? "compact" : "comfortable") as Density;
  const width = (String(formData.get("width")) === "wide" ? "wide" : "standard") as Width;
  const rawTheme = String(formData.get("theme"));
  const theme = (rawTheme === "light" || rawTheme === "dark" ? rawTheme : "auto") as Theme;
  // This form has no field for the assistant rail's collapse flag (that's set from `/assistant`
  // itself, via `lib/prefsActions.ts`) — read the current cookie first so saving density/width/theme
  // here never stomps it back to the default.
  const current = await getPrefs();
  await writePrefs({ density, width, theme, assistantRailCollapsed: current.assistantRailCollapsed });
  // Applied on the shell — refresh the whole app so the new density takes hold.
  revalidatePath("/", "layout");
}

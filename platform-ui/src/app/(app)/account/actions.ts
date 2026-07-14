"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
// SESSION_COOKIE is exported from lib/session (not session-server, which is
// the request-context half) — mirrors src/app/login/actions.ts.
import { SESSION_COOKIE } from "@/lib/session";
import { writePrefs, type Density, type Width } from "@/lib/prefs";

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  redirect("/login");
}

export async function savePrefs(formData: FormData): Promise<void> {
  const density = (String(formData.get("density")) === "compact" ? "compact" : "comfortable") as Density;
  const width = (String(formData.get("width")) === "wide" ? "wide" : "standard") as Width;
  await writePrefs({ density, width });
  // Applied on the shell — refresh the whole app so the new density takes hold.
  revalidatePath("/", "layout");
}

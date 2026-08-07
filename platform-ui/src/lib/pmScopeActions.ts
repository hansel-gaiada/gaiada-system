"use server";
// Persisting the PM scope switcher's choice (P4-A4) — byte-for-byte the same shape as
// `lib/tenant.ts`'s company switcher: a plain cookie write + redirect back to wherever the user
// was, so a scope survives navigation and a fresh visit to `/pm` reopens on the last thing viewed.
//
// Deliberately NOT the place that validates a department/project still exists — `getPmScope` below
// is a plain read, same division of labour as `tenant.ts::getActiveTenant` (a plain read) vs. the
// caller that reconciles it against real data. `resolveScopeWork` (`lib/pmScope-data.ts`) is that
// reconciler for PM scope: a stale/foreign id degrades to `@all` there, not here.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parsePmScope, encodePmScope, PM_SCOPE_COOKIE, type PmScope } from "./pmScope";

export async function getPmScope(): Promise<PmScope> {
  const jar = await cookies();
  return parsePmScope(jar.get(PM_SCOPE_COOKIE)?.value);
}

/** `scope`: the encoded `PmScope` the switcher just selected. `next`: the path to return to
 *  (the SAME view the user was on — Repsona's switcher never changes what you're looking at,
 *  only what it's scoped to) — `ScopeSwitcher` fills this from `usePathname()` + its own search. */
export async function setPmScope(formData: FormData): Promise<void> {
  const raw = String(formData.get("scope") ?? "all");
  const next = String(formData.get("next") ?? "/pm");
  const jar = await cookies();
  jar.set(PM_SCOPE_COOKIE, encodePmScope(parsePmScope(raw)), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  redirect(next);
}

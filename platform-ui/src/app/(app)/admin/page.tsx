import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { adminRouteAllowed } from "@/lib/adminAccess";

// Settings landing → the first section the person may open (Users & Roles for an administrator).
// DW-D20: nobody allowed into any section gets a 404 here, never an empty Settings area.
const SECTIONS = ["users", "identity", "modules", "services", "compliance", "audit", "mail", "about"];

export default async function SettingsIndex() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const first = SECTIONS.find((s) => adminRouteAllowed(`/admin/${s}`, me, tenant) !== false);
  if (!first) notFound();
  redirect(`/admin/${first}`);
}

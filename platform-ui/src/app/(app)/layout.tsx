import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPrefs } from "@/lib/prefs";
import { Shell } from "@/components/shell/Shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId).catch(() => null);
  if (!me) redirect("/login");
  const tenantId = await getActiveTenant(me);
  const prefs = await getPrefs();
  return (
    <Shell me={me} tenantId={tenantId} moduleLabel="My Workspace" prefs={prefs}>
      {children}
    </Shell>
  );
}

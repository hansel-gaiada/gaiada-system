import { notFound, redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { PortfolioPanel } from "@/components/webdesk/PortfolioPanel";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { safeConsoleRead } from "@/lib/webdesk";
import { fetchPortfolio } from "@/lib/webdeskPortfolio.server";

type Params = Promise<{ deptId: string }>;

// The estate portfolio (design v2.0 §07), sibling to the Zone B site registry one level up.
//
// Reuses `safeConsoleRead` for the same 404="module not enabled here" / 403="genuinely refused"
// split every other webdev reader draws. Coalescing either into an empty portfolio would be a
// confident wrong answer — and on THIS page it would be the worst possible one, because an empty
// portfolio reads as "we operate no sites" rather than "you cannot see them".
export default async function SitePortfolioPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  await params;
  if (!tenant) notFound();

  const read = await safeConsoleRead(() => fetchPortfolio(userId, tenant));
  if (!read.ok) {
    if (read.reason === "not_enabled") {
      return (
        <Card title="Site portfolio">
          <EmptyNote>WebDesk isn&apos;t turned on for this company yet.</EmptyNote>
        </Card>
      );
    }
    return <ReadRefusal subject="the site portfolio" kind="forbidden" />;
  }

  return <PortfolioPanel data={read.data} />;
}

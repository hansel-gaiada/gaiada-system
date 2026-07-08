import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listCampaigns, type Campaign } from "@/lib/entities";
import { formatBudget } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";

const COLUMNS = [{ label: "Name" }, { label: "Status" }, { label: "Budget", align: "right" as const }];
const TCOLS = "2fr 1fr 1fr";

export default async function AgencyPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  // listCampaigns returns [] both when there are simply no campaigns yet and when the
  // agency module isn't enabled for the active company (404 skipped in entities.ts) —
  // we can't tell those apart from here, so a single quiet empty state covers both.
  const campaigns: Campaign[] = tenant ? await listCampaigns(userId, tenant) : [];

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Agency"
        subtitle="Campaigns for the active company."
        actions={
          <>
            <Link href="/approvals" className="lux-btn lux-btn--ghost lux-btn--sm">
              Pending approvals
            </Link>
            <Link href="/agency/new" className="lux-btn lux-btn--solid lux-btn--sm">
              New campaign
            </Link>
          </>
        }
      />
      <Card>
        {campaigns.length === 0 ? (
          <div className="dash-empty">
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>No campaigns yet</div>
            <p>If Agency isn&apos;t enabled for this company, switch companies from the top bar.</p>
          </div>
        ) : (
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={campaigns.map((c) => [
              <Link key={c.id} href={`/agency/${c.id}`}>{c.name}</Link>,
              <StatusBadge key={`${c.id}-status`} label={c.status} />,
              formatBudget(c.budget_minor, c.currency),
            ])}
          />
        )}
      </Card>
    </>
  );
}

import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getPendingApprovals } from "@/lib/data";
import { decideApproval } from "../actions";
import { Card, Eyebrow } from "@/components/ui";
import { ApprovalsPanel } from "@/components/dashboard/ApprovalsPanel";

export default async function ApprovalsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const approvals = await getPendingApprovals(userId, me.companies);
  const byCompany = new Map<string, typeof approvals>();
  for (const a of approvals) {
    const list = byCompany.get(a.company) ?? [];
    list.push(a);
    byCompany.set(a.company, list);
  }

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Workspace</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Approvals</h1>
        <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 560 }}>
          Everything awaiting your decision, across every company. Agent and identity requests join this inbox as those systems come online.
        </p>
      </div>
      {byCompany.size === 0 ? (
        <Card><div className="dash-empty">
          <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>All clear</div>
          <p>Nothing awaiting your review right now.</p>
        </div></Card>
      ) : (
        <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
          {[...byCompany.entries()].map(([company, items]) => (
            <Card key={company} title={company} headerRight={<span className="dash-pending-chip">{items.length} PENDING</span>}>
              <ApprovalsPanel items={items} decide={decideApproval} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

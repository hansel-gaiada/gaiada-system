import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listMembers } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// HR console home — headcount and org shape at a glance, with a way into the
// people directory. Composed from data that already exists (members + org).
export default async function HROverviewPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <Card><EmptyNote>Select a company from the top bar.</EmptyNote></Card>;

  const [members, depts] = await Promise.all([
    listMembers(userId, tenant).catch(() => []),
    listDepartmentBriefs(userId, tenant).catch(() => []),
  ]);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="People" value={String(members.length)} foot="in this company" />
        <KpiTile label="Departments" value={String(depts.length)} />
      </div>

      <Card
        title="People directory"
        headerRight={<Link href="/hr/people" className="lux-btn lux-btn--ghost lux-btn--sm">Open directory →</Link>}
      >
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--erp-ink-60)", maxWidth: 620 }}>
          Everyone in {me.companies.find((c) => c.id === tenant)?.name ?? "this company"} — profiles, roles, assigned work and
          identity links. Manage placement in the org structure from the Org tab.
        </p>
      </Card>
    </>
  );
}

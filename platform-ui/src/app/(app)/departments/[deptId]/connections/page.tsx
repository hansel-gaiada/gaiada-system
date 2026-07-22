import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Connections — GitHub / Google Drive / Claude-seat links for this department
// (F1 `integration_connections`, decision #6-#9). This IS the destination tab
// (no further CTA); skeleton only here (P1-06) — the real connect/edit/revoke
// flow + team status grid + seat mapping are P1-08/09/10's job.
export default async function DepartmentConnectionsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <Card title="Connections">
      <TeachState
        glyph="⌁"
        title="Nothing connected yet"
        body="Connect GitHub, Google Drive, or a Claude seat for this department — Repositories, Deliverables, and Activity light up once you do."
      />
    </Card>
  );
}

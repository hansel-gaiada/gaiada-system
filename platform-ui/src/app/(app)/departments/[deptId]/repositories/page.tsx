import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Repositories — linked code repositories for this department. Connection-
// backed (F1 / P1-08, not built yet); skeleton only here (P1-06) — teaches
// the person to the Connections tab, per the "Connect X" pattern (P1-02 §5).
export default async function DepartmentRepositoriesPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <Card title="Repositories">
      <TeachState
        glyph="⎇"
        title="No repositories connected"
        body="Connect GitHub for this department to see linked repos and their activity here."
        ctaLabel="Go to Connections"
        ctaHref={`/departments/${deptId}/connections`}
      />
    </Card>
  );
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { moveTask } from "@/lib/pmActions";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board } from "@/components/pm/Board";

type Params = Promise<{ deptId: string }>;

// Board — the department's working kanban (decision #10 split: this used to
// share a tab with the owned-project rollup, which now lives on the Projects
// tab). Tasks routed to this department, its divisions, or its people appear
// here; drag a card to move it.
export default async function DepartmentBoardPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div style={{ font: "700 10px var(--font-body)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>Work board</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/pipeline" className="lux-btn lux-btn--ghost lux-btn--sm">Delivery Pipeline</Link>
          <Link href="/projects" className="lux-btn lux-btn--ghost lux-btn--sm">All projects</Link>
        </div>
      </div>

      {dept.tasks.length === 0 ? (
        <Card><EmptyNote>No work routed to this department yet. Tasks assigned to {dept.name}, its divisions, or its people appear here.</EmptyNote></Card>
      ) : (
        <Board columns={dept.columns} move={moveTask} />
      )}
    </>
  );
}

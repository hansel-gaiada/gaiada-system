import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { listProjects, readClients, readDepartmentDeliverables } from "@/lib/entities";
import { readResult } from "@/lib/readResult";
import { formatDate } from "@/lib/format";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { TeachState } from "@/components/departments/TeachState";
import { departmentDeliverablesView } from "./page-helpers";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// DW-6g — Web Dev > Build > Deliverables (contract §33). The deliverables recorded on the projects this department,
// or any unit under it, owns (`GET deliverables?departmentId=`), in the list's own order: due date, then newest.
// The project and client names come from two more department-scoped reads (`projects?departmentId=` and
// `clients?departmentId=`), never one read per row. Reads are honest: a refusal or a failure is a <ReadRefusal>,
// never "no deliverables". Produced artefacts that are not deliverable rows (PRDs, site builds) stay on their own tabs.
export default async function DepartmentDeliverablesPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const [dept, deliverables, projects, clients] = await Promise.all([
    getDepartment(userId, tenant, deptId),
    readDepartmentDeliverables(userId, tenant, deptId),
    readResult(listProjects(userId, tenant, undefined, deptId)),
    readClients(userId, tenant, deptId),
  ]);
  if (!dept) notFound();

  const view = departmentDeliverablesView(deliverables, projects, clients);
  if (view.kind === "forbidden") return <ReadRefusal subject="this department's deliverables" kind="forbidden" />;
  if (view.kind === "unavailable") return <ReadRefusal subject="This department's deliverables" kind="unavailable" reason={view.reason} />;

  return (
    <Card
      title="Deliverables"
      hint="Deliverables recorded on the projects this department, or a unit under it, owns."
      headerRight={view.kind === "rows" ? <span className="dept-proj__total">{view.rows.length} deliverable{view.rows.length === 1 ? "" : "s"}</span> : undefined}
    >
      {view.kind === "empty" ? (
        <TeachState
          glyph="▤"
          title="No deliverables yet"
          body="No deliverables are recorded on this department's projects. Add one to a project and it appears here."
          ctaLabel="New deliverable"
          ctaHref="/deliverables/new"
        />
      ) : (
        <div className="lux-table-scroll erp-scroll">
          <HairlineTable
            columns={[
              { label: "Deliverable" },
              { label: "Project" },
              { label: "Client" },
              { label: "Status" },
              { label: "Due", align: "right" },
            ]}
            tcols="2fr 1.8fr 1.5fr 1fr 1fr"
            rows={view.rows.map((r) => [
              <span key="n" className="dept-proj__name">{r.name}</span>,
              <Link key="p" href={`/projects/${r.projectId}`} className="dept-proj__name">{r.projectName ?? "Open project"}</Link>,
              r.clientId
                ? <Link key="c" href={`/clients/${r.clientId}`} className="dept-proj__name">{r.clientName ?? "Open client"}</Link>
                : "—",
              <StatusBadge key="s" label={r.status} />,
              <span key="d">{r.dueDate ? formatDate(r.dueDate) : "no due date"}</span>,
            ])}
          />
        </div>
      )}
    </Card>
  );
}

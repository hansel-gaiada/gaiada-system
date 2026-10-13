import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { listProjects, readClients } from "@/lib/entities";
import { listClientCentres } from "@/lib/clientCentre-data";
import { registry, businessTypeLabel } from "@/lib/clientCentre";
import { readCentres } from "@/lib/clientBusinessType";
import { readResult } from "@/lib/readResult";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { TeachState } from "@/components/departments/TeachState";
import { departmentClientsView } from "./page-helpers";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// DW-6d — the department's Clients row (contract §33). A department's clients are the clients with a LIVE project
// that the department, or any unit under it, owns (`GET clients?departmentId=`); a client served only through an
// engagement or a site, with no project, is not listed, and the page says so. The project count per client comes
// from ONE `GET projects?departmentId=` read, never one read per client. Reads are honest: a refusal or a failure
// is a <ReadRefusal>, never "no clients".
export default async function DepartmentClientsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const [dept, clients, projects, centreOutcome] = await Promise.all([
    getDepartment(userId, tenant, deptId),
    readClients(userId, tenant, deptId),
    readResult(listProjects(userId, tenant, undefined, deptId)),
    listClientCentres(userId, tenant).then(
      (items) => ({ items, thrown: undefined as unknown }),
      (e: unknown) => ({ items: null, thrown: e ?? new Error("read failed") }),
    ),
  ]);
  if (!dept) notFound();

  // Business types come from the Client Centre profile list (one row per client). When that read failed, or came
  // back empty for a company that has clients, the column reads "—" (unknown), never a guess.
  const centres = readCentres(clients.kind === "ok" ? clients.data.length : 0, centreOutcome.items, centreOutcome.thrown);
  const businessTypes = centres.ok
    ? new Map([...centres.byClientId].map(([id, c]) => [id, businessTypeLabel(registry, c.businessType)] as const))
    : null;
  const view = departmentClientsView(clients, projects, businessTypes);

  if (view.kind === "forbidden") return <ReadRefusal subject="this department's clients" kind="forbidden" />;
  if (view.kind === "unavailable") return <ReadRefusal subject="This department's clients" kind="unavailable" reason={view.reason} />;

  return (
    <Card
      title="Department clients"
      hint="Clients with a live project this department, or a unit under it, owns."
      headerRight={view.kind === "rows" ? <span className="dept-proj__total">{view.rows.length} client{view.rows.length === 1 ? "" : "s"}</span> : undefined}
    >
      {view.kind === "empty" ? (
        <TeachState
          glyph="◇"
          title="No clients with projects in this department yet"
          body="This list comes from the department's projects: a client appears here once a live project of this department, or of a unit under it, belongs to them."
          ctaLabel="Go to the department's projects"
          ctaHref={`/departments/${deptId}/projects`}
        />
      ) : (
        <>
          <div className="lux-table-scroll erp-scroll">
            <HairlineTable
              columns={[
                { label: "Client" },
                { label: "Business type" },
                { label: "Status" },
                { label: "Projects here", align: "right" },
              ]}
              tcols="2.2fr 1.4fr 1fr 1fr"
              rows={view.rows.map((r) => [
                <Link key={r.id} href={`/clients/${r.id}`} className="dept-proj__name">{r.name}</Link>,
                r.businessType ?? "—",
                <StatusBadge key="s" label={r.status} />,
                <span key="n">{r.projectCount ?? "—"}</span>,
              ])}
            />
          </div>
          <p className="dept-proj__sub" style={{ marginTop: 12 }}>
            This list comes from the department&apos;s projects. A client served only through an engagement or a site, with no project here, is not listed.
            {projects.kind !== "ok" ? " The project counts could not be read just now." : ""}
            {businessTypes === null ? " Business types could not be read just now." : ""}
          </p>
        </>
      )}
    </Card>
  );
}

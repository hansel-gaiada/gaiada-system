import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readClientNames, readSharedCampaigns } from "@/lib/campaigns-data";
import { formatDate } from "@/lib/format";
import "@/components/agency/campaigns.css";

type Params = Promise<{ deptId: string }>;

const COLUMNS = [
  { label: "Campaign" }, { label: "Client" }, { label: "Our part" }, { label: "Owner" }, { label: "Due" }, { label: "Campaign status" },
];
const TCOLS = "2.2fr 1.4fr 1fr 1.2fr 1fr 1fr";

// DW-5b — Campaigns › Shared (plan §7.1): the shared campaigns this department has a part in, or leads, with our part's
// status. Reads `GET .../modules/agency/campaigns?unitId=<dept>` (contract §31.4). The read is honest: a refusal or a
// failure is a <ReadRefusal>, never a table that says "no campaigns". Only an `ok` answer with no rows says the
// department has no part in any campaign yet. Agency pack only: the registry's AGENCY_ONLY gate hides the tab elsewhere.
export default async function DepartmentSharedCampaignsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const [rowsResult, clients] = await Promise.all([readSharedCampaigns(userId, tenant, deptId), readClientNames(userId, tenant)]);
  if (rowsResult.kind === "forbidden") return <ReadRefusal subject="this department's shared campaigns" kind="forbidden" />;
  if (rowsResult.kind === "unavailable") {
    return <ReadRefusal subject="This department's shared campaigns" kind="unavailable" reason={rowsResult.reason} />;
  }
  const rows = rowsResult.data;

  const clientCell = (clientId: string | null) => {
    if (!clientId) return "—";
    if (clients.kind !== "ok") return <span title="The client list could not be read">Unavailable</span>;
    const name = clients.data[clientId];
    return name ? <Link href={`/clients/${clientId}`}>{name}</Link> : "—";
  };

  return (
    <Card title="Shared campaigns" hint="Campaigns shared across departments, where this department has a part or leads.">
      {rows.length === 0 ? (
        <p className="cmp-empty">This department has no part in any campaign yet.</p>
      ) : (
        <HairlineTable
          tcols={TCOLS}
          columns={COLUMNS}
          rows={rows.map((r) => [
            <span key={`${r.id}-n`}>
              <Link href={`/agency/${r.id}`}>{r.name}</Link>
              {r.leadUnitId === deptId ? <span className="cmp-lead-tag">Lead</span> : null}
            </span>,
            <span key={`${r.id}-c`}>{clientCell(r.clientId)}</span>,
            r.part ? <StatusBadge key={`${r.id}-p`} label={r.part.status} /> : <span key={`${r.id}-p`}>Lead, no part</span>,
            r.part?.ownerName ?? (r.part ? "No owner" : "—"),
            r.part?.dueOn ? formatDate(r.part.dueOn) : "—",
            <StatusBadge key={`${r.id}-s`} label={r.status} />,
          ])}
        />
      )}
      {clients.kind !== "ok" && rows.length > 0 && (
        <p className="cmp-note" style={{ marginTop: 12 }}>The client names could not be read, so the Client column shows &ldquo;Unavailable&rdquo;.</p>
      )}
    </Card>
  );
}

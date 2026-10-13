import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { AskLinks } from "@/components/requests/AskLinks";
import { RequestsTable, StatusFilterNav } from "@/components/requests/RequestsTable";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { activeCompany } from "@/lib/companyContext";
import { readRequests } from "@/lib/requests-data";
import { readOrgRoot } from "@/lib/campaigns-data";
import { parseStatusFilter } from "@/lib/requests";
import "@/components/requests/requests.css";

// DW-5c — My requests (plan §7.3): the asks this person sent, newest first, for people with no department as much as for
// those with one. Reads `GET requests?box=mine&status=` (contract §32.5). Open by default, with a Closed and an All
// switch. The read is honest: a refusal or a failure is a <ReadRefusal>, never a table that says "no requests". Only an
// `ok` answer with no rows says there are none. Record page area `shared`: it keeps the workspace you came from.
export default async function MyRequestsPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();
  const status = parseStatusFilter((await searchParams).status);

  const [result, root] = await Promise.all([readRequests(userId, tenant, { box: "mine" }, status), readOrgRoot(me, tenant)]);

  const header = <PageHeader title="My requests" />;
  if (result.kind === "forbidden") return <>{header}<ReadRefusal subject="your requests" kind="forbidden" /></>;
  if (result.kind === "unavailable") return <>{header}<ReadRefusal subject="Your requests" kind="unavailable" reason={result.reason} /></>;
  const rows = result.data;

  const empty = status === "open" ? "You have no open requests." : status === "closed" ? "You have no closed requests." : "You have not sent any requests yet.";
  return (
    <>
      {header}
      <div className="req-bar">
        <StatusFilterNav basePath="/requests" current={status} />
        <AskLinks root={root} vertical={activeCompany(me, tenant)?.vertical} />
      </div>
      <Card title="Requests you sent" hint="Asks you made of other departments, and where each one stands.">
        {rows.length === 0 ? <p className="req-empty">{empty}</p> : <RequestsTable rows={rows} showRequester={false} />}
      </Card>
    </>
  );
}

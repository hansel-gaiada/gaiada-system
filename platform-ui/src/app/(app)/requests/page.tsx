import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { PageHeader } from "@/components/PageHeader";
import { AskLinks } from "@/components/requests/AskLinks";
import { StatusFilterNav } from "@/components/requests/RequestsTable";
import { SentRequests } from "@/components/requests/SentRequests";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { activeCompany } from "@/lib/companyContext";
import { readOutboundRequests, readRequests } from "@/lib/requests-data";
import { readOrgRoot } from "@/lib/campaigns-data";
import { mergeSentReads, parseStatusFilter } from "@/lib/requests";
import "@/components/requests/requests.css";

// DW-5c — My requests (plan §7.3): the asks this person sent, newest first, for people with no department as much as for
// those with one. Reads `GET requests?box=mine&status=` (contract §32.5). Open by default, with a Closed and an All
// switch. The read is honest: a refusal or a failure is a <ReadRefusal>, never a table that says "no requests". Only an
// `ok` answer with no rows says there are none. Record page area `shared`: it keeps the workspace you came from.
// DW-10e (BFF §60.9): merges §32's read (`box=mine`) with the sender read (`requests/outbound?box=mine`), so a request to another group
// company is listed too, naming the company and the department. The page says which scope the sender read answered (DW-D40), and when
// one of the two reads fails it shows the other AND says which part could not be read.
export default async function MyRequestsPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();
  const status = parseStatusFilter((await searchParams).status);

  const [result, outbound, root] = await Promise.all([
    readRequests(userId, tenant, { box: "mine" }, status),
    readOutboundRequests(userId, tenant, { box: "mine" }, status),
    readOrgRoot(me, tenant),
  ]);

  const header = <PageHeader title="My requests" />;
  // Neither half could be read: the whole page is the refusal, as it always was.
  if (result.kind !== "ok" && outbound.kind !== "ok") {
    return result.kind === "forbidden"
      ? <>{header}<ReadRefusal subject="your requests" kind="forbidden" /></>
      : <>{header}<ReadRefusal subject="Your requests" kind="unavailable" reason={result.kind === "unavailable" ? result.reason : undefined} /></>;
  }
  const merged = mergeSentReads(result, outbound);

  const empty = status === "open" ? "You have no open requests." : status === "closed" ? "You have no closed requests." : "You have not sent any requests yet.";
  return (
    <>
      {header}
      <div className="req-bar">
        <StatusFilterNav basePath="/requests" current={status} />
        <AskLinks root={root} vertical={activeCompany(me, tenant)?.vertical} />
      </div>
      <SentRequests merged={merged} company={activeCompany(me, tenant)?.name ?? null} empty={empty} showRequester={false} />
    </>
  );
}

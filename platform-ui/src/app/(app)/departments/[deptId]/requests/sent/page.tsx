import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AskLinks } from "@/components/requests/AskLinks";
import { StatusFilterNav } from "@/components/requests/RequestsTable";
import { SentRequests } from "@/components/requests/SentRequests";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { readOutboundRequests, readRequests } from "@/lib/requests-data";
import { readOrgRoot } from "@/lib/campaigns-data";
import { mergeSentReads, parseStatusFilter } from "@/lib/requests";
import "@/components/requests/requests.css";

type Params = Promise<{ deptId: string }>;

// DW-5h — Requests › Sent: what this department's people have asked of other departments, and where each stands.
// Reads `GET requests?box=sent&unitId=<dept>&status=` (contract §32.5), newest first. The request is attributed to the
// requester's department by the server (§32.3), so a person in a division counts for their department. Open by default,
// with a Closed and an All switch. The read is honest: a refusal or a failure is a <ReadRefusal>, never a table that
// says "no requests". `/departments/[deptId]/requests` (Incoming) is another page and is not changed here.
// DW-10e (BFF §60.9): the tab merges the sender read (`requests/outbound?box=sent&unitId=<dept>`), so what this department's people asked of
// OTHER group companies is listed too ("To <unit> · <company>"), with the scope note (DW-D40) and the part that failed named.
export default async function DepartmentSentRequestsPage({
  params, searchParams,
}: { params: Params; searchParams: Promise<{ status?: string | string[] }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const status = parseStatusFilter((await searchParams).status);

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const [result, outbound, root] = await Promise.all([
    readRequests(userId, tenant, { box: "sent", unitId: deptId }, status),
    readOutboundRequests(userId, tenant, { box: "sent", unitId: deptId }, status),
    readOrgRoot(me, tenant),
  ]);
  if (result.kind !== "ok" && outbound.kind !== "ok") {
    return result.kind === "forbidden"
      ? <ReadRefusal subject="this department's sent requests" kind="forbidden" />
      : <ReadRefusal subject="This department's sent requests" kind="unavailable" reason={result.kind === "unavailable" ? result.reason : undefined} />;
  }
  const merged = mergeSentReads(result, outbound);

  const empty =
    status === "open" ? `${dept.name} has no open requests to other departments.`
    : status === "closed" ? `${dept.name} has no closed requests.`
    : `${dept.name} has not sent any requests yet.`;
  return (
    <>
      <div className="req-bar">
        <StatusFilterNav basePath={`/departments/${encodeURIComponent(deptId)}/requests/sent`} current={status} />
        <AskLinks root={root} vertical={activeCompany(me, tenant)?.vertical} />
      </div>
      <SentRequests
        merged={merged} company={activeCompany(me, tenant)?.name ?? null} empty={empty} showRequester
        titleOverride="Sent requests" hintOverride="Asks this department's people made of other departments and of other companies, and where each one stands."
      />
    </>
  );
}

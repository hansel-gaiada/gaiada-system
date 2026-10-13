import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card } from "@/components/ui";
import { DeliveredRequestsTable } from "@/components/requests/DeliveredRequestsTable";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readRequests } from "@/lib/requests-data";
import { deliveredOnly } from "@/lib/requests";
import "@/components/requests/requests.css";

type Params = Promise<{ deptId: string }>;

// DW-5d: Requests > Delivered, the asset requests this department has delivered (`box=incoming&kind=assets&status=closed`,
// contract §32.5). The server's `closed` also carries declined and cancelled ones, so only `delivered` is listed, newest
// delivery first, and a note says how many others are closed (they are on the request's own page). A refusal or a failed
// read is a <ReadRefusal>, never a table that says nothing was delivered.
export default async function DepartmentDeliveredRequestsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const result = await readRequests(userId, tenant, { box: "incoming", unitId: deptId }, "closed", { kind: "assets" });
  if (result.kind === "forbidden") return <ReadRefusal subject="this department's delivered requests" kind="forbidden" />;
  if (result.kind === "unavailable") return <ReadRefusal subject="This department's delivered requests" kind="unavailable" reason={result.reason} />;
  const { delivered, otherClosed } = deliveredOnly(result.data);

  return (
    <Card title="Delivered requests" hint="Asset requests this department has delivered, newest first.">
      {delivered.length === 0
        ? <p className="req-empty">Nothing has been delivered yet.</p>
        : <DeliveredRequestsTable rows={delivered} />}
      {otherClosed > 0 ? (
        <p className="req-note" style={{ marginTop: 10 }}>
          {otherClosed === 1
            ? "1 other closed request was declined or cancelled and is not listed here."
            : `${otherClosed} other closed requests were declined or cancelled and are not listed here.`}
        </p>
      ) : null}
    </Card>
  );
}

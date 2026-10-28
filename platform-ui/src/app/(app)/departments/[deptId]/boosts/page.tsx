import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getBoostList } from "@/lib/socialBoosts-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { BoostBoard } from "@/components/social/BoostBoard";
import "@/components/social/cycles.css";
import "@/components/social/boosts.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ cursor?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// SCP-4b (BFF §63.11, §63.17): Boosting. Three parts, from the one read `GET boosts`: the candidates (live posts well above their client's average, each with a Boost button),
// the boosts running and waiting (filterable by status and client; every row opens its post) and the totals the listed boosts commit and have spent. A boost records what the team runs
// in the network's own ads tools: nothing is bought from here (the D14 doctrine on money-spending tools is untouched). A refused read is "no access" and a failed one is "cannot tell",
// never an empty list.
export default async function BoostingPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // Boosting belongs to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const cursor = first((await searchParams).cursor) ?? null;
  const list = await getBoostList(userId, tenant, { cursor });
  if (list.kind === "forbidden") return <ReadRefusal subject="Boosting" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />;
  if (list.kind === "unavailable") return <ReadRefusal subject="Boosting" kind="unavailable" reason={list.reason} />;

  const here = `/departments/${encodeURIComponent(deptId)}/boosts`;
  return (
    <Card title="Boosting">
      <p className="scp-lede">
        Boost the posts that are doing well, and keep each client&apos;s monthly boost budget. A boost records what the team runs in the network&apos;s own ads tools; nothing is bought from here.
        Within the month&apos;s agreed budget a boost starts without asking; over it, the client is asked to approve it.
      </p>
      <BoostBoard deptId={deptId} data={list.data} nextHref={list.data.nextCursor ? `${here}?cursor=${encodeURIComponent(list.data.nextCursor)}` : null} />
    </Card>
  );
}

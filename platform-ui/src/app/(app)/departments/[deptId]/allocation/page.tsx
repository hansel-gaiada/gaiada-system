import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { can } from "@/lib/rbac";
import { todayIsoInDisplayZone } from "@/lib/format";
import { getAllocation, getOfficerCandidates } from "@/lib/socialAllocation-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AllocationTable, type OfficerOption } from "@/components/social/AllocationTable";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ mine?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// SCP-1a (BFF §63.4, §63.17; plan §8 row 1a): the Social Media Allocation page. Every client that is not closed, with its officer, creative source,
// target, report format and day, delivery batch, platforms, formats, default posting time, and this cycle's counts against the target.
//
// The page is READABLE by the whole team (`GET allocation`: `social_engagement` · `read`; the registry row has no gate) and EDITABLE only by the four Social
// approvers (the server's per-row `canPlan`, `social_engagement` · `plan`), so a person who is not one sees the same list with every control disabled and
// the reason on the page. The gate never grants anything: the server's 403 `not_a_social_approver` is the boundary. A client's brand book opens in a drawer
// from its row; changing it needs the Social Media manager tier on the server (`update`), which the page mirrors with `social.scope.write`.
// `?mine=1` keeps the caller's own clients (the Profile switcher's list).
export default async function SocialAllocationPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // The allocation belongs to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const sp = await searchParams;
  const mineQ = first(sp.mine);
  const mine = mineQ === "1" || mineQ === "true";
  const [allocation, members] = await Promise.all([getAllocation(userId, tenant, { mine }), getOfficerCandidates(userId, tenant)]);

  if (allocation.kind === "forbidden") {
    return <ReadRefusal subject="the Social Media allocation" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />;
  }
  if (allocation.kind === "unavailable") return <ReadRefusal subject="The Social Media allocation" kind="unavailable" reason={allocation.reason} />;

  const officers: OfficerOption[] = members.kind === "ok" ? members.data.map((m) => ({ id: m.user_id, name: m.name })) : [];
  const month = todayIsoInDisplayZone().slice(0, 7);
  return (
    <Card title={mine ? "Allocation: my clients" : "Allocation"}>
      <p className="scp-lede" style={{ margin: "0 0 12px" }}>
        Who looks after each client, how many posts a month it gets, where its designs come from, and when its report is due. The Social Media head, the GM, the
        owner and the superadmin can change it; everyone else reads it.
      </p>
      {members.kind !== "ok" && (
        <p className="scp-note" role="status">
          The company&rsquo;s member list could not be read, so the officer box lists only the current officers.
        </p>
      )}
      <AllocationTable rows={allocation.data} officers={officers} canEditBrandBook={can(me, "social.scope.write", tenant)} month={month} />
    </Card>
  );
}

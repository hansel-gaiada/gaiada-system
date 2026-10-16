import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { unitPathOf } from "@/lib/rbac";
import { readOrgRoot } from "@/lib/campaigns-data";
import { listNotices } from "@/lib/notices-data";
import { mayPostNotice, noticesPastHref, noticesUnitHref, parseNoticeState } from "@/lib/notices";
import { Card } from "@/components/ui";
import { NoticeBoard } from "@/components/notices/NoticeBoard";
import { PostNotice } from "@/components/notices/NoticeForm";
import "@/components/notices/notices.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ state?: string | string[]; cursor?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// DW-10a-2 (BFF §57.8): a unit's notice board. Current notices first, pinned on top with a "Pinned" marker; the unit's own, those posted to a
// unit above it ("From <unit>") and the company-wide ones, as `GET /notices?unitNodeId=` answers them. Past notices are `?state=past`. A head
// (or a company admin) is offered "Post a notice" and, on each notice the server says they may change (`canEdit`), Edit and Withdraw. All of it
// is a mirror: the server narrows every read and decides every write.
//
// Honest by construction: a refused or failed read is said as such in the list's place (`NoticeBoard`), never "No current notices".
export default async function DepartmentNoticesPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const sp = await searchParams;
  const state = parseNoticeState(first(sp.state));
  const cursor = first(sp.cursor) || null;

  const [result, root] = await Promise.all([
    listNotices(userId, tenant, { unitNodeId: deptId }, { state, cursor }),
    readOrgRoot(me, tenant),
  ]);

  // A head's grant is unit-scoped, so company-wide `can()` never counts it: ask over the unit's path in the org tree (when the tree cannot
  // be read only a company-wide holder passes). The form is for the current view and for a person whose read was not refused.
  const canPost = state === "current" && result.kind !== "forbidden" && mayPostNotice(me, tenant, root ? unitPathOf(root, deptId) : []);
  const base = noticesUnitHref(deptId);
  const nextHref = result.kind === "ok" && result.data.nextCursor
    ? `${base}?${new URLSearchParams({ ...(state === "past" ? { state } : {}), cursor: result.data.nextCursor }).toString()}`
    : null;

  return (
    <Card
      title={state === "past" ? "Past notices" : "Notices"}
      hint="What this unit's head and the company want its people to know. Notices posted to a unit above this one, and company-wide notices, are shown here too."
      headerRight={
        <span className="nt-head__links">
          {state === "past"
            ? <Link href={base} className="nt-link">Current notices</Link>
            : <Link href={noticesPastHref(base)} className="nt-link">Past notices</Link>}
        </span>
      }
    >
      {canPost && <PostNotice tenantId={tenant} target={{ scope: "unit", unitNodeId: deptId }} />}
      <NoticeBoard result={result} tenantId={tenant} here={deptId} state={state} nextHref={nextHref} />
    </Card>
  );
}

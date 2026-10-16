import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listNotices } from "@/lib/notices-data";
import { NOTICES_COMPANY_HREF, mayPostNotice, noticesPastHref, parseNoticeState } from "@/lib/notices";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { NoticeBoard } from "@/components/notices/NoticeBoard";
import { PostNotice } from "@/components/notices/NoticeForm";
import "@/components/notices/notices.css";

type SearchParams = Promise<{ state?: string | string[]; cursor?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// DW-10a-2 (BFF §57.8): the company-wide notice board, `GET /notices?scope=company`. Every person with `read` in the company may read it; only a
// company admin posts here (a head posting company-wide is a 403), so the form is offered to `can(me, "notices.post", company)` alone and its scope
// is fixed to the whole company. Same honest states as a unit's board: a refusal or a failed read is never "No current notices".
export default async function CompanyNoticesPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();
  const sp = await searchParams;
  const state = parseNoticeState(first(sp.state));
  const cursor = first(sp.cursor) || null;

  const result = await listNotices(userId, tenant, { scope: "company" }, { state, cursor });
  const canPost = state === "current" && result.kind !== "forbidden" && mayPostNotice(me, tenant, null);
  const nextHref = result.kind === "ok" && result.data.nextCursor
    ? `${NOTICES_COMPANY_HREF}?${new URLSearchParams({ ...(state === "past" ? { state } : {}), cursor: result.data.nextCursor }).toString()}`
    : null;

  return (
    <>
      <PageHeader eyebrow="Company" title={state === "past" ? "Past company notices" : "Company notices"} />
      <Card
        title="Whole company"
        hint="Notices for everyone in the company. A department's own notices are on its Notices tab."
        headerRight={
          <span className="nt-head__links">
            {state === "past"
              ? <Link href={NOTICES_COMPANY_HREF} className="nt-link">Current notices</Link>
              : <Link href={noticesPastHref(NOTICES_COMPANY_HREF)} className="nt-link">Past notices</Link>}
          </span>
        }
      >
        {canPost && <PostNotice tenantId={tenant} target={{ scope: "company" }} />}
        <NoticeBoard result={result} tenantId={tenant} here={null} state={state} nextHref={nextHref} />
      </Card>
    </>
  );
}

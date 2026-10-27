import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getAllocation } from "@/lib/socialAllocation-data";
import { cycleCountsText } from "@/lib/socialAllocation";
import { clientHref } from "@/lib/socialClient";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import "@/components/social/cycles.css";
import "@/components/social/allocation.css";
import "@/components/social/client.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ scope?: string | string[]; create?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// SCP-1k (BFF §63.4 `GET allocation?mine=`, §63.17; plan §6.2 Profile): the client switcher, the first tab of the Profile row. It lists the clients the
// caller looks after (`mine=1`: the clients whose officer they are) and links each to its client page. One of the four Social approvers (the server's
// `canPlan`, on every row) sees every client, because they act on all of them; anyone else can open every client from "All clients" (the list is readable
// by the whole team). A person with no clients gets a sentence, not a blank page: an empty list is a claim, so it is only said when the read succeeded.
// `?create=post|extra` is the Create menu's way in: it asks for a client and sends the person to that client's New post form.
export default async function SocialProfileSwitcherPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // The client page belongs to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const sp = await searchParams;
  const wantAll = first(sp.scope) === "all";
  const create = first(sp.create);
  const creating = create === "post" || create === "extra" ? create : null;

  const [mine, all] = await Promise.all([getAllocation(userId, tenant, { mine: true }), getAllocation(userId, tenant)]);
  // The whole list decides who is an approver (`canPlan` is the caller's, the same on every row) and is the list an approver sees.
  if (all.kind === "forbidden") {
    return <ReadRefusal subject="the Social Media clients" kind="forbidden" detail="Reading them needs a Social Media read tier (the social_staff role, or a manager)." />;
  }
  if (all.kind === "unavailable") return <ReadRefusal subject="The Social Media clients" kind="unavailable" reason={all.reason} />;
  const approver = all.data.some((r) => r.canPlan);
  if (!approver && !wantAll) {
    if (mine.kind === "forbidden") return <ReadRefusal subject="your Social Media clients" kind="forbidden" />;
    if (mine.kind === "unavailable") return <ReadRefusal subject="Your Social Media clients" kind="unavailable" reason={mine.reason} />;
  }
  const rows = approver || wantAll ? all.data : mine.kind === "ok" ? mine.data : [];
  const base = `/departments/${encodeURIComponent(deptId)}/profile`;
  const heading = creating
    ? creating === "extra" ? "Choose a client for the extra post" : "Choose a client for the new post"
    : approver ? "Profile: every client" : wantAll ? "Profile: all clients" : "Profile: your clients";

  return (
    <Card title={heading}>
      <p className="scp-lede">
        {approver
          ? "As the Social Media head, the GM, the owner or the superadmin you see every client."
          : wantAll ? "Every client of the department. Anyone on the team can read them." : "The clients you look after as their officer."}{" "}
        Each client page holds the plan, the stories, the calendar, the list and the brand book.
      </p>
      {rows.length === 0 ? (
        <p className="scp-note">
          You are not the officer of any client yet.{" "}
          <Link href={`${base}?scope=all${creating ? `&create=${creating}` : ""}`}>Show all clients</Link>, or ask a Social Media head to put you on one in{" "}
          <Link href={`/departments/${encodeURIComponent(deptId)}/allocation`}>Allocation</Link>.
        </p>
      ) : (
        <ul className="scp-switch" aria-label="Clients">
          {rows.map((r) => {
            const counts = cycleCountsText(r);
            return (
              <li key={r.engagementId}>
                <Link href={clientHref(deptId, r.engagementId, "plan", creating ? { new: creating } : {})} className="scp-switch__card">
                  <h3 className="scp-switch__name">{r.clientName}</h3>
                  <span className="scp-chead__meta">{r.officer ? `Officer: ${r.officer.name}` : "No officer yet"}</span>
                  <span className="scp-chead__meta">
                    {counts ? `${counts.main} posts this month${counts.beside ? ` · ${counts.beside}` : ""}` : "No cycle this month"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {!approver && !wantAll && rows.length > 0 && (
        <p className="scp-note"><Link href={`${base}?scope=all${creating ? `&create=${creating}` : ""}`}>Show all clients</Link></p>
      )}
    </Card>
  );
}

import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listMembers } from "@/lib/entities";
import {
  hrScopeCompanies, resolveHrScopeParam, fanOutHr, listLeave, listLeaveBalances, rawListLeave,
} from "@/lib/hr";
import { fileLeave, cancelLeave, decideHrLeave } from "@/lib/hrActions";
import { Card, HairlineTable, Eyebrow, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { HrCompanyScope, HrEnvelopeBanner } from "@/components/hr/HrCompanyScope";
import { LeaveForm } from "@/components/hr/LeaveForm";
import { LeaveQueue } from "@/components/hr/LeaveQueue";
import { CancelLeaveButton } from "@/components/hr/CancelLeaveButton";
import { formatDate } from "@/lib/format";

type SearchParams = Promise<{ company?: string }>;

function days(minutes: number): string {
  return `${Math.round((minutes / 480) * 10) / 10}d`;
}

// HR › Leave — self-service filing/balances/history for everyone, plus (only
// for hr_staff/hr_manager/company_admin/elevated) a decision queue that fans
// out across every HR company the viewer serves. WSD-5.
export default async function HrLeavePage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <Card><EmptyNote>Select a company from the top bar.</EmptyNote></Card>;

  const { company } = await searchParams;
  const scopeCompanies = hrScopeCompanies(me, tenant);
  const scope = resolveHrScopeParam(company, scopeCompanies);

  const [myLeave, myBalances] = await Promise.all([
    listLeave(userId, tenant, { subjectUserId: userId }),
    listLeaveBalances(userId, tenant, { subjectUserId: userId, year: new Date().getFullYear() }),
  ]);

  const targets = scope === "all" ? scopeCompanies : scopeCompanies.filter((c) => c.id === scope);
  const teamEnvelope = scopeCompanies.length > 0
    ? await fanOutHr(targets, (companyId) => rawListLeave(userId, companyId, { status: "pending" }))
    : null;

  const canDecideAny = scopeCompanies.some((c) => can(me, "approvals.decide", c.id) || can(me, "hr.manage", c.id));
  const canFileForOthers = scopeCompanies.some((c) => can(me, "hr.manage", c.id));
  const subjectOptions = canFileForOthers
    ? (await listMembers(userId, tenant).catch(() => [])).map((m) => ({ value: m.user_id, label: m.name }))
    : undefined;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 6, display: "block" }}>Leave</Eyebrow>
          <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--erp-ink-60)", maxWidth: 560 }}>
            File your own leave, track balances, and — if you hold HR staff/manager access — review what&apos;s waiting on you.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {scopeCompanies.length > 0 && <HrCompanyScope companies={scopeCompanies} value={scope} />}
          <LeaveForm file={fileLeave} companyId={tenant} subjectOptions={subjectOptions} />
        </div>
      </div>

      {teamEnvelope && <HrEnvelopeBanner companies={teamEnvelope.companies} />}

      {scopeCompanies.length > 0 && (
        <Card title="Awaiting decision" headerRight={<span className="dash-pending-chip">{teamEnvelope!.items.length} PENDING</span>} style={{ marginBottom: 20 }}>
          {canDecideAny ? (
            <LeaveQueue items={teamEnvelope!.items} decide={decideHrLeave} showCompany={scope === "all"} />
          ) : teamEnvelope!.items.length === 0 ? (
            <EmptyNote>Nothing pending right now.</EmptyNote>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {teamEnvelope!.items.map((r) => (
                <li key={r.id} style={{ padding: "10px 0", borderTop: "0.5px solid var(--erp-hairline)", font: "400 14px var(--font-body)" }}>
                  {r.subjectName ?? r.subjectUserId} · {r.leaveType} · {formatDate(r.startsOn)}–{formatDate(r.endsOn)}
                  {scope === "all" ? ` · ${r.tenantName}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Your balances" style={{ marginBottom: 20 }}>
        {myBalances.length === 0 ? (
          <EmptyNote>No balances recorded yet for this year.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Type" }, { label: "Allocated", align: "right" }, { label: "Used", align: "right" }, { label: "Remaining", align: "right" }]}
            rows={myBalances.map((b) => [b.leaveType, days(b.allocatedMinutes), days(b.usedMinutes), days(b.allocatedMinutes - b.usedMinutes)])}
            tcols="1fr 1fr 1fr 1fr"
          />
        )}
      </Card>

      <Card title="Your requests">
        {myLeave.length === 0 ? (
          <EmptyNote>No leave requests filed yet.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Type" }, { label: "Dates" }, { label: "Days", align: "right" }, { label: "Status" }, { label: "" }]}
            rows={myLeave.map((r) => [
              r.leaveType,
              `${formatDate(r.startsOn)} – ${formatDate(r.endsOn)}`,
              days(r.minutes),
              <StatusBadge key="s" label={r.status} />,
              r.status === "pending" ? <CancelLeaveButton key="c" tenantId={tenant} id={r.id} cancel={cancelLeave} /> : null,
            ])}
            tcols="1fr 1.6fr 0.7fr 0.9fr 0.7fr"
          />
        )}
      </Card>
    </>
  );
}

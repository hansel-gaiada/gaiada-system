import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listMembers } from "@/lib/entities";
import { hrScopeCompanies, resolveHrScopeParam, fanOutHr, listAttendance, rawListAttendance } from "@/lib/hr";
import { upsertAttendance } from "@/lib/hrActions";
import { Card, HairlineTable, Eyebrow, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { HrCompanyScope, HrEnvelopeBanner } from "@/components/hr/HrCompanyScope";
import { AttendanceForm } from "@/components/hr/AttendanceForm";
import { formatDate } from "@/lib/format";

type SearchParams = Promise<{ company?: string }>;

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// HR › Attendance — self-service daily log for everyone, plus (hr_staff/
// hr_manager/company_admin/elevated) a recent team log fanned out across
// every HR company the viewer serves. WSD-5.
export default async function HrAttendancePage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const { company } = await searchParams;
  const scopeCompanies = hrScopeCompanies(me, tenant);
  const scope = resolveHrScopeParam(company, scopeCompanies);
  const from = isoDaysAgo(13);
  const to = isoDaysAgo(0);

  const myRecent = await listAttendance(userId, tenant, { subjectUserId: userId, from, to });

  const targets = scope === "all" ? scopeCompanies : scopeCompanies.filter((c) => c.id === scope);
  const teamEnvelope = scopeCompanies.length > 0
    ? await fanOutHr(targets, (companyId) => rawListAttendance(userId, companyId, { from, to }))
    : null;

  const canLogForOthers = scopeCompanies.some((c) => can(me, "hr.manage", c.id) || can(me, "hr.view", c.id));
  const subjectOptions = canLogForOthers
    ? (await listMembers(userId, tenant).catch(() => [])).map((m) => ({ value: m.user_id, label: m.name }))
    : undefined;

  const teamRows = (teamEnvelope?.items ?? []).slice().sort((a, b) => b.day.localeCompare(a.day));

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 6, display: "block" }}>Attendance</Eyebrow>
          <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--erp-ink-60)", maxWidth: 560 }}>
            One row per person per day. Approved leave is stamped automatically once decided.
          </p>
        </div>
        {scopeCompanies.length > 0 && <HrCompanyScope companies={scopeCompanies} value={scope} />}
      </div>

      <AttendanceForm upsert={upsertAttendance} companyId={tenant} subjectOptions={subjectOptions} />

      {teamEnvelope && <HrEnvelopeBanner companies={teamEnvelope.companies} />}

      {scopeCompanies.length > 0 && (
        <Card title="Team log — last 14 days" style={{ marginBottom: 20 }}>
          {teamRows.length === 0 ? (
            <EmptyNote>No attendance logged for this window yet.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Day" }, { label: "Person" }, { label: "Status" }, { label: "Note" }, ...(scope === "all" ? [{ label: "Company" }] : [])]}
              rows={teamRows.map((r) => [
                formatDate(r.day),
                r.subjectName ?? r.subjectUserId,
                <StatusBadge key="s" label={r.status} />,
                r.note ?? "—",
                ...(scope === "all" ? [r.tenantName] : []),
              ])}
              tcols={scope === "all" ? "0.8fr 1.2fr 0.8fr 1.4fr 1fr" : "0.8fr 1.2fr 0.8fr 1.6fr"}
            />
          )}
        </Card>
      )}

      <Card title="Your last 14 days">
        {myRecent.length === 0 ? (
          <EmptyNote>Nothing logged yet — use the form above.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Day" }, { label: "Status" }, { label: "Note" }]}
            rows={myRecent.slice().sort((a, b) => b.day.localeCompare(a.day)).map((r) => [
              formatDate(r.day),
              <StatusBadge key="s" label={r.status} />,
              r.note ?? "—",
            ])}
            tcols="1fr 1fr 2fr"
          />
        )}
      </Card>
    </>
  );
}

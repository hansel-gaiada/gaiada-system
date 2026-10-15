import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import {
  minutesToDays, formatMoney, isoDay, type Holiday, type HolidayCalendar, type LeavePolicy, type LeavePolicyAssignment, type PayGrade,
  type WorkingDayBreakdown,
} from "@/lib/hr-full";
import type { Employee } from "@/lib/iam";
import {
  listCalendarsResult, listHolidaysResult, getWorkingDaysResult, listLeavePoliciesResult, listPolicyAssignmentsResult,
  listPayGradesResult, listParameterSetsResult, listPipelineStagesResult, listEmployeesResult,
} from "@/lib/hr-full-data";
import type { ReadResult } from "@/lib/readResult";
import { PICKABLE_EMPLOYEE_STATUSES, WEEKDAYS, label } from "@/lib/hrPolicy";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import {
  CalendarForm, HolidayForm, DeleteHolidayButton, LeavePolicyForm, LeavePolicyEditForm, AssignmentForm, PayGradeForm, ParameterSetForm,
} from "@/components/hr/PolicyForms";
import {
  createCalendar, addHoliday, deleteHoliday, createLeavePolicy, updateLeavePolicy, assignLeavePolicy, createPayGrade,
  createParameterSet,
} from "@/lib/hrPolicyActions";

type One = string | string[] | undefined;
type SearchParams = Promise<{ tab?: One; calendar?: One; policy?: One; from?: One; to?: One }>;
const first = (v: One): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;

// HR › Settings — the company's own HR RULES (HR-FULL wave A/D; the write screens are DW-7f-5).
//
// Holiday calendars, leave policies, pay grades, the recruitment funnel, and the statutory parameter sets. These
// authorize as `hr_policy`, the one HR kind whose READ is deliberately wide: there is no person on the other side of a
// holiday calendar, and hiding the leave policy from the people it governs is a support ticket, not a security posture.
// WRITE is the HR manager tier (hr.policy.manage); RATIFY is narrower still (hr.policy.ratify, company administrator at
// high assurance) and lives on the parameter set's own page, beside the numbers being signed off.
//
// Layout: the page is long, so it is split into tabs, each a link (`?tab=`), so a tab only reads what it shows.
//   calendars   — add a calendar; pick one (`?calendar=`) to see, add and delete its holidays; a working-day check.
//   leave       — add a policy; pick one (`?policy=`) to edit it and to list and add its assignments.
//   grades      — list and add pay grades (there is no edit on the server).
//   statutory   — list and add parameter sets; each links to its page for the numbers and Ratify.
//   funnel      — the recruitment stages, read-only here (they are edited on the recruitment page).
// Every list is an honest read (ReadResult): a refused or failed read is said in words, never an empty table, and a
// KPI whose read failed shows a dash. Controls follow the capability mirror; the server still decides.
const TABS = [
  { key: "calendars", label: "Holiday calendars" },
  { key: "leave", label: "Leave policies" },
  { key: "grades", label: "Pay grades" },
  { key: "statutory", label: "Statutory parameters" },
  { key: "funnel", label: "Recruitment funnel" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const dim = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;
const dayName = (d: number) => WEEKDAYS.find((w) => w.value === d)?.label ?? String(d);

function Refused<T>({ read, subject }: { read: Exclude<ReadResult<T>, { kind: "ok" }>; subject: string }) {
  const Subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  return read.kind === "forbidden"
    ? <ReadRefusal inline subject={subject} kind="forbidden" />
    : <ReadRefusal inline subject={Subject} kind="unavailable" reason={read.reason} />;
}

export default async function HrSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const sp = await searchParams;
  const requested = first(sp?.tab);
  const tab: Tab = TABS.some((t) => t.key === requested) ? (requested as Tab) : "calendars";
  const calendarParam = first(sp?.calendar);
  const policyParam = first(sp?.policy);
  const wdFrom = first(sp?.from);
  const wdTo = first(sp?.to);
  const canManage = can(me, "hr.policy.manage", tenant);

  // The KPI tiles read these four whatever the tab; the rest are read only by the tab that shows them.
  const [calendarsRead, policiesRead, stagesRead, setsRead] = await Promise.all([
    listCalendarsResult(userId, tenant),
    listLeavePoliciesResult(userId, tenant),
    listPipelineStagesResult(userId, tenant),
    listParameterSetsResult(userId, tenant),
  ]);
  const calendars = calendarsRead.kind === "ok" ? calendarsRead.data : [];
  const policies = policiesRead.kind === "ok" ? policiesRead.data : [];
  const stages = stagesRead.kind === "ok" ? stagesRead.data : [];
  const sets = setsRead.kind === "ok" ? setsRead.data : [];

  const today = new Date().toISOString().slice(0, 10);
  const inForce = sets.find((s) => isoDay(s.effectiveFrom) <= today && (!s.effectiveTo || isoDay(s.effectiveTo) >= today));
  const defaultCalendar = calendars.find((c) => c.isDefault);
  const selectedCalendar = calendarParam ? calendars.find((c) => c.id === calendarParam) : undefined;
  const selectedPolicy = policyParam ? policies.find((p) => p.id === policyParam) : undefined;

  const tabHref = (key: Tab) => `/hr/settings?tab=${key}`;

  // The current tab's own reads. The tab components below are plain (not async) so they can be rendered and tested.
  const [holidaysRead, workingRead, assignmentsRead, employeesRead, gradesRead] = await Promise.all([
    tab === "calendars" && selectedCalendar ? listHolidaysResult(userId, tenant, selectedCalendar.id) : null,
    tab === "calendars" && wdFrom && wdTo ? getWorkingDaysResult(userId, tenant, wdFrom, wdTo, selectedCalendar?.id ?? defaultCalendar?.id) : null,
    tab === "leave" && selectedPolicy ? listPolicyAssignmentsResult(userId, tenant, selectedPolicy.id) : null,
    tab === "leave" && selectedPolicy ? listEmployeesResult(userId, tenant) : null,
    tab === "grades" ? listPayGradesResult(userId, tenant) : null,
  ]);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile
          label="Holiday calendar"
          value={calendarsRead.kind !== "ok" ? "—" : defaultCalendar ? String(defaultCalendar.holidayCount) : "—"}
          foot={calendarsRead.kind !== "ok" ? "cannot be read" : defaultCalendar ? `${defaultCalendar.name} · default` : "no default set"}
        />
        <KpiTile
          label="Leave policies"
          value={policiesRead.kind === "ok" ? String(policies.filter((p) => p.isActive).length) : "—"}
          foot={policiesRead.kind === "ok" ? "active" : "cannot be read"}
        />
        <KpiTile
          label="Pipeline stages"
          value={stagesRead.kind === "ok" ? String(stages.filter((s) => s.isActive).length) : "—"}
          foot={stagesRead.kind === "ok" ? undefined : "cannot be read"}
        />
        <KpiTile
          label="Statutory set"
          value={setsRead.kind !== "ok" ? "—" : inForce ? (inForce.ratifiedAt ? "Ratified" : "Unratified") : "None"}
          foot={setsRead.kind !== "ok" ? "cannot be read" : inForce?.name ?? "nothing covers today"}
        />
      </div>

      <nav aria-label="Settings sections" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
        {TABS.map((t) => (
          <Link
            key={t.key} href={tabHref(t.key)} aria-current={t.key === tab ? "page" : undefined}
            className={`lux-btn ${t.key === tab ? "lux-btn--solid" : "lux-btn--ghost"} lux-btn--sm`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "calendars" && (
        <CalendarsTab
          tenant={tenant} canManage={canManage} read={calendarsRead} selectedId={calendarParam}
          selected={selectedCalendar} defaultCalendarId={defaultCalendar?.id}
          holidaysRead={holidaysRead} workingRead={workingRead} wdFrom={wdFrom} wdTo={wdTo}
        />
      )}
      {tab === "leave" && (
        <LeaveTab
          tenant={tenant} canManage={canManage} read={policiesRead} selectedId={policyParam} selected={selectedPolicy}
          assignmentsRead={assignmentsRead} employeesRead={employeesRead}
        />
      )}
      {tab === "grades" && gradesRead && <GradesTab tenant={tenant} canManage={canManage} read={gradesRead} />}
      {tab === "statutory" && (
        <Card
          title="Statutory parameters"
          hint="Every regulated payroll number — tax brackets, BPJS rates and caps, severance multipliers — effective-dated and signed off. The payroll runner reads THESE, never a constant in code."
        >
          <div style={{ display: "grid", gap: 12 }}>
            {canManage && <ParameterSetForm tenantId={tenant} action={createParameterSet} />}
            {setsRead.kind !== "ok" ? (
              <Refused read={setsRead} subject="the statutory parameter sets" />
            ) : sets.length === 0 ? (
              <EmptyNote>
                No parameter sets configured. Until one exists the payroll engine falls back to a built-in
                <strong> unratified</strong> fixture, and every run says so — it will still calculate, but
                approving it requires an explicit, permanently-recorded override.
              </EmptyNote>
            ) : (
              <HairlineTable
                columns={[
                  { label: "Set" }, { label: "Country" }, { label: "Effective" }, { label: "Parameters", align: "right" },
                  { label: "Ratified" },
                ]}
                rows={sets.map((s) => [
                  <Link key={s.id} href={`/hr/settings/statutory/${s.id}`} style={{ color: "var(--erp-accent)" }}>
                    {s.name}
                  </Link>,
                  s.countryCode,
                  `${isoDay(s.effectiveFrom)} → ${s.effectiveTo ? isoDay(s.effectiveTo) : "open"}`,
                  String(s.parameterCount),
                  <StatusBadge key={`${s.id}-r`} label={s.ratifiedAt ? "ratified" : "unratified"} />,
                ])}
              />
            )}
            <p style={{ margin: 0, ...dim }}>
              Ratifying a set is a company-administrator act at high assurance, deliberately separate from creating one:
              open a set to see its numbers and, where you hold the right, ratify it.
            </p>
          </div>
        </Card>
      )}
      {tab === "funnel" && (
        <Card title="Recruitment funnel" hint="Stages are DATA, not a schema constant — every company runs the funnel it actually runs.">
          <div style={{ display: "grid", gap: 12 }}>
            {stagesRead.kind !== "ok" ? (
              <Refused read={stagesRead} subject="the recruitment stages" />
            ) : stages.length === 0 ? (
              <EmptyNote>No stages defined. Applications cannot be advanced until at least one exists.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Stage" }, { label: "Terminal" }, { label: "Needs interview" }]}
                rows={stages.map((s) => [
                  `${s.sortOrder}. ${s.label}`,
                  s.isTerminal ? (s.terminalKind ?? "yes") : "—",
                  s.requiresInterview ? "yes" : "—",
                ])}
              />
            )}
            <p style={{ margin: 0, ...dim }}>
              Stages are added and changed on the <Link href="/hr/recruitment" style={{ color: "var(--erp-accent)" }}>recruitment</Link> page.
            </p>
          </div>
        </Card>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════ CALENDARS ═══════════════
function CalendarsTab({ tenant, canManage, read, selectedId, selected, defaultCalendarId, holidaysRead, workingRead, wdFrom, wdTo }: {
  tenant: string; canManage: boolean; read: ReadResult<HolidayCalendar[]>;
  selectedId: string | undefined; selected: { id: string; name: string } | undefined; defaultCalendarId: string | undefined;
  holidaysRead: ReadResult<Holiday[]> | null; workingRead: ReadResult<WorkingDayBreakdown> | null;
  wdFrom?: string; wdTo?: string;
}) {
  const calendars = read.kind === "ok" ? read.data : [];

  return (
    <div style={{ display: "grid", gap: 22 }}>
      <Card
        title="Holiday calendars"
        hint="The working-day definition: the weekend pattern plus the holiday set. Leave charging and payroll proration both read it."
      >
        <div style={{ display: "grid", gap: 12 }}>
          {canManage && <CalendarForm tenantId={tenant} action={createCalendar} />}
          {read.kind !== "ok" ? (
            <Refused read={read} subject="the holiday calendars" />
          ) : calendars.length === 0 ? (
            <EmptyNote>
              No calendar. Without one, leave is charged on a plain Saturday/Sunday weekend and public
              holidays are counted as working days.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Calendar" }, { label: "Country" }, { label: "Weekend" }, { label: "Holidays", align: "right" }, { label: "" }]}
              rows={calendars.map((c) => [
                `${c.name}${c.isDefault ? " · default" : ""}`,
                c.countryCode,
                // ISO day numbers are meaningless to a reader; render the names.
                c.weekendDays.map(dayName).join(", ") || "none",
                String(c.holidayCount),
                <Link key={c.id} href={`/hr/settings?tab=calendars&calendar=${encodeURIComponent(c.id)}`}
                  aria-label={`Holidays of ${c.name}`} style={{ color: "var(--erp-accent)" }}>
                  Holidays
                </Link>,
              ])}
            />
          )}
        </div>
      </Card>

      {selectedId && read.kind === "ok" && !selected && (
        <EmptyNote>That calendar is not in this company&apos;s list. It may have been removed.</EmptyNote>
      )}

      {selected && holidaysRead && (
        <Card title={`Holidays — ${selected.name}`} hint="Joint leave (cuti bersama) is normally deducted from the leave entitlement; the other kinds are not.">
          <div style={{ display: "grid", gap: 12 }}>
            {canManage && <HolidayForm tenantId={tenant} calendarId={selected.id} action={addHoliday} />}
            {holidaysRead.kind !== "ok" ? (
              <Refused read={holidaysRead} subject="this calendar's holidays" />
            ) : holidaysRead.data.length === 0 ? (
              <EmptyNote>This calendar has no holidays yet.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Date" }, { label: "Holiday" }, { label: "Kind" }, { label: "Deducts leave" }, ...(canManage ? [{ label: "" }] : [])]}
                rows={holidaysRead.data.map((h) => [
                  h.day,
                  h.name,
                  label(h.kind),
                  h.kind === "joint_leave" ? (h.deductsEntitlement === false ? "no" : "yes") : "—",
                  ...(canManage
                    ? [<DeleteHolidayButton key={h.id} tenantId={tenant} holidayId={h.id} holidayLabel={`${h.name} on ${h.day}`} action={deleteHoliday} />]
                    : []),
                ])}
              />
            )}
          </div>
        </Card>
      )}

      <Card title="Working-day check" hint="The same count the leave form and payroll use, for a date range against a calendar.">
        <div style={{ display: "grid", gap: 12 }}>
          <form method="get" action="/hr/settings" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <input type="hidden" name="tab" value="calendars" />
            {selected && <input type="hidden" name="calendar" value={selected.id} />}
            <label style={{ display: "grid", gap: 4, font: "600 12px var(--font-body)" }}>
              <span>From</span>
              <input type="date" name="from" required defaultValue={wdFrom} className="lux-field__control" />
            </label>
            <label style={{ display: "grid", gap: 4, font: "600 12px var(--font-body)" }}>
              <span>To</span>
              <input type="date" name="to" required defaultValue={wdTo} className="lux-field__control" />
            </label>
            <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Count working days</button>
          </form>
          <p style={{ margin: 0, ...dim }}>
            Uses {selected ? selected.name : defaultCalendarId ? "the default calendar" : "a plain Saturday and Sunday weekend (no default calendar is set)"}.
          </p>
          {workingRead && (workingRead.kind !== "ok" ? (
            <Refused read={workingRead} subject="the working-day count" />
          ) : (
            <HairlineTable
              columns={[
                { label: "Calendar days", align: "right" }, { label: "Working days", align: "right" }, { label: "Weekend days", align: "right" },
                { label: "Holiday days", align: "right" }, { label: "Joint leave charged", align: "right" }, { label: "Chargeable", align: "right" },
              ]}
              rows={[[
                String(workingRead.data.calendarDays), String(workingRead.data.workingDays), String(workingRead.data.weekendDays),
                String(workingRead.data.holidayDays), String(workingRead.data.jointLeaveChargedDays), String(workingRead.data.chargeableDays),
              ]]}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════ LEAVE POLICIES ══════════
function LeaveTab({ tenant, canManage, read, selectedId, selected, assignmentsRead, employeesRead }: {
  tenant: string; canManage: boolean; read: ReadResult<LeavePolicy[]>;
  selectedId: string | undefined; selected: LeavePolicy | undefined;
  assignmentsRead: ReadResult<LeavePolicyAssignment[]> | null; employeesRead: ReadResult<Employee[]> | null;
}) {
  const policies = read.kind === "ok" ? read.data : [];
  // Assignments are USER-keyed: an employee without a login account cannot be assigned a policy by person.
  const employees = employeesRead?.kind === "ok" ? employeesRead.data : [];
  const people = employees
    .filter((e) => e.userId && PICKABLE_EMPLOYEE_STATUSES.includes(e.employmentStatus))
    .map((e) => ({ value: e.userId as string, label: e.displayName }));
  const nameOf = new Map(employees.filter((e) => e.userId).map((e) => [e.userId as string, e.displayName]));

  return (
    <div style={{ display: "grid", gap: 22 }}>
      <Card
        title="Leave policies"
        hint="The RULE that produces a balance. Without one, an allocation is a number somebody typed and nothing can restate how it was reached."
      >
        <div style={{ display: "grid", gap: 12 }}>
          {canManage && <LeavePolicyForm tenantId={tenant} action={createLeavePolicy} />}
          {read.kind !== "ok" ? (
            <Refused read={read} subject="the leave policies" />
          ) : policies.length === 0 ? (
            <EmptyNote>
              No leave policies. The Indonesian statutory default is 12 working days after 12 months of
              continuous service (UU 13/2003 art. 79) — an <em>upfront</em> policy with a 12-month waiting
              period and an entitlement of {minutesToDays(5760)} days. Nothing here assumes it; it has to be
              configured.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Policy" }, { label: "Type" }, { label: "Accrual" },
                { label: "Entitlement", align: "right" }, { label: "Waiting", align: "right" }, { label: "Carryover", align: "right" },
                { label: "Active" }, { label: "" },
              ]}
              rows={policies.map((p) => [
                p.name,
                p.leaveType,
                p.accrualMethod,
                `${minutesToDays(p.annualEntitlementMinutes)}d`,
                p.waitingPeriodMonths ? `${p.waitingPeriodMonths}mo` : "—",
                p.carryoverMaxMinutes
                  ? `${minutesToDays(p.carryoverMaxMinutes)}d${p.carryoverExpiryMonths ? ` · ${p.carryoverExpiryMonths}mo` : ""}`
                  : "—",
                p.isActive ? "yes" : "no",
                <Link key={p.id} href={`/hr/settings?tab=leave&policy=${encodeURIComponent(p.id)}`}
                  aria-label={`Manage ${p.name}`} style={{ color: "var(--erp-accent)" }}>
                  Manage
                </Link>,
              ])}
            />
          )}
        </div>
      </Card>

      {selectedId && read.kind === "ok" && !selected && (
        <EmptyNote>That policy is not in this company&apos;s list. It may have been removed.</EmptyNote>
      )}

      {selected && (
        <Card title={`${selected.name} — assignments`} hint="Who the policy applies to, and from when. The most specific assignment for a person wins.">
          <div style={{ display: "grid", gap: 12 }}>
            {canManage && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <LeavePolicyEditForm tenantId={tenant} policyId={selected.id} action={updateLeavePolicy} initial={selected} />
                {employeesRead?.kind === "ok" ? (
                  <AssignmentForm tenantId={tenant} policyId={selected.id} people={people} action={assignLeavePolicy} />
                ) : employeesRead ? (
                  <Refused read={employeesRead} subject="the employee list" />
                ) : null}
              </div>
            )}
            {assignmentsRead && (assignmentsRead.kind !== "ok" ? (
              <Refused read={assignmentsRead} subject="this policy's assignments" />
            ) : assignmentsRead.data.length === 0 ? (
              <EmptyNote>This policy is not assigned to anyone yet.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Applies to" }, { label: "From" }, { label: "Until" }]}
                rows={assignmentsRead.data.map((a) => [
                  a.subjectUserId ? (nameOf.get(a.subjectUserId) ?? "A person (name not shown)")
                    : a.unitNodeId ? `Org unit ${a.unitNodeId}`
                    : "Everyone in the company (default)",
                  isoDay(a.effectiveFrom),
                  a.effectiveTo ? isoDay(a.effectiveTo) : "open",
                ])}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════ PAY GRADES ══════════════
function GradesTab({ tenant, canManage, read }: { tenant: string; canManage: boolean; read: ReadResult<PayGrade[]> }) {
  const grades = read.kind === "ok" ? read.data : [];
  return (
    <Card title="Pay grades" hint="Optional. Where grades exist, an offer or a raise outside the band is refused.">
      <div style={{ display: "grid", gap: 12 }}>
        {canManage && <PayGradeForm tenantId={tenant} action={createPayGrade} defaultCurrency={grades[0]?.currency ?? "IDR"} />}
        {read.kind !== "ok" ? (
          <Refused read={read} subject="the pay grades" />
        ) : grades.length === 0 ? (
          <EmptyNote>No grade structure defined — compensation is set freehand.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Grade" }, { label: "Track" }, { label: "Band", align: "right" }, { label: "Per" }, { label: "Active" }]}
            rows={grades.map((g) => [
              `${g.code} · ${g.name}`,
              `${g.track} L${g.level}`,
              `${formatMoney(g.minAmount, g.currency)} – ${formatMoney(g.maxAmount, g.currency)}${g.midAmount ? ` (mid ${formatMoney(g.midAmount, g.currency)})` : ""}`,
              label(g.rateBasis),
              g.isActive ? "yes" : "no",
            ])}
          />
        )}
      </div>
    </Card>
  );
}

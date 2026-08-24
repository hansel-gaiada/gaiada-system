import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import {
  listCalendars, listLeavePolicies, listPipelineStages, listParameterSets, minutesToDays,
} from "@/lib/hr-full";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// HR › Settings — the company's own HR RULES (HR-FULL wave A/D).
//
// Holiday calendars, leave policies, the recruitment funnel, and the statutory parameter sets. These
// authorize as `hr_policy`, the one HR kind whose READ is deliberately wide: there is no person on
// the other side of a holiday calendar, and hiding the leave policy from the people it governs is a
// support ticket, not a security posture. WRITE is the HR manager tier; RATIFY is narrower still.
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function HrSettingsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const [calendars, policies, stages, parameterSets] = await Promise.all([
    listCalendars(userId, tenant),
    listLeavePolicies(userId, tenant),
    listPipelineStages(userId, tenant),
    listParameterSets(userId, tenant),
  ]);

  const canRatify = can(me, "hr.policy.ratify", tenant);
  const today = new Date().toISOString().slice(0, 10);
  const inForce = parameterSets.find((s) => s.effectiveFrom <= today && (!s.effectiveTo || s.effectiveTo >= today));
  const defaultCalendar = calendars.find((c) => c.isDefault);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile
          label="Holiday calendar"
          value={defaultCalendar ? String(defaultCalendar.holidayCount) : "—"}
          foot={defaultCalendar ? `${defaultCalendar.name} · default` : "no default set"}
        />
        <KpiTile label="Leave policies" value={String(policies.filter((p) => p.isActive).length)} foot="active" />
        <KpiTile label="Pipeline stages" value={String(stages.filter((s) => s.isActive).length)} />
        <KpiTile
          label="Statutory set"
          value={inForce ? (inForce.ratifiedAt ? "Ratified" : "Unratified") : "None"}
          foot={inForce?.name ?? "nothing covers today"}
        />
      </div>

      <Card
        title="Statutory parameters"
        hint="Every regulated payroll number — tax brackets, BPJS rates and caps, severance multipliers — effective-dated and signed off. The payroll runner reads THESE, never a constant in code."
        style={{ marginBottom: 22 }}
      >
        {parameterSets.length === 0 ? (
          <EmptyNote>
            No parameter sets configured. Until one exists the payroll engine falls back to a built-in
            <strong> unratified</strong> fixture, and every run says so — it will still calculate, but
            approving it requires an explicit, permanently-recorded override.
          </EmptyNote>
        ) : (
          <>
            <HairlineTable
              columns={[
                { label: "Set" }, { label: "Effective" }, { label: "Parameters", align: "right" },
                { label: "Ratified" },
              ]}
              rows={parameterSets.map((s) => [
                <Link key={s.id} href={`/hr/settings/statutory/${s.id}`} style={{ color: "var(--erp-accent)" }}>
                  {s.name}
                </Link>,
                `${s.effectiveFrom} → ${s.effectiveTo ?? "open"}`,
                String(s.parameterCount),
                <StatusBadge key={`${s.id}-r`} label={s.ratifiedAt ? "ratified" : "unratified"} />,
              ])}
            />
            {!canRatify && inForce && !inForce.ratifiedAt && (
              <p style={{ margin: "12px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
                Ratifying a set is a company-administrator act at high assurance, deliberately separate from
                editing one — the routine change that fixes a typo must not also be able to declare the tax
                tables legally correct.
              </p>
            )}
          </>
        )}
      </Card>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 22 }}>
        <Card
          title="Holiday calendars"
          hint="The working-day definition: the weekend pattern plus the holiday set. Leave charging and payroll proration both read it."
        >
          {calendars.length === 0 ? (
            <EmptyNote>
              No calendar. Without one, leave is charged on a plain Saturday/Sunday weekend and public
              holidays are counted as working days.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Calendar" }, { label: "Weekend" }, { label: "Holidays", align: "right" }]}
              rows={calendars.map((c) => [
                `${c.name}${c.isDefault ? " · default" : ""}`,
                // ISO day numbers are meaningless to a reader; render the names.
                c.weekendDays.map((d) => DAY_NAMES[d] ?? String(d)).join(", "),
                String(c.holidayCount),
              ])}
            />
          )}
        </Card>

        <Card
          title="Recruitment funnel"
          hint="Stages are DATA, not a schema constant — every company runs the funnel it actually runs."
        >
          {stages.length === 0 ? (
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
        </Card>
      </div>

      <Card
        title="Leave policies"
        hint="The RULE that produces a balance. Without one, an allocation is a number somebody typed and nothing can restate how it was reached."
      >
        {policies.length === 0 ? (
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
            ])}
          />
        )}
      </Card>
    </>
  );
}

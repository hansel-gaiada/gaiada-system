import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { listLeave, listLeaveBalances, LEAVE_TYPES, type HrLeaveRequest } from "@/lib/hr";
import { cancelLeave, fileLeave } from "@/lib/hrActions";
import { LeaveForm } from "@/components/hr/LeaveForm";
import { CancelLeaveButton } from "@/components/hr/CancelLeaveButton";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card, StatusBadge } from "@/components/ui";

// `/me/leave` — the employee's OWN leave (wave A).
//
// Nothing here is new backend surface: the `member` self-service rule in resource_hr_case.yaml
// already allows read/create/cancel on one's own leave, and `fileLeave`/`cancelLeave` already exist
// for /hr/leave. What was missing was a page where an employee could reach it without walking into
// the HR department console — which reads as someone else's tool, and whose other tabs they cannot
// use. Same components, same actions, addressed to the subject instead of the administrator.
//
// The subject filter is pinned to the viewer. Staff who want the whole queue use /hr/leave.

const DAY_MINUTES = 480;

function days(minutes: number): string {
  const d = minutes / DAY_MINUTES;
  return `${d % 1 === 0 ? d : d.toFixed(1)} day${d === 1 ? "" : "s"}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function MyLeavePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // Every /api/:t/modules/hr/* route answers 403/404 while the module is dark, so the form would
  // submit into nothing. Say so instead.
  if (!(await isModuleOnForActiveCompany("hr"))) {
    return <ModuleDisabled module="hr" label="HR" />;
  }

  const [requests, balances] = await Promise.all([
    listLeave(userId, tenant, { subjectUserId: userId }),
    listLeaveBalances(userId, tenant, { subjectUserId: userId }),
  ]);

  const year = new Date().getUTCFullYear();
  const thisYear = balances.filter((b) => b.year === year);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        {/* No subjectOptions: this page is always about the viewer. Filing for someone else is an
            HR action and lives on /hr/leave. */}
        <LeaveForm file={fileLeave} companyId={tenant} />
      </div>

      <section>
        <h2 style={{
          margin: "0 0 12px", font: "700 11px var(--font-body)", letterSpacing: "0.08em",
          textTransform: "uppercase", color: "var(--erp-ink-50)",
        }}>
          Balances {year}
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          {LEAVE_TYPES.map((t) => {
            const b = thisYear.find((x) => x.leaveType === t);
            const allocated = b?.allocatedMinutes ?? 0;
            const used = b?.usedMinutes ?? 0;
            const left = Math.max(0, allocated - used);
            return (
              <Card key={t}>
                <p style={{
                  margin: 0, font: "700 11px var(--font-body)", letterSpacing: "0.08em",
                  textTransform: "uppercase", color: "var(--erp-ink-50)",
                }}>
                  {t}
                </p>
                <p style={{ margin: "8px 0 0", font: "300 22px var(--font-display)", color: "var(--erp-ink)" }}>
                  {allocated === 0 ? "—" : days(left)}
                </p>
                <p style={{ margin: "4px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                  {allocated === 0
                    ? "No allocation set"
                    : `${days(used)} used of ${days(allocated)}`}
                </p>
              </Card>
            );
          })}
        </div>
        <p style={{ margin: "10px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          A balance moves when a request is APPROVED, not when it is filed — so a pending request is
          not yet deducted here.
        </p>
      </section>

      <section>
        <h2 style={{
          margin: "0 0 12px", font: "700 11px var(--font-body)", letterSpacing: "0.08em",
          textTransform: "uppercase", color: "var(--erp-ink-50)",
        }}>
          My requests
        </h2>
        {requests.length === 0 ? (
          <EmptyNote>You have not filed any leave in this company.</EmptyNote>
        ) : (
          <div style={{ border: "0.5px solid var(--erp-hairline)" }}>
            {requests.map((r: HrLeaveRequest, i) => (
              <div
                key={r.id}
                style={{
                  display: "flex", alignItems: "center", gap: 16, padding: "14px 18px",
                  borderTop: i === 0 ? "none" : "0.5px solid var(--erp-hairline)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, font: "500 14px var(--font-body)", color: "var(--erp-ink)" }}>
                    {r.leaveType} — {days(r.minutes)}
                  </p>
                  <p style={{ margin: "4px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                    {when(r.startsOn)}{r.endsOn && r.endsOn !== r.startsOn ? ` → ${when(r.endsOn)}` : ""}
                    {r.note ? ` · ${r.note}` : ""}
                  </p>
                </div>
                <StatusBadge label={r.status} />
                {r.status === "pending" && (
                  <CancelLeaveButton tenantId={tenant} id={r.id} cancel={cancelLeave} label="Withdraw" />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

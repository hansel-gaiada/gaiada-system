import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPendingApprovals, getMyTasks, getActivity, weeklyThroughput } from "@/lib/data";
import { decideApproval } from "./actions";
import { Card, Eyebrow, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { LineChart } from "@/components/LineChart";
import { ApprovalsPanel } from "@/components/dashboard/ApprovalsPanel";

function timeOfDay(): string {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

export default async function MyWork() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenantId = await getActiveTenant(me);
  const firstName = me.name.split(/\s+/)[0];

  const [approvals, tasks, activity] = await Promise.all([
    getPendingApprovals(userId, me.companies),
    tenantId ? getMyTasks(userId, tenantId) : Promise.resolve([]),
    tenantId ? getActivity(userId, tenantId) : Promise.resolve([]),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const dueToday = tasks.filter((t) => t.due_date && t.due_date.slice(0, 10) <= today).length;
  const series = weeklyThroughput(activity);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 26 }}>
        <div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Personal home</Eyebrow>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>
            Good {timeOfDay()}, {firstName}
          </h1>
          <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 560 }}>
            {approvals.length > 0
              ? `You have ${approvals.length} item${approvals.length === 1 ? "" : "s"} awaiting review and ${dueToday} task${dueToday === 1 ? "" : "s"} due today. Here is your brief.`
              : "Nothing is waiting on you right now. Here is your brief."}
          </p>
        </div>
      </div>

      <div className="dash-grid">
        <section className="dash-kpis">
          <KpiTile label="Approvals pending" value={String(approvals.length)} foot="across your companies" deltaUp={approvals.length === 0} />
          <KpiTile label="Tasks due" value={String(dueToday)} foot="today or overdue" />
          <KpiTile label="Assigned to you" value={String(tasks.length)} foot="open tasks" />
          <KpiTile label="Companies" value={String(me.companies.length)} foot="in your scope" />
        </section>

        <Card title="Your throughput" headerRight={<Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Last 8 weeks</Eyebrow>} style={{ gridArea: "chart" }}>
          <LineChart series={series} />
        </Card>

        <Card title="Awaiting you" style={{ gridArea: "tasks" }}
          headerRight={<span className="dash-pending-chip">{approvals.length} PENDING</span>}>
          <ApprovalsPanel items={approvals} decide={decideApproval} />
        </Card>

        <Card title="Assigned to you" style={{ gridArea: "table", padding: "22px 0 8px" }}>
          {tasks.length === 0 ? (
            <div className="dash-empty"><p>No open tasks assigned to you in this company.</p></div>
          ) : (
            <HairlineTable
              tcols="2.2fr 1.2fr 1fr 1fr"
              columns={[{ label: "Task" }, { label: "Project" }, { label: "Due" }, { label: "Status", align: "right" }]}
              rows={tasks.slice(0, 8).map((t) => [
                t.title, t.project_name, t.due_date ? t.due_date.slice(0, 10) : "—",
                <StatusBadge key={t.id} label={t.status ?? "Open"} />,
              ])}
            />
          )}
        </Card>

        <Card title="Activity" style={{ gridArea: "activity" }}>
          {activity.length === 0 ? (
            <div className="dash-empty"><p>Quiet so far — activity appears here as work happens.</p></div>
          ) : activity.slice(0, 6).map((a) => (
            <div key={a.id} className="dash-activity-row">
              <div className="dash-activity-dot"><span /><span /></div>
              <div style={{ minWidth: 0 }}>
                <div style={{ font: "400 13px/1.45 var(--font-body)" }}>
                  <b style={{ fontWeight: 700 }}>{a.actor_name ?? "System"}</b> {a.verb} {a.target_entity_type.replace(/_/g, " ")}
                </div>
                <div style={{ font: "400 11px var(--font-body)", color: "rgba(26,25,22,.5)", marginTop: 3 }}>
                  {new Date(a.occurred_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

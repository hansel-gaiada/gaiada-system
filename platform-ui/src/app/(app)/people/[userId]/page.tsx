import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canViewEmployee, getEmployee } from "@/lib/people";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, KpiTile, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";

type Params = Promise<{ userId: string }>;

const SCOPE_LABEL: Record<string, string> = { global: "Global", company: "Company", team: "Team" };
const OPEN = new Set(["todo", "in_progress", "in progress", "open", "blocked", "review"]);

function when(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function whenTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

function shell(title: string, body: React.ReactNode) {
  return (
    <>
      <PageHeader eyebrow="People" title={title} />
      {body}
    </>
  );
}

export default async function EmployeePage({ params }: { params: Params }) {
  const viewerId = await getSessionUserId();
  if (!viewerId) redirect("/login");
  const me = await getMe(viewerId);
  const { userId } = await params;

  if (!canViewEmployee(me, userId)) {
    return shell(
      "Person",
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
          You can only view your own profile. This page is otherwise limited to owners and administrators.
        </p>
      </Card>,
    );
  }

  const tenant = await getActiveTenant(me);
  if (!tenant) return shell("Person", <EmptyNote>Select a company from the top bar.</EmptyNote>);

  const emp = await getEmployee(viewerId, tenant, userId, me);
  if (!emp) return shell("Person not found", <EmptyNote>No person with that id in this company.</EmptyNote>);

  const { profile, isSelf, tasks, projects, timeEntries, identityLinks, activity } = emp;
  const openTasks = tasks.filter((t) => OPEN.has((t.status ?? "").toLowerCase())).length;
  const totalMinutes = timeEntries.reduce((n, e) => n + (e.minutes ?? 0), 0);

  const identity = [
    { label: "Email", value: profile.email },
    { label: "Title", value: profile.title ?? "—" },
    { label: "Status", value: <StatusBadge label={profile.status} /> },
  ];

  return (
    <>
      <PageHeader
        eyebrow="People"
        title={profile.name}
        subtitle={profile.title ?? profile.email}
        actions={isSelf ? <StatusBadge label="You" /> : undefined}
      />

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="Open tasks" value={String(openTasks)} foot={`${tasks.length} assigned`} />
        <KpiTile label="Projects owned" value={String(projects.length)} />
        <KpiTile label="Hours logged" value={hours(totalMinutes)} foot={`${timeEntries.length} entries`} />
        <KpiTile label="Linked channels" value={String(identityLinks.length)} />
      </div>

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <Card title="Identity">
          <DescriptionList items={identity} />
        </Card>
        <Card title="Roles">
          {profile.roles.length === 0 ? (
            <EmptyNote>No roles assigned — general access only.</EmptyNote>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {profile.roles.map((r, i) => (
                <span key={`${r.role}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "0.5px solid var(--erp-hairline)", padding: "7px 12px" }}>
                  <span style={{ font: "400 13px var(--font-body)", color: "var(--text-primary)" }}>{r.role}</span>
                  <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
                    {SCOPE_LABEL[r.scopeType] ?? r.scopeType}
                  </span>
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title={`Assigned tasks${tasks.length ? ` · ${tasks.length}` : ""}`}>
          {tasks.length === 0 ? (
            <EmptyNote>No tasks assigned.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Task" }, { label: "Project" }, { label: "Status" }, { label: "Due", align: "right" }]}
              rows={tasks.map((t) => [
                <Link key="t" href={`/tasks/${t.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{t.title}</Link>,
                t.project_name,
                <StatusBadge key="s" label={t.status ?? "—"} />,
                when(t.due_date ?? ""),
              ])}
              tcols="1.6fr 1.2fr 0.8fr 0.8fr"
            />
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title={`Projects owned${projects.length ? ` · ${projects.length}` : ""}`}>
          {projects.length === 0 ? (
            <EmptyNote>Doesn&apos;t own any projects.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Project" }, { label: "Status" }, { label: "Due", align: "right" }]}
              rows={projects.map((p) => [
                <Link key="p" href={`/projects/${p.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{p.name}</Link>,
                <StatusBadge key="s" label={p.status} />,
                when(p.due_date ?? ""),
              ])}
              tcols="2fr 1fr 1fr"
            />
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20, display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <Card title="Recent time">
          {timeEntries.length === 0 ? (
            <EmptyNote>No time logged{isSelf ? " yet" : " visible"}.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Date" }, { label: "Hours" }, { label: "Billable", align: "right" }]}
              rows={timeEntries.slice(0, 8).map((e) => [when(e.entry_date), hours(e.minutes), e.billable ? "Yes" : "No"])}
              tcols="1.2fr 0.6fr 0.6fr"
            />
          )}
        </Card>
        <Card title="Linked channels">
          {identityLinks.length === 0 ? (
            <EmptyNote>No WhatsApp / Telegram identities linked.</EmptyNote>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {identityLinks.map((l) => (
                <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <span style={{ font: "400 13px var(--font-body)" }}>
                    <span style={{ textTransform: "capitalize" }}>{l.provider}</span> · {l.external_id}
                  </span>
                  <StatusBadge label={l.verified_at ? "approved" : "pending"} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Recent activity">
          {activity.length === 0 ? (
            <EmptyNote>No recent activity.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Action" }, { label: "Record" }, { label: "When", align: "right" }]}
              rows={activity.map((a) => [
                <StatusBadge key="v" label={a.verb || "—"} />,
                a.target_entity_type ? `${a.target_entity_type}${a.target_entity_id ? ` · ${a.target_entity_id}` : ""}` : "—",
                whenTime(a.occurred_at),
              ])}
              tcols="0.9fr 1.6fr 1fr"
            />
          )}
        </Card>
      </div>
    </>
  );
}

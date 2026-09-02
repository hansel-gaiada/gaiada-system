import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listMaintenance, listMonitors, getSummary, sortForBoard } from "@/lib/monitoring";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { MaintenanceManager } from "@/components/monitoring/MaintenanceManager";

export const metadata = { title: "Maintenance windows" };
export const dynamic = "force-dynamic";

// MON-20 — closes the last piece of the "close the loop" ticket: a way to suppress alerting for a
// planned outage, so a scheduled deploy or WordPress upgrade doesn't page anyone.
export default async function MaintenancePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  const [windows, monitors, summary] = await Promise.all([
    listMaintenance(userId, tenant),
    listMonitors(userId, tenant),
    getSummary(userId, tenant),
  ]);

  // Same sentinel the board page uses: `getSummary` returns null (not a zeroed shape) specifically
  // so an absent backend is distinguishable from a company that simply has no monitors yet. Reused
  // here rather than invented fresh, because `listMaintenance` alone collapses "no windows" and
  // "endpoint not built" into the same empty array — exactly the ambiguity this ticket exists to fix.
  const backendAbsent = summary === null && monitors.length === 0;
  const canCreate = can(me, "monitoring.maintenance.create", tenant);
  const canDelete = can(me, "monitoring.maintenance.delete", tenant);

  return (
    <>
      <p style={{ marginBottom: 12 }}>
        <Link href="/monitoring">← Monitoring</Link>
        {" · "}
        <Link href="/monitoring/channels">Alert channels</Link>
      </p>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Maintenance windows</h1>
      <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 14 }}>
        Schedule a window to suppress alerting — and SLA/uptime math — for a planned outage. Nothing
        pages anyone while a window is active for its scope; that is deliberate, so schedule the end
        time you actually expect rather than a generous guess.
        {!canCreate && !canDelete && " You have read access here; ask a manager or company admin for changes."}
      </p>

      {backendAbsent ? (
        <EmptyNote>
          The monitoring backend is not connected yet, so this cannot tell "no windows scheduled"
          from "could not ask" — treat this as the latter, not an all-clear. See{" "}
          <code>docs/blueprints/monitoring-program.md</code>.
        </EmptyNote>
      ) : (
        <Card
          title="Windows"
          hint="Active suppresses alerting right now. Upcoming and closed are informational only."
        >
          <MaintenanceManager
            tenantId={tenant}
            windows={windows}
            monitors={sortForBoard(monitors).map((m) => ({ id: m.id, name: m.name }))}
            canCreate={canCreate}
            canDelete={canDelete}
          />
        </Card>
      )}
    </>
  );
}

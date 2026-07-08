import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getSystemStatus } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { Card, Button, StatusBadge, HairlineTable } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { EmptyNote } from "@/components/systems/EmptyNote";

interface WorkflowRow {
  name?: string;
  status?: string;
  lastRun?: string;
}

export default async function AutomationSystemPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const status = await getSystemStatus(userId, "automation");
  const detail = status?.detail ?? {};
  const workflows = Array.isArray(detail.workflows) ? (detail.workflows as WorkflowRow[]) : null;
  const n8nUrl = typeof detail.n8nUrl === "string" ? detail.n8nUrl : null;

  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="Automation"
        subtitle="n8n-orchestrated workflows — n8n is the orchestrator, MCP is the only access path; no business logic lives in workflows."
      />

      <StatusCard status={status} />

      <div style={{ marginTop: 20 }}>
        <Card title="Workflows">
          {workflows && workflows.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Name" }, { label: "Status" }, { label: "Last run" }]}
              rows={workflows.map((w) => [
                w.name ?? "—",
                <StatusBadge key="status" label={w.status ?? "unknown"} />,
                w.lastRun ?? "—",
              ])}
            />
          ) : (
            <EmptyNote>Workflow list appears once Automation is connected.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="n8n">
          {n8nUrl ? (
            <a href={n8nUrl} target="_blank" rel="noreferrer" className="lux-btn lux-btn--solid lux-btn--sm">
              Open n8n
            </a>
          ) : (
            <>
              <Button disabled>Open n8n</Button>
              <p style={{ margin: "10px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
                n8n URL appears once Automation is connected.
              </p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { listWorkflows, getWorkflow, layoutGraph } from "@/lib/it";
import { getSystemStatus } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { Card, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { WorkflowCanvas } from "@/components/it/WorkflowCanvas";
import "@/components/it/it.css";

type SearchParams = Promise<{ wf?: string }>;

export default async function WorkflowsPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const { wf } = await searchParams;

  const [workflows, status] = await Promise.all([
    listWorkflows(userId),
    getSystemStatus(userId, "automation"),
  ]);
  const n8nUrl = typeof status?.detail?.n8nUrl === "string" ? (status.detail.n8nUrl as string) : null;

  const selectedId = wf && workflows.some((w) => w.id === wf) ? wf : workflows[0]?.id ?? null;
  const workflow = selectedId ? await getWorkflow(userId, selectedId) : null;
  const layout = layoutGraph(workflow);
  const selected = workflows.find((w) => w.id === selectedId) ?? null;

  return (
    <>
      <PageHeader
        eyebrow="IT"
        title="Workflows"
        subtitle="n8n automation workflows — read-only viewer. n8n orchestrates; MCP is the only access path."
        actions={
          n8nUrl ? (
            <a href={n8nUrl} target="_blank" rel="noreferrer" className="lux-btn lux-btn--solid lux-btn--sm">Open in n8n</a>
          ) : undefined
        }
      />

      {workflows.length === 0 ? (
        <Card><EmptyNote>No workflows found. The list appears once Automation is connected.</EmptyNote></Card>
      ) : (
        <div className="it-wf-wrap">
          <Card title="Workflows" style={{ alignSelf: "start" }}>
            <div className="it-wf-list">
              {workflows.map((w) => (
                <Link
                  key={w.id}
                  href={`/it/workflows?wf=${encodeURIComponent(w.id)}`}
                  className={`it-wf-item${w.id === selectedId ? " it-wf-item--active" : ""}`}
                >
                  <span>{w.name}</span>
                  <StatusBadge label={w.active ? "active" : "draft"} />
                </Link>
              ))}
            </div>
          </Card>

          <Card title={selected ? selected.name : "Workflow"}>
            {workflow ? (
              <WorkflowCanvas layout={layout} />
            ) : (
              <EmptyNote>Couldn&apos;t load this workflow&apos;s definition.</EmptyNote>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

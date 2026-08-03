import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getSystemStatus, getSystemConfig, getWorkflowExecutions, getBridgeHealth } from "@/lib/admin";
import { listWorkflows } from "@/lib/it";
import { isElevated } from "@/lib/rbac";
import { listAutomationApprovals } from "@/lib/automationApprovals";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, Button, StatusBadge, HairlineTable, KpiTile } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ActionButton } from "@/components/systems/ActionButton";
import { WorkflowsTable, ExecutionsTable } from "@/components/systems/AutomationLists";
import { SearchableTable } from "@/components/systems/SearchableTable";
import { toggleWorkflow, replayDeadLetters } from "./actions";
import "@/components/systems/systems.css";
import { formatTimestamp } from "@/lib/format";

interface WorkflowRow {
  name?: string;
  status?: string;
  lastRun?: string;
}

// Automation is three things stacked, and the console has to show all three or it lies by omission:
//   1. the WORKFLOWS n8n holds and their run history,
//   2. the EVENT BRIDGE that makes event-triggered workflows fire at all (a stalled bridge silently
//      stops every one of them while the workflow list still reads "active"), and
//   3. the APPROVALS queue where medium+/unclassified automation writes suspend for a human.
export default async function AutomationSystemPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  const [status, config, workflowList, executions, bridge, approvals] = await Promise.all([
    getSystemStatus(userId, "automation"),
    getSystemConfig(userId, "automation"),
    // The ID-bearing list (not the status probe's name-only summary) — an activate/deactivate needs
    // n8n's workflow id, which the probe's shape never carried.
    listWorkflows(userId),
    getWorkflowExecutions(userId, 50),
    getBridgeHealth(userId),
    // Approvals are tenant-scoped (they carry company data); the systems console shows the active
    // company's queue and says so, rather than silently implying it is platform-wide.
    tenant ? listAutomationApprovals(userId, tenant, { status: "pending" }) : Promise.resolve([]),
  ]);

  const detail = status?.detail ?? {};
  // The probe's name-only rows are the fallback for when the ID-bearing list is unavailable (no
  // Public-API key): the table still renders, just without the controls.
  const probeRows = Array.isArray(detail.workflows) ? (detail.workflows as WorkflowRow[]) : null;
  const n8nUrl = typeof detail.n8nUrl === "string" ? detail.n8nUrl : null;
  const elevated = isElevated(me);

  // Newest execution per workflow, so the list can show a real last-run without a second round-trip
  // (executions come back newest-first).
  const lastRun = new Map<string, (typeof executions)[number]>();
  for (const e of executions) if (!lastRun.has(e.workflowId)) lastRun.set(e.workflowId, e);

  const failed = executions.filter((e) => e.status !== "success" && e.status !== "running").length;
  const backlog = (bridge?.streams ?? []).reduce((n, s) => n + s.backlog, 0);
  const deadLetters = (bridge?.streams ?? []).reduce((n, s) => n + s.deadLetter, 0);

  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="Automation"
        subtitle="n8n-orchestrated workflows — n8n is the orchestrator, MCP is the only access path; no business logic lives in workflows."
      />

      <StatusCard status={status} />

      <div style={{ marginTop: 20 }}>
        <Card title="At a glance">
          <div className="sys-status-card__counters" style={{ marginTop: 0 }}>
            <KpiTile label="Workflows" value={String(workflowList.length || probeRows?.length || 0)} />
            <KpiTile label="Recent runs" value={String(executions.length)} foot={`${failed} not successful`} />
            <KpiTile label="Bridge backlog" value={String(backlog)} foot={bridge?.enabled ? undefined : "bridge off"} />
            <KpiTile label="Pending approvals" value={String(approvals.length)} />
          </div>
        </Card>
      </div>

      {/* An operational problem gets a band, not a table cell. */}
      {deadLetters > 0 && (
        <p className="sys-alert-band" style={{ marginTop: 20 }}>
          {deadLetters} event{deadLetters === 1 ? "" : "s"} dead-lettered after {bridge?.maxRetries} delivery attempts —
          the workflows those events trigger did not run. Inspect the streams below.
        </p>
      )}

      <div style={{ marginTop: 20 }}>
        <Card title="Workflows">
          {workflowList.length > 0 ? (
            <WorkflowsTable
              workflows={workflowList}
              lastRunByWorkflowId={lastRun}
              elevated={elevated}
              toggleWorkflow={toggleWorkflow}
            />
          ) : probeRows && probeRows.length > 0 ? (
            <>
              <SearchableTable
                items={probeRows}
                columns={[{ label: "Name" }, { label: "Status" }, { label: "Last run" }]}
                getSearchText={(w) => `${w.name ?? ""} ${w.status ?? ""}`}
                searchLabel="Search workflows"
                searchPlaceholder="Filter by name or status…"
                emptyState={
                  <EmptyNote>
                    Workflow list appears once Automation is connected with an n8n Public-API key.
                  </EmptyNote>
                }
                renderRow={(w) => [
                  w.name ?? "—",
                  <StatusBadge key={`s-${w.name}`} label={w.status ?? "unknown"} />,
                  formatTimestamp(w.lastRun),
                ]}
              />
              <p className="sys-empty-note" style={{ marginTop: 12 }}>
                Activate/deactivate needs the n8n Public-API list, which isn&apos;t available right now.
              </p>
            </>
          ) : (
            <EmptyNote>
              Workflow list appears once Automation is connected with an n8n Public-API key.
            </EmptyNote>
          )}
          <p className="sys-empty-note" style={{ marginTop: 12 }}>
            <Link href="/it/workflows">Open the read-only workflow canvas</Link> to inspect a workflow&apos;s nodes and
            connections.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Recent executions">
          <ExecutionsTable executions={executions} />
        </Card>
      </div>

      {/* The delivery path. Without this, a stalled bridge is indistinguishable from a quiet system. */}
      <div style={{ marginTop: 20 }}>
        <Card
          title="Event bridge"
          headerRight={bridge ? <StatusBadge label={bridge.enabled ? "enabled" : "disabled"} /> : undefined}
        >
          {bridge ? (
            <>
              {bridge.error && <p className="sys-alert-band">{bridge.error}</p>}
              <DescriptionList
                items={[
                  {
                    label: "Bridged event types",
                    value: bridge.events.length > 0 ? bridge.events.join(", ") : "(none — no event can reach n8n)",
                  },
                  {
                    label: "Webhook target",
                    value: <StatusBadge label={bridge.webhookConfigured ? "Configured" : "Absent"} />,
                  },
                  {
                    label: "Shared secret",
                    value: <StatusBadge label={bridge.secretConfigured ? "Configured" : "Absent"} />,
                  },
                  { label: "Dead-letter after", value: `${bridge.maxRetries} delivery attempts` },
                  { label: "Webhook timeout", value: `${bridge.timeoutMs}ms` },
                ]}
              />
              <div style={{ marginTop: 18 }}>
                {bridge.streams.length > 0 ? (
                  <HairlineTable
                    columns={[
                      { label: "Stream" },
                      { label: "Backlog" },
                      { label: "Dead-lettered" },
                      { label: "Oldest pending" },
                      ...(elevated ? [{ label: "" }] : []),
                    ]}
                    rows={bridge.streams.map((s) => [
                      s.entityType,
                      s.error ? "—" : String(s.backlog),
                      s.error ? "—" : String(s.deadLetter),
                      s.error ? s.error : s.oldestPendingMs != null ? formatAge(s.oldestPendingMs) : "—",
                      ...(elevated
                        ? [
                            // Replay is offered only where there is something parked — a button that
                            // can only report "nothing to do" is noise.
                            s.deadLetter > 0 ? (
                              <ActionButton
                                key={`rp-${s.entityType}`}
                                label={`Replay ${s.deadLetter}`}
                                pendingLabel="Requeuing…"
                                variant="solid"
                                action={replayDeadLetters.bind(null, s.entityType)}
                                confirm={`Requeue ${s.deadLetter} dead-lettered ${s.entityType} event${s.deadLetter === 1 ? "" : "s"}? The workflows they trigger will run again.`}
                              />
                            ) : (
                              "—"
                            ),
                          ]
                        : []),
                    ])}
                  />
                ) : (
                  <EmptyNote>No event streams are being watched — the bridge forwards nothing.</EmptyNote>
                )}
              </div>
            </>
          ) : (
            <EmptyNote>Bridge health appears once the platform admin API is reachable.</EmptyNote>
          )}
        </Card>
      </div>

      {/* Where automation stops and a human decides (WS4 §3 / D14). */}
      <div style={{ marginTop: 20 }}>
        <Card title="Suspended writes awaiting approval">
          {!tenant ? (
            <EmptyNote>Select a company to see its automation approvals.</EmptyNote>
          ) : approvals.length > 0 ? (
            <HairlineTable
              columns={[
                { label: "Requested" },
                { label: "Origin" },
                { label: "Workflow / agent" },
                { label: "Tool" },
                { label: "Impact" },
                { label: "Reason" },
              ]}
              rows={approvals.map((a) => [
                formatTimestamp(a.created_at),
                a.origin,
                a.agent_name ?? a.workflow_id,
                a.tool_name,
                <StatusBadge key={`i-${a.id}`} label={a.impact} />,
                a.reason ?? "—",
              ])}
            />
          ) : (
            <EmptyNote>Nothing is suspended — every attempted automation write ran within its impact tier.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Configuration">
          {config.length > 0 ? (
            <DescriptionList
              items={config.map((f) => ({
                label: f.label,
                value:
                  f.kind === "secretPresence" ? (
                    <StatusBadge label={f.value ? "Configured" : "Absent"} />
                  ) : f.kind === "boolean" ? (
                    f.value ? "On" : "Off"
                  ) : (
                    String(f.value ?? "—")
                  ),
              }))}
            />
          ) : (
            <EmptyNote>Configuration appears once the platform admin API is reachable.</EmptyNote>
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
              <p className="sys-empty-note" style={{ marginTop: 10 }}>
                n8n URL appears once Automation is connected.
              </p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

/** Compact age for a pending-entry timestamp: 45s / 12m / 3h. */
function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

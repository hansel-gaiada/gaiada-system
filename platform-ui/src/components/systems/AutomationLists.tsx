"use client";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ui";
import { ActionButton, type ActionState } from "./ActionButton";
import { SearchableTable } from "./SearchableTable";
import { EmptyNote } from "./EmptyNote";
import { formatTimestamp } from "@/lib/format";

// The Automation console's two long, potentially-unbounded lists (workflows, recent executions),
// pulled out of the (server-component) page so they can carry client-side search + pagination
// state. `page.tsx` still does the data fetch and passes the full, already-fetched array down —
// no new request here, only what's rendered from it.

export interface WorkflowListItem {
  id: string;
  name: string;
  active: boolean;
}

export interface WorkflowLastRun {
  status: string;
  startedAt?: string | null;
}

export function WorkflowsTable({
  workflows,
  lastRunByWorkflowId,
  elevated,
  toggleWorkflow,
}: {
  workflows: WorkflowListItem[];
  lastRunByWorkflowId: Map<string, WorkflowLastRun>;
  elevated: boolean;
  toggleWorkflow: (
    workflowId: string,
    activate: boolean,
    prev: ActionState | null,
    formData: FormData,
  ) => Promise<ActionState>;
}) {
  return (
    <SearchableTable
      items={workflows}
      columns={[{ label: "Name" }, { label: "State" }, { label: "Last run" }, ...(elevated ? [{ label: "" }] : [])]}
      getSearchText={(w) => `${w.name} ${w.active ? "active" : "inactive"}`}
      searchLabel="Search workflows"
      searchPlaceholder="Filter by name or state…"
      emptyState={
        <EmptyNote>Workflow list appears once Automation is connected with an n8n Public-API key.</EmptyNote>
      }
      renderRow={(w) => {
        const run = lastRunByWorkflowId.get(w.id);
        const cells: ReactNode[] = [
          w.name,
          <StatusBadge key={`s-${w.id}`} label={w.active ? "active" : "inactive"} />,
          run?.startedAt ? (
            <span key={`r-${w.id}`}>
              {formatTimestamp(run.startedAt)} · {run.status}
            </span>
          ) : (
            "never run"
          ),
        ];
        if (elevated) {
          cells.push(
            <ActionButton
              key={`a-${w.id}`}
              label={w.active ? "Deactivate" : "Activate"}
              pendingLabel={w.active ? "Deactivating…" : "Activating…"}
              variant={w.active ? "ghost" : "solid"}
              action={toggleWorkflow.bind(null, w.id, !w.active)}
              confirm={
                w.active
                  ? `Deactivate "${w.name}"? Events and schedules will stop triggering it until it is activated again.`
                  : undefined
              }
            />,
          );
        }
        return cells;
      }}
    />
  );
}

export interface ExecutionListItem {
  id: string;
  workflowName: string;
  status: string;
  mode?: string | null;
  startedAt?: string | null;
  durationMs?: number | null;
}

export function ExecutionsTable({ executions }: { executions: ExecutionListItem[] }) {
  return (
    <SearchableTable
      items={executions}
      columns={[{ label: "Workflow" }, { label: "Status" }, { label: "Mode" }, { label: "Started" }, { label: "Duration" }]}
      getSearchText={(e) => `${e.workflowName} ${e.status} ${e.mode ?? ""}`}
      searchLabel="Search executions"
      searchPlaceholder="Filter by workflow or status…"
      emptyState={<EmptyNote>Execution history appears once n8n has run a workflow (and an API key is set).</EmptyNote>}
      renderRow={(e) => [
        e.workflowName,
        <StatusBadge key={`e-${e.id}`} label={e.status} />,
        e.mode ?? "—",
        formatTimestamp(e.startedAt),
        e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : "—",
      ]}
    />
  );
}

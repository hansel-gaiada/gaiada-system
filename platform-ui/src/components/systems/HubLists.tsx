"use client";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ui";
import { SearchableTable } from "./SearchableTable";
import { ConnectionState } from "./ConnectionState";
import { EmptyNote } from "./EmptyNote";
import { formatTimestamp } from "@/lib/format";

// The MCP Hub console's long lists (tool registry, decision audit, resource/prompt templates),
// pulled out of the (server-component) hub page so they can carry client-side search +
// pagination state. The page still does the fetch (already source/decision-filtered server-side
// via the existing `?source=`/`?decision=` links) and passes the resulting array down — this
// layer only decides what subset of THAT array is rendered.

export interface HubToolListItem {
  name: string;
  description: string;
  minAssurance: string;
  write?: boolean;
  impact?: "low" | "medium" | "high" | null;
  source?: string;
}

export function HubToolsTable({
  tools,
  emptyState,
}: {
  tools: HubToolListItem[];
  /** Overrides the default "not connected" state — e.g. when `tools` is already server-side
   *  source-filtered down to zero, which is "nothing in this source" rather than "not connected". */
  emptyState?: ReactNode;
}) {
  return (
    <SearchableTable
      items={tools}
      columns={[{ label: "Tool" }, { label: "Description" }, { label: "Source" }, { label: "Min assurance" }, { label: "Kind" }]}
      getSearchText={(t) => `${t.name} ${t.description} ${t.source ?? ""} ${t.minAssurance}`}
      searchLabel="Search tools"
      searchPlaceholder="Filter by name, description or source…"
      emptyState={emptyState ?? <ConnectionState system="MCP Hub tool registry" />}
      renderRow={(tool) => [
        tool.name,
        tool.description,
        tool.source ?? "unknown",
        <StatusBadge key={`a-${tool.name}`} label={tool.minAssurance} />,
        tool.write ? (
          <StatusBadge key={`k-${tool.name}`} label={`write · ${tool.impact ?? "unclassified"}`} />
        ) : (
          <StatusBadge key={`k-${tool.name}`} label="read" />
        ),
      ]}
    />
  );
}

export interface HubAuditListItem {
  ts: number;
  tool: string;
  principal: { provider: string; externalId: string; assurance: string };
  decision: "allow" | "deny";
  ok?: boolean;
  reason?: string;
}

export function HubAuditTable({ audit, hasUnfilteredEntries }: { audit: HubAuditListItem[]; hasUnfilteredEntries: boolean }) {
  return (
    <SearchableTable
      items={audit}
      columns={[{ label: "Time" }, { label: "Tool" }, { label: "Principal" }, { label: "Assurance" }, { label: "Decision" }, { label: "Reason" }]}
      getSearchText={(a) => `${a.tool} ${a.principal?.provider ?? ""} ${a.principal?.externalId ?? ""} ${a.decision} ${a.reason ?? ""}`}
      searchLabel="Search decision audit"
      searchPlaceholder="Filter by tool, principal, decision or reason…"
      emptyState={
        <EmptyNote>{hasUnfilteredEntries ? "No entries match this filter." : "No tool calls have been decided yet."}</EmptyNote>
      }
      renderRow={(row, i) => [
        formatTimestamp(row.ts),
        row.tool,
        // Untrusted identifier from an external surface — rendered as an inert text child.
        `${row.principal?.provider ?? "?"}:${row.principal?.externalId ?? "?"}`,
        <StatusBadge key={`as-${i}`} label={row.principal?.assurance ?? "unknown"} />,
        <StatusBadge key={`d-${i}`} label={row.decision === "allow" ? (row.ok === false ? "allow · failed" : "allow") : "deny"} />,
        row.reason ?? "—",
      ]}
    />
  );
}

export interface HubResourceListItem {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export function HubResourcesTable({ resources }: { resources: HubResourceListItem[] }) {
  return (
    <SearchableTable
      items={resources}
      columns={[{ label: "URI template" }, { label: "Name" }, { label: "Description" }, { label: "Type" }]}
      getSearchText={(r) => `${r.uriTemplate} ${r.name} ${r.description} ${r.mimeType}`}
      searchLabel="Search resources"
      searchPlaceholder="Filter by URI, name or description…"
      emptyState={<EmptyNote>Resource templates appear once the hub admin API is reachable.</EmptyNote>}
      renderRow={(r) => [r.uriTemplate, r.name, r.description, r.mimeType]}
    />
  );
}

export interface HubPromptListItem {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

export function HubPromptsTable({ prompts }: { prompts: HubPromptListItem[] }) {
  return (
    <SearchableTable
      items={prompts}
      columns={[{ label: "Prompt" }, { label: "Description" }, { label: "Arguments" }]}
      getSearchText={(p) => `${p.name} ${p.description}`}
      searchLabel="Search prompts"
      searchPlaceholder="Filter by name or description…"
      emptyState={<EmptyNote>Prompt templates appear once the hub admin API is reachable.</EmptyNote>}
      renderRow={(p) => [p.name, p.description, p.arguments.map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ") || "—"]}
    />
  );
}

"use client";
import { StatusBadge } from "@/components/ui";
import { SearchableTable } from "./SearchableTable";
import { EmptyNote } from "./EmptyNote";
import { formatTimestamp } from "@/lib/format";

// The AI Gateway console's long lists (provider inventory, egress audit, per-tenant spend), pulled
// out of the (server-component) gateway page so they can carry client-side search + pagination
// state. The page still does the fetch (egress audit is already decision/capability-filtered
// server-side via the existing `?decision=`/`?capability=` links) and passes the array down.

export interface GatewayProviderListItem {
  name: string;
  model?: string;
  endpoint?: string;
  keyRequired: boolean;
  keyConfigured: boolean;
  siteExcluded?: boolean;
}

export function GatewayProvidersTable({ providers }: { providers: GatewayProviderListItem[] }) {
  return (
    <SearchableTable
      items={providers}
      columns={[{ label: "Provider" }, { label: "Model" }, { label: "Credential" }, { label: "Note" }]}
      getSearchText={(p) => `${p.name} ${p.model ?? ""}`}
      searchLabel="Search providers"
      searchPlaceholder="Filter by name or model…"
      emptyState={<EmptyNote>Provider inventory appears once the gateway admin API is reachable.</EmptyNote>}
      renderRow={(p) => [
        p.name,
        p.model ?? "—",
        <StatusBadge key={`k-${p.name}`} label={!p.keyRequired ? "Not required" : p.keyConfigured ? "Configured" : "Absent"} />,
        p.siteExcluded ? "Excluded in site topology — forwarded to central" : p.endpoint ? p.endpoint : "—",
      ]}
    />
  );
}

export interface GatewayAuditListItem {
  time?: string;
  capability?: string | null;
  provider?: string;
  decision?: string;
  latencyMs?: number | null;
  redactions?: number;
}

export function GatewayAuditTable({ audit, hasFilter }: { audit: GatewayAuditListItem[]; hasFilter: boolean }) {
  return (
    <SearchableTable
      items={audit}
      columns={[{ label: "Time" }, { label: "Capability" }, { label: "Provider" }, { label: "Decision" }, { label: "Latency" }, { label: "Redactions" }]}
      getSearchText={(a) => `${a.capability ?? ""} ${a.provider ?? ""} ${a.decision ?? ""}`}
      searchLabel="Search egress audit"
      searchPlaceholder="Filter by capability, provider or decision…"
      emptyState={
        <EmptyNote>
          {hasFilter ? "No entries match this filter." : "Egress audit appears once the gateway admin API is connected."}
        </EmptyNote>
      }
      renderRow={(row, i) => [
        formatTimestamp(row.time),
        row.capability ?? "—",
        row.provider ?? "—",
        <StatusBadge key={`decision-${i}`} label={row.decision ?? "unknown"} />,
        row.latencyMs != null ? `${row.latencyMs}ms` : "—",
        row.redactions ? String(row.redactions) : "—",
      ]}
    />
  );
}

export function GatewayTenantSpendTable({
  tenantSpend,
  perTenantCap,
}: {
  tenantSpend: Array<[string, number]>;
  perTenantCap?: number;
}) {
  return (
    <SearchableTable
      items={tenantSpend}
      columns={[{ label: "Tenant" }, { label: "Calls today" }, { label: "Of per-tenant cap" }]}
      getSearchText={([tenant]) => tenant}
      searchLabel="Search tenants"
      searchPlaceholder="Filter by tenant…"
      emptyState={<EmptyNote>No tenant has spent against the cap today.</EmptyNote>}
      renderRow={([tenant, used]) => [
        tenant,
        String(used),
        perTenantCap ? `${Math.round((used / perTenantCap) * 100)}%` : "—",
      ]}
    />
  );
}

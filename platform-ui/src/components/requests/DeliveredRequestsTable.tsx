import { HairlineTable } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { unitText, type RequestRow } from "@/lib/requests";
import "./requests.css";

// DW-5d: Creatives' Delivered, what this department has handed over, newest first, with how many assets each carried.
export function DeliveredRequestsTable({ rows }: { rows: readonly RequestRow[] }) {
  return (
    <HairlineTable
      tcols="2.4fr 1.3fr 1.3fr 1fr 0.8fr"
      columns={[{ label: "Request" }, { label: "For" }, { label: "Requested by" }, { label: "Delivered" }, { label: "Assets" }]}
      rowLinks={rows.map((r) => ({ href: `/requests/${encodeURIComponent(r.id)}`, label: r.title }))}
      rows={rows.map((r) => [
        <span key={`${r.id}-t`} className="req-title">{r.title}</span>,
        unitText(r.fromUnit),
        r.requestedBy.name,
        formatDate(r.closedAt),
        String(r.assetCount),
      ])}
    />
  );
}

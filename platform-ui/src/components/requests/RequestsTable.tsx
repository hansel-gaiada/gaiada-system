import Link from "next/link";
import { HairlineTable, StatusBadge } from "@/components/ui";
import {
  neededByText, requestKindLabel, unitText, workText,
  type RequestRow,
} from "@/lib/requests";
import "./requests.css";

// DW-5c UI — one table for "my requests" and a department's Sent tab. The whole row opens the request. Every value is
// plain text: a title, a name and a brief are user input.
export function RequestsTable({ rows, showRequester }: { rows: readonly RequestRow[]; showRequester: boolean }) {
  const columns = [
    { label: "Request" }, { label: "To" },
    ...(showRequester ? [{ label: "Requested by" }] : []),
    { label: "Needed by" }, { label: "Status" }, { label: "Work" },
  ];
  const tcols = showRequester ? "2.2fr 1.3fr 1.2fr 1fr 1fr 2fr" : "2.4fr 1.4fr 1fr 1fr 2fr";
  return (
    <HairlineTable
      tcols={tcols}
      columns={columns}
      rowLinks={rows.map((r) => ({ href: `/requests/${encodeURIComponent(r.id)}`, label: r.title }))}
      rows={rows.map((r) => [
        <span key={`${r.id}-t`}>
          <span className="req-title">{r.title}</span>
          <span className="req-sub">{requestKindLabel(r.kind)}</span>
        </span>,
        unitText(r.toUnit),
        ...(showRequester ? [r.requestedBy.name] : []),
        neededByText(r.neededBy),
        <StatusBadge key={`${r.id}-s`} label={r.status} />,
        <span key={`${r.id}-w`} className="req-quiet">
          {r.status === "open" || r.status === "delivered" ? workText(r.work) : "—"}
        </span>,
      ])}
    />
  );
}

/** The Open / Closed / All switch. A plain link per state, so it works without script and keeps the URL shareable. */
export function StatusFilterNav({ basePath, current }: { basePath: string; current: "open" | "closed" | "all" }) {
  const items: { key: "open" | "closed" | "all"; label: string }[] = [
    { key: "open", label: "Open" }, { key: "closed", label: "Closed" }, { key: "all", label: "All" },
  ];
  return (
    <nav className="req-filter" aria-label="Show requests">
      {items.map((i) => (
        <Link key={i.key} href={`${basePath}?status=${i.key}`} className="req-filter__item" aria-current={i.key === current ? "true" : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

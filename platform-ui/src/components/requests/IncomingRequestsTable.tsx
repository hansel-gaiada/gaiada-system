import { HairlineTable, StatusBadge } from "@/components/ui";
import {
  ageText, isNeededByOverdue, neededByText, unitText, workText,
  type RequestRow,
} from "@/lib/requests";
import "./requests.css";

// DW-5d: Creatives' Incoming, the asset requests waiting on this department. The whole row opens the request. Every value
// is plain text (a title, a name and a campaign name are user input). A past needed-by date carries the word "Overdue",
// so it never rests on colour alone.
export function IncomingRequestsTable({ rows, now }: { rows: readonly RequestRow[]; now?: Date }) {
  return (
    <HairlineTable
      tcols="2.2fr 1.2fr 1.2fr 1.4fr 1.2fr 2fr 0.7fr"
      columns={[
        { label: "Request" }, { label: "From" }, { label: "Requested by" }, { label: "Needed by" },
        { label: "Campaign" }, { label: "Work" }, { label: "Age" },
      ]}
      rowLinks={rows.map((r) => ({ href: `/requests/${encodeURIComponent(r.id)}`, label: r.title }))}
      rows={rows.map((r) => [
        <span key={`${r.id}-t`} className="req-title">{r.title}</span>,
        unitText(r.fromUnit),
        r.requestedBy.name,
        <span key={`${r.id}-n`}>
          {neededByText(r.neededBy)}
          {isNeededByOverdue(r.neededBy, now) ? <> <StatusBadge label="Overdue" /></> : null}
        </span>,
        r.campaign ? r.campaign.name : "—",
        <span key={`${r.id}-w`} className="req-quiet">{workText(r.work)}</span>,
        ageText(r.createdAt, now),
      ])}
    />
  );
}

import Link from "next/link";
import type { TeamRow } from "@/lib/activityTeam";
import "./activity.css";

export const TEAM_QUIET = "Nothing recorded in this period";
export const TEAM_UNAVAILABLE = "Unavailable";

/** The link to one person's own view: the server decides whether the caller may read it. */
export const personActivityHref = (userId: string, unit: string): string =>
  `/analytics/activity?${new URLSearchParams({ user: userId, unit }).toString()}`;

// DW-4i: Team activity as a real table with a caption. One row per person, in the order given (by name), with what they did BY
// KIND over the period. There is no total column and no ranking (DW-D19): the counts are not summed and no column sorts. A
// person whose read was refused or failed says "Unavailable" on their row alone.
export function TeamActivityTable({ rows, caption, unit }: { rows: readonly TeamRow[]; caption: string; unit: string }) {
  return (
    <table className="act-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Person</th>
          <th scope="col">Done in this period, by kind</th>
          <th scope="col"><span className="act-table__sr">Their activity</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.userId}>
            <th scope="row">{r.name}</th>
            <td className={r.state === "ok" && r.phrase !== "" ? undefined : "act-table__quiet"}>
              {r.state === "unavailable" ? TEAM_UNAVAILABLE : r.phrase !== "" ? r.phrase : TEAM_QUIET}
            </td>
            <td><Link href={personActivityHref(r.userId, unit)}>Open {r.name}&apos;s activity</Link></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

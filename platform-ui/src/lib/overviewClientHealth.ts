// DW-10d: the Overview's Client health block (DW-D34's first optional block), as pure rules: where it is placed and how the
// board read (BFF §54.2) becomes a block. No React and no server imports, so every rule here is a plain unit test.
//
// The block is a SUMMARY of the staff health board (`/clients/health`): one line of counts, then the clients that need a person, worst
// first, each with the board's own chip and short reason. The state is the backend's; nothing here works one out.
//
// ── A FAILED READ IS NOT AN EMPTY BOARD ─────────────────────────────────────────────────────────────
// A refused or failed read says "Unavailable" and shows no count and no list: "No clients" and "All on track" are claims, made only
// after a successful read. The same goes for the department facet: when it cannot be read the block is unavailable, never the
// company's whole board under a department's name. A source that failed INSIDE a successful read (`unavailable[]`) is named in a note.
import type { ReadResult } from "./readResult";
import { STATE_LABEL, type ClientHealthBoard, type HealthState } from "./clientHealth";
import { shortReasons, sortWorstFirst, filterBoard, STATE_ORDER, unavailableSentence } from "./clientHealthBoard";

export const CLIENT_HEALTH_KEY = "client-health";
/** The company Overview's block: the whole company's board, never narrowed (its own key, as `company-campaigns`). */
export const COMPANY_CLIENT_HEALTH_KEY = "company-client-health";
/** The block lists at most this many clients (plan §3: a block shows at most 4 numbers or 6 rows). */
export const MAX_CLIENT_HEALTH_ROWS = 5;
/** The states that need a person; the others (on track, quiet) are counted but not listed. */
const NEEDS_ATTENTION: readonly HealthState[] = ["off_track", "at_risk", "unknown"];

/** The department block (`client-health`) reads for the department's org node, to narrow the board to its clients, so a workspace with no
 *  node has nothing to narrow to and the block is not placed there. The company Overview lists `company-client-health` instead, which is
 *  never narrowed. Other widget keys are not this rule's business and stay placed. */
export function clientHealthWidgetPlaced(key: string, subject: { deptId: string | null }): boolean {
  return key !== CLIENT_HEALTH_KEY || !!subject.deptId;
}

export interface ClientHealthRowView {
  clientId: string;
  name: string;
  state: HealthState;
  /** The board's short words for the reasons, "" when the backend gave none. */
  reason: string;
}

export type ClientHealthView =
  /** A refused read and a failed one read the same here: the block says "Unavailable" and nothing else. */
  | { kind: "unavailable" }
  | {
      kind: "ok";
      /** The clients the block is about: the department's, or the company's. */
      total: number;
      /** One entry per state with at least one client, worst first. */
      counts: Array<{ state: HealthState; label: string; count: number }>;
      /** True when there is at least one client and every one of them is on track: the one line that says nothing is wrong. */
      allOnTrack: boolean;
      /** Up to five clients that are off track, at risk or unknown, worst first (the board's order). */
      rows: ClientHealthRowView[];
      /** How many more need a person than the rows show. */
      more: number;
      /** "Could not be read: site monitoring." or "". */
      unavailableNote: string;
    };

/** `board` is the §54.2 read; `departmentIds` is the department facet's read (`readDepartmentClientIds`), or null in the company frame
 *  (no narrowing). Either failing makes the block unavailable. */
export function clientHealthView(
  board: ReadResult<ClientHealthBoard>,
  departmentIds: ReadResult<ReadonlySet<string>> | null,
): ClientHealthView {
  // An unreadable board or facet (refused or failed alike) is never an empty list: the caller draws "Unavailable".
  if (board.kind !== "ok") return { kind: "unavailable" };
  if (departmentIds && departmentIds.kind !== "ok") return { kind: "unavailable" };
  const rows = filterBoard(board.data.clients, { departmentClientIds: departmentIds ? departmentIds.data : null });
  const counts = STATE_ORDER
    .map((state) => ({ state, label: STATE_LABEL[state], count: rows.filter((r) => r.state === state).length }))
    .filter((c) => c.count > 0);
  const attention = sortWorstFirst(rows, board.data.asOf).filter((r) => NEEDS_ATTENTION.includes(r.state));
  return {
    kind: "ok",
    total: rows.length,
    counts,
    allOnTrack: rows.length > 0 && rows.every((r) => r.state === "on_track"),
    rows: attention.slice(0, MAX_CLIENT_HEALTH_ROWS).map((r) => ({ clientId: r.clientId, name: r.name, state: r.state, reason: shortReasons(r.reasons) })),
    more: Math.max(0, attention.length - MAX_CLIENT_HEALTH_ROWS),
    unavailableNote: unavailableSentence(board.data.unavailable),
  };
}

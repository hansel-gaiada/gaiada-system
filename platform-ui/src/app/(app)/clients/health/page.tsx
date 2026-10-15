import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readClients } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { getClientHealthBoard } from "@/lib/clientHub";
import {
  BOARD_COLUMNS, STATE_ORDER, filterBoard, healthBoardCells, healthBoardHref, isHealthState, ownerOptions, sortWorstFirst,
  stateOptions, unavailableSentence,
} from "@/lib/clientHealthBoard";
import { COULD_NOT_BE_LOADED, STATE_MEANING, STATE_LABEL } from "@/lib/clientHealth";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { DataTable } from "@/components/data/DataTable";
import { FilterBar } from "@/components/data/FilterBar";

type Search = Promise<{ state?: string; owner?: string; department?: string }>;

// PV7-05 — Clients › Health, the staff board (BFF §54.2, `GET :t/clients/health`).
//
// One row per live client from ONE set read. The state is the backend's (`client-health-rules.ts`); this page draws it,
// it never works one out. Staff only, and the state is never a score or a number: a chip and its reasons in short words.
//
// ── A FAILED READ IS NOT AN EMPTY BOARD ─────────────────────────────────────────────────────────────
// A refused or failed read says "Could not be loaded" and shows no table: a board with no rows would read as "this
// company has no clients". A source that failed INSIDE a successful read (`unavailable[]`) is a banner that names it, and
// its columns show "—" (never 0).
//
// ── THE DEPARTMENT FILTER ───────────────────────────────────────────────────────────────────────────
// The board API has no department filter. The facet is the clients list's own (DW-6d, `GET clients?departmentId=`: the
// clients with a live project the department, or a unit under it, owns), read only when a department is picked, and the
// board rows are narrowed to those ids here. The departments come from the org structure (`listDepartmentBriefs`), never
// from a hard-coded id: HR, Finance and IT ids are per company. A department read that fails shows a refusal instead of
// an unfiltered board under a department chip.
export default async function ClientHealthBoardPage({ searchParams }: { searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Client health" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }
  const { state: stateParam, owner: ownerParam, department: deptParam } = await searchParams;

  const [boardRead, departments] = await Promise.all([
    getClientHealthBoard(userId, tenant),
    listDepartmentBriefs(userId, tenant).catch(() => []),
  ]);

  const header = <PageHeader eyebrow="Business" title="Client health" subtitle="Who needs attention, and why." />;

  if (boardRead.kind === "forbidden") {
    return (<>{header}<ReadRefusal subject="the client health board" kind="forbidden" /></>);
  }
  if (boardRead.kind === "unavailable") {
    return (
      <>
        {header}
        <p role="alert" className="ch-board__alert" style={{ margin: "0 0 12px", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
          {COULD_NOT_BE_LOADED}: the client health board. That is not a statement that every client is fine. Try again in a moment.
        </p>
      </>
    );
  }

  const board = boardRead.data;
  const state = isHealthState(stateParam) ? stateParam : undefined;
  const owner = ownerParam && (ownerParam === "none" || board.clients.some((c) => c.ownerUserId === ownerParam)) ? ownerParam : undefined;
  const department = deptParam && departments.some((d) => d.id === deptParam) ? deptParam : undefined;

  // Department facet: the department's client ids, from the clients list's own read.
  let departmentIds: Set<string> | null = null;
  let departmentFailed = false;
  if (department) {
    const read = await readClients(userId, tenant, department);
    if (read.kind === "ok") departmentIds = new Set(read.data.map((c) => c.id));
    else departmentFailed = true;
  }

  // Facet counts are over the other active filters, so a chip never promises rows that the rest of the filter removes.
  const inScope = (extra: { state?: typeof state; owner?: string }) =>
    filterBoard(board.clients, { state: extra.state, owner: extra.owner, departmentClientIds: departmentIds });
  const rows = sortWorstFirst(inScope({ state, owner }), board.asOf);
  const href = (next: Partial<{ state: string | undefined; owner: string | undefined; department: string | undefined }>) =>
    healthBoardHref({ state, owner, department, ...next });

  const sentence = unavailableSentence(board.unavailable);
  const owners = ownerOptions(inScope({ state }));
  const states = stateOptions(inScope({ owner }));

  return (
    <>
      {header}
      {sentence && (
        <p role="status" className="ch-board__banner" style={{ margin: "0 0 12px", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
          {sentence} Those columns show &ldquo;—&rdquo; rather than zero.
          {board.unavailable.some((s) => s !== "reports") && " A client that would otherwise read On track reads Unknown."}
        </p>
      )}
      {board.clients.length === 0 ? (
        <EmptyNote>No clients to show yet.</EmptyNote>
      ) : (
        <>
          <div style={{ display: "grid", gap: 10, marginBottom: 14 }}>
            <FilterBar
              label="Filter by health"
              totalCount={inScope({ owner }).length}
              active={state}
              options={states}
              buildHref={(next) => href({ state: next })}
            />
            {owners.length > 0 && (
              <FilterBar
                label="Filter by owner"
                allLabel="Any owner"
                totalCount={inScope({ state }).length}
                active={owner}
                options={owners}
                buildHref={(next) => href({ owner: next })}
              />
            )}
            {departments.length > 0 && (
              <FilterBar
                label="Filter by department"
                allLabel="Any department"
                totalCount={board.clients.length}
                active={department}
                options={departments.map((d) => ({ key: d.id, label: d.name }))}
                buildHref={(next) => href({ department: next })}
              />
            )}
          </div>
          <p style={{ margin: "0 0 10px", font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
            Worst first: {STATE_ORDER.map((s) => STATE_LABEL[s]).join(", ")}. {state ? STATE_MEANING[state] : "The state is a summary for the account team and is never shown to the client."}
          </p>
          {departmentFailed ? (
            <p role="alert" style={{ margin: "0 0 12px", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
              {COULD_NOT_BE_LOADED}: the clients of this department, so the board is not shown filtered by it. Pick another department or clear the filter.
            </p>
          ) : (
            <DataTable
              columns={BOARD_COLUMNS}
              rows={rows.map((r) => healthBoardCells(r, board.asOf))}
              link={{ base: "/clients", idKey: "id", labelKey: "name" }}
              csvName="client-health"
              pageSize={25}
              empty="No client matches these filters."
            />
          )}
        </>
      )}
    </>
  );
}

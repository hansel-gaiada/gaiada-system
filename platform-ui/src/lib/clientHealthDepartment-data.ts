import "server-only";
// The department facet of the client health board, shared by the board page (PV7-05) and the Overview's Client health block
// (DW-10d). The board API (`GET :t/clients/health`, BFF §54.2) has no department filter, so a department's rows are the board's
// rows narrowed to the ids the clients list's own facet returns (`GET clients?departmentId=`, BFF §33, DW-6d): the clients with a
// live project the department, or a unit under it, owns. Both callers narrow with `filterBoard(..., { departmentClientIds })`.
//
// A `ReadResult`, so a refused or failed read is something the caller can name. It must NEVER be treated as "no clients" or as
// "no filter": the caller shows a refusal instead of an unfiltered board under a department's name.
import { readClients } from "./entities";
import type { ReadResult } from "./readResult";

export async function readDepartmentClientIds(userId: string, tenant: string, departmentId: string): Promise<ReadResult<Set<string>>> {
  const read = await readClients(userId, tenant, departmentId);
  return read.kind === "ok" ? { kind: "ok", data: new Set(read.data.map((c) => c.id)) } : read;
}

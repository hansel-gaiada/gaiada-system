import type { OverviewWidgetProps } from "./index";
import { getClientHealthBoard } from "@/lib/clientHub";
import { readDepartmentClientIds } from "@/lib/clientHealthDepartment-data";
import { clientHealthView } from "@/lib/overviewClientHealth";
import { ClientHealthBlock } from "./ClientHealthBlock";

// DW-10d: "Client health", the Work band's optional block (DW-D34): off until the person switches it on in Customise. Reads the staff
// health board (`GET :t/clients/health`, BFF §54.2) and, in a department workspace, narrows it to the department's clients exactly
// as the board page does: the clients list's own `departmentId` facet (§33), because the board API has no department filter. In the
// company frame (no `deptId`) it is the whole company's board. The frame does not place it in a workspace that has no node and is not
// the company (`clientHealthWidgetPlaced`). Both reads are `ReadResult`s: a refused or failed one says "Unavailable", never an empty board.
export async function ClientHealth({ me, tenantId, deptId }: OverviewWidgetProps) {
  const [board, departmentIds] = await Promise.all([
    getClientHealthBoard(me.userId, tenantId),
    deptId ? readDepartmentClientIds(me.userId, tenantId, deptId) : Promise.resolve(null),
  ]);
  return <ClientHealthBlock view={clientHealthView(board, departmentIds)} departmentId={deptId} />;
}

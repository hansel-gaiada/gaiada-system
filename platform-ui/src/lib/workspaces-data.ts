import "server-only";
// DW-1b: the person's workspaces for the active company, read on the server and handed to the client
// shell as plain data (the sidebar picks its area on the client, plan §13 trap 2). The logic is the
// pure `resolveMyWorkspaces` in `lib/workspaceAccess.ts`; this file only fetches the org tree.
import { cache } from "react";
import type { Me } from "./platform";
import { getOrgStructure, type OrgNode } from "./org";
import { activeCompany } from "./companyContext";
import { resolveMyWorkspaces, type MyWorkspaces } from "./workspaceAccess";

/** Memoised per request, like `getDepartment`, so the layout and a page share one org read. An org
 *  tree that cannot be read leaves the functional workspaces and the Company area, never an error. */
export const myWorkspaces = cache(async function myWorkspaces(me: Me, tenantId: string | null): Promise<MyWorkspaces> {
  const company = activeCompany(me, tenantId);
  let root: OrgNode | null = null;
  if (tenantId && company) {
    try {
      root = (await getOrgStructure(me.userId, tenantId, company)).structure.root;
    } catch {
      root = null;
    }
  }
  return resolveMyWorkspaces({ me, tenantId, root });
});

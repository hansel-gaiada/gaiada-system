// Shared setup for the DW-2b tests (not a test itself): a Web Dev employee's shell model, from the real
// registry and the DW-1 fixtures, and a wrapper that puts a component inside the workspace shell.
import type { ReactNode } from "react";
import { buildShellModel, type ShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { agencyTree, me, member } from "@/lib/workspaceFixtures";
import { WorkspaceShellProvider } from "./WorkspaceShellContext";

// A placed Web Dev employee in an agency company with Web Dev, SEO and the GM in its org tree.
const employee = me([member()]);
export const shellModel = buildShellModel({
  me: employee,
  tenantId: "co-a",
  workspaces: resolveMyWorkspaces({ me: employee, tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) }),
});

// The same person as a company admin, who is offered the Admin area's rows.
const admin = me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
export const adminShellModel = buildShellModel({
  me: admin,
  tenantId: "co-a",
  workspaces: resolveMyWorkspaces({ me: admin, tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) }),
});

/** The component inside the workspace shell. Without it, outside the workspace shell. */
export function inShell(ui: ReactNode, model: ShellModel = shellModel) {
  return <WorkspaceShellProvider model={model}>{ui}</WorkspaceShellProvider>;
}

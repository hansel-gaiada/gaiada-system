import type { ApprovalsResult } from "@/lib/approvals";
import { approvalsGateInput } from "@/lib/workspaceAccess";
import { ShellApprovalsSettle } from "./WorkspaceShellContext";

// DW-9d perf: the shell's pending-approvals read, streamed. The (app) layout starts `listApprovals` early and does NOT wait for it before
// the first byte; this async server component sits in a <Suspense fallback={null}> inside the shell's provider, awaits that promise and
// hands `{ pending }` (or null when the read was unavailable) to the client provider, which settles the Approvals row (DW-D23).
// `listApprovals` never throws; the catch is only so that a bug there reads as "unavailable" (the row stays shown) and never as an error page.
export async function ShellApprovalsFeed({ read }: { read: Promise<ApprovalsResult> }) {
  let settled: { pending: number } | null;
  try {
    const r = await read;
    settled = approvalsGateInput({ items: r.envelope.items, unavailable: r.unavailable });
  } catch {
    settled = null;
  }
  return <ShellApprovalsSettle read={settled} />;
}

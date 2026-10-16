import type { RequestRoute } from "@/lib/requests";
import { ShellRoutesSettle } from "./WorkspaceShellContext";

// DW-10e + DW-9 perf: the shell's routes read (BFF §60.9), streamed. The (app) layout starts `routesForShell` for a company whose pack lacks the
// Requests row and does NOT wait for it before the first byte; this async server component sits in a <Suspense fallback={null}> inside the shell's
// provider, awaits that promise and hands the routes (or null when the read failed) to the client provider, which settles the routes-gated rows
// and "Ask ..." actions. `routesForShell` never throws; the catch is only so that a bug there reads as "failed" (everything stays hidden).
export async function ShellRoutesFeed({ read }: { read: Promise<RequestRoute[] | null> }) {
  let settled: RequestRoute[] | null;
  try {
    settled = await read;
  } catch {
    settled = null;
  }
  return <ShellRoutesSettle read={settled} />;
}

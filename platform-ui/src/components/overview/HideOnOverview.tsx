"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useWorkspaceShell } from "@/components/shell/WorkspaceShellContext";

// DW-3a: a layout's own page header, hidden on that workspace's Overview page only. In the workspace shell
// the Overview draws its own header (greeting, period, quick actions), and the layout's title above it
// would say the same thing twice. A layout gets no pathname on the server (plan §13 trap 2), so the choice
// is made here on the client, from the same URL the shell reads.
//
// Everywhere else it renders its children untouched: classic shell (no shell context), every other page of
// the workspace, and a layout that passes `enabled={false}` because its page keeps the header (the GM's
// refusal page, which draws no Overview).
export function HideOnOverview({ overviewPath, enabled = true, children }: {
  /** The workspace's Overview path, e.g. `/departments/<id>` or `/hr`. */
  overviewPath: string;
  enabled?: boolean;
  children: ReactNode;
}) {
  const shell = useWorkspaceShell();
  const pathname = usePathname() ?? "";
  const here = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (enabled && shell && here === overviewPath) return null;
  return <>{children}</>;
}

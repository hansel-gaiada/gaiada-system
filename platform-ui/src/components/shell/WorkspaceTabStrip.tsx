"use client";
import Link from "next/link";
import { Icon } from "./icons";
import { useWorkspaceShell } from "./WorkspaceShellContext";

// DW-2b: the workspace shell's one tab strip (plan §2.4). The sidebar row picks the group and this shows
// that row's tools, drawn from the registry, so a page can sit in a row without moving. It reuses the
// `.sec-tabs` look so it reads like the console strips it replaces. Nothing in the classic shell, for a
// row with a single tab (the sidebar link is the whole navigation) or for a page no row holds.
export function WorkspaceTabStrip() {
  const shell = useWorkspaceShell();
  const row = shell?.activeRow;
  if (!shell || !row || row.tabs.length < 2) return null;
  return (
    <nav className="sec-tabs ws-tabs" aria-label={`${row.label} sections`}>
      {row.tabs.map((t) => {
        const isActive = shell.active?.tabKey === t.key;
        return (
          <Link key={t.key} href={t.href} className={`sec-tab${isActive ? " sec-tab--active" : ""}`} aria-current={isActive ? "page" : undefined}>
            <Icon name={t.icon} size={16} />
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

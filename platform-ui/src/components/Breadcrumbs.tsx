"use client";
import Link from "next/link";
import { useWorkspaceShell } from "@/components/shell/WorkspaceShellContext";

export interface Crumb { label: string; href?: string }

// Trail shown above a page title on deep pages. Last crumb is the current page
// (no link). Kept tiny + presentational.
//
// DW-2b: a client component only to ask the workspace shell where the page is. On a tool page of the
// current view (the pathname IS a tab) the sidebar and tab strip already say where you are, so the trail
// hides (plan §2.4). A record below a tool, and every page in the classic shell, keep it.
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const shell = useWorkspaceShell();
  if (items.length === 0 || shell?.onToolPage) return null;
  return (
    <nav aria-label="Breadcrumb" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, marginBottom: 10 }}>
      {items.map((c, i) => (
        <span key={`${c.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          {i > 0 && <span aria-hidden="true" style={{ color: "var(--erp-ink-50)", fontSize: 12 }}>/</span>}
          {c.href && i < items.length - 1 ? (
            <Link href={c.href} className="erp-crumb" style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", textDecoration: "none" }}>{c.label}</Link>
          ) : (
            <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

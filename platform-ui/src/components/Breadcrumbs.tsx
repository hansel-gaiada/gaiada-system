import Link from "next/link";

export interface Crumb { label: string; href?: string }

// Trail shown above a page title on deep pages. Last crumb is the current page
// (no link). Kept tiny + presentational.
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, marginBottom: 10 }}>
      {items.map((c, i) => (
        <span key={`${c.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          {i > 0 && <span aria-hidden="true" style={{ color: "var(--erp-ink-50)", fontSize: 12 }}>/</span>}
          {c.href && i < items.length - 1 ? (
            <Link href={c.href} style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", textDecoration: "none" }}>{c.label}</Link>
          ) : (
            <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

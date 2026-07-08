import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui";

// The standard page title block, extracted from the dashboard/approvals pages
// (eyebrow + 34px display H1 + subtitle), now shared by every page.
export function PageHeader({ eyebrow, title, subtitle, actions }: {
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 26 }}>
      <div>
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>{eyebrow}</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 560 }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div style={{ display: "flex", gap: 12, alignItems: "center" }}>{actions}</div>}
    </div>
  );
}

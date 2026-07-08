import type { CSSProperties, ReactNode } from "react";
import "./ui.css";

export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span className="type-eyebrow" style={style}>{children}</span>;
}

export function Card({ children, title, headerRight, dark, style }: {
  children: ReactNode; title?: string; headerRight?: ReactNode; dark?: boolean; style?: CSSProperties;
}) {
  return (
    <section className={`lux-card${dark ? " lux-card--dark" : ""}`} style={style}>
      {(title || headerRight) && (
        <div className="lux-card__head">
          {title ? <h3 className="lux-card__title">{title}</h3> : <span />}
          {headerRight}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ children, variant = "solid", size = "sm", onClick, type = "button", disabled }: {
  children: ReactNode; variant?: "solid" | "ghost"; size?: "sm" | "md";
  onClick?: () => void; type?: "button" | "submit"; disabled?: boolean;
}) {
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`lux-btn lux-btn--${variant} lux-btn--${size}`}>
      {children}
    </button>
  );
}

// Normalizes both prototype Title-Case labels ("Active") and raw backend
// enums ("active", "in_progress", "on_hold") to a single lookup key so
// statusColor/humanizeStatus behave the same regardless of which shape the
// caller passes in.
export function normalizeStatus(s: string): string {
  return s.toLowerCase().replace(/[_\s]+/g, " ").trim();
}

// Status→color map keyed on normalized strings. Covers both the original
// prototype labels and the raw backend enums used by the business pages
// (projects/tasks/companies/campaigns/briefs).
const STATUS_COLORS: Record<string, string> = {
  // green — done/positive states
  approved: "#4B7A5A", "on track": "#4B7A5A", paid: "#4B7A5A", active: "#4B7A5A", shipped: "#4B7A5A",
  done: "#4B7A5A", completed: "#4B7A5A", "closed won": "#4B7A5A", configured: "#4B7A5A",
  // bronze — in-flight/neutral states
  open: "#6E5A43", pending: "#6E5A43", review: "#6E5A43", todo: "#6E5A43", "in progress": "#6E5A43",
  proposal: "#6E5A43", negotiation: "#6E5A43", discovery: "#6E5A43",
  // champagne — inactive/unpublished states
  draft: "#A39174", archived: "#A39174", absent: "#A39174",
  // rust — attention/negative states
  "at risk": "#B5622F", overdue: "#B5622F", low: "#B5622F", critical: "#B5622F", blocked: "#B5622F",
  "on hold": "#B5622F", rejected: "#B5622F",
};
export function statusColor(s: string): string {
  return STATUS_COLORS[normalizeStatus(s)] ?? "#6E5A43";
}

// "in_progress" -> "In progress", "on_hold" -> "On hold", "todo" -> "Todo".
export function humanizeStatus(s: string): string {
  const normalized = normalizeStatus(s);
  if (!normalized) return normalized;
  return normalized[0].toUpperCase() + normalized.slice(1);
}

export function StatusBadge({ label }: { label: string }) {
  const color = statusColor(label);
  return (
    <span className="lux-badge" style={{ color }}>
      <span className="lux-badge__dot" style={{ background: color }} />
      {humanizeStatus(label)}
    </span>
  );
}

export function KpiTile({ label, value, delta, deltaUp, foot }: {
  label: string; value: string; delta?: string; deltaUp?: boolean; foot?: string;
}) {
  return (
    <div className="lux-kpi">
      <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
      <div className="lux-kpi__value">{value}</div>
      {(delta || foot) && (
        <div className="lux-kpi__delta">
          {delta && (
            <span style={{ color: deltaUp ? "var(--erp-accent)" : "rgba(26,25,22,.45)", fontWeight: 700 }}>
              {deltaUp ? "▲ " : "▼ "}{delta}
            </span>
          )}
          {foot && <span style={{ color: "var(--erp-ink-50)" }}>{foot}</span>}
        </div>
      )}
    </div>
  );
}

export function HairlineTable({ columns, rows, tcols }: {
  columns: { label: string; align?: "right" }[];
  rows: ReactNode[][];
  tcols?: string;
}) {
  const style = tcols ? ({ "--lux-tcols": tcols } as CSSProperties) : undefined;
  return (
    <div className="lux-table" style={style}>
      <div className="lux-table__head">
        {columns.map((c) => (
          <Eyebrow key={c.label} style={{ fontSize: 10, opacity: 0.5, ...(c.align === "right" ? { justifySelf: "end" } : {}) }}>
            {c.label}
          </Eyebrow>
        ))}
      </div>
      {rows.map((cells, i) => (
        <div className="lux-table__row" key={i}>
          {cells.map((cell, j) => (
            <span key={j} className={columns[j]?.align === "right" ? "lux-table__cell--right" : undefined}
              style={{ font: j === 0 ? "400 14px var(--font-body)" : "400 13px var(--font-body)", color: j === 0 ? "var(--text-primary)" : "rgba(26,25,22,.65)" }}>
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Toast({ message }: { message: string }) {
  return <div className="lux-toast" role="status">{message}</div>;
}

import type { CSSProperties, ReactNode } from "react";
import { InfoHint } from "./InfoHint";
import "./ui.css";

// `className` exists so callers can reach the eyebrow from a stylesheet. Passing
// layout through `style` instead — `style={{ display: "block" }}` was the old
// idiom — makes the eyebrow unreachable from a media query, because an inline
// declaration outranks any selector. That is what left the sidebar's section
// labels rendering inside the collapsed mobile rail.
export function Eyebrow({ children, style, className }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return <span className={`type-eyebrow${className ? ` ${className}` : ""}`} style={style}>{children}</span>;
}

export function Card({ children, title, headerRight, dark, style, hint }: {
  children: ReactNode; title?: string; headerRight?: ReactNode; dark?: boolean; style?: CSSProperties;
  /** Optional "?" beside the title explaining what the card shows. Omit when the title already
   *  says it — a hint that repeats the heading is noise with an extra tab stop. */
  hint?: ReactNode;
}) {
  return (
    <section className={`lux-card${dark ? " lux-card--dark" : ""}`} style={style}>
      {(title || headerRight) && (
        <div className="lux-card__head">
          {title ? (
            <h3 className="lux-card__title">
              {title}
              {hint && <InfoHint label={title}>{hint}</InfoHint>}
            </h3>
          ) : <span />}
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

// Status→semantic family, keyed on normalized strings. Covers both the original
// prototype labels and the raw backend enums used by the business pages
// (projects/tasks/companies/campaigns/briefs).
//
// The map stores a FAMILY, not a colour, because every status needs two colour
// tiers that must never drift apart: the darkened text value (4.5:1 against the
// page surface) and the lighter graphic value (3:1, for dots and bars). Storing
// one hex per status is what let champagne — 2.7:1 — ship as label text.
type StatusFamily = "ok" | "progress" | "idle" | "critical";
const STATUS_FAMILY: Record<string, StatusFamily> = {
  // sage — done/positive states
  approved: "ok", "on track": "ok", paid: "ok", active: "ok", shipped: "ok",
  done: "ok", completed: "ok", "closed won": "ok", configured: "ok",
  // bronze — in-flight/neutral states
  open: "progress", pending: "progress", review: "progress", todo: "progress", "in progress": "progress",
  proposal: "progress", negotiation: "progress", discovery: "progress",
  // champagne — inactive/unpublished states
  draft: "idle", archived: "idle", absent: "idle",
  // rust — attention/negative states
  "at risk": "critical", overdue: "critical", low: "critical", critical: "critical", blocked: "critical",
  "on hold": "critical", rejected: "critical", error: "critical",
  // D14-08 — automation_approvals.execution_status (0078), the decision-vs-execution second axis.
  // "pending"/"executing" fall through to the default "progress" family already; "executed" is
  // its own positive terminal state (distinct from the decision "approved") and "failed" its own
  // negative one (distinct from "rejected" — a rejected row never executes at all).
  executed: "ok", failed: "critical",
  // ORG-13 service-assignment lifecycle states
  proposed: "progress", suspended: "idle", orphaned: "critical", revoked: "critical",
  // F1/C1 connection/seat lifecycle states (unconfigured/pending/error/revoked
  // already covered above by draft/pending/at-risk-family aliases where they
  // overlap; only the two not already present are added here).
  linked: "ok", unconfigured: "idle",
  // 2026-09-03 — the two states the department Connections tab actually renders, now that it stops
  // printing the vault's raw `status` column at people (see ConnectionsPanel's `mappingLabel`).
  // "not set" is idle: nothing has been recorded, which is inactive, not in-flight — the default
  // "progress" family would put a bronze in-flight tone on a row where nobody has done anything.
  // "mapped" deliberately STAYS in the default progress family rather than joining `linked` in
  // "ok": an account mapping with no credential behind it is a half-finished thing, and a green
  // badge would say the integration works. It does not — that is the whole point of the label.
  "not set": "idle",
  // PRV-04 — webdev_provisioned_sites lifecycle (requested/pending/provisioned already fall through
  // to the default "progress" family). "live" is the terminal success state, same family as
  // active/shipped; "failed" is already covered by the D14-08 entry above.
  live: "ok",
  // MON — Plane B monitor states (docs/blueprints/monitoring-program.md §3). These MUST be listed
  // explicitly: the default family is "progress" (bronze), which would render a DOWN monitor in the
  // same neutral tone as an in-flight task. A monitoring surface whose failure state reads as
  // neutral is the exact defect this module was built to replace, so the mapping is load-bearing.
  // "degraded" takes the attention family rather than progress — a partial failure is a failure.
  // "maintenance"/"unknown" take idle: honest "not currently evidence of health", never a green.
  up: "ok", down: "critical", degraded: "critical", maintenance: "idle", unknown: "idle",
  // MSO-06 — Plane A `infra_hosts.status` (contract §20.1a). "onboarding" is expected-pending
  // (bronze, same family as other in-flight states), NOT idle — an idle/champagne badge reads as
  // "inactive/nothing to see", which is the wrong message for a host that is actively being brought
  // up. "decommissioned" takes idle: retired on purpose, not a failure.
  onboarding: "progress", decommissioned: "idle",
};
function familyOf(s: string): StatusFamily {
  return STATUS_FAMILY[normalizeStatus(s)] ?? "progress";
}

/** Text tier — for a status LABEL. Clears 4.5:1 on the page surface. */
export function statusColor(s: string): string {
  return `var(--status-${familyOf(s)}-fg)`;
}
/** Graphic tier — for dots, bars and borders, which only need 3:1. */
export function statusGraphic(s: string): string {
  return `var(--status-${familyOf(s)})`;
}

// "in_progress" -> "In progress", "on_hold" -> "On hold", "todo" -> "Todo".
export function humanizeStatus(s: string): string {
  const normalized = normalizeStatus(s);
  if (!normalized) return normalized;
  return normalized[0].toUpperCase() + normalized.slice(1);
}

export function StatusBadge({ label }: { label: string }) {
  return (
    <span className="lux-badge" style={{ color: statusColor(label) }}>
      <span className="lux-badge__dot" style={{ background: statusGraphic(label) }} />
      {humanizeStatus(label)}
    </span>
  );
}

export function KpiTile({ label, value, delta, deltaUp, foot, hint }: {
  // `value` accepts ReactNode (not just string) so a caller can ride a badge (e.g. SM-38's
  // SimulatedBadge) alongside the figure — every existing string call site is unaffected.
  label: string; value: ReactNode; delta?: string; deltaUp?: boolean; foot?: string;
  /** Optional "?" explaining what this figure counts. State the rule, not a restatement of the
   *  label: "Tasks due within 7 days, overdue included" earns its place; "the due-soon count"
   *  does not. */
  hint?: ReactNode;
}) {
  return (
    <div className="lux-kpi">
      {/* The hint sits OUTSIDE the Eyebrow on purpose: that element is faded to 0.6, and an
          `opacity < 1` ancestor creates a stacking context — a popover nested inside it is trapped
          below any positioned sibling (e.g. a sticky rail) whatever its z-index, and inherits the
          fade. Siblings in a flex row avoid both. */}
      {hint ? (
        <span style={{ display: "flex", alignItems: "center" }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
          <InfoHint label={label}>{hint}</InfoHint>
        </span>
      ) : (
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
      )}
      <div className="lux-kpi__value">{value}</div>
      {(delta || foot) && (
        <div className="lux-kpi__delta">
          {delta && (
            <span style={{ color: deltaUp ? "var(--erp-accent)" : "var(--ink-subtle)", fontWeight: 700 }}>
              {deltaUp ? "▲ " : "▼ "}{delta}
            </span>
          )}
          {foot && <span style={{ color: "var(--erp-ink-50)" }}>{foot}</span>}
        </div>
      )}
    </div>
  );
}

export function HairlineTable({ columns, rows, tcols, sort, onSort }: {
  /** `sortKey` opts a column into the sort affordance below; columns without one stay static. */
  columns: { label: string; align?: "right"; sortKey?: string }[];
  rows: ReactNode[][];
  tcols?: string;
  /** The column currently sorted, and which way. Omit for an unsorted table. */
  sort?: { key: string; dir: "asc" | "desc" };
  /** Called with a column's `sortKey`. The CALLER owns the sort state and the actual ordering of
   *  `rows` — this primitive never reorders anything, it only renders the control. */
  onSort?: (key: string) => void;
}) {
  // ── Sorting is OPT-IN and additive (2026-09-03) ───────────────────────────────────────────────
  // Nothing in this app had a sortable table — `aria-sort` appeared zero times in `src/` — so the
  // portfolio's rebuild had the usual choice between inventing a private pattern next door and
  // teaching the primitive. It teaches the primitive: every one of the ~60 existing call sites
  // passes neither `sort` nor `onSort` and renders byte-identically.
  //
  // No `aria-sort`, deliberately. `.lux-table` is a grid of plain `div`/`span`s with NO table or
  // grid roles at all, and `aria-sort` is only meaningful on a `columnheader` inside a
  // row/rowgroup/table hierarchy. Bolting the attribute onto a bare div would be invalid ARIA that
  // reads as compliance, and adding the full role hierarchy would change screen-reader behaviour on
  // every table in the app from one department's ticket. So the state is carried where it is always
  // announced: in the button's own accessible name.

  // DERIVE the grid template from the column count when the caller does not give one.
  //
  // `.lux-table__head/__row` fall back to `var(--lux-tcols, 2fr 1fr 1fr 1fr)` — FOUR tracks. Any
  // table with more columns than that and no `tcols` put N items into 4 tracks, so every row wrapped
  // onto extra lines and the columns rendered out of order. On the receivables aging the header read
  // "61–90 / Current 90+ / 1–30 Total / 31–60" and each customer's figures split across two visual
  // rows — the page's headline number, unreadable, in production.
  //
  // A scan found 62 such tables across finance, HR, IT, learning, monitoring, PM and search. Fixing
  // them one by one would leave the 63rd broken the day someone adds it, so the default moves here:
  // first column wide, the rest even, which is exactly what the old 4-track literal encoded.
  //
  // Nothing in the pipeline could see this. The markup is correct and every cell is present in DOM
  // order, so `tsc`, vitest, `next build` and the axe sweep all pass — wrapping is neither a type
  // error nor a contrast failure. It was found by opening the page.
  //
  // Callers that pass `tcols` are unaffected. Tables with 4 columns get `2fr 1fr 1fr 1fr`, identical
  // to before; tables with 2 or 3 stop rendering phantom empty tracks.
  const template = tcols ?? `2fr repeat(${Math.max(columns.length - 1, 1)}, 1fr)`;
  const style = { "--lux-tcols": template } as CSSProperties;
  return (
    <div className="lux-table" style={style}>
      <div className="lux-table__head">
        {columns.map((c) => (
          // `--ink-subtle`, not `opacity: 0.5`.
          //
          // The ink ramp exists so every text tier clears WCAG AA on its worst-case surface, and
          // `--ink-subtle` (4.54:1) is documented for precisely this — "small caps labels". Halving
          // the alpha on top of it discarded that: axe rated these column headers a SERIOUS contrast
          // failure on EVERY table in the app, and they were the last violation left across all ten
          // finance routes once the finance-owned rules were moved onto the ramp.
          //
          // These labels are not decoration. They are the only thing saying which column holds the
          // amount and which the account, so `--ink-faint` (2.62:1, "decorative only") would be the
          // wrong tier even though it looks closer to the old rendering.
          c.sortKey && onSort ? (
            <button
              key={c.label}
              type="button"
              className="lux-table__sort"
              style={c.align === "right" ? { justifySelf: "end" } : undefined}
              onClick={() => onSort(c.sortKey as string)}
              aria-label={
                sort?.key === c.sortKey
                  ? `${c.label}, sorted ${sort.dir === "asc" ? "ascending" : "descending"} — activate to reverse`
                  : `Sort by ${c.label}`
              }
            >
              <Eyebrow style={{ fontSize: 10, color: sort?.key === c.sortKey ? "var(--text-primary)" : "var(--ink-subtle)" }}>
                {c.label}
              </Eyebrow>
              {/* aria-hidden: the direction is already in the button's accessible name above, and a
                  screen reader reading "black up-pointing triangle" after it is noise. */}
              <span aria-hidden="true" className="lux-table__sort-mark">
                {sort?.key === c.sortKey ? (sort.dir === "asc" ? "▲" : "▼") : ""}
              </span>
            </button>
          ) : (
            <Eyebrow key={c.label} style={{ fontSize: 10, color: "var(--ink-subtle)", ...(c.align === "right" ? { justifySelf: "end" } : {}) }}>
              {c.label}
            </Eyebrow>
          )
        ))}
      </div>
      {rows.map((cells, i) => (
        <div className="lux-table__row" key={i}>
          {cells.map((cell, j) => (
            <span key={j} className={columns[j]?.align === "right" ? "lux-table__cell--right" : undefined}
              style={{ font: j === 0 ? "400 14px var(--font-body)" : "400 13px var(--font-body)", color: j === 0 ? "var(--text-primary)" : "var(--ink-muted)" }}>
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// `onUndo` is additive (P2-06 recurring-task "Undo" affordance) — omit it and
// Toast renders exactly as before (plain message, no action).
export function Toast({ message, onUndo, undoLabel = "Undo" }: { message: string; onUndo?: () => void; undoLabel?: string }) {
  return (
    <div className="lux-toast" role="status">
      {message}
      {onUndo && (
        <button type="button" className="lux-toast__undo" onClick={onUndo}>{undoLabel}</button>
      )}
    </div>
  );
}

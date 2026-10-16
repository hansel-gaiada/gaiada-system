// DW-10b — the PURE half of the monthly-targets surface (docs/FRONTEND-BFF-CONTRACT.md §58): the proposal validation both
// the single propose and the batch propose use, the batch bodies, the month window of the series read and the series
// shape. No DB, no clock, no Nest: `today` is always an argument. The routes are dept-kpis.controller.ts; the writes are
// dept-kpi-targets.ts.
//
// ONE VALIDATOR, TWO ROUTES. The single `POST /dept-kpis/targets` used to hold these checks inline; the batch must apply
// "each item exactly as a single proposal" (§58.2), so both now call `parseProposalShape` and `checkProposalAgainstWorkspace`.
// The check order of the single route is kept: shape (kpiKey, effectiveFrom, target, tolerance, note) first, the unit
// lookup after it, and only then the checks that need the unit's workspace (KPI membership, percent as a fraction).
import { kpiDefFor, type WorkspaceSlug } from "./dept-kpis";
import { enumerateCalendarStarts, resolveCalendarRange } from "./report-calendar";
import type { KpiRead, UnitKpis } from "./dept-kpi-targets";

export const MONTH_START_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const MAX_NOTE = 2000;
/** §58.1: the series window. */
export const MAX_SERIES_MONTHS = 12;
/** §58.2 and §58.3: items per batch. */
export const MAX_BATCH = 36;

/** A 400 that names the offending input. The controller turns it into `BadRequestException({message, field})`. */
export class FieldError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "FieldError";
  }
}

// ═══════════════════════════════ one proposal ═══════════════════════════════

export interface ProposalFields {
  kpiKey: string;
  effectiveFrom: string;
  target: number;
  tolerance: number;
  note: string | null;
}

/** PURE. Everything the single propose checks before it looks the unit up. Throws FieldError. */
export function parseProposalShape(body: Record<string, unknown>): ProposalFields {
  const kpiKey = typeof body.kpiKey === "string" ? body.kpiKey : "";
  if (!kpiKey) throw new FieldError("kpiKey", "kpiKey is required");
  const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : "";
  if (!MONTH_START_RE.test(effectiveFrom)) {
    throw new FieldError("effectiveFrom", "effectiveFrom must be the first day of a month (YYYY-MM-01)");
  }
  const target = body.target;
  if (typeof target !== "number" || !Number.isFinite(target)) throw new FieldError("target", "target must be a number");
  const tolerance = body.tolerance;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new FieldError("tolerance", "tolerance must be a number of at least 0");
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.length > MAX_NOTE) {
      throw new FieldError("note", `note must be a string of at most ${MAX_NOTE} characters`);
    }
    note = body.note.trim() || null;
  }
  return { kpiKey, effectiveFrom, target, tolerance, note };
}

/** PURE. The checks that need the unit's workspace: the KPI is one of its set, a percent is a fraction. Throws FieldError. */
export function checkProposalAgainstWorkspace(workspace: WorkspaceSlug, p: Pick<ProposalFields, "kpiKey" | "target" | "tolerance">): void {
  const def = kpiDefFor(workspace, p.kpiKey);
  if (!def) throw new FieldError("kpiKey", `kpiKey is not a KPI of this unit's workspace (${workspace})`);
  if (def.unit === "percent" && (p.target < 0 || p.target > 1 || p.tolerance > 1)) {
    throw new FieldError("target", "a percent target and tolerance are fractions between 0 and 1 (0.85 = 85%)");
  }
  if (def.unit !== "percent" && p.target < 0) throw new FieldError("target", "target must not be negative");
}

// ═══════════════════════════════ the batch propose (§58.2) ═══════════════════════════════

/** PURE. `items` is an array of 1 to 36 entries, else FieldError `items`. */
export function parseBatchItems(raw: unknown): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new FieldError("items", "items must be a list of 1 to 36 proposals");
  if (raw.length > MAX_BATCH) throw new FieldError("items", `items must hold at most ${MAX_BATCH} proposals`);
  return raw;
}

/**
 * PURE. Each item in order, exactly as a single proposal; the FIRST invalid item answers, its index in `field`
 * (`items[3].target`). Per item: its shape, then a duplicate `(kpiKey, effectiveFrom)` of an earlier item
 * (`items[i].effectiveFrom`), then, when the unit is known (`workspace` not null), the workspace checks. With an unknown
 * unit only the shape and duplicate checks run, so the caller can answer 404 once the shape is sound (the single's order:
 * shape, unit, workspace).
 */
export function validateBatchItems(items: readonly unknown[], workspace: WorkspaceSlug | null): ProposalFields[] {
  const seen = new Set<string>();
  const out: ProposalFields[] = [];
  items.forEach((raw, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new FieldError(`items[${i}]`, `items[${i}] must be an object`);
    let p: ProposalFields;
    try {
      p = parseProposalShape(raw as Record<string, unknown>);
      const key = `${p.kpiKey}\u0000${p.effectiveFrom}`;
      if (seen.has(key)) throw new FieldError("effectiveFrom", "a KPI can have one proposal per month in a batch");
      seen.add(key);
      if (workspace) checkProposalAgainstWorkspace(workspace, p);
    } catch (err) {
      if (err instanceof FieldError) throw new FieldError(`items[${i}].${err.field}`, `items[${i}]: ${err.message}`);
      throw err;
    }
    out.push(p);
  });
  return out;
}

// ═══════════════════════════════ the batch decide (§58.3) ═══════════════════════════════

export interface DecideBatchBody {
  decision: "approve" | "reject";
  ids: string[];
  note: string | null;
}

/** PURE. `{decision, ids, note?}`: 1 to 36 distinct ids. Throws FieldError (`decision`, `ids`, `note`). */
export function parseDecideBatchBody(body: Record<string, unknown>): DecideBatchBody {
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") throw new FieldError("decision", "decision must be approve or reject");
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== "string" || x === "")) {
    throw new FieldError("ids", "ids must be a list of 1 to 36 proposal ids");
  }
  if (ids.length > MAX_BATCH) throw new FieldError("ids", `ids must hold at most ${MAX_BATCH} proposals`);
  if (new Set(ids as string[]).size !== ids.length) throw new FieldError("ids", "ids must be distinct");
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.length > MAX_NOTE) {
      throw new FieldError("note", `note must be a string of at most ${MAX_NOTE} characters`);
    }
    note = body.note.trim() || null;
  }
  return { decision, ids: ids as string[], note };
}

/**
 * PURE. The order a batch decides in, inside its one transaction: by (unit, KPI), then effective month ascending, then id.
 * Two reasons. (1) Approving a month supersedes the approved rows of that (unit, KPI) from the month ON, so a LATER month
 * must be approved AFTER an earlier one or the earlier approval would supersede the row just approved. (2) Families are
 * locked in one global order, so two overlapping batches serialise instead of deadlocking.
 */
export function decisionOrder<T extends { id: string; unitNodeId: string; kpiKey: string; effectiveFrom: string }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      a.unitNodeId.localeCompare(b.unitNodeId) ||
      a.kpiKey.localeCompare(b.kpiKey) ||
      a.effectiveFrom.localeCompare(b.effectiveFrom) ||
      a.id.localeCompare(b.id),
  );
}

// ═══════════════════════════════ the series (§58.1) ═══════════════════════════════

export interface MonthSlot {
  month: string;
  start: string;
  end: string;
  partial: boolean;
}

/**
 * PURE. The months of the series, oldest first. `from` and `to` are `YYYY-MM`; `today` is `YYYY-MM-DD` in REPORTS_TZ.
 * Both given: `from <= to`, at most 12 months, `to` not after the current month. A supplied value that is not a month is a
 * 400 even when the other is missing. Without both, the window is the 12 months ending with the current month (§58.1).
 * The current month is `partial`. Throws FieldError `from` or `to`.
 */
export function monthWindow(fromRaw: unknown, toRaw: unknown, today: string): MonthSlot[] {
  if (fromRaw !== undefined && (typeof fromRaw !== "string" || !MONTH_RE.test(fromRaw))) throw new FieldError("from", "from must be a month (YYYY-MM)");
  if (toRaw !== undefined && (typeof toRaw !== "string" || !MONTH_RE.test(toRaw))) throw new FieldError("to", "to must be a month (YYYY-MM)");
  const current = today.slice(0, 7);
  let from: string;
  let to: string;
  if (typeof fromRaw === "string" && typeof toRaw === "string") {
    from = fromRaw;
    to = toRaw;
  } else {
    to = current;
    from = shiftMonth(current, -(MAX_SERIES_MONTHS - 1));
  }
  if (from > to) throw new FieldError("from", "from must not be after to");
  if (to > current) throw new FieldError("to", "to must not be after the current month");
  const starts = enumerateCalendarStarts("month", `${from}-01`, `${to}-01`);
  if (starts.length > MAX_SERIES_MONTHS) throw new FieldError("from", `the window is at most ${MAX_SERIES_MONTHS} months`);
  return starts.map((s) => {
    const r = resolveCalendarRange("month", s);
    return { month: s.slice(0, 7), start: r.start, end: r.end, partial: s.slice(0, 7) === current };
  });
}

/** PURE. `YYYY-MM` shifted by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export type SeriesCell = Omit<KpiRead, "key" | "label" | "unit" | "direction"> & { month: string };

export interface SeriesView {
  unit: { id: string; name: string };
  workspace: UnitKpis["workspace"];
  months: Array<MonthSlot & { condition: UnitKpis["condition"] }>;
  kpis: Array<Pick<KpiRead, "key" | "label" | "unit" | "direction"> & { cells: SeriesCell[] }>;
}

/**
 * PURE. The series shape: `perMonth[i]` is the evaluation of `slots[i]`. A cell is exactly that month's `KpiRead` (never
 * 0, never carried over from another month); the KPIs come in catalogue order, one cell per month, oldest first.
 */
export function assembleSeries(unit: { id: string; name: string }, workspace: UnitKpis["workspace"], slots: readonly MonthSlot[], perMonth: readonly UnitKpis[]): SeriesView {
  const first = perMonth[0];
  return {
    unit: { id: unit.id, name: unit.name },
    workspace,
    months: slots.map((s, i) => ({ month: s.month, start: s.start, end: s.end, partial: s.partial, condition: perMonth[i].condition })),
    kpis: (first ? first.kpis : []).map((k) => ({
      key: k.key,
      label: k.label,
      unit: k.unit,
      direction: k.direction,
      cells: perMonth.map((m, i) => {
        const read = m.kpis.find((x) => x.key === k.key);
        if (!read) throw new Error(`series: month ${slots[i].month} has no read for KPI ${k.key}`);
        const { key: _key, label: _label, unit: _unit, direction: _direction, ...rest } = read;
        return { month: slots[i].month, ...rest };
      }),
    })),
  };
}

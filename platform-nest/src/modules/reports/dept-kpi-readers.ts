// DW-6n / DW-7 (docs/FRONTEND-BFF-CONTRACT.md §40.5.1): the registry of department KPI module readers. A catalogue entry
// (dept-kpis.ts) with `{ kind: "module", readerId }` is read by `MODULE_KPI_READERS[readerId]` in evaluateUnits. DW-6's readers
// register in dept-kpi-readers/delivery, DW-7's in dept-kpi-readers/functional; this file only merges the two.
import { DELIVERY_READERS } from "./dept-kpi-readers/delivery";
import { FUNCTIONAL_READERS } from "./dept-kpi-readers/functional";
import type { ModuleKpiReader } from "./dept-kpi-readers/types";
import type { DeptKpiDef } from "./dept-kpis";

export type { ModuleKpiReader, ReaderCtx } from "./dept-kpi-readers/types";

export const MODULE_KPI_READERS: Record<string, ModuleKpiReader> = { ...DELIVERY_READERS, ...FUNCTIONAL_READERS };

let readersOverride: Record<string, ModuleKpiReader> | null = null;
/** TEST ONLY: the registry `moduleKpiReaders()` returns. Null restores the real one. */
export function setModuleKpiReadersForTests(map: Record<string, ModuleKpiReader> | null): void {
  readersOverride = map;
}
/** The registry the engine reads: the merged record, or a test's fake one. */
export const moduleKpiReaders = (): Record<string, ModuleKpiReader> => readersOverride ?? MODULE_KPI_READERS;

/** PURE. The parity check (§40.5.1): every readerId a catalogue names has a registered reader, and every registered reader
 *  is named by exactly one catalogue entry. Returns the problems, empty when the two agree. */
export function readerParityProblems(
  sets: Readonly<Record<string, readonly DeptKpiDef[]>>,
  readers: Readonly<Record<string, ModuleKpiReader>>,
): string[] {
  const named = new Map<string, string[]>();
  for (const [slug, defs] of Object.entries(sets)) {
    for (const d of defs) {
      if (d.reader.kind !== "module" || d.reader.readerId === undefined) continue;
      named.set(d.reader.readerId, [...(named.get(d.reader.readerId) ?? []), `${slug}/${d.key}`]);
    }
  }
  const problems: string[] = [];
  for (const [id, who] of named) {
    if (!Object.prototype.hasOwnProperty.call(readers, id)) problems.push(`readerId "${id}" (${who.join(", ")}) has no registered reader`);
    if (who.length > 1) problems.push(`readerId "${id}" is named by ${who.length} catalogue entries (${who.join(", ")})`);
  }
  for (const id of Object.keys(readers)) {
    if (!named.has(id)) problems.push(`registered reader "${id}" is named by no catalogue entry`);
  }
  return problems;
}

// DW-7g-1: tax-return preparation on Finance > Tax. Plain module (no "use server", no "server-only"): the wire shapes of
// `GET/POST /api/:t/finance/tax/returns`, `POST .../returns/:id/file` and `GET .../returns/drift` (platform-nest
// `finance.controller.ts`, the F7 lifecycle), the constants the action and the screen share, and the few pure rules.
// A "use server" file may export only async functions, so none of this can live in `financeTaxActions.ts`.
import type { Me } from "./platform";
import { can, isElevated } from "./rbac";

/** The five kinds the backend accepts (`TAX_RETURN_KINDS`). Four are monthly (SPT Masa); `pph_badan` is annual. */
export const TAX_RETURN_KINDS = ["ppn", "pph21", "pph23", "pph42", "pph_badan"] as const;
export type TaxReturnKind = (typeof TAX_RETURN_KINDS)[number];

export const TAX_RETURN_KIND_LABEL: Record<TaxReturnKind, string> = {
  ppn: "PPN (VAT), monthly",
  pph21: "PPh 21, monthly",
  pph23: "PPh 23, monthly",
  pph42: "PPh 4(2), monthly",
  pph_badan: "PPh Badan, annual",
};

export const isTaxReturnKind = (k: string): k is TaxReturnKind => (TAX_RETURN_KINDS as readonly string[]).includes(k);
/** `pph_badan` is the ANNUAL return: it has a year and no month. Every other kind needs a month. */
export const isAnnualKind = (k: string): boolean => k === "pph_badan";

/** Lifecycle: `draft` (prepared, holds no figures) -> `filed` -> `amended` (an amendment may follow an amendment). */
export type TaxReturnStatus = "draft" | "filed" | "amended";

/** One row of `GET finance/tax/returns`. The `filed*` figures are numeric(20,4) and arrive as strings; all three are
 *  null while the return is a draft (a draft stores no numbers, they are recomputed from the ledger on demand). The
 *  payload carries no "prepared at" date. */
export interface TaxReturn {
  id: string;
  kind: string;
  periodYear: number;
  periodMonth: number | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  filedOutput: string | null;
  filedInput: string | null;
  filedNet: string | null;
  filedAt: string | null;
  filingReference: string | null;
  notes: string | null;
}

/** `GET finance/tax/returns/drift`: one entry per FILED or AMENDED return whose net no longer matches the ledger. */
export interface TaxReturnDrift {
  problems: Array<{ problem: string; detail: string }>;
  clean: boolean;
}

/** `POST finance/tax/returns` -> 201. `computed` is the live answer from the ledger at that moment (not stored). */
export interface PreparedTaxReturn {
  id: string;
  kind: string;
  periodYear: number;
  periodMonth: number | null;
  periodStart?: string;
  periodEnd?: string;
  status?: string;
  computed: { output: number; input: number; net: number };
}

/** `POST finance/tax/returns/:id/file` -> 200. */
export interface FiledTaxReturn {
  id: string;
  status?: string;
  period: string;
  filingReference: string;
  filed: { output: number; input: number; net: number };
}

/** An amount as `money()` in `finance.ts` renders it (IDR, no minor unit), without that file's "server-only" guard, so the
 *  client component can format a figure the server returned. Strings come from pg numeric and are formatted, never summed. */
export function formatTaxAmount(amount: string | number | null | undefined): string {
  if (amount == null) return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency: "IDR", minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The period's label exactly as the server builds it, `PPN 2026-03` or `PPH_BADAN 2026`. It is also the string the
 *  filing confirmation must echo (`requireConfirmation(body.confirm, label, "period")`). */
export function returnLabel(r: { kind: string; periodYear: number; periodMonth: number | null }): string {
  return r.periodMonth === null
    ? `${r.kind.toUpperCase()} ${r.periodYear}`
    : `${r.kind.toUpperCase()} ${r.periodYear}-${pad2(r.periodMonth)}`;
}

/** What the three stored figures mean for a kind. PPN nets creditable input VAT against output; a withholding return
 *  has nothing to offset (input is stated as 0, net equals what was withheld). */
export function figureLabels(kind: string): { output: string; input: string; net: string } {
  return kind === "ppn"
    ? { output: "Output VAT", input: "Input VAT (creditable)", net: "Net payable" }
    : { output: "Withheld", input: "Offset", net: "To remit" };
}

/**
 * The period to offer when preparing: the last month that is CLOSED. A period counts as closed when its state is not
 * OPEN and it ended before `today`; failing that, the last whole calendar month before `today`. A filing is refused
 * for a period that has not ended, so the current month is never offered.
 */
export function defaultReturnPeriod(
  periods: ReadonlyArray<{ startDate: string; endDate: string; state: string }>,
  today: string,
): { year: number; month: number } {
  const closed = periods
    .filter((p) => p.state !== "OPEN" && p.endDate < today && p.startDate.slice(0, 7) === p.endDate.slice(0, 7))
    .sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0];
  if (closed) return { year: Number(closed.endDate.slice(0, 4)), month: Number(closed.endDate.slice(5, 7)) };
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/**
 * Which returns the drift read is talking about. A drift entry's `detail` starts `<kind> <year>-<MM|annual>: ...`
 * (`finance_tax_return_drift`); the screen lists every entry verbatim and uses this only to mark the matching row.
 */
export function driftFor(r: TaxReturn, drift: TaxReturnDrift | null | undefined): string | null {
  if (!drift) return null;
  const prefix = `${r.kind} ${r.periodYear}-${r.periodMonth === null ? "annual" : pad2(r.periodMonth)}:`;
  return drift.problems.find((p) => p.detail.startsWith(prefix))?.detail ?? null;
}

/**
 * Whether to offer Prepare, Record filing and Amend at all. COSMETIC: the server decides (Cerbos `finance_tax`).
 * The rules are `prepare` for the finance staff and manager roles and the platform operator, and `file` (also at high
 * assurance) for the finance manager role, company_admin and the platform operator. `ROLE_CAPS` has no capability
 * for either, so this is a SUPERSET: `company.manage` or an operator, plus a finance staff or manager grant that covers
 * the company. Someone it shows a control to may still be refused, in words.
 */
export function canWorkTaxReturns(me: Me, tenant: string): boolean {
  if (isElevated(me) || can(me, "company.manage", tenant)) return true;
  return me.roles.some(
    (g) =>
      (g.role === "finance_staff" || g.role === "finance_manager") &&
      (g.scopeType === "global" || (g.scopeType === "company" && g.scopeId === tenant)),
  );
}

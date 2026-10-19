// DW-10f-3b — invoices FROM THE SCHEDULE: the types and the PURE rules behind `/invoices/new` and the invoice page
// (FRONTEND-BFF-CONTRACT §61.5, §61.9, §61.17). Client-safe on purpose (no `server-only`, no I/O): the picker imports these to
// decide what to tick and what to say, and `contractBilling.test.ts` pins every rule. The reader is `contractBilling-data.ts`
// (server-only) and the writes are in `invoiceActions.ts` ("use server"), the same trio as `contracts{,-data,Actions}.ts`.
//
// Cerbos stays the authority. Nothing here decides who may bill; it decides what to OFFER from the answer the backend gave.
import { formatMinor, minorUnitOf, toMinor } from "./contracts";

/** One row of `GET invoices/billable-instalments` (§61.5). `state` is §61.3's staff state; only these three come back. */
export interface BillableInstalment {
  instalmentId: string;
  client: { id: string; name: string };
  contract: { id: string; title: string; reference: string | null; kind: string | null; projectId: string | null };
  position: number;
  count: number;
  label: string;
  amount: number;
  currency: string;
  due: { kind: "on_signing" | "date"; on: string | null };
  state: "due" | "upcoming" | "invoicing" | string;
  /** The draft that claims it, for an `invoicing` row. */
  invoice: { id: string; status: string } | null;
}

export interface BillableAnswer {
  dueBy: string;
  items: BillableInstalment[];
}

/** The most rows the billable read returns (§61.5): a full page is "this many or more", never a total. */
export const BILLABLE_LIMIT = 500;

/** Only a `due` instalment can be ticked. `upcoming` is shown with its date, and `invoicing` links its draft. */
export const isTickable = (i: Pick<BillableInstalment, "state">): boolean => i.state === "due";

/** What is ticked when the list opens: every `due` row (§61.9). */
export function defaultSelection(items: readonly BillableInstalment[]): string[] {
  return items.filter(isTickable).map((i) => i.instalmentId);
}

export interface SelectionSummary {
  count: number;
  /** The one currency of the ticked rows; null when none is ticked or they are in more than one. */
  currency: string | null;
  mixed: boolean;
  /** "IDR 45,000,000" for the ticked rows, exact (minor units); null when there is no single currency. */
  totalText: string | null;
}

/** The ticked rows' count and total. Rows in more than one currency are `mixed`: the server refuses them (`currency_mixed`),
 *  and the picker says so before the click instead of after. A tick that is not on the list counts for nothing. */
export function summariseSelection(items: readonly BillableInstalment[], selected: readonly string[]): SelectionSummary {
  const chosen = items.filter((i) => isTickable(i) && selected.includes(i.instalmentId));
  const currencies = new Set(chosen.map((i) => i.currency));
  if (chosen.length === 0) return { count: 0, currency: null, mixed: false, totalText: null };
  if (currencies.size > 1) return { count: chosen.length, currency: null, mixed: true, totalText: null };
  const currency = chosen[0].currency;
  const minor = minorUnitOf(currency);
  let total = BigInt(0);
  for (const i of chosen) total += toMinor(Math.abs(i.amount).toFixed(minor), minor) ?? BigInt(0);
  return { count: chosen.length, currency, mixed: false, totalText: formatMinor(total, currency) };
}

/** An instalment as one phrase: "Deposit (50%), 1 of 2". */
export const instalmentName = (i: Pick<BillableInstalment, "label" | "position" | "count">): string => `${i.label} (${i.position} of ${i.count})`;

/** "Website build agreement · GDA-2026-040", the contract the instalment belongs to. */
export function contractName(c: BillableInstalment["contract"]): string {
  return c.reference ? `${c.title} · ${c.reference}` : c.title;
}

/** Where the contract is shown: the client's Contracts & billing page, at the contract's own row. */
export const contractHref = (clientId: string, contractId: string): string => `/clients/${encodeURIComponent(clientId)}/billing#contract-${encodeURIComponent(contractId)}`;

/** The default "Due up to": today, in the caller's zone (the page passes it). A malformed value falls back to it. */
export function dueByOrToday(raw: string | undefined, today: string): { dueBy: string; invalid: boolean } {
  if (raw === undefined || raw === "") return { dueBy: today, invalid: false };
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw
    ? { dueBy: raw, invalid: false }
    : { dueBy: today, invalid: true };
}

/** `due` rows among a billable list, for the Finance Overview's tile: the count of what is ready to invoice. */
export function countDue(items: readonly Pick<BillableInstalment, "state">[]): number {
  return items.filter((i) => i.state === "due").length;
}

// ── the draft's refusals, in words ──────────────────────────────────────────────────────────────

export type UnavailableReason = "not_found" | "other_client" | "not_signed" | "superseded" | "not_due" | "already_invoiced";
export interface UnavailableItem { instalmentId: string; reason: UnavailableReason | string; invoiceId?: string }

/** One instalment that can no longer be billed, as a clause (§61.5's `detail.items[].reason`). */
export function unavailableWords(reason: string): string {
  switch (reason) {
    case "not_found": return "no longer exists";
    case "other_client": return "belongs to another client";
    case "not_signed": return "is on an agreement that is no longer signed";
    case "superseded": return "is on an agreement that a newer signed version has replaced";
    case "not_due": return "is not due yet for the date you chose";
    case "already_invoiced": return "is already on another invoice";
    default: return "can no longer be billed";
  }
}

/** The lead sentence for a 409 `instalment_unavailable`; the items follow as a list (`unavailableWords`). Nothing was written. */
export const UNAVAILABLE_LEAD = "Some of the instalments you ticked can no longer be billed. Nothing was created. Reload the list and tick again.";

/**
 * Every refusal of `POST invoices {source: 'instalments'}` (§61.5) as a sentence. Branch on `reason`, never on the message.
 * `instalment_unavailable` is worded by the caller from its `detail.items`, so it is the lead sentence here.
 */
export function draftErrorText(status: number | null, reason: string | undefined, message: string): string {
  switch (reason) {
    case "instalment_unavailable": return UNAVAILABLE_LEAD;
    case "source_fields_mixed": return "An invoice is made from the payment schedule or from logged hours, never both.";
    case "source_invalid": return "That is not a way to make an invoice. Choose the payment schedule, or logged hours as the exception.";
    case "instalment_ids_invalid": return "Tick between 1 and 60 instalments.";
    case "due_by_invalid": return "That \"Due up to\" date is not a date. Use the date picker.";
    case "tax_code_invalid": return "That tax code is not valid. Use letters, digits, full stops, underscores and hyphens, up to 32 characters, or leave it blank.";
    case "client_not_found": return "That client could not be found. Pick the client again.";
    case "currency_mixed": return "The instalments you ticked are in more than one currency. Make one invoice per currency.";
    default: break;
  }
  if (status === 403) return "Drafting invoices is limited to finance administrators.";
  return message;
}

/** The cancel-draft answer, in words: how many instalments went back to the schedule. */
export function cancelledWords(released: number): string {
  if (released <= 0) return "Draft cancelled. Nothing was posted to the books because it was never issued.";
  return `Draft cancelled. ${released} ${released === 1 ? "instalment goes" : "instalments go"} back to the payment schedule, ready to invoice again.`;
}

/** Cancel draft's refusals. */
export function cancelErrorText(status: number | null, reason: string | undefined, message: string): string {
  if (status === 403) return "Cancelling a draft invoice is limited to finance administrators.";
  if (status === 404) return "That invoice could not be found. It may have been removed.";
  if (status === 409 && reason === "invoice_unvoid_refused") return "A cancelled invoice that billed instalments cannot be brought back. Draft a new one from the schedule.";
  if (status === 409) return "This invoice has been issued, so it can no longer be cancelled as a draft. Void it instead, which reverses it in the books.";
  return message;
}

/** The draft invoice's lines, as the staff read sends them: an hourly line carries hours and a rate, an instalment line neither. */
export interface InvoiceLineLike {
  description: string;
  kind?: string | null;
  hours?: number | null;
  rate?: number | null;
  amount: number;
  contractId?: string | null;
  instalmentId?: string | null;
}

/** A line with `kind: 'instalment'` (§61.5), or any line with no hours and no rate: billed as a fixed fee, quantity 1. */
export function isFixedFeeLine(l: Pick<InvoiceLineLike, "kind" | "hours" | "rate">): boolean {
  return l.kind === "instalment" || (l.hours == null && l.rate == null);
}

export interface LineCells { description: string; quantity: string; /** "Fixed fee" for an instalment; null for an hourly line (the page formats its rate). */ rate: string | null; amount: number; contractId: string | null; fixedFee: boolean }

/** What one line prints: quantity 1 and "Fixed fee" for an instalment, hours and the rate otherwise. Never the text `undefined`. */
export function lineCells(l: InvoiceLineLike): LineCells {
  if (isFixedFeeLine(l)) {
    return { description: l.description, quantity: "1", rate: "Fixed fee", amount: l.amount, contractId: l.contractId ?? null, fixedFee: true };
  }
  return { description: l.description, quantity: l.hours == null ? "—" : String(l.hours), rate: null, amount: l.amount, contractId: l.contractId ?? null, fixedFee: false };
}

/** True when an invoice has at least one instalment line (the cancel wording, and the contract link on blockers). */
export const hasInstalmentLines = (lines: readonly Pick<InvoiceLineLike, "kind">[]): boolean => lines.some((l) => l.kind === "instalment");

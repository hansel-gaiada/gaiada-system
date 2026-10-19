// PV3-08 — the staff "Contracts & billing" area: types and the PURE rules behind its buttons.
//
// Client-safe on purpose (no `server-only`, no I/O): the client components import these to decide what
// to render, and `contracts.test.ts` pins every rule without rendering anything. The readers are in
// `contracts-data.ts` (server-only) and the writes in `contractsActions.ts` ("use server"), the same
// trio as `appraisals{,-data,Actions}.ts`.
//
// Backend: `platform-nest/src/core/contracts.controller.ts` (BFF §16e). Cerbos stays the authority. Nothing
// here decides who may do what; it only decides what to OFFER from what the backend already said about a
// row (`canCountersign`) and from the row's own state.

import type { SignatureTier } from "./billingView";

export type ContractStatus = "draft" | "sent" | "signed" | "declined" | "expired" | "void";

export interface Contract {
  id: string;
  clientId: string;
  clientName: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  reference: string | null;
  version: number;
  supersedesId: string | null;
  status: ContractStatus;
  fileId: string | null;
  bodyMd: string | null;
  value: number | null;
  currency: string;
  startsOn: string | null;
  endsOn: string | null;
  sentAt: string | null;
  signedAt: string | null;
  declineReason: string | null;
  createdBy: string | null;
  createdAt: string;
  clientSigned: boolean;
  providerSigned: boolean;
  termEnded: boolean;
  /** PV3-01: the backend's answer to "may THIS caller countersign THIS row right now". The page shows the
   *  Countersign control only when this is exactly `true`. It is never derived from a role in the browser. */
  canCountersign: boolean;
  /** PV3-07: whether the client sees this row, computed by the backend from the portal's own rules. Declared so
   *  the types merge cleanly; this page does not render it (PV3-09 does). */
  clientVisible?: boolean;
  /** PV5-06: the tier chosen when the contract was SENT (null while draft), the SHA-256 fixed then, when, and whether staff
   *  marked the draft certified. All optional: an older server omits them, and a contract sent before PV5-06 has a null
   *  hash. A missing field claims nothing (the row says "not recorded", never invents a tier). */
  signatureTier?: SignatureTier | null;
  contentSha256?: string | null;
  contentFixedAt?: string | null;
  certifiedRequested?: boolean;
  /** PV5-07: the sealed signed copy (the contract, its evidence page and the company seal), once rendered. Absent and
   *  null read alike: a signed contract says "being prepared", any other says nothing (lib/billingView.ts). */
  signedCopyFileId?: string | null;
  /** PV5-11: certified signing through a provider (here the SIMULATED PSrE at the review stage). All optional: an older
   *  server omits them, and a missing field claims nothing. Never derived from a role in the browser. */
  signatureProvider?: string | null;
  providerEnvelopeId?: string | null;
  /** The backend's answer to "may THIS caller countersign at the provider now". A UI path in `countersignUrl`. */
  canCountersignAtProvider?: boolean;
  countersignUrl?: string | null;
  /** The envelope is at the simulated PSrE: every surface says so. */
  signatureSimulated?: boolean;
  /** This server's certified-signing set-up (`label` e.g. "Simulated PSrE (review stage)"). */
  certifiedSigning?: CertifiedSigningSetup;
  /** DW-10f-2b (BFF §61.4): an agreement or an amendment. An older server omits it, and a missing field claims nothing. */
  kind?: "agreement" | "amendment" | null;
  /** DW-10f-2b (BFF §61.4): the list's summary of the payment schedule. `null` = no instalments; omitted = an older server. */
  scheduleSummary?: ScheduleSummary | null;
  /** DW-10f-2b (DW-D49, BFF §61.4a): the state half of "Finance may add a schedule once": signed, a value above zero, no
   *  schedule, not superseded. Whether THIS person may is the server's call; the page offers the control to `company.manage`. */
  scheduleAddable?: boolean;
}

export interface CertifiedSigningSetup {
  available: boolean;
  provider: string | null;
  label: string | null;
  simulated: boolean;
}

export interface ContractSignature {
  party: "client" | "provider";
  /** PV5-11: the provider a certified signature was made through; null (or absent) is a typed name. */
  provider?: string | null;
  signer: string | null;
  signerName: string;
  signerTitle: string | null;
  signedAt: string;
  /** PV5-06: the hash this signature was made over. */
  contentSha256?: string | null;
  /** DW-10f-2a: the schedule hash this signature copied, when the schedule was fixed at send. Never a claim that anyone
   *  signed a schedule added after signing (BFF §61.4a). Declared, not rendered. */
  scheduleSha256?: string | null;
}

export interface ContractDetail extends Contract {
  signatures: ContractSignature[];
  /** DW-10f-2b (BFF §61.4): the payment schedule with each instalment's state; `null` without instalments, omitted by an older server. */
  schedule?: ContractSchedule | null;
}

export interface InvoicePayment {
  id: string;
  invoiceId: string;
  clientId: string | null;
  clientName: string | null;
  amount: number;
  currency: string;
  paidOn: string;
  method: string | null;
  reference: string | null;
  status: "pending" | "confirmed" | "rejected";
  note: string | null;
  proofFileId: string | null;
  recordedBy: string | null;
  recordedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  rejectedReason: string | null;
  invoiceTotal: number;
  invoiceStatus: string;
  /** PV3-07: backend-computed "the client sees this". Declared, not rendered (PV3-09). */
  clientVisible?: boolean;
}

// ── contract groups ─────────────────────────────────────────────────────────────────────────────

export type ContractGroupKey = "draft" | "sent" | "signed" | "void" | "closed";

export interface ContractGroup {
  key: ContractGroupKey;
  label: string;
  /** Said under the heading, so a reader knows what the state means for the relationship. */
  hint: string;
  rows: Contract[];
}

/**
 * Draft · Sent · Signed · Void, in that order, plus a fifth "Declined or expired" group that exists only
 * when it has rows. The ticket names four groups, but the status CHECK admits `declined` and `expired`
 * too, and dropping a row because it fits no heading would hide a contract the client has refused.
 *
 * Every group is returned (even an empty one) except the fifth, so the page can say "none" per group
 * instead of making a whole state vanish. Rows keep the order they arrived in (the backend sends newest
 * first).
 */
export function groupContracts(rows: Contract[]): ContractGroup[] {
  const groups: ContractGroup[] = [
    { key: "draft", label: "Draft", hint: "Not sent. The client cannot see these.", rows: [] },
    { key: "sent", label: "Sent", hint: "With the client. A contract is Signed once both parties have signed.", rows: [] },
    { key: "signed", label: "Signed", hint: "Both parties have signed.", rows: [] },
    { key: "void", label: "Void", hint: "Cancelled. Kept for the record.", rows: [] },
  ];
  const closed: ContractGroup = { key: "closed", label: "Declined or expired", hint: "The client declined, or the term lapsed unsigned.", rows: [] };
  const by = new Map(groups.map((g) => [g.key as string, g]));
  for (const r of rows) {
    const g = by.get(r.status);
    if (g) g.rows.push(r);
    else closed.rows.push(r);
  }
  return closed.rows.length > 0 ? [...groups, closed] : groups;
}

// ── what to offer on a contract row ─────────────────────────────────────────────────────────────

export interface ContractActions {
  /** Edit the draft in place. Only a draft: a sent or signed contract is never edited, it is re-issued. */
  edit: boolean;
  /** Present for a draft only. `enabled: false` carries the reason the button shows next to it. */
  send: { shown: boolean; enabled: boolean; reason: string | null };
  /** Shown ONLY when the backend said `canCountersign: true`. A role in the browser never decides this. */
  countersign: boolean;
  /** Void from any state but void itself, behind a confirm. */
  void: boolean;
  /** PV5-09: "Mark certified", a draft only, and (PV5-F4, owner ruling PV-D44: simple signing only) ONLY while the backend
   *  says `certifiedSigning.available`. When it does not, nothing is rendered: no disabled button, no reason. `enabled` and
   *  `reason` are kept for the row's markup and are always `true` and `null`. */
  markCertified: { shown: boolean; enabled: boolean; reason: string | null };
  /** PV5-F4: "Countersign at <provider>", a link. The backend's `canCountersignAtProvider` and a `countersignUrl`, AND the
   *  provider still being available: a switched-off provider's page cannot be reached, so the link is not offered. */
  countersignAtProvider: boolean;
  /** DW-10f-2b (DW-D49): "Add a payment schedule", on a signed contract the backend says `scheduleAddable`. Whether THIS person
   *  is offered it is the page's `company.manage` gate; the server decides either way. */
  addSchedule: boolean;
  /** DW-10f-2b: the payment schedule's own editor, on a draft only (a sent contract's schedule is fixed and read-only). */
  editSchedule: boolean;
}

/** PV-D43 / PV-D44: certified signing is available only while a provider is switched on (a simulated one for the review
 *  stage, behind a server flag; PV-D44, 2026-10-15: simple signing only, the simulated path is to be switched off). Whether
 *  it is offered comes from the backend per row (`certifiedSigning.available`), never from a constant in the browser. When
 *  the server says no (or an older server says nothing) the certified controls are NOT RENDERED, and the 409 below stays
 *  handled either way: the server is the authority. A contract that is already certified keeps its read-only tier,
 *  provider and signed-copy display. */
export const CERTIFIED_UNAVAILABLE_REASON = "Certified signing isn't set up yet. Every contract is signed by typed name and sealed by our company for now.";

/** The mark-certified route's refusals, in words. Branch on `reason`, never on the message. */
export function markCertifiedErrorText(status: number | null, reason: string | undefined, message: string): string {
  if (status === 409 && reason === "no_certified_provider") return CERTIFIED_UNAVAILABLE_REASON;
  if (status === 403) return "Only company administrators can mark a contract certified.";
  if (status === 400) return "Only a draft can be marked certified. A sent contract's tier is already fixed.";
  return message;
}

export const SEND_BLOCKED_REASON = "Write the terms or attach a PDF before sending. A contract with nothing to read cannot be signed.";

/** True when a contract has something for the client to read: in-app terms or an attached file. */
export function hasDocument(c: Pick<Contract, "bodyMd" | "fileId">): boolean {
  return Boolean((c.bodyMd ?? "").trim()) || Boolean(c.fileId);
}

export function contractActions(c: Contract): ContractActions {
  const isDraft = c.status === "draft";
  const docOk = hasDocument(c);
  const scheduleReason = isDraft ? scheduleSendBlock(c) : null;
  // `=== true`: an older backend that omits the field reads as "not set up".
  const certifiedAvailable = c.certifiedSigning?.available === true;
  return {
    edit: isDraft,
    // Both reasons are said when both apply: a person who fixes the one should not meet the other by surprise.
    send: {
      shown: isDraft,
      enabled: isDraft && docOk && !scheduleReason,
      reason: isDraft ? ([!docOk ? SEND_BLOCKED_REASON : null, scheduleReason].filter(Boolean).join(" ") || null) : null,
    },
    // `=== true`, not truthiness: an older backend that omits the field must read as "not offered".
    countersign: c.canCountersign === true,
    void: c.status !== "void",
    markCertified: {
      shown: isDraft && c.certifiedRequested !== true && certifiedAvailable,
      enabled: true,
      reason: null,
    },
    countersignAtProvider: certifiedAvailable && c.canCountersignAtProvider === true && Boolean(c.countersignUrl),
    // `=== true`: an older server that omits the field reads as "not addable".
    addSchedule: c.status === "signed" && c.scheduleAddable === true,
    editSchedule: isDraft,
  };
}

/** The "who has signed" line for a sent contract: party, name, title and date, one per signature. */
export function signatureLine(s: ContractSignature, formatDate: (iso: string) => string, providerLabel?: string | null): string {
  const who = s.party === "provider" ? "Our company" : "Client";
  const title = s.signerTitle ? `, ${s.signerTitle}` : "";
  const via = s.provider ? `, through ${providerName(s.provider, providerLabel)}` : "";
  return `${who}: ${s.signerName}${title}, ${formatDate(s.signedAt)}${via}`;
}

/** The provider named for a reader: the backend's label when it sent one, else a plain phrase. */
export function providerName(provider: string | null | undefined, label?: string | null): string {
  if (!provider) return "";
  return label && label.trim() ? label : "a certified provider";
}

/** What the staff row says a certified contract is waiting for at the provider; null when it is not that case. */
export function certifiedWaitingText(c: Pick<Contract, "status" | "certifiedRequested" | "signatureProvider" | "providerEnvelopeId" | "certifiedSigning" | "signatureTier">): string | null {
  if (c.status !== "sent") return null;
  const certified = c.certifiedRequested === true || c.signatureTier === "certified";
  if (!certified || c.providerEnvelopeId) return null;
  return `Waiting for the client to start signing at ${c.certifiedSigning?.label ?? "the signing provider"}.`;
}

/** What a sent contract is waiting for, in words. Both parties must sign, in either order. */
export function awaitingText(c: Pick<Contract, "status" | "clientSigned" | "providerSigned">): string | null {
  if (c.status !== "sent") return null;
  if (c.clientSigned && !c.providerSigned) return "The client has signed. Waiting for our countersignature.";
  if (!c.clientSigned && c.providerSigned) return "We have signed. Waiting for the client.";
  if (!c.clientSigned && !c.providerSigned) return "Waiting for both parties to sign.";
  return null;
}

// ── payments ────────────────────────────────────────────────────────────────────────────────────

export interface PaymentDecisionState {
  /** May the form be submitted as it stands? */
  canSubmit: boolean;
  /** Shown beside a disabled Reject. Null when submittable. */
  reason: string | null;
}

/** Confirm needs nothing. Reject needs a reason: the client reads it in their portal and has no other way
 *  to tell whether to re-send the transfer or query the reference. Mirrors the route's own 400. */
export function paymentDecisionState(decision: "confirm" | "reject", reason: string): PaymentDecisionState {
  if (decision === "confirm") return { canSubmit: true, reason: null };
  if (!reason.trim()) return { canSubmit: false, reason: "Say why you are rejecting this payment. The client sees your reason." };
  return { canSubmit: true, reason: null };
}

/** The platform's refusals for a decision, in words. The maker-checker one is a 403 the person must be
 *  told in full: it is the single most likely refusal here and "forbidden" would read as a bug. */
export function decideErrorText(status: number | null, message: string): string {
  if (/someone other than whoever recorded/i.test(message)) {
    return "You recorded this payment, so someone else has to confirm or reject it. Ask a colleague.";
  }
  if (/already (confirmed|rejected)/i.test(message)) return "This payment has already been decided. Refresh to see its current state.";
  if (status === 403) return "You don't have permission to decide payments for this company.";
  return message;
}

/** The platform's refusals for a countersignature, in words. */
export function countersignErrorText(status: number | null, message: string): string {
  if (status === 403) return "Only a company owner can countersign. You can ask the owner to open this page and sign.";
  return message;
}

// ── the tab badge ───────────────────────────────────────────────────────────────────────────────

/** True when the backend says this caller may countersign this row now, typed or at the provider (PV5-11). */
export function needsMyCountersign(c: Pick<Contract, "canCountersign" | "canCountersignAtProvider">): boolean {
  return c.canCountersign === true || c.canCountersignAtProvider === true;
}

/** Pending payments plus contracts awaiting OUR countersignature (those the backend says this caller may
 *  countersign now: the layout counts rows whose `canCountersign` or `canCountersignAtProvider` is true). Both are things this company has
 *  to do, which is what the hub's badges mean. */
export function billingBadgeCount(pendingPayments: number, contractsToCountersign: number): number {
  return pendingPayments + contractsToCountersign;
}

// ── the draft form ──────────────────────────────────────────────────────────────────────────────

export interface ContractFormValues {
  title: string;
  value: string;
  startsOn: string;
  endsOn: string;
}

/** Field-level checks the browser can make before the round trip. The backend repeats all of them. */
export function validateContractForm(v: ContractFormValues): { field: keyof ContractFormValues; message: string } | null {
  if (!v.title.trim()) return { field: "title", message: "Give the contract a title." };
  if (v.value.trim() !== "") {
    const n = Number(v.value);
    if (!Number.isFinite(n) || n < 0) return { field: "value", message: "The value must be a number that is not negative." };
  }
  if (v.startsOn && v.endsOn && v.endsOn < v.startsOn) return { field: "endsOn", message: "The end date cannot be before the start date." };
  return null;
}

/** The largest PDF the page will send. The files route accepts 25 MB; 10 MB matches the portal's receipt cap
 *  and keeps a base64 JSON body well inside what a server action carries. */
export const MAX_CONTRACT_FILE_BYTES = 10 * 1024 * 1024;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The payment schedule (DW-10f-2b; FRONTEND-BFF-CONTRACT §61.3, §61.4, §61.4a, §61.9)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Pure and client-safe, like everything above: the editor, the row, the readers and the actions import these, and
// `contracts.test.ts` pins every rule. The server is the authority on all of it (PD610 to PD618); this file decides what
// to OFFER and puts every refusal in a sentence.
//
// ── MONEY ───────────────────────────────────────────────────────────────────────────────────────────
// Amounts the person types stay DECIMAL STRINGS and go to the server as strings (it writes them `$n::numeric`). Every sum,
// split and comparison here is BigInt over the currency's minor unit, never a float, so "the rows add up" is exact and a
// preset's remainder lands to the minor unit. The server's `finance_currencies.minor_unit` is the truth; `minorUnitOf` is the
// browser's table for the few currencies this group bills in, and a mismatch is answered by the server as `schedule_precision`.

export type InstalmentState = "scheduled" | "upcoming" | "due" | "invoicing" | "invoiced" | "paid" | "not_billed";

export interface InstalmentDue {
  kind: "on_signing" | "date";
  /** A date: the due date. On signing: the signed date once signed, else null. */
  on: string | null;
}

export interface Instalment {
  id: string;
  position: number;
  label: string;
  amount: number;
  due: InstalmentDue;
  /** §61.3. A state this file does not know prints as it came (never a guess). */
  state: InstalmentState | string;
  /** Why a `not_billed` instalment is not billed: `superseded`, `deleted`, `void`, `declined`, `expired`. */
  notBilledReason?: string | null;
  /** The live invoice that claims it (its number once issued). */
  invoice: { id: string; invoiceNo: string | null; status: string } | null;
}

export interface ContractSchedule {
  currency: string;
  value: number | null;
  total: number;
  matchesValue: boolean;
  scheduleSha256: string | null;
  /** DW-D49: set when Finance added the schedule after the contract was signed. */
  addedAfterSigning: { at: string; by: { id: string; name: string | null } } | null;
  instalments: Instalment[];
}

export interface ScheduleSummary {
  count: number;
  total: number;
  matchesValue: boolean;
}

/** One row of the editor: all text, as the person typed it. `due` is `"on_signing"`, a `YYYY-MM-DD` date, or `""` (not chosen). */
export interface ScheduleDraftRow {
  label: string;
  amount: string;
  due: string;
}

export const MAX_INSTALMENTS = 60;
export const MAX_INSTALMENT_LABEL = 120;
export const ON_SIGNING = "on_signing";

const ZERO_DECIMAL = new Set(["IDR", "JPY", "KRW", "VND", "CLP", "PYG", "UGX", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/** The decimals a currency allows. Two unless it is one of the zero- or three-decimal currencies. */
export function minorUnitOf(currency: string): number {
  const c = currency.trim().toUpperCase();
  return ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
}

/** A real calendar date in YYYY-MM-DD (no 2026-02-30). */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** A plain non-negative decimal ("1500000", "12.5") as minor units, or null when it is not one or carries more decimals than
 *  `minor` allows. No sign, no exponent, no grouping: what the server's `canonicalAmount` accepts. */
export function toMinor(text: string, minor: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > minor) return null;
  return BigInt(m[1] + (frac + "0".repeat(minor)).slice(0, minor));
}

/** Minor units back to a plain decimal string with exactly `minor` decimals ("3333334", "12.50"). */
export function fromMinor(units: bigint, minor: number): string {
  const neg = units < BigInt(0);
  const digits = (neg ? -units : units).toString().padStart(minor + 1, "0");
  const int = minor > 0 ? digits.slice(0, digits.length - minor) : digits;
  const frac = minor > 0 ? `.${digits.slice(digits.length - minor)}` : "";
  return `${neg ? "-" : ""}${int}${frac}`;
}

/** A JSON number (the contract's `value`) as minor units. A value with more decimals than the currency keeps the nearest. */
export function valueToMinor(value: number | null | undefined, currency: string): bigint | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const minor = minorUnitOf(currency);
  return toMinor(value.toFixed(minor), minor);
}

/** "IDR 1,234,567" (zero-decimal) or "USD 1,234.50": a fixed locale, so server and browser agree (no hydration drift). */
export function formatMinor(units: bigint, currency: string, withCurrency = true): string {
  const minor = minorUnitOf(currency);
  const plain = fromMinor(units, minor);
  const negative = plain.startsWith("-");
  const [int, frac] = plain.replace("-", "").split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
  return withCurrency ? `${currency.toUpperCase()} ${body}` : body;
}

/** A JSON amount (a number the server sent for display) as the same text. */
export function formatAmountNumber(amount: number, currency: string): string {
  const minor = minorUnitOf(currency);
  const u = toMinor(Math.abs(amount).toFixed(minor), minor);
  return u === null ? `${currency} ${amount}` : formatMinor(amount < 0 ? -u : u, currency);
}

// ── presets ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Split `total` (minor units) into `n` parts: every part rounded DOWN to the minor unit, the remainder on the FIRST part, so
 * the parts add up exactly (BFF §61.4). `splitEvenly(10_000_000, 3)` is 3,333,334, 3,333,333, 3,333,333.
 */
export function splitEvenly(total: bigint, n: number): bigint[] {
  if (!Number.isInteger(n) || n < 1) return [];
  const count = BigInt(n);
  const base = total / count;
  const rest = total % count;
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + rest : base));
}

/** The date `months` calendar months after `first` on the SAME day of the month, or that month's last day when it is shorter.
 *  Anchored on `first`'s day, never chained: 31 Jan, 28 Feb, 31 Mar (not 28 Mar). Null when `first` is not a date. */
export function addMonthsClamped(first: string, months: number): string | null {
  if (!isIsoDate(first)) return null;
  const [y, m, d] = first.split("-").map(Number);
  const target = y * 12 + (m - 1) + months;
  const ty = Math.floor(target / 12);
  const tm = target % 12; // 0-based
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${String(ty).padStart(4, "0")}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/** The date a preset row gets: a valid date as typed, else "" (blank and required, §61.4). */
const dateOrBlank = (s: string | null | undefined): string => (s && isIsoDate(s) ? s : "");

/** "All on signing": one row, the whole value. Empty without a value. */
export function presetAllOnSigning(value: number | null | undefined, currency: string): ScheduleDraftRow[] {
  const v = valueToMinor(value, currency);
  if (v === null || v <= BigInt(0)) return [];
  return [{ label: "Payment on signing", amount: fromMinor(v, minorUnitOf(currency)), due: ON_SIGNING }];
}

/** 50/50: "Deposit (50%)" on signing and "Balance (50%)" on `balanceDue` (blank when none). The remainder is on the deposit. */
export function presetFiftyFifty(value: number | null | undefined, currency: string, balanceDue?: string | null): ScheduleDraftRow[] {
  const v = valueToMinor(value, currency);
  if (v === null || v <= BigInt(0)) return [];
  const minor = minorUnitOf(currency);
  const [deposit, balance] = splitEvenly(v, 2);
  return [
    { label: "Deposit (50%)", amount: fromMinor(deposit, minor), due: ON_SIGNING },
    { label: "Balance (50%)", amount: fromMinor(balance, minor), due: dateOrBlank(balanceDue) },
  ];
}

/** Monthly x N (1 to 60): "Month 1" to "Month N", the first on `firstDue` (blank when none), each next on the same day of the
 *  following month or that month's last day. The remainder is on Month 1. */
export function presetMonthly(value: number | null | undefined, currency: string, n: number, firstDue?: string | null): ScheduleDraftRow[] {
  const v = valueToMinor(value, currency);
  if (v === null || v <= BigInt(0) || !Number.isInteger(n) || n < 1 || n > MAX_INSTALMENTS) return [];
  const minor = minorUnitOf(currency);
  const first = dateOrBlank(firstDue);
  return splitEvenly(v, n).map((part, i) => ({
    label: `Month ${i + 1}`,
    amount: fromMinor(part, minor),
    due: first ? (addMonthsClamped(first, i) ?? "") : "",
  }));
}

// ── the live line ───────────────────────────────────────────────────────────────────────────────

export type ScheduleLineKind = "empty" | "ok" | "short" | "over" | "invalid" | "no_value";

export interface ScheduleLine {
  kind: ScheduleLineKind;
  /** The sentence the editor shows under the rows. */
  text: string;
  /** True only for `ok`: the rows add up to the value exactly. */
  addsUp: boolean;
}

/**
 * "Adds up to IDR 120,000,000 of 120,000,000", "IDR 5,000 short" or "IDR 5,000 over" (BFF §61.9), from the rows as typed.
 * A row whose amount is not a plain decimal within the currency's decimals makes the line `invalid`: a sum over rows the
 * server would refuse says nothing.
 */
export function scheduleLine(rows: readonly ScheduleDraftRow[], value: number | null | undefined, currency: string): ScheduleLine {
  const minor = minorUnitOf(currency);
  const v = valueToMinor(value, currency);
  if (rows.length === 0) {
    return { kind: "empty", addsUp: false, text: "No instalments yet. Pick a preset or add a row." };
  }
  let total = BigInt(0);
  for (const r of rows) {
    const u = toMinor(r.amount, minor);
    if (u === null || u <= BigInt(0)) {
      return { kind: "invalid", addsUp: false, text: `Every amount must be a positive number with at most ${minor} ${minor === 1 ? "decimal" : "decimals"} for ${currency.toUpperCase()}.` };
    }
    total += u;
  }
  if (v === null || v <= BigInt(0)) {
    return { kind: "no_value", addsUp: false, text: "This contract has no value, so it carries no payment schedule. Set a value first." };
  }
  if (total === v) return { kind: "ok", addsUp: true, text: `Adds up to ${formatMinor(total, currency)} of ${formatMinor(v, currency, false)}.` };
  const diff = total > v ? total - v : v - total;
  const word = total > v ? "over" : "short";
  return {
    kind: total > v ? "over" : "short", addsUp: false,
    text: `${formatMinor(diff, currency)} ${word}. The rows add up to ${formatMinor(total, currency)} of ${formatMinor(v, currency, false)}.`,
  };
}

// ── what the browser can check before the round trip ────────────────────────────────────────────

export interface ScheduleProblem {
  /** The row (0-based) the problem is on; null for the schedule as a whole. */
  index: number | null;
  field: "label" | "amount" | "due" | "rows" | "order";
  message: string;
}

/** The server's `schedule_invalid` and `schedule_order_invalid`, said before the round trip. The server repeats every one. */
export function validateScheduleRows(rows: readonly ScheduleDraftRow[], currency: string, opts: { requireOne?: boolean } = {}): ScheduleProblem | null {
  if (rows.length > MAX_INSTALMENTS) return { index: null, field: "rows", message: `A schedule has at most ${MAX_INSTALMENTS} instalments.` };
  if (opts.requireOne && rows.length === 0) return { index: null, field: "rows", message: "Add at least one instalment." };
  const minor = minorUnitOf(currency);
  let lastDate: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const n = i + 1;
    const label = r.label.trim();
    if (!label) return { index: i, field: "label", message: `Give instalment ${n} a label.` };
    if (label.length > MAX_INSTALMENT_LABEL) return { index: i, field: "label", message: `Instalment ${n} has a label longer than ${MAX_INSTALMENT_LABEL} characters.` };
    const u = toMinor(r.amount, minor);
    if (u === null) {
      return { index: i, field: "amount", message: `Instalment ${n}: the amount must be a positive number with at most ${minor} ${minor === 1 ? "decimal" : "decimals"} for ${currency.toUpperCase()}.` };
    }
    if (u <= BigInt(0)) return { index: i, field: "amount", message: `Instalment ${n}: the amount must be more than zero.` };
    if (r.due === ON_SIGNING) {
      if (i !== 0) return { index: i, field: "order", message: "Only the first instalment can be due on signing, and only one can." };
      continue;
    }
    if (!isIsoDate(r.due)) return { index: i, field: "due", message: `Instalment ${n}: choose "On signing" or a due date.` };
    if (lastDate !== null && r.due < lastDate) return { index: i, field: "order", message: `Instalment ${n} is due before the one above it. Put the dates in order.` };
    lastDate = r.due;
  }
  return null;
}

/** The body of `PUT …/schedule` and `POST …/schedule/after-signing`: amounts as the strings typed. */
export function scheduleBody(rows: readonly ScheduleDraftRow[]): { instalments: { label: string; amount: string; due: string }[] } {
  return { instalments: rows.map((r) => ({ label: r.label.trim(), amount: r.amount.trim(), due: r.due })) };
}

/** The editor's starting rows from a saved schedule. */
export function rowsFromSchedule(s: ContractSchedule | null | undefined): ScheduleDraftRow[] {
  if (!s) return [];
  const minor = minorUnitOf(s.currency);
  return s.instalments.map((i) => ({
    label: i.label,
    amount: fromMinor(toMinor(i.amount.toFixed(minor), minor) ?? BigInt(0), minor),
    due: i.due.kind === "on_signing" ? ON_SIGNING : (i.due.on ?? ""),
  }));
}

// ── Send, and the words ─────────────────────────────────────────────────────────────────────────

export const SEND_SCHEDULE_REASON = "The payment schedule must add up to the value before sending.";

/**
 * Why Send is disabled for the schedule, or null. A contract with a value above zero needs a schedule that adds up to it
 * (`scheduleSummary.matchesValue`, PD612's rule). `scheduleSummary: null` is "no instalments". An omitted field is an older
 * server: it claims nothing, so Send is left to the server's own check.
 */
export function scheduleSendBlock(c: Pick<Contract, "value" | "scheduleSummary">): string | null {
  if (c.scheduleSummary === undefined) return null;
  const valued = c.value != null && c.value > 0;
  if (c.scheduleSummary === null) return valued ? SEND_SCHEDULE_REASON : null;
  return c.scheduleSummary.matchesValue ? null : SEND_SCHEDULE_REASON;
}

/** "On signing" or "Due 12 Oct 2026": the schedule's due column, in the caller's date format. */
export function dueWords(due: InstalmentDue, formatDate: (iso: string) => string): string {
  if (due.kind === "on_signing") return due.on ? `On signing (${formatDate(due.on)})` : "On signing";
  return due.on ? `Due ${formatDate(due.on)}` : "Due date not set";
}

/** Why a `not_billed` instalment is not billed, in words. */
export function notBilledWhy(reason: string | null | undefined): string {
  switch (reason) {
    case "superseded": return "a newer signed version replaced the agreement";
    case "deleted": return "the agreement was removed";
    case "void": return "the agreement was voided";
    case "declined": return "the client declined the agreement";
    case "expired": return "the agreement expired unsigned";
    default: return "the agreement is closed";
  }
}

/** §61.3's staff column, one phrase per state. A state this file does not know prints as it came. */
export function instalmentStateWords(i: Pick<Instalment, "state" | "due" | "invoice" | "notBilledReason">, formatDate: (iso: string) => string): string {
  switch (i.state) {
    case "scheduled": return "Scheduled";
    case "upcoming": return i.due.on ? `Upcoming, ${formatDate(i.due.on)}` : "Upcoming";
    case "due": return "Due: ready to invoice";
    case "invoicing": return "On a draft invoice";
    case "invoiced": return i.invoice?.invoiceNo ? `Invoiced, ${i.invoice.invoiceNo}` : "Invoiced";
    case "paid": return "Paid";
    case "not_billed": return `Not billed (${notBilledWhy(i.notBilledReason)})`;
    default: return String(i.state);
  }
}

/** "Added after signing by Olive Owner, 18 Oct 2026" (BFF §61.9). The name is the server's; a missing one says nothing of who. */
export function addedAfterSigningWords(a: NonNullable<ContractSchedule["addedAfterSigning"]>, formatDate: (iso: string) => string): string {
  return `Added after signing${a.by.name ? ` by ${a.by.name}` : ""}, ${formatDate(a.at)}`;
}

export const AFTER_SIGNING_WARNING =
  "This agreement is already signed. The schedule must restate the payment terms the agreement states. It can be added once and never changed.";

interface ScheduleErrorDetail { value?: number; total?: number }

/**
 * Every refusal of the schedule routes (§61.4, §61.4a) and of Send, in a sentence. Branch on `reason`, never on the message.
 * `detail` is the server's figures for `schedule_total_mismatch`.
 */
export function scheduleErrorText(
  status: number | null, reason: string | undefined, message: string, detail?: ScheduleErrorDetail | null, currency = "",
): string {
  const money = (n: number) => (currency ? formatAmountNumber(n, currency) : String(n));
  switch (reason) {
    case "contract_not_found": return "That contract could not be found. It may have been removed.";
    case "schedule_frozen": return "This contract has been sent, so its payment schedule is fixed and can no longer be changed.";
    case "contract_terms_frozen": return "This contract has been sent, so its value and payment schedule are fixed.";
    case "schedule_invalid": return "The schedule is not valid: every instalment needs a label, a positive amount and a due date or \"On signing\", and there can be at most 60.";
    case "schedule_order_invalid": return "Only the first instalment can be due on signing, and the dates must run in order.";
    case "currency_unknown": return "This contract's currency is not one the books know, so a schedule cannot be saved. Check the currency code.";
    case "schedule_precision": return "An amount has more decimals than this currency allows.";
    case "schedule_needs_value": return "This contract has no value, so it carries no payment schedule. Set a value first.";
    case "schedule_total_mismatch":
      return detail && typeof detail.value === "number" && typeof detail.total === "number"
        ? `The instalments add up to ${money(detail.total)}, but the contract's value is ${money(detail.value)}. They must match exactly.`
        : "The instalments must add up exactly to the contract's value.";
    case "not_allowed_via_automation": return "A schedule can be added to a signed agreement only by a person, not through automation.";
    case "contract_not_signed": return "Only a signed agreement can have a schedule added this way. A draft's schedule is edited on the draft.";
    case "contract_closed": return "This agreement is void, expired or declined, so a schedule cannot be added.";
    case "contract_superseded": return "A newer signed version replaces this agreement, so its instalments could never be billed.";
    case "schedule_exists": return "This agreement already has a payment schedule. One can be added only once and is never changed.";
    case "schedule_changed": return "The agreement changed while the schedule was being added, so nothing was saved. Reload the page and look again.";
    case "conflict": return "The contract changed while you were saving, so nothing was saved. Reload the page and try again.";
    default: break;
  }
  if (status === 403) return "You don't have permission to change this contract's payment schedule.";
  return message;
}

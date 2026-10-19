import "server-only";
// DEMO_MODE fixtures for PV3-08 — the staff Contracts & billing area (docs/FRONTEND-BFF-CONTRACT.md §16e).
//
// ONE stateful store of Northwind Traders' (`cl-1`) contracts and payment claims, read and written by:
//   GET   /api/:t/contracts[?clientId&status]          GET /api/:t/contracts/:id
//   POST  /api/:t/contracts                            PATCH /api/:t/contracts/:id      (draft edit, void)
//   POST  /api/:t/contracts/:id/send                   POST  /api/:t/contracts/:id/countersign
//   GET   /api/:t/invoice-payments[?clientId&status]   POST  /api/:t/invoice-payments/:id/decide
//   PUT   /api/:t/contracts/:id/schedule               POST  /api/:t/contracts/:id/schedule/after-signing   (DW-10f, BFF §61.4, §61.4a)
//   GET   /api/:t/invoices/billable-instalments        (DW-10f, BFF §61.5; the invoice POST and void live beside the invoice store)
// and by the hub Overview fixture (`demoBillingNeedsUs` / `demoBillingNeedsClient`), so the Overview's
// items, the tab badge and this area can never disagree: deciding a payment here removes it from "waiting
// on us" there.
//
// It models the REAL controller's refusals, not a friendly subset (the point of a fixture that drives a
// browser test): authorize FIRST, and only then validate the body (an unauthorized caller with an empty
// body gets 403, never 400); a draft only is editable; a draft with neither terms nor file cannot be sent;
// a contract is Signed only when BOTH parties have signed, in either order; countersign is owner-only; a
// payment cannot be decided by whoever recorded it; a reject needs a reason; a repeat of any of these
// answers with the controller's own message.
//
// Who is who (see lib/demoIdentity.ts):
//   demo-hansel (platform_admin) and demo-owner (owner) may do everything, including countersign.
//   dept-manager (a manager) may read contracts only.
//   everyone else is refused every one of these routes (403 with the Cerbos denial text).
import type { DemoResult } from "./demoFixtures";
import { isIsoDate, minorUnitOf } from "./contracts";

const CLIENT_ID = "cl-1";

type Status = "draft" | "sent" | "signed" | "declined" | "expired" | "void";
interface Signature { party: "client" | "provider"; signer: string | null; signerName: string; signerTitle: string | null; signedAt: string }
/** DW-10f: one row of a contract's payment schedule (`contract_instalments`). `invoiceId` is the claim: set when a live invoice bills it,
 *  released when that invoice is voided. The state is DERIVED on read (`stateOf`), never stored, exactly as the server does (§61.3). */
interface DemoInstalment {
  id: string; position: number; label: string; amount: number; dueKind: "on_signing" | "date"; dueOn: string | null; invoiceId: string | null;
}
interface DemoContract {
  id: string; clientId: string; clientName: string; projectId: string | null; projectName: string | null;
  title: string; reference: string | null; version: number; status: Status; fileId: string | null; bodyMd: string | null;
  value: number | null; currency: string; startsOn: string | null; endsOn: string | null;
  sentAt: string | null; signedAt: string | null; declineReason: string | null; createdAt: string; signatures: Signature[];
  /** DW-10f: an agreement (the default) or an amendment with its own value and schedule. */
  kind?: "agreement" | "amendment"; amendsId?: string | null;
  /** DW-10f: the payment schedule; absent = none. */
  instalments?: DemoInstalment[];
  /** DW-D49: who added the schedule after the contract was signed, and when. */
  scheduleAdded?: { at: string; by: string } | null;
}
interface DemoPayment {
  id: string; invoiceId: string; clientId: string; clientName: string; amount: number; currency: string; paidOn: string;
  method: string; reference: string | null; status: "pending" | "confirmed" | "rejected"; note: string | null;
  proofFileId: string | null; recordedBy: string; recordedAt: string; confirmedBy: string | null; confirmedAt: string | null;
  rejectedReason: string | null; invoiceTotal: number; invoiceStatus: string;
}

const daysAgo = (n: number): string => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString(); };
const dayOnly = (n: number): string => daysAgo(n).slice(0, 10);

// Lumen Studio (`cl-3`) carries its own contracts and payments so the billing e2e can drive the whole flow
// (draft, send, countersign, confirm) WITHOUT touching Northwind's items (the hub Overview spec asserts them
// by name) or Cedar Group's (cl-2 must stay empty: another spec asserts its empty state). The demo store is
// shared across parallel specs, so each spec needs a client of its own.
const LUMEN = { clientId: "cl-3", clientName: "Lumen Studio", projectId: null, projectName: null, version: 1, currency: "USD", startsOn: null, endsOn: null, declineReason: null };

/** A schedule row for a seed: `due` is `"on_signing"` or a YYYY-MM-DD date. */
const inst = (cid: string, n: number, label: string, amount: number, due: string, invoiceId: string | null = null): DemoInstalment => ({
  id: `di-${cid}-${n}`, position: n, label, amount, dueKind: due === "on_signing" ? "on_signing" : "date", dueOn: due === "on_signing" ? null : due, invoiceId,
});

// Viceroy (`cl-4`, a group company that is OUR client) carries the payment-schedule cases (DW-10f, BFF §61.9), in IDR, so that
// `e2e/contract-billing.spec.ts` can drive the whole flow without touching Northwind's items (the hub specs assert them by
// name), Cedar Group's empty state, or Lumen Studio's send/countersign flow (`client-billing.spec.ts`). The store is shared by every
// spec on the same server, so each spec needs a client of its own.
const VICEROY = { clientId: "cl-4", clientName: "Viceroy", projectId: null, projectName: null, version: 1, currency: "IDR", declineReason: null };

const seedContracts = (): DemoContract[] => [
  { id: "dk-1", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: "p-web-1", projectName: "Website redesign", title: "Statement of Work: redesign", reference: "GDA-2026-014", version: 1, status: "sent", fileId: "f-1", bodyMd: null, value: 18000, currency: "USD", startsOn: dayOnly(30), endsOn: dayOnly(-120), sentAt: daysAgo(4), signedAt: null, declineReason: null, createdAt: daysAgo(6), signatures: [] },
  { id: "dk-2", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Master services agreement 2026", reference: "GDA-2026-020", version: 1, status: "draft", fileId: null, bodyMd: "## Master services agreement\n\nThe parties agree to the terms set out here.", value: null, currency: "USD", startsOn: null, endsOn: null, sentAt: null, signedAt: null, declineReason: null, createdAt: daysAgo(2), signatures: [] },
  { id: "dk-3", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Hosting addendum", reference: null, version: 1, status: "draft", fileId: null, bodyMd: null, value: 1200, currency: "USD", startsOn: null, endsOn: null, sentAt: null, signedAt: null, declineReason: null, createdAt: daysAgo(1), signatures: [] },
  { id: "dk-4", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Retainer agreement", reference: "GDA-2026-017", version: 1, status: "sent", fileId: null, bodyMd: "Monthly retainer, ninety days' notice.", value: 4000, currency: "USD", startsOn: dayOnly(14), endsOn: null, sentAt: daysAgo(9), signedAt: null, declineReason: null, createdAt: daysAgo(10),
    signatures: [{ party: "client", signer: "demo-client", signerName: "Dana Whitfield", signerTitle: "Head of Marketing", signedAt: daysAgo(3) }] },
  { id: "dk-5", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Mutual NDA", reference: "GDA-2026-009", version: 1, status: "signed", fileId: "f-1", bodyMd: null, value: null, currency: "USD", startsOn: null, endsOn: null, sentAt: daysAgo(40), signedAt: daysAgo(35), declineReason: null, createdAt: daysAgo(41),
    signatures: [
      { party: "client", signer: "demo-client", signerName: "Dana Whitfield", signerTitle: "Head of Marketing", signedAt: daysAgo(36) },
      { party: "provider", signer: "demo-owner", signerName: "Olive Owner", signerTitle: "Owner", signedAt: daysAgo(35) },
    ] },
  { id: "dk-6", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Pilot agreement (superseded)", reference: "GDA-2026-002", version: 1, status: "void", fileId: null, bodyMd: "Pilot terms.", value: 2500, currency: "USD", startsOn: null, endsOn: null, sentAt: daysAgo(80), signedAt: null, declineReason: null, createdAt: daysAgo(82), signatures: [] },
  // A draft with a value must carry a schedule that adds up to it before it can be sent (BFF §61.1 row 3): this one is "all on signing".
  { ...LUMEN, id: "dk-7", title: "Onboarding agreement", reference: "GDA-2026-031", status: "draft", fileId: null, bodyMd: "Onboarding terms.", value: 900, sentAt: null, signedAt: null, createdAt: daysAgo(1), signatures: [],
    instalments: [inst("dk-7", 1, "Payment on signing", 900, "on_signing")] },
  { ...LUMEN, id: "dk-8", title: "Retainer agreement", reference: "GDA-2026-029", status: "sent", fileId: null, bodyMd: "Monthly retainer.", value: 2000, sentAt: daysAgo(6), signedAt: null, createdAt: daysAgo(7),
    signatures: [{ party: "client", signer: "lumen-1", signerName: "Lena Lumen", signerTitle: "Director", signedAt: daysAgo(2) }] },

  // ── DW-10f: the payment-schedule cases (Viceroy, cl-4) ──
  // A draft with a 50/50 schedule that adds up (120,000,000 = 60,000,000 + 60,000,000): the editor, and Send enabled.
  { ...VICEROY, id: "dk-10", title: "Website build agreement", reference: "GDA-2026-040", status: "draft", fileId: null, bodyMd: "Build terms.", value: 120_000_000,
    startsOn: dayOnly(-10), endsOn: dayOnly(-70), sentAt: null, signedAt: null, createdAt: daysAgo(3), signatures: [],
    instalments: [inst("dk-10", 1, "Deposit (50%)", 60_000_000, "on_signing"), inst("dk-10", 2, "Balance (50%)", 60_000_000, dayOnly(-70))] },
  // A draft with a value and NO schedule: Send is disabled until one is saved. 10,000,000 / 3 leaves a remainder of 1 on Month 1.
  { ...VICEROY, id: "dk-11", title: "Retainer 2027", reference: "GDA-2026-043", status: "draft", fileId: null, bodyMd: "Retainer terms.", value: 10_000_000,
    startsOn: dayOnly(-30), endsOn: null, sentAt: null, signedAt: null, createdAt: daysAgo(2), signatures: [] },
  // A signed agreement: one instalment already invoiced (the issued invoice `inv-sch-1`), one due, one upcoming.
  { ...VICEROY, id: "dk-12", title: "Website build agreement (signed)", reference: "GDA-2026-041", status: "signed", fileId: null, bodyMd: "Signed build terms.", value: 90_000_000,
    startsOn: dayOnly(40), endsOn: null, sentAt: daysAgo(45), signedAt: daysAgo(40), createdAt: daysAgo(46),
    signatures: [
      { party: "client", signer: "viceroy-1", signerName: "Wayan Viceroy", signerTitle: "Finance Director", signedAt: daysAgo(41) },
      { party: "provider", signer: "demo-owner", signerName: "Olive Owner", signerTitle: "Owner", signedAt: daysAgo(40) },
    ],
    instalments: [
      inst("dk-12", 1, "Deposit", 30_000_000, "on_signing", "inv-sch-1"),
      inst("dk-12", 2, "Milestone: design approved", 30_000_000, dayOnly(10)),
      inst("dk-12", 3, "Milestone: launch", 30_000_000, dayOnly(-45)),
    ] },
  // A signed amendment with its own value and its own schedule (its one instalment is on signing, so it is due).
  { ...VICEROY, id: "dk-13", title: "Amendment 1: extra pages", reference: "GDA-2026-041-A1", status: "signed", fileId: null, bodyMd: "Amendment terms.", value: 15_000_000,
    kind: "amendment", amendsId: "dk-12", startsOn: null, endsOn: null, sentAt: daysAgo(7), signedAt: daysAgo(5), createdAt: daysAgo(8),
    signatures: [
      { party: "client", signer: "viceroy-1", signerName: "Wayan Viceroy", signerTitle: "Finance Director", signedAt: daysAgo(6) },
      { party: "provider", signer: "demo-owner", signerName: "Olive Owner", signerTitle: "Owner", signedAt: daysAgo(5) },
    ],
    instalments: [inst("dk-13", 1, "Amendment fee", 15_000_000, "on_signing")] },
  // A signed agreement with a value and NO schedule (sent before 10f): `scheduleAddable`, so Finance may add one once (DW-D49).
  { ...VICEROY, id: "dk-14", title: "Hosting agreement", reference: "GDA-2026-042", status: "signed", fileId: null, bodyMd: "Hosting terms: 24,000,000 a year, billed in two halves.", value: 24_000_000,
    startsOn: dayOnly(20), endsOn: null, sentAt: daysAgo(25), signedAt: daysAgo(20), createdAt: daysAgo(26),
    signatures: [
      { party: "client", signer: "viceroy-1", signerName: "Wayan Viceroy", signerTitle: "Finance Director", signedAt: daysAgo(21) },
      { party: "provider", signer: "demo-owner", signerName: "Olive Owner", signerTitle: "Owner", signedAt: daysAgo(20) },
    ] },
  // A signed agreement whose schedule was ADDED AFTER SIGNING (DW-D49): read-only, says who and when.
  { ...VICEROY, id: "dk-15", title: "Maintenance agreement", reference: "GDA-2026-044", status: "signed", fileId: null, bodyMd: "Maintenance terms.", value: 6_000_000,
    startsOn: dayOnly(60), endsOn: null, sentAt: daysAgo(65), signedAt: daysAgo(60), createdAt: daysAgo(66),
    signatures: [
      { party: "client", signer: "viceroy-1", signerName: "Wayan Viceroy", signerTitle: "Finance Director", signedAt: daysAgo(61) },
      { party: "provider", signer: "demo-owner", signerName: "Olive Owner", signerTitle: "Owner", signedAt: daysAgo(60) },
    ],
    scheduleAdded: { at: daysAgo(3), by: "demo-owner" },
    instalments: [inst("dk-15", 1, "Month 1", 3_000_000, dayOnly(-20)), inst("dk-15", 2, "Month 2", 3_000_000, dayOnly(-50))] },
];

const seedPayments = (): DemoPayment[] => [
  { id: "dpay-1", invoiceId: "inv-1", clientId: CLIENT_ID, clientName: "Northwind Traders", amount: 2400, currency: "USD", paidOn: dayOnly(11), method: "bank_transfer", reference: "TRX-88231", status: "pending", note: "Part payment against the June invoice.", proofFileId: "f-2", recordedBy: "demo-client", recordedAt: daysAgo(11), confirmedBy: null, confirmedAt: null, rejectedReason: null, invoiceTotal: 6300, invoiceStatus: "sent" },
  // Lumen Studio (`cl-3`), recorded by demo-hansel: when demo-hansel tries to confirm it, the controller's
  // maker-checker 403 shows. It sits on a DIFFERENT client from dpay-1 on purpose: the Northwind Overview then
  // has exactly one "Confirm a client-recorded payment" item (the hub e2e asserts that link is unique). The
  // invoice link points at `inv-1`, the one invoice the demo has, so the link opens something.
  { id: "dpay-2", invoiceId: "inv-1", clientId: "cl-3", clientName: "Lumen Studio", amount: 150, currency: "USD", paidOn: dayOnly(3), method: "cash", reference: null, status: "pending", note: null, proofFileId: null, recordedBy: "demo-hansel", recordedAt: daysAgo(3), confirmedBy: null, confirmedAt: null, rejectedReason: null, invoiceTotal: 6300, invoiceStatus: "sent" },
  { id: "dpay-3", invoiceId: "inv-1", clientId: "cl-3", clientName: "Lumen Studio", amount: 300, currency: "USD", paidOn: dayOnly(2), method: "bank_transfer", reference: "LUM-1", status: "pending", note: null, proofFileId: null, recordedBy: "lumen-1", recordedAt: daysAgo(2), confirmedBy: null, confirmedAt: null, rejectedReason: null, invoiceTotal: 6300, invoiceStatus: "sent" },
];

// Pinned on globalThis: the page, the layout and the server actions can land in different module instances
// under `next dev`, and they must all see ONE store.
const G = globalThis as unknown as { __demoBilling?: { contracts: DemoContract[]; payments: DemoPayment[]; seq: number } };
const store = () => (G.__demoBilling ??= { contracts: seedContracts(), payments: seedPayments(), seq: 100 });

/** Test hook: put the store back to its seed. */
export function resetDemoBilling(): void { G.__demoBilling = undefined; }

const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });
const deny = (action: string, kind: string): DemoResult => err(403, `not authorized: cerbos denied ${action} on ${kind}`);

const CONTRACT_READ = new Set(["demo-hansel", "demo-owner", "dept-manager"]);
const CONTRACT_WRITE = new Set(["demo-hansel", "demo-owner"]);
const COUNTERSIGN = new Set(["demo-hansel", "demo-owner"]);
const INVOICE_READ = new Set(["demo-hansel", "demo-owner", "dept-manager"]);
const INVOICE_UPDATE = new Set(["demo-hansel", "demo-owner"]);

// PV3-09 — `clientVisible`, by the backend's rule (BFF §22d; `portal-visibility.ts`): a contract is visible to
// the client when it has a client and is not a draft; a payment through its INVOICE (a draft invoice is not
// visible, anything else is, and a pending or rejected claim shows in the invoice's history too). Overview
// items use the same two functions, so the list, the detail and the Overview cannot disagree.
const contractVisible = (k: { clientId: string | null; status: string }): boolean => k.clientId != null && k.status !== "draft";
const paymentVisible = (x: { clientId: string | null; invoiceStatus: string }): boolean => x.clientId != null && x.invoiceStatus !== "draft";

/** A stand-in SHA-256 for a demo contract: 64 hex characters derived from its id. Not a real digest, and nothing checks it. */
const demoHash = (id: string): string => {
  let hex = "";
  for (let i = 0; hex.length < 64; i++) hex += (id.charCodeAt(i % id.length) * 7 + i * 13).toString(16).padStart(2, "0");
  return hex.slice(0, 64);
};

// ══ DW-10f: the payment schedule (BFF §61.3 to §61.5) ═════════════════════════════════════════════════════════════════════════════

type InvoiceRow = Record<string, unknown>;
const USER_NAMES: Record<string, string> = { "demo-hansel": "Hansel (demo)", "demo-owner": "Olive Owner" };
const nameOf = (id: string): string => USER_NAMES[id] ?? id;
const KNOWN_CURRENCIES = new Set(["IDR", "USD", "EUR", "GBP", "SGD", "JPY", "AUD"]);
const KNOWN_CLIENTS = new Set(["cl-1", "cl-2", "cl-3", "cl-4"]);
const today = (): string => new Date().toISOString().slice(0, 10);
const insts = (k: DemoContract): DemoInstalment[] => k.instalments ?? [];
const sumOf = (k: DemoContract): number => insts(k).reduce((n, i) => n + i.amount, 0);
const valued = (k: DemoContract): boolean => k.value != null && k.value > 0;
/** A refusal in the server's shape: `{error: <code>, reason: <code>}` plus `detail` where §61 names one (BFF §61.17 "Refusal shape"). */
const refuse = (status: number, code: string, detail?: Record<string, unknown>): DemoResult => ({ status, json: { error: code, reason: code, ...(detail ? { detail } : {}) } });

/** A signed version that supersedes it would make its instalments unbillable (§61.1 row 6). The demo has no `supersedes` chains. */
const superseded = (_k: DemoContract): boolean => false;

/** When an instalment is due: its date, or the signed date for an on-signing one (null until signed). */
const effectiveDue = (k: DemoContract, i: DemoInstalment): string | null => (i.dueKind === "on_signing" ? (k.signedAt ? k.signedAt.slice(0, 10) : null) : i.dueOn);

/** §61.3, derived on read, never stored: the same ladder as `instalmentStateSql`. */
function stateOf(k: DemoContract, i: DemoInstalment, invoices: InvoiceRow[], dueBy: string): { state: string; invoice: InvoiceRow | null; reason: string | null } {
  const inv = i.invoiceId ? (invoices.find((x) => x.id === i.invoiceId) ?? null) : null;
  if (inv) {
    const st = String(inv.status);
    return { state: st === "draft" || st === "approved" ? "invoicing" : st === "paid" ? "paid" : "invoiced", invoice: inv, reason: null };
  }
  if (k.status === "draft" || k.status === "sent") return { state: "scheduled", invoice: null, reason: null };
  if (k.status !== "signed" || superseded(k)) return { state: "not_billed", invoice: null, reason: superseded(k) ? "superseded" : k.status };
  const due = effectiveDue(k, i);
  return { state: i.dueKind === "on_signing" || (due != null && due <= dueBy) ? "due" : "upcoming", invoice: null, reason: null };
}

/** The staff `schedule` object (§61.4); null without instalments, or an object with none when `emptyAsObject` (the PUT's answer after a clear). */
function scheduleOf(k: DemoContract, invoices: InvoiceRow[], emptyAsObject = false) {
  const rows = insts(k);
  if (rows.length === 0 && !emptyAsObject) return null;
  const total = sumOf(k);
  return {
    currency: k.currency, value: k.value, total,
    matchesValue: valued(k) ? rows.length > 0 && total === k.value : rows.length === 0,
    scheduleSha256: k.sentAt != null && rows.length > 0 ? demoHash(`schedule-${k.id}`) : null,
    addedAfterSigning: k.scheduleAdded ? { at: k.scheduleAdded.at, by: { id: k.scheduleAdded.by, name: nameOf(k.scheduleAdded.by) } } : null,
    instalments: rows.map((i) => {
      const st = stateOf(k, i, invoices, today());
      return {
        id: i.id, position: i.position, label: i.label, amount: i.amount, due: { kind: i.dueKind, on: effectiveDue(k, i) },
        state: st.state, notBilledReason: st.state === "not_billed" ? st.reason : null,
        invoice: st.invoice ? { id: String(st.invoice.id), invoiceNo: (st.invoice.invoiceNo as string | null | undefined) ?? null, status: String(st.invoice.status) } : null,
      };
    }),
  };
}

/** `scheduleAddable` (§61.4a, the state half): signed, a value above zero, no schedule, not superseded. */
const addable = (k: DemoContract): boolean => k.status === "signed" && valued(k) && insts(k).length === 0 && !k.scheduleAdded && !superseded(k);

/** The server's body rules for `PUT …/schedule` and the addition, in its order (§61.4): shape, order, currency, precision. Returns rows or a refusal. */
function parseSchedule(body: unknown, k: DemoContract, requireOne: boolean): DemoInstalment[] | DemoResult {
  const raw = (body as { instalments?: unknown } | null)?.instalments;
  if (!Array.isArray(raw) || raw.length > 60 || (requireOne && raw.length === 0)) return refuse(400, "schedule_invalid");
  const rows: DemoInstalment[] = [];
  for (const [n, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return refuse(400, "schedule_invalid");
    const it = item as { label?: unknown; amount?: unknown; due?: unknown };
    const label = typeof it.label === "string" ? it.label.trim() : "";
    if (!label || label.length > 120) return refuse(400, "schedule_invalid");
    const amountText = typeof it.amount === "number" ? String(it.amount) : typeof it.amount === "string" ? it.amount.trim() : "";
    if (!/^\d+(\.\d+)?$/.test(amountText) || Number(amountText) <= 0) return refuse(400, "schedule_invalid");
    const due = it.due;
    const isDate = typeof due === "string" && isIsoDate(due);
    if (due !== "on_signing" && !isDate) return refuse(400, "schedule_invalid");
    rows.push({ id: `di-${k.id}-${n + 1}`, position: n + 1, label, amount: Number(amountText), dueKind: due === "on_signing" ? "on_signing" : "date", dueOn: due === "on_signing" ? null : (due as string), invoiceId: null });
    (rows[rows.length - 1] as DemoInstalment & { _text?: string })._text = amountText;
  }
  let last: string | null = null;
  for (const [n, r] of rows.entries()) {
    if (r.dueKind === "on_signing") { if (n !== 0) return refuse(400, "schedule_order_invalid"); continue; }
    if (last !== null && (r.dueOn as string) < last) return refuse(400, "schedule_order_invalid");
    last = r.dueOn;
  }
  if (rows.length > 0) {
    if (!KNOWN_CURRENCIES.has(k.currency)) return refuse(400, "currency_unknown");
    const mu = minorUnitOf(k.currency);
    for (const r of rows) {
      const text = (r as DemoInstalment & { _text?: string })._text ?? "";
      if ((text.split(".")[1] ?? "").replace(/0+$/, "").length > mu) return refuse(400, "schedule_precision");
    }
  }
  for (const r of rows) delete (r as DemoInstalment & { _text?: string })._text;
  return rows;
}
const isRefusal = (x: DemoInstalment[] | DemoResult): x is DemoResult => !Array.isArray(x);

/** One instalment as `GET invoices/billable-instalments` lists it (§61.5). */
function billableRow(k: DemoContract, i: DemoInstalment, st: { state: string; invoice: InvoiceRow | null }) {
  return {
    instalmentId: i.id, client: { id: k.clientId, name: k.clientName },
    contract: { id: k.id, title: k.title, reference: k.reference, kind: k.kind ?? "agreement", projectId: k.projectId },
    position: i.position, count: insts(k).length, label: i.label, amount: i.amount, currency: k.currency,
    due: { kind: i.dueKind, on: effectiveDue(k, i) }, state: st.state,
    invoice: st.invoice ? { id: String(st.invoice.id), status: String(st.invoice.status) } : null,
  };
}

/** `GET invoices/billable-instalments` (§61.5): signed, live, unsuperseded contracts' instalments with no live invoice (`due` or `upcoming`), and those on an unissued draft (`invoicing`), oldest due first. */
function billableList(invoices: InvoiceRow[], dueBy: string, clientId: string | null) {
  const items: ReturnType<typeof billableRow>[] = [];
  for (const k of store().contracts) {
    if (k.status !== "signed" || superseded(k) || (clientId && k.clientId !== clientId)) continue;
    for (const i of insts(k)) {
      const st = stateOf(k, i, invoices, dueBy);
      if (st.state === "due" || st.state === "upcoming" || st.state === "invoicing") items.push(billableRow(k, i, st));
    }
  }
  return items.sort((a, b) => String(a.due.on ?? "9999").localeCompare(String(b.due.on ?? "9999")) || a.contract.title.localeCompare(b.contract.title) || a.position - b.position).slice(0, 500);
}

const findInstalment = (id: string): { k: DemoContract; i: DemoInstalment } | null => {
  for (const k of store().contracts) { const i = insts(k).find((x) => x.id === id); if (i) return { k, i }; }
  return null;
};

/**
 * `POST invoices {source: 'instalments'}` (§61.5): authorize first, then validate in the server's order, check each instalment, claim them and
 * add the DRAFT invoice to the invoice store the caller owns. A replay of exactly the instalments of one live draft answers that draft
 * (`deduped`). Nothing is written on a refusal.
 */
export function demoInvoiceFromSchedule(invoices: InvoiceRow[], body: Record<string, unknown>, userId: string, newId: () => string): DemoResult {
  if (!INVOICE_UPDATE.has(userId)) return deny("create", "invoice");
  if (body.periodStart !== undefined || body.periodEnd !== undefined || body.rate !== undefined) return refuse(400, "source_fields_mixed");
  const ids = body.instalmentIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 60 || !ids.every((x) => typeof x === "string" && x) || new Set(ids).size !== ids.length) return refuse(400, "instalment_ids_invalid");
  let dueBy = today();
  if (body.dueBy !== undefined && body.dueBy !== null) {
    if (typeof body.dueBy !== "string" || !isIsoDate(body.dueBy)) return refuse(400, "due_by_invalid");
    dueBy = body.dueBy;
  }
  let taxCode: string | null = null;
  if (body.taxCode !== undefined && body.taxCode !== null && !(typeof body.taxCode === "string" && body.taxCode.trim() === "")) {
    if (typeof body.taxCode !== "string" || !/^[A-Za-z0-9_.-]{1,32}$/.test(body.taxCode.trim())) return refuse(400, "tax_code_invalid");
    taxCode = body.taxCode.trim();
  }
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  if (!KNOWN_CLIENTS.has(clientId)) return refuse(404, "client_not_found");
  const chosen = (ids as string[]).map((id) => ({ id, hit: findInstalment(id) }));

  // The replay rule: every instalment claimed by ONE live, unissued draft of this client whose instalment lines are exactly these.
  const claimers = new Set(chosen.map((c) => c.hit?.i.invoiceId ?? null));
  if (chosen.every((c) => c.hit) && claimers.size === 1 && !claimers.has(null)) {
    const inv = invoices.find((x) => x.id === [...claimers][0]) as { id: string; clientId: string; status: string; invoiceNo?: string | null; total: number; currency: string; lines: { kind?: string; instalmentId?: string }[] } | undefined;
    if (inv && inv.clientId === clientId && !inv.invoiceNo && (inv.status === "draft" || inv.status === "approved")) {
      const have = inv.lines.filter((l) => l.kind === "instalment").map((l) => l.instalmentId).sort();
      if (JSON.stringify(have) === JSON.stringify([...(ids as string[])].sort())) {
        return { status: 201, json: { id: inv.id, source: "instalments", lineCount: inv.lines.length, total: inv.total, currency: inv.currency, deduped: true } };
      }
    }
  }
  const items: { instalmentId: string; reason: string; invoiceId?: string }[] = [];
  for (const c of chosen) {
    if (!c.hit) items.push({ instalmentId: c.id, reason: "not_found" });
    else if (c.hit.k.clientId !== clientId) items.push({ instalmentId: c.id, reason: "other_client" });
    else if (c.hit.k.status !== "signed") items.push({ instalmentId: c.id, reason: "not_signed" });
    else if (superseded(c.hit.k)) items.push({ instalmentId: c.id, reason: "superseded" });
    else if (c.hit.i.invoiceId) items.push({ instalmentId: c.id, reason: "already_invoiced", invoiceId: c.hit.i.invoiceId });
    else if (!(c.hit.i.dueKind === "on_signing" || (c.hit.i.dueOn != null && c.hit.i.dueOn <= dueBy))) items.push({ instalmentId: c.id, reason: "not_due" });
  }
  if (items.length > 0) return refuse(409, "instalment_unavailable", { items });
  const rows = chosen.map((c) => c.hit as { k: DemoContract; i: DemoInstalment });
  if (new Set(rows.map((r) => r.k.currency)).size !== 1) return refuse(400, "currency_mixed");
  const sorted = [...rows].sort((a, b) => String(effectiveDue(a.k, a.i) ?? "9999").localeCompare(String(effectiveDue(b.k, b.i) ?? "9999")) || a.i.position - b.i.position);
  const dates = sorted.map((r) => effectiveDue(r.k, r.i)).filter((d): d is string => d != null);
  const id = newId();
  const lines = sorted.map((r) => ({
    kind: "instalment", description: `${[r.k.reference, r.k.title].filter(Boolean).join(" ")} · ${r.i.label} (${r.i.position} of ${insts(r.k).length})`,
    contractId: r.k.id, instalmentId: r.i.id, projectId: r.k.projectId, amount: r.i.amount,
  }));
  const total = sorted.reduce((n, r) => n + r.i.amount, 0);
  invoices.push({
    id, clientId, clientName: sorted[0].k.clientName, periodStart: dates[0] ?? null, periodEnd: dates[dates.length - 1] ?? null, status: "draft",
    currency: sorted[0].k.currency, total, lines, createdAt: new Date().toISOString(), createdBy: userId, approvedBy: null, approvedAt: null, updatedBy: userId,
    taxCode,
  });
  for (const r of sorted) r.i.invoiceId = id;
  return { status: 201, json: { id, source: "instalments", lineCount: lines.length, total, currency: sorted[0].k.currency } };
}

/** Voiding (cancelling) an invoice releases the instalments it claimed; returns how many (`releasedInstalments`). */
export function demoReleaseInstalments(invoiceId: string): number {
  let n = 0;
  for (const k of store().contracts) for (const i of insts(k)) if (i.invoiceId === invoiceId) { i.invoiceId = null; n += 1; }
  return n;
}

/** How many instalments an invoice claims (what voiding it will release). */
export function demoClaimedInstalments(invoiceId: string): number {
  return store().contracts.reduce((n, k) => n + insts(k).filter((i) => i.invoiceId === invoiceId).length, 0);
}

/** §61.5's three readiness blockers, for an invoice with instalment lines (the demo twin of `issue.ts`). */
export function demoInstalmentBlockers(invoice: { id: string; lines?: { kind?: string; instalmentId?: string; amount?: number }[] }): { code: string; message: string }[] {
  const lines = (invoice.lines ?? []).filter((l) => l.kind === "instalment");
  if (lines.length === 0) return [];
  const out: { code: string; message: string }[] = [];
  const hits = lines.map((l) => (l.instalmentId ? findInstalment(l.instalmentId) : null));
  const seen = new Set<string>();
  const invalid = lines.some((l, n) => {
    const hit = hits[n];
    const dup = l.instalmentId ? seen.has(l.instalmentId) : false;
    if (l.instalmentId) seen.add(l.instalmentId);
    return !hit || hit.i.invoiceId !== invoice.id || dup || hit.i.amount !== l.amount;
  });
  if (invalid) out.push({ code: "INSTALMENT_LINES_INVALID", message: "an instalment line names an instalment this invoice does not claim, names one twice, or carries another amount than the instalment's" });
  if (hits.some((h) => h && h.k.status !== "signed")) out.push({ code: "INSTALMENT_CONTRACT_NOT_SIGNED", message: "a line's contract is no longer signed (it was voided after this draft); cancel the draft, which releases its instalments" });
  if (hits.some((h) => h && superseded(h.k))) out.push({ code: "INSTALMENT_SUPERSEDED", message: "a signed version now supersedes a line's contract, so its instalments are no longer billable; cancel the draft" });
  return out;
}

/** The contract as the list serves it: no `signatures`, plus the derived flags. */
function row(k: DemoContract, userId: string, invoices: InvoiceRow[] = []) {
  const { signatures, instalments: _i, scheduleAdded: _a, ...rest } = k;
  void invoices;
  const clientSigned = signatures.some((s) => s.party === "client");
  const providerSigned = signatures.some((s) => s.party === "provider");
  // PV5-06: sending FIXES the content (the hash and the tier); a draft has neither. PV5-07: the sealed signed copy
  // exists only for dk-5 here, so every other signed contract (including one signed in a session) reads "being prepared".
  const fixed = k.sentAt != null;
  return {
    ...rest, supersedesId: null, createdBy: "demo-hansel", clientSigned, providerSigned,
    kind: k.kind ?? "agreement",
    scheduleSummary: insts(k).length > 0
      ? { count: insts(k).length, total: sumOf(k), matchesValue: valued(k) ? sumOf(k) === k.value : false }
      : null,
    scheduleAddable: addable(k),
    signatureTier: fixed ? "attested" : null, contentSha256: fixed ? demoHash(k.id) : null,
    contentFixedAt: fixed ? k.sentAt : null, certifiedRequested: false,
    signedCopyFileId: k.id === "dk-5" ? "f-signed-dk5" : null,
    termEnded: Boolean(k.endsOn && k.endsOn < dayOnly(0)),
    clientVisible: contractVisible(k),
    // PV3-01: one decision per caller, true only for a sent row still waiting on us.
    canCountersign: COUNTERSIGN.has(userId) && k.status === "sent" && !providerSigned,
  };
}

/** Hub Overview, "waiting on us": drafts we have not sent, and payments nobody has confirmed. */
export function demoBillingNeedsUs(clientId: string): { kind: "payment" | "contract"; id: string; label: string; context: string; href: string; since: string; clientVisible: boolean }[] {
  const s = store();
  const href = `/clients/${clientId}/billing`;
  return [
    ...s.payments.filter((p) => p.clientId === clientId && p.status === "pending").map((p) => ({
      kind: "payment" as const, id: p.id, label: "Confirm a client-recorded payment", context: `${p.currency} ${p.amount.toLocaleString("en-US")}`, href, since: p.recordedAt, clientVisible: paymentVisible(p),
    })),
    ...s.contracts.filter((k) => k.clientId === clientId && k.status === "draft").map((k) => ({
      kind: "contract" as const, id: k.id, label: "Send a drafted agreement", context: k.title, href, since: k.createdAt, clientVisible: contractVisible(k),
    })),
  ];
}

/** Hub Overview, "waiting on the client": contracts sent and not yet signed by them. */
export function demoBillingNeedsClient(clientId: string): { kind: "contract"; id: string; label: string; context: string; href: string; since: string; clientVisible: boolean }[] {
  return store().contracts
    .filter((k) => k.clientId === clientId && k.status === "sent" && !k.signatures.some((s) => s.party === "client"))
    .map((k) => ({ kind: "contract" as const, id: k.id, label: "Awaiting client signature", context: k.title, href: `/clients/${clientId}/billing`, since: k.sentAt ?? k.createdAt, clientVisible: contractVisible(k) }));
}

export function demoBillingPendingTotal(clientId: string): number {
  return store().payments.filter((p) => p.clientId === clientId && p.status === "pending").reduce((n, p) => n + p.amount, 0);
}

export function billingDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string, invoices: InvoiceRow[] = []): DemoResult | null {
  const m = method.toUpperCase();
  const s = store();
  let hit: RegExpMatchArray | null;

  // ── DW-10f-3a (BFF §61.5): what Finance can draft from the schedule. `invoice` read, then `contract` read. ──
  if (/^\/api\/[^/]+\/invoices\/billable-instalments$/.test(p) && m === "GET") {
    if (!INVOICE_READ.has(userId)) return deny("read", "invoice");
    if (!CONTRACT_READ.has(userId)) return deny("read", "contract");
    const dueByRaw = params.get("dueBy");
    if (dueByRaw && !isIsoDate(dueByRaw)) return refuse(400, "due_by_invalid");
    const dueBy = dueByRaw || today();
    return ok({ dueBy, items: billableList(invoices, dueBy, params.get("clientId") || null) });
  }

  // ── DW-10f-2a (BFF §61.4): a DRAFT's whole schedule; refusals in the server's order ──
  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)\/schedule$/)) && m === "PUT") {
    if (!CONTRACT_WRITE.has(userId)) return deny("update", "contract");
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (!k) return refuse(404, "contract_not_found");
    if (k.status !== "draft") return refuse(409, "schedule_frozen");
    const rows = parseSchedule(JSON.parse(body || "{}"), k, false);
    if (isRefusal(rows)) return rows;
    if (rows.length > 0 && !valued(k)) return refuse(400, "schedule_needs_value");
    k.instalments = rows;
    return ok(scheduleOf(k, invoices, true));
  }
  // ── DW-10f-2a (BFF §61.4a, DW-D49): ONCE, on a signed contract with a value and no schedule ──
  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)\/schedule\/after-signing$/)) && m === "POST") {
    if (!CONTRACT_WRITE.has(userId)) return deny("update", "contract");
    if (!INVOICE_UPDATE.has(userId)) return deny("create", "invoice");
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (!k) return refuse(404, "contract_not_found");
    if (k.status === "draft" || k.status === "sent") return refuse(409, "contract_not_signed");
    if (k.status !== "signed") return refuse(409, "contract_closed");
    if (superseded(k)) return refuse(409, "contract_superseded");
    if (insts(k).length > 0 || k.scheduleAdded) return refuse(409, "schedule_exists");
    if (!valued(k)) return refuse(400, "schedule_needs_value");
    const rows = parseSchedule(JSON.parse(body || "{}"), k, true);
    if (isRefusal(rows)) return rows;
    const total = rows.reduce((n, r) => n + r.amount, 0);
    if (Math.abs(total - (k.value as number)) > 1e-6) return refuse(400, "schedule_total_mismatch", { value: k.value, total });
    k.instalments = rows;
    k.scheduleAdded = { at: new Date().toISOString(), by: userId };
    return { status: 201, json: scheduleOf(k, invoices) };
  }

  // ── documents (PV5-08, BFF §30b): signed agreements and payment proofs of one client, newest first ──
  if ((hit = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/documents$/)) && m === "GET") {
    if (!CONTRACT_READ.has(userId)) return deny("read", "client");
    const cid = hit[1];
    const items = [
      ...s.contracts.filter((k) => k.clientId === cid && k.status === "signed").map((k) => ({
        id: k.id, kind: "signed_contract", title: k.title, date: k.signedAt ?? k.createdAt,
        fileId: k.id === "dk-5" ? "f-signed-dk5" : k.fileId, ready: k.id === "dk-5", clientVisible: contractVisible(k),
      })),
      ...s.payments.filter((x) => x.clientId === cid && x.proofFileId).map((x) => ({
        id: x.id, kind: "receipt", title: "Payment proof", date: x.paidOn, fileId: x.proofFileId, ready: true, clientVisible: paymentVisible(x),
      })),
    ];
    return ok({ items: items.sort((x, y) => Date.parse(y.date) - Date.parse(x.date)) });
  }

  // ── payments ────────────────────────────────────────────────────────────────────────────────
  if ((hit = p.match(/^\/api\/[^/]+\/invoice-payments$/)) && m === "GET") {
    if (!INVOICE_READ.has(userId)) return deny("read", "invoice");
    const cid = params.get("clientId"), st = params.get("status");
    let rows = s.payments.filter((x) => (!st || x.status === st));
    if (cid) rows = cid.toLowerCase() === "internal" ? [] : rows.filter((x) => x.clientId === cid);
    return ok([...rows].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending")).map((x) => ({ ...x, clientVisible: paymentVisible(x) })));
  }
  if ((hit = p.match(/^\/api\/[^/]+\/invoice-payments\/([^/]+)\/decide$/)) && m === "POST") {
    // Authorize BEFORE validating (PV3-06): a caller who may not decide gets 403 whatever they sent.
    if (!INVOICE_UPDATE.has(userId)) return deny("update", "invoice");
    const b = JSON.parse(body || "{}") as { decision?: string; reason?: string };
    if (b.decision !== "confirm" && b.decision !== "reject") return err(400, "decision must be confirm|reject");
    if (b.decision === "reject" && !(b.reason ?? "").trim()) return err(400, "a reason is required when rejecting a payment");
    const pay = s.payments.find((x) => x.id === hit![1]);
    if (!pay) return err(404, "payment not found");
    if (pay.status !== "pending") return err(400, `this payment is already ${pay.status}`);
    if (pay.recordedBy === userId) return err(403, "a payment must be confirmed by someone other than whoever recorded it");
    pay.status = b.decision === "confirm" ? "confirmed" : "rejected";
    pay.confirmedBy = userId; pay.confirmedAt = new Date().toISOString();
    if (b.decision === "reject") pay.rejectedReason = (b.reason ?? "").trim();
    const paid = b.decision === "confirm" && pay.amount >= pay.invoiceTotal - 1;
    return ok({ ok: true, decision: b.decision, invoicePaid: paid });
  }

  // ── contracts ───────────────────────────────────────────────────────────────────────────────
  if ((hit = p.match(/^\/api\/[^/]+\/contracts$/))) {
    if (m === "GET") {
      if (!CONTRACT_READ.has(userId)) return deny("read", "contract");
      const cid = params.get("clientId"), st = params.get("status");
      let rows = s.contracts.filter((k) => !st || k.status === st);
      if (cid) rows = cid.toLowerCase() === "internal" ? [] : rows.filter((k) => k.clientId === cid);
      return ok(rows.map((k) => row(k, userId, invoices)));
    }
    if (m === "POST") {
      // Authorize BEFORE validating (PV3-06), as on the other writes.
      if (!CONTRACT_WRITE.has(userId)) return deny("create", "contract");
      const b = JSON.parse(body || "{}") as Record<string, unknown>;
      if (!b.clientId || !b.title) return err(400, "clientId and title required");
      if (b.value != null && !(Number.isFinite(Number(b.value)) && Number(b.value) >= 0)) return err(400, "value must be a non-negative number");
      if (b.startsOn && b.endsOn && String(b.endsOn) < String(b.startsOn)) return err(400, "endsOn cannot be before startsOn");
      const reference = b.reference ? String(b.reference).slice(0, 100) : null;
      if (reference) {
        const dup = s.contracts.find((k) => k.reference === reference && k.version === 1);
        if (dup) return dup.clientId === b.clientId ? { status: 201, json: { id: dup.id, status: dup.status, deduped: true } } : err(409, "that reference is already used by another contract");
      }
      const id = `dk-${++s.seq}`;
      s.contracts.unshift({
        id, clientId: String(b.clientId), clientName: String(b.clientId) === "cl-3" ? "Lumen Studio" : "Northwind Traders", projectId: (b.projectId as string) ?? null,
        projectName: b.projectId ? "Website redesign" : null, title: String(b.title).slice(0, 300), reference, version: 1, status: "draft",
        fileId: (b.fileId as string) ?? null, bodyMd: (b.bodyMd as string) ?? null, value: b.value == null ? null : Number(b.value),
        currency: String(b.currency || "USD").slice(0, 8), startsOn: (b.startsOn as string) ?? null, endsOn: (b.endsOn as string) ?? null,
        sentAt: null, signedAt: null, declineReason: null, createdAt: new Date().toISOString(), signatures: [],
      });
      return { status: 201, json: { id, status: "draft" } };
    }
    return null;
  }

  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)$/))) {
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (m === "GET") {
      if (!CONTRACT_READ.has(userId)) return deny("read", "contract");
      if (!k) return err(404, "contract not found");
      return ok({ ...row(k, userId, invoices), signatures: k.signatures, schedule: scheduleOf(k, invoices) });
    }
    if (m === "PATCH") {
      if (!CONTRACT_WRITE.has(userId)) return deny("update", "contract");
      if (!k) return err(404, "contract not found");
      const b = JSON.parse(body || "{}") as Record<string, unknown>;
      const voiding = b.status === "void";
      if (k.status !== "draft" && !voiding) return { status: 400, json: { error: `a ${k.status} contract cannot be edited, only voided; issue a new version with supersedesId instead`, reason: "only_void_after_send" } };
      if (b.status && b.status !== "void" && b.status !== "draft") return err(400, "status here may only be set to void; use /send to issue");
      if (voiding) { k.status = "void"; return ok({ ok: true }); }
      if (typeof b.title === "string" && b.title) k.title = b.title.slice(0, 300);
      if (typeof b.reference === "string" && b.reference) k.reference = b.reference.slice(0, 100);
      if (typeof b.bodyMd === "string") k.bodyMd = b.bodyMd;
      if (typeof b.fileId === "string") k.fileId = b.fileId;
      if (b.value != null) k.value = Number(b.value);
      if (typeof b.currency === "string" && b.currency) k.currency = b.currency;
      if (typeof b.startsOn === "string" && b.startsOn) k.startsOn = b.startsOn;
      if (typeof b.endsOn === "string" && b.endsOn) k.endsOn = b.endsOn;
      return ok({ ok: true });
    }
    return null;
  }

  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)\/send$/)) && m === "POST") {
    if (!CONTRACT_WRITE.has(userId)) return deny("send", "contract");
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (!k) return err(404, "contract not found");
    if (k.status !== "draft") return err(400, `this contract is already ${k.status}`);
    if (!k.fileId && !k.bodyMd) return err(400, "attach a document or write the terms before sending");
    // BFF §61.1 row 3: a contract with a value above zero cannot be sent unless its schedule adds up exactly to the value.
    if (valued(k) && !(insts(k).length > 0 && Math.abs(sumOf(k) - (k.value as number)) < 1e-6)) return refuse(400, "schedule_total_mismatch", { value: k.value, total: sumOf(k) });
    k.status = "sent"; k.sentAt = new Date().toISOString();
    return ok({ ok: true, status: "sent", notified: 2, ...(insts(k).length > 0 ? { scheduleSha256: demoHash(`schedule-${k.id}`) } : {}) });
  }

  // PV5-06/PV-D25: certified signing is parked, so marking a draft certified is refused and writes nothing.
  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)\/mark-certified$/)) && m === "POST") {
    if (!CONTRACT_WRITE.has(userId)) return deny("mark_certified", "contract");
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (!k) return err(404, "contract not found");
    if (k.status !== "draft") return err(400, "only a draft can be marked certified");
    return { status: 409, json: { error: "no certified signing provider is set up", reason: "no_certified_provider" } };
  }

  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)\/countersign$/)) && m === "POST") {
    // Authorize BEFORE validating (PV3-06): a company_admin with an empty body gets 403, not 400.
    if (!COUNTERSIGN.has(userId)) return deny("countersign", "contract");
    const b = JSON.parse(body || "{}") as { signerName?: string; signerTitle?: string };
    const signerName = (b.signerName ?? "").trim();
    if (signerName.length < 2) return err(400, "signerName required");
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (!k) return err(404, "contract not found");
    if (k.signatures.some((x) => x.party === "provider")) return ok({ ok: true, complete: k.status === "signed", alreadySigned: true });
    if (k.status !== "sent") return err(400, `a ${k.status} contract cannot be countersigned`);
    k.signatures.push({ party: "provider", signer: userId, signerName, signerTitle: b.signerTitle?.trim() || null, signedAt: new Date().toISOString() });
    const complete = k.signatures.some((x) => x.party === "client");
    if (complete) { k.status = "signed"; k.signedAt = new Date().toISOString(); }
    return ok({ ok: true, complete, alreadySigned: false });
  }

  return null;
}

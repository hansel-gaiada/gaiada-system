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
}

export interface ContractSignature {
  party: "client" | "provider";
  signer: string | null;
  signerName: string;
  signerTitle: string | null;
  signedAt: string;
}

export interface ContractDetail extends Contract {
  signatures: ContractSignature[];
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
}

export const SEND_BLOCKED_REASON = "Write the terms or attach a PDF before sending. A contract with nothing to read cannot be signed.";

/** True when a contract has something for the client to read: in-app terms or an attached file. */
export function hasDocument(c: Pick<Contract, "bodyMd" | "fileId">): boolean {
  return Boolean((c.bodyMd ?? "").trim()) || Boolean(c.fileId);
}

export function contractActions(c: Contract): ContractActions {
  const isDraft = c.status === "draft";
  const docOk = hasDocument(c);
  return {
    edit: isDraft,
    send: { shown: isDraft, enabled: isDraft && docOk, reason: isDraft && !docOk ? SEND_BLOCKED_REASON : null },
    // `=== true`, not truthiness: an older backend that omits the field must read as "not offered".
    countersign: c.canCountersign === true,
    void: c.status !== "void",
  };
}

/** The "who has signed" line for a sent contract: party, name, title and date, one per signature. */
export function signatureLine(s: ContractSignature, formatDate: (iso: string) => string): string {
  const who = s.party === "provider" ? "Our company" : "Client";
  const title = s.signerTitle ? `, ${s.signerTitle}` : "";
  return `${who}: ${s.signerName}${title}, ${formatDate(s.signedAt)}`;
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

/** Pending payments plus contracts awaiting OUR countersignature (those the backend says this caller may
 *  countersign now: the layout counts rows whose `canCountersign` is true). Both are things this company has
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

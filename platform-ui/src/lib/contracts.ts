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
  // `=== true`: an older backend that omits the field reads as "not set up".
  const certifiedAvailable = c.certifiedSigning?.available === true;
  return {
    edit: isDraft,
    send: { shown: isDraft, enabled: isDraft && docOk, reason: isDraft && !docOk ? SEND_BLOCKED_REASON : null },
    // `=== true`, not truthiness: an older backend that omits the field must read as "not offered".
    countersign: c.canCountersign === true,
    void: c.status !== "void",
    markCertified: {
      shown: isDraft && c.certifiedRequested !== true && certifiedAvailable,
      enabled: true,
      reason: null,
    },
    countersignAtProvider: certifiedAvailable && c.canCountersignAtProvider === true && Boolean(c.countersignUrl),
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

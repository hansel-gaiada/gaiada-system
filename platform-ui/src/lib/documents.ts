// PV5-08 — the Documents lists' types and wording (BFF §30b). Client-safe: no server imports.
//
//   portal  GET /api/:t/portal/documents                  -> { items: DocumentItem[] }
//   staff   GET /api/:t/clients/:clientId/documents       -> { items: StaffDocumentItem[] }
//
// Legal and money documents only (plan decision 18): signed agreements, issued-invoice PDFs, payment receipts.
// Deliverables stay under Projects. The download links are NOT built here: the portal links through its own
// `/api/:t/portal/files/:id` route, staff through `/api/files/:id` (BFF §26, §30b); each re-checks ownership.

export type DocumentKind = "signed_contract" | "invoice" | "receipt";

export interface DocumentItem {
  /** The source row (contract, invoice or payment). Stable: a React key. */
  id: string;
  kind: DocumentKind;
  title: string;
  /** ISO 8601: a timestamp, or a plain date for a receipt. */
  date: string;
  /** Null until a file exists. For a signed agreement still being sealed it is the attached original. */
  fileId: string | null;
  /** False while the document is being prepared (the sealed copy, an invoice PDF still rendering). */
  ready: boolean;
}

export interface StaffDocumentItem extends DocumentItem {
  /** From the backend only (trap 9): a client-wide contact sees this row in their portal. */
  clientVisible?: boolean;
}

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  signed_contract: "Signed agreement",
  invoice: "Invoice",
  receipt: "Payment receipt",
};

/** What a row says about its file, in words: never a blank where a client expects a download. */
export function documentStateNote(d: Pick<DocumentItem, "kind" | "fileId" | "ready">): string | null {
  if (d.ready && d.fileId) return null;
  if (d.kind === "signed_contract") return d.fileId ? "The sealed copy is being prepared" : "The signed copy is being prepared";
  if (d.kind === "invoice") return "The invoice PDF is being prepared";
  return "No file is available";
}

/** The label of the link: the sealed copy is the document; before it exists the link is the unsealed original. */
export function documentLinkLabel(d: Pick<DocumentItem, "kind" | "ready">): string {
  return d.kind === "signed_contract" && !d.ready ? "Download the original (not yet sealed)" : "Download";
}

// PV5-08 — the Documents list: legal and money documents only (plan decision 18). Deliverables stay under Projects.
//
// ONE shape and ONE set of SELECTs, used by TWO callers that supply the WHERE half themselves:
//   * the portal   (`portal-documents.controller.ts`)  : `<entity>InPortalScope(...)`, the caller's reach.
//   * the staff hub (`client-documents.controller.ts`) : the client's rows, each flagged `clientVisible` from the
//                                                         SAME row-state builders via `staffClientVisible`.
// Neither caller writes a visibility rule of its own: the row-state comes from portal-visibility.ts (plan trap 1 and 9),
// and `client-documents.db.test.ts` proves the staff flag equals what the portal returns (the parity test).
//
// Three kinds, each reached through its own parent row:
//   signed_contract : a SIGNED contract. `fileId` is the sealed copy (PV5-07, `contract_signed_copy`) with `ready: true`;
//                     until that exists it is the document attached to the contract (if any) with `ready: false`
//                     ("being prepared"), so a client sees the agreement exists and never gets an unsealed file labelled sealed.
//   invoice         : the `invoice_pdf` of an ISSUED invoice (PV5-07). `ready: false` and no file while it is being rendered.
//   receipt         : the proof file on a payment (the portal's "tell us you have paid" upload, or staff's).
// Every `fileId` is a file the portal file route (`GET portal/files/:fileId`) will serve to the same caller: the joins below
// repeat that route's parent-entity test (target type + id, not deleted), so the list never offers a link that 404s.
import type { PoolClient } from "pg";
import { CONTRACT_SIGNED_COPY_FILE_ID, INVOICE_PDF_FILE_ID } from "./document-read-fields";

export type DocumentKind = "signed_contract" | "invoice" | "receipt";

export interface DocumentItem {
  /** The source row: the contract, the invoice or the payment. Stable, for keys and for the parity test. */
  id: string;
  kind: DocumentKind;
  title: string;
  /** ISO 8601 (a timestamp, or a plain date for a receipt). */
  date: string;
  fileId: string | null;
  ready: boolean;
}

export interface StaffDocumentItem extends DocumentItem {
  /** Staff list only: a client-wide contact of this client can see this row in the portal. */
  clientVisible: boolean;
}

/** The WHERE half and the `clientVisible` expression for each kind. Parameters are the caller's own. */
export interface DocumentQueryParts {
  contractWhere: string;
  invoiceWhere: string;
  receiptWhere: string;
  /** SQL boolean expressions: `TRUE` on the portal (every row it lists is visible), the staff flag on the hub. */
  contractFlag: string;
  invoiceFlag: string;
  receiptFlag: string;
  /** Positional parameters PER QUERY: Postgres refuses a statement given a parameter it never references, and the
   *  portal's contract query binds two (clients, projects) where its invoice and receipt queries bind one. */
  contractParams: unknown[];
  invoiceParams: unknown[];
  receiptParams: unknown[];
}

const PER_KIND_LIMIT = 200;
const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

interface RawRow {
  id: string;
  title: string;
  date: string;
  file_id: string | null;
  ready: boolean;
  flag: boolean;
}

/** Contracts: signed only. `k` = contracts. The attached document is joined the way the portal file route tests it. */
export function contractDocumentsSql(where: string, flag: string): string {
  return `SELECT k.id, k.title, ${ISO("COALESCE(k.signed_at, k.updated_at)")} AS date,
                 COALESCE(${CONTRACT_SIGNED_COPY_FILE_ID("k")}, af.id) AS file_id,
                 (${CONTRACT_SIGNED_COPY_FILE_ID("k")} IS NOT NULL) AS ready,
                 ${flag} AS flag
            FROM contracts k
            LEFT JOIN files af ON af.id = k.file_id AND af.target_entity_type = 'contract' AND af.target_entity_id = k.id
                              AND af.deleted_at IS NULL AND af.storage_key IS NOT NULL
           WHERE ${where} AND k.status = 'signed'
           ORDER BY COALESCE(k.signed_at, k.updated_at) DESC, k.id LIMIT ${PER_KIND_LIMIT}`;
}

/** Invoices: issued only (an unissued one has no document). `i` = invoices. */
export function invoiceDocumentsSql(where: string, flag: string): string {
  return `SELECT i.id, COALESCE(i.invoice_no, 'Invoice') AS title, ${ISO("i.issued_at")} AS date,
                 ${INVOICE_PDF_FILE_ID("i")} AS file_id,
                 (${INVOICE_PDF_FILE_ID("i")} IS NOT NULL) AS ready,
                 ${flag} AS flag
            FROM invoices i
           WHERE ${where} AND i.issued_at IS NOT NULL
           ORDER BY i.issued_at DESC, i.id LIMIT ${PER_KIND_LIMIT}`;
}

/** Receipts: a payment with a live proof file. `pp` = invoice_payments, `i` = its invoice (LEFT JOIN is fine on staff). */
export function receiptDocumentsSql(where: string, flag: string): string {
  return `SELECT pp.id, 'Payment proof' || COALESCE(', ' || i.invoice_no, '') AS title,
                 to_char(pp.paid_on, 'YYYY-MM-DD') AS date, pf.id AS file_id, TRUE AS ready,
                 ${flag} AS flag
            FROM invoice_payments pp
            LEFT JOIN invoices i ON i.id = pp.invoice_id
            JOIN files pf ON pf.id = pp.proof_file_id AND pf.target_entity_type = 'invoice_payment' AND pf.target_entity_id = pp.id
                         AND pf.deleted_at IS NULL AND pf.storage_key IS NOT NULL
           WHERE ${where}
           ORDER BY pp.paid_on DESC, pp.id LIMIT ${PER_KIND_LIMIT}`;
}

/** Run the three queries and merge them, newest first. Ties break by kind then id so the order is stable. */
export async function loadDocuments(c: PoolClient, q: DocumentQueryParts): Promise<StaffDocumentItem[]> {
  const [contracts, invoices, receipts] = await Promise.all([
    c.query<RawRow>(contractDocumentsSql(q.contractWhere, q.contractFlag), q.contractParams),
    c.query<RawRow>(invoiceDocumentsSql(q.invoiceWhere, q.invoiceFlag), q.invoiceParams),
    c.query<RawRow>(receiptDocumentsSql(q.receiptWhere, q.receiptFlag), q.receiptParams),
  ]);
  const map = (kind: DocumentKind) => (r: RawRow): StaffDocumentItem => ({
    id: r.id, kind, title: r.title, date: r.date, fileId: r.file_id, ready: r.ready, clientVisible: r.flag === true,
  });
  const items = [
    ...contracts.rows.map(map("signed_contract")),
    ...invoices.rows.map(map("invoice")),
    ...receipts.rows.map(map("receipt")),
  ];
  return items.sort((a, b) => {
    const d = Date.parse(b.date) - Date.parse(a.date);
    if (d !== 0) return d;
    return a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind);
  });
}

/** The portal's view of an item: the public shape, without the staff flag. */
export function toPortalItem(i: StaffDocumentItem): DocumentItem {
  const { clientVisible: _flag, ...rest } = i;
  void _flag;
  return rest;
}

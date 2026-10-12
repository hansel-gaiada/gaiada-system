// PV5-07 — the two read fields every invoice and contract read carries (staff and portal, list and detail), in ONE
// place so the four controllers cannot drift:
//   * `pdfFileId`        : the live `invoice_pdf` file of an ISSUED invoice; null = not issued, or being prepared.
//   * `signedCopyFileId` : the live `contract_signed_copy` file of a contract; null = not signed, or being prepared.
// PV5-08 (Documents) and PV5-09 (screens) consume exactly these names (FRONTEND-BFF-CONTRACT §30).
//
// Scalar subqueries over `files` (core table, tenant RLS): `ux_files_live_role` guarantees at most one row, and the
// lookup uses that same index. The alias is a SQL table alias chosen by the caller, never input.

const ALIAS_RE = /^[a-z][a-z0-9_]{0,15}$/;
const alias = (a: string): string => {
  if (!ALIAS_RE.test(a)) throw new Error(`invalid SQL alias ${a}`);
  return a;
};

/** `(SELECT ...)` yielding the issued invoice's PDF file id, or NULL. `i` = the invoices alias. */
export function INVOICE_PDF_FILE_ID(i: string): string {
  const a = alias(i);
  return `(SELECT f.id FROM files f
            WHERE f.target_entity_type = 'invoice' AND f.target_entity_id = ${a}.id AND f.role = 'invoice_pdf'
              AND f.deleted_at IS NULL AND ${a}.issued_at IS NOT NULL
            LIMIT 1)`;
}

/** `(SELECT ...)` yielding the contract's sealed signed copy file id, or NULL. `k` = the contracts alias. */
export function CONTRACT_SIGNED_COPY_FILE_ID(k: string): string {
  const a = alias(k);
  return `(SELECT f.id FROM files f
            WHERE f.target_entity_type = 'contract' AND f.target_entity_id = ${a}.id AND f.role = 'contract_signed_copy'
              AND f.deleted_at IS NULL
            LIMIT 1)`;
}

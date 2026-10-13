// PV5-04b — the pieces of invoice numbering (ruling PV-D35) that more than one file needs: the service-line facts an invoice
// is judged on, and the constants shared with the controller. Tables: billing_service_lines, billing_number_codes
// (202610132115). The number is `{company}/{yyyy}/{mm}/{code}/{nnnn}`; see issue.ts for where it is made.
import type { PoolClient } from "pg";

/** The key of a service line: lower-case, starts with a letter, 2-32 characters (mirrors the table's CHECK). */
export const SERVICE_LINE_KEY = /^[a-z][a-z0-9_]{1,31}$/;
/** A number code, as the table's CHECK has it. Generated codes are 3 characters from the alphabet below. */
export const NUMBER_CODE = /^[A-Z0-9]{2,4}$/;
/** What `billing_number_code()` draws from: no O, 0, I, 1 or L, so a code is never misread. Kept here for the tests. */
export const NUMBER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface ServiceLineFacts {
  /** The line staff chose on the invoice, or null. */
  chosenKey: string | null;
  /** The line every project behind the invoice's lines maps to through its department, or null. */
  defaultKey: string | null;
  /** chosen, else default: the line the invoice will be issued under (null when neither exists). */
  effectiveKey: string | null;
  effectiveName: string | null;
  /** False when there is no effective line or it has been switched off. */
  effectiveActive: boolean;
}

/**
 * The service-line facts of one invoice. `c` is any client (the tables are core, not module walled).
 *
 * THE DEFAULT. The invoice's lines carry `projectId` (invoice.controller.ts writes it). The default is a line only when
 * EVERY line has a project, every such project has a department, and each department maps to EXACTLY ONE active service
 * line, and they are all the same line. Anything else (a line with no project, a project with no department, two lines
 * linked to one department, projects that disagree) gives NO default, and staff choose. It is never a guess.
 */
export async function readServiceLineFacts(c: PoolClient, invoiceId: string): Promise<ServiceLineFacts> {
  const r = await c.query<{ chosenKey: string | null; defaultKey: string | null; effectiveKey: string | null; effectiveName: string | null; effectiveActive: boolean | null }>(
    `WITH inv AS (
       SELECT id, tenant_id, service_line_key, lines FROM invoices WHERE id = $1
     ), d AS (
       SELECT CASE WHEN count(*) > 0 AND bool_and(m.key IS NOT NULL) AND count(DISTINCT m.key) = 1 THEN min(m.key) END AS key
         FROM inv
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(inv.lines) = 'array' THEN inv.lines ELSE '[]'::jsonb END) AS x(l)
         LEFT JOIN LATERAL (
           SELECT p.department_id FROM projects p
            WHERE p.tenant_id = inv.tenant_id AND p.id::text = x.l->>'projectId' LIMIT 1
         ) pr ON true
         CROSS JOIN LATERAL (
           SELECT (SELECT CASE WHEN count(*) = 1 THEN min(s.key) END
                     FROM billing_service_lines s
                    WHERE s.tenant_id = inv.tenant_id AND s.active
                      AND pr.department_id IS NOT NULL AND s.department_id = pr.department_id) AS key
         ) m
     )
     SELECT inv.service_line_key AS "chosenKey", d.key AS "defaultKey", sl.key AS "effectiveKey",
            sl.name AS "effectiveName", sl.active AS "effectiveActive"
       FROM inv CROSS JOIN d
       LEFT JOIN billing_service_lines sl ON sl.tenant_id = inv.tenant_id AND sl.key = COALESCE(inv.service_line_key, d.key)`,
    [invoiceId],
  );
  const row = r.rows[0];
  if (!row) return { chosenKey: null, defaultKey: null, effectiveKey: null, effectiveName: null, effectiveActive: false };
  return {
    chosenKey: row.chosenKey,
    defaultKey: row.defaultKey,
    effectiveKey: row.effectiveKey,
    effectiveName: row.effectiveName,
    effectiveActive: row.effectiveActive === true,
  };
}

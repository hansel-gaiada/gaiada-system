// AIP-13b (docs/plans/2026-10-27-ai-plan.md §6.2 item 7, owner ruling AIP-D10; docs/FRONTEND-BFF-CONTRACT.md §65; PERMISSION-CONTRACT §56) —
// a department's own assistant preamble: the body validator, the answer's shape and the SQL, kept out of the controller so the rules are
// unit-testable and the controller stays a thin authorize-then-delegate layer (the dept-notices layout).
//
// Two halves in one file, on purpose:
//   1. PURE rules: `parsePutBody`, `toPreambleView`. No DB, no Nest: `dept-assistant-preamble.service.test.ts` drives them directly.
//   2. SQL helpers that take the caller's `PoolClient`, so every write runs inside the controller's one `withTenants` transaction.
//
// One current text per (company, unit) in `assistant_dept_preambles`. The text REPLACES the registry default when the assistant builds a
// prompt for a turn sent from that department (modules/assistant/department-context.ts `resolvePreamble`); an empty PUT deletes the row,
// which is how a head goes back to the default.
import type { PoolClient } from "pg";
import {
  PREAMBLE_MAX_CHARS, capPreamble, defaultPreamble, previewText, type TurnDepartment,
} from "../modules/assistant/department-context";
import { scrubText } from "./scrub";

/** A refusal the controller maps to an HTTP exception. Pure data: no Nest import, so unit tests need no app. */
export class PreambleRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "PreambleRuleError";
  }
}
export const departmentNotFound = () => new PreambleRuleError(404, "department_not_found", "unitNodeId");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Length in code points, as Postgres `char_length` counts them (a JS string's `.length` counts UTF-16 units). */
const cpLength = (s: string): number => Array.from(s).length;

/** Plain text, as a notice's is (dept-notices.service.ts `plainText`): a NUL cannot live in a Postgres text column (it would be a 500),
 *  CRLF becomes LF (line breaks are kept), and PAN, national ids and e-mail addresses are scrubbed BEFORE the length is measured: the
 *  scrubbed text is what is stored (and what reaches a prompt), and a redaction tag can be longer than what it replaced. */
function plainText(s: string): string {
  return scrubText(s.replace(/\u0000/g, "").replace(/\r\n?/g, "\n")).text;
}

/**
 * The PUT body: `{ body: string }`, nothing else. The text is trimmed; 1 to `PREAMBLE_MAX_CHARS` characters is a text to store; an empty
 * (or whitespace-only) text is `null`, meaning "reset: delete the row and go back to the default"; anything else is a 400 naming `body`.
 * Called AFTER the authorization decision, so a refused caller always gets 403 and never learns that the body was invalid.
 */
export function parsePutBody(body: unknown): { text: string | null } {
  if (!isPlainObject(body)) throw new PreambleRuleError(400, "the body must be an object with a `body` string", "body");
  for (const k of Object.keys(body)) {
    if (k !== "body") throw new PreambleRuleError(400, `${k} is not a field of a preamble`, k);
  }
  if (typeof body.body !== "string") throw new PreambleRuleError(400, "body is required and must be a string", "body");
  const text = plainText(body.body).trim();
  const n = cpLength(text);
  if (n === 0) return { text: null };
  if (n > PREAMBLE_MAX_CHARS) throw new PreambleRuleError(400, `body must be at most ${PREAMBLE_MAX_CHARS} characters`, "body");
  return { text };
}

export interface PreambleDbRow {
  body: string;
  updated_at: Date;
  updated_by: string | null;
  updated_by_name: string | null;
}

export interface PreambleView {
  unitNodeId: string;
  /** The department as the server resolved it (name and registry key from the row, never from the request). Always set on an answer:
   *  an unknown or inactive department is a 404 before a view is built. */
  department: { name: string; key: string } | null;
  /** The head's own text, or `null` when the department uses the default. */
  custom: string | null;
  /** The registry default for the department's key, or `null` (a department with no default, e.g. a custom one). */
  defaultText: string | null;
  /** What the assistant uses: `custom` when there is one, else `defaultText`, else `null`. */
  effective: string | null;
  /** When the custom text was last written (null with no custom text). */
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
  /** The department block of the prompt EXACTLY as the assistant reads it (`previewText`: the context line, then `Department guidance:` and
   *  the effective text), or `null` when there is nothing to say. */
  preview: string | null;
  /** Whether the assistant uses department guidance in this company at all (the company switch `ASSISTANT_DEPT_CONTEXT`, `deptContextEnabled`).
   *  False: the text can still be saved, the assistant just does not read it yet. */
  contextEnabled: boolean;
}

/** The answer of GET and PUT. `row` is the stored row or `null` (no custom text: the default stands). `contextEnabled` is
 *  `deptContextEnabled(tenantId)`, decided by the caller (this function stays pure and reads no config). */
export function toPreambleView(unitNodeId: string, department: TurnDepartment, row: PreambleDbRow | null, contextEnabled: boolean): PreambleView {
  const custom = row && row.body.trim() ? capPreamble(row.body) : null;
  const defaultText = defaultPreamble(department.key);
  const effective = custom ?? defaultText;
  return {
    unitNodeId,
    department: { name: department.name, key: department.key },
    custom,
    defaultText,
    effective,
    updatedAt: custom && row ? row.updated_at.toISOString() : null,
    updatedBy: custom && row && row.updated_by ? { id: row.updated_by, name: row.updated_by_name ?? "" } : null,
    preview: previewText(department, effective),
    contextEnabled,
  };
}

// ───────────────────────────────────────── SQL ─────────────────────────────────────────

/** The stored row for (tenant, unit) with the last editor's name, or `null`. RLS keeps it in the tenant; the query still names it. */
export async function loadPreambleRow(c: PoolClient, tenantId: string, unitNodeId: string): Promise<PreambleDbRow | null> {
  const { rows } = await c.query<PreambleDbRow>(
    `SELECT p.body, p.updated_at, p.updated_by, u.name AS updated_by_name
       FROM assistant_dept_preambles p LEFT JOIN users u ON u.id = p.updated_by
      WHERE p.tenant_id = $1 AND p.unit_node_id = $2`,
    [tenantId, unitNodeId],
  );
  return rows[0] ?? null;
}

/** Write the unit's text (insert, or replace the one row); the first writer's `created_at` is kept. */
export async function upsertPreamble(c: PoolClient, tenantId: string, unitNodeId: string, body: string, userId: string): Promise<void> {
  await c.query(
    `INSERT INTO assistant_dept_preambles (tenant_id, unit_node_id, body, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, unit_node_id)
     DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, unitNodeId, body, userId],
  );
}

/** Delete the unit's row (back to the default). Returns whether a row was there. */
export async function deletePreamble(c: PoolClient, tenantId: string, unitNodeId: string): Promise<boolean> {
  const { rowCount } = await c.query(`DELETE FROM assistant_dept_preambles WHERE tenant_id = $1 AND unit_node_id = $2`, [tenantId, unitNodeId]);
  return (rowCount ?? 0) > 0;
}

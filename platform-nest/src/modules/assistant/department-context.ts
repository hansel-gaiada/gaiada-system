// AIP-10 / AIP-13 — the department of a turn (docs/plans/2026-10-27-ai-plan.md §3 and §6.2, items 1 to 3).
//
// WHAT THIS IS. The assistant learns which department and page a message was sent from, adds that department's short
// preamble to the prompt, and (context.ts) asks knowledge retrieval to rank that department first. This file holds the
// pieces that are not the prompt itself: the flag helper, the sanitising, the `turn_context` part, the registry-keyed
// default preambles and the one-line context sentence.
//
// ── THE AUTHORIZATION LINE (plan §3.3, binding) ─────────────────────────────────────────────────────────────────────
// Department context is a LABEL that narrows, never an authority that widens. Nothing in this file reads a record, opens
// a tool or changes who the principal is: the chat still runs as the chatting user, and what may be CITED is still decided
// by DW-D26's per-record read filter (context.ts). The browser's `departmentId` is not trusted as a fact: it must name an
// ACTIVE department of the thread's own company (an `org_units` row, else a department node of its org tree: see
// `resolveDepartment`), and the name and key come from that row. An unknown id, or another
// company's node id (node ids repeat across companies), resolves to NO department and no error. `page` is a label only.
//
// ── PER TURN, NEVER STORED ON THE THREAD (plan §3.3 item 3) ─────────────────────────────────────────────────────────
// The resolved context is written onto the reply's PLACEHOLDER row as a `turn_context` part, the way ASST-17 writes
// `turn_mode`, and the stream reads it back from that ROW, never from its own query string (an EventSource URL is the
// browser's to edit). The finished reply rewrites `parts` whole (stream.ts `persistGenerationOutcome`), so the part does
// not outlive the turn it described; nothing about the department is kept on `assistant_threads`.
//
// ── THE FLAG (AIP-D3) ───────────────────────────────────────────────────────────────────────────────────────────────
// `ASSISTANT_DEPT_CONTEXT`, one flag per company (config.ts `parseDeptContext`). Off means the prompt and the knowledge
// call are byte for byte what they were before Phase 3: the send route writes no part, and the stream re-checks the flag
// before it reads one, so a flag turned off between send and stream also leaves the old prompt.
//
// ── THE PREAMBLE (AIP-13, AIP-13b) ──────────────────────────────────────────────────────────────────────────────────
// The defaults below describe each department's work and vocabulary from the workspace registry's mission line. They INVENT
// NO RULES: a rule belongs to the department's head, who edits the text in AIP-13b (a table row that `resolvePreamble` will
// prefer over the default). The text lives on the server, not in `workspaces.ts`, because a rule the browser sends is a rule
// the browser can leave out.
import type { PoolClient } from "pg";
import { config } from "../../config";

// ── the flag ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Is department context on for this company? Reads `config.assistant.deptContext` at call time, so a test (or a restart-free
 *  override) sees the live value. No company means off: with nothing to scope to, nothing is resolved. */
export function deptContextEnabled(tenantId: string | null | undefined): boolean {
  const flag = config.assistant.deptContext;
  if (!tenantId) return false;
  if (flag.all) return true;
  return flag.companies.includes(tenantId.toLowerCase());
}

// ── the slug (an exact copy of platform-ui `lib/deptToolkits.ts`) ───────────────────────────────────────────────────────

/** "Web Dev" -> "web-dev", "Social Media" -> "social-media". An EXACT copy of platform-ui's `deptSlug` (the workspace key the
 *  registry uses), so the server and the UI name a department the same way. Keep the two in step. */
export function deptSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── the turn's context ────────────────────────────────────────────────────────────────────────────────────────────────

/** A department as the server resolved it: the org node id, the name on the row, and the registry key. */
export interface TurnDepartment {
  nodeId: string;
  name: string;
  key: string;
}

/** The `parts` entry that records a turn's context on its placeholder row. */
export interface TurnContext {
  type: "turn_context";
  department: TurnDepartment | null;
  page: string | null;
}

/** What the browser sends, after the type check. Both fields are claims, not facts. */
export interface RawTurnContext {
  departmentId?: string;
  page?: string;
}

/** `body.context` as the send and ask routes accept it: an object whose `departmentId` and `page` are strings. Anything else
 *  (a non-object, a field of the wrong type) is ignored, never an error: the context is a hint for the prompt, not input the
 *  request depends on. */
export function readRawContext(body: unknown): RawTurnContext {
  const ctx = body && typeof body === "object" ? (body as { context?: unknown }).context : undefined;
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return {};
  const { departmentId, page } = ctx as { departmentId?: unknown; page?: unknown };
  return {
    ...(typeof departmentId === "string" ? { departmentId } : {}),
    ...(typeof page === "string" ? { page } : {}),
  };
}

const PAGE_MAX = 60;
/** Letters, digits, spaces and `& · - / ' ( )`. ASCII on purpose: the registry's page names are, and a label that reaches a
 *  prompt gets the narrowest alphabet that fits. A newline or any other control character is outside it, so it is dropped. */
const PAGE_RE = /^[A-Za-z0-9 &·\-/'()]+$/;

/** A page label, or `null`. Trimmed, one line, at most 60 characters, only the alphabet above; anything else is DROPPED, not
 *  repaired (a label that needed repairing was not the registry's). */
export function sanitizePage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const page = raw.trim();
  if (page.length === 0 || page.length > PAGE_MAX) return null;
  return PAGE_RE.test(page) ? page : null;
}

/** The org node id is a claim until it names an active row of this company; this only bounds what is even looked up. */
const NODE_ID_MAX = 200;

/** One-line, collapsed, bounded: a department name from the row, made safe to sit in a sentence. */
function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Resolve `departmentId` to an ACTIVE department of THIS company, or `null` (no error): the name and the key come from the
 *  row, never from the request. `c` must already be a `withTenants([tenantId])` client; both reads still name `tenant_id`, so
 *  another company's node id (ids repeat across companies) can match nothing even on a client scoped wider.
 *
 *  TWO SOURCES, `org_units` FIRST (the design's rule: an active `org_units` row of the company). `org_units` holds only the
 *  LAZILY anchored units (service-assigned ones: migration 0026, FRONTEND-BFF-CONTRACT's HR terminate row), while the department
 *  id the UI sends is a node id of the company's org tree (`company_org_structure`, the direct `department` children of the
 *  root, which is what `platform-ui/src/lib/departments.ts` lists). Reading `org_units` alone would resolve no department for
 *  every department without a service assignment, so a node of the tree is the second source. Both are this company's own rows
 *  and both give the same three facts; neither widens what the turn may read. */
export async function resolveDepartment(c: PoolClient, tenantId: string, departmentId: string | undefined): Promise<TurnDepartment | null> {
  if (!departmentId) return null;
  const id = departmentId.trim();
  if (!id || id.length > NODE_ID_MAX) return null;
  const anchored = await c.query<{ node_id: string; name: string }>(
    `SELECT node_id, name FROM org_units WHERE tenant_id = $1 AND node_id = $2 AND status = 'active' LIMIT 1`,
    [tenantId, id],
  );
  let row = anchored.rows[0];
  if (!row) {
    const node = await c.query<{ node_id: string; name: string }>(
      `SELECT n ->> 'id' AS node_id, n ->> 'name' AS name
         FROM company_org_structure s
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(s.structure -> 'root' -> 'children') = 'array' THEN s.structure -> 'root' -> 'children' ELSE '[]'::jsonb END
         ) AS n
        WHERE s.tenant_id = $1 AND n ->> 'kind' = 'department' AND n ->> 'id' = $2
        LIMIT 1`,
      [tenantId, id],
    );
    row = node.rows[0];
  }
  if (!row || typeof row.node_id !== "string" || typeof row.name !== "string") return null;
  const name = oneLine(row.name, 120);
  return name ? { nodeId: row.node_id, name, key: deptSlug(name) } : null;
}

/** The part to write, or `null` when there is nothing to write: no department and no page means NO part, so a turn without
 *  context has the same `parts` it had before. */
export function turnContextPart(department: TurnDepartment | null, page: string | null): TurnContext | null {
  if (!department && !page) return null;
  return { type: "turn_context", department, page };
}

/** Resolve a request's raw context into the part to store, or `null`. Flag off (for this company) returns `null` without
 *  touching the database. */
export async function resolveTurnContext(c: PoolClient, tenantId: string, raw: RawTurnContext): Promise<TurnContext | null> {
  if (!deptContextEnabled(tenantId)) return null;
  const department = await resolveDepartment(c, tenantId, raw.departmentId);
  return turnContextPart(department, sanitizePage(raw.page));
}

/** Read the context back off a `parts` jsonb value. Absent-tolerant like `readTurnMode`: `null` for a plain turn, an empty `[]`
 *  and any malformed or hand-edited value, so a bad row can only degrade a turn to the context-free prompt. The stored values
 *  are re-validated (the page again, the department's shape) because the row, not the request, is what the prompt trusts. */
export function readTurnContext(parts: unknown): TurnContext | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (!p || typeof p !== "object" || (p as { type?: unknown }).type !== "turn_context") continue;
    const d = (p as { department?: unknown }).department;
    let department: TurnDepartment | null = null;
    if (d && typeof d === "object") {
      const { nodeId, name, key } = d as { nodeId?: unknown; name?: unknown; key?: unknown };
      if (typeof nodeId === "string" && typeof name === "string" && typeof key === "string" && name.trim()) {
        department = { nodeId, name: oneLine(name, 120), key };
      }
    }
    return turnContextPart(department, sanitizePage((p as { page?: unknown }).page));
  }
  return null;
}

// ── the preamble ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The cap on a preamble, defaults and (AIP-13b) a head's own text alike. */
export const PREAMBLE_MAX_CHARS = 1000;

/**
 * AIP-13: a short default per workspace key, taken from the registry's mission line (`platform-ui/src/lib/workspaces.ts`,
 * `WORKSPACES`: web-dev, seo, social-media, creatives, gm, hr, finance, it). Each says what the department does and the words
 * it uses, and nothing more: NO RULES are invented here (a head adds rules in AIP-13b). Plain sentences, at most 1,000 characters.
 * A department with no entry (the generic workspace, a custom department) gets no preamble.
 */
export const DEFAULT_DEPT_PREAMBLES: Readonly<Record<string, string>> = {
  "web-dev":
    "Web Dev takes client requirements to a shipped build. Its work moves through a pipeline of builds and runs, and the sites it " +
    "delivers are watched in monitoring. Common words: briefing, request, board, deliverable, pipeline, build, run, monitoring, " +
    "website, uptime, reopened work.",
  seo:
    "SEO is search marketing: organic search (SEO), AI answers (GEO) and paid search (SEM). It works per client account and " +
    "reports on results. Common words: keyword, ranking, audit, content brief, traffic, campaign, ad budget, " +
    "client report.",
  "social-media":
    "Social Media runs organic publishing across every connected network, one master post at a time. Posts are planned on a " +
    "calendar, designed, approved by the client and published. Common words: master post, caption, campaign, content calendar, " +
    "design queue, approval, boost, allocation, inbox, reach, engagement.",
  creatives:
    "Creatives is creative production, from raw capture to on-brand, export-ready assets. It takes asset requests, works them " +
    "in the studio and delivers the files. Common words: asset request, brief, image studio, library, review, revision round, " +
    "export, delivered.",
  gm:
    "The Office of the GM looks at the whole business, one altitude up: how the company, its clients, projects and departments " +
    "are doing. Common words: decision, approval, revenue against plan, margin, utilization, project health, client health, " +
    "receivables, business review.",
  hr:
    "HR is people: hiring, time, pay, growth and the cases in between. Common words: directory, onboarding, org structure, " +
    "leave, attendance, compensation, payroll, recruitment, appraisal cycle, case, compliance, mandatory learning.",
  finance:
    "Finance is money: the ledger, what the company is owed and owes, cash, tax and the close. Common words: journal, general " +
    "ledger, chart of accounts, receivables, invoice, payables, treasury, fixed assets, tax, period close, consolidation, " +
    "financial statements.",
  it:
    "IT looks after devices, the network, staff accounts and the workflows that run them. Common words: device, network, " +
    "topology, sign-in, threat alert, block, account request, workflow, UniFi, Google Admin, n8n, uptime.",
};

/** The preamble for a department: today the default for its registry key. This is the seam AIP-13b widens (the company's own
 *  row for that unit replaces the default); it is async and takes the tenant and node id so that change touches no caller.
 *  `null` for a department with no preamble. Never longer than `PREAMBLE_MAX_CHARS`. */
export async function resolvePreamble(_tenantId: string, _nodeId: string, key: string): Promise<string | null> {
  const text = Object.prototype.hasOwnProperty.call(DEFAULT_DEPT_PREAMBLES, key) ? DEFAULT_DEPT_PREAMBLES[key] : undefined;
  return text ? text.slice(0, PREAMBLE_MAX_CHARS) : null;
}

// ── the sentence ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** "You are helping someone in the SEO department, on the Rankings page." (or without the page clause). With no department
 *  but a page: "You are helping someone on the Rankings page." With neither: `null`. */
export function contextLine(department: Pick<TurnDepartment, "name"> | null, page: string | null): string | null {
  const name = department ? oneLine(department.name, 120) : "";
  if (name && page) return `You are helping someone in the ${name} department, on the ${page} page.`;
  if (name) return `You are helping someone in the ${name} department.`;
  if (page) return `You are helping someone on the ${page} page.`;
  return null;
}

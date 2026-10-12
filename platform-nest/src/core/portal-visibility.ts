// PV3-02 — the client portal's ROW-VISIBILITY predicates, in one place.
//
// ── WHAT THIS FILE IS ──────────────────────────────────────────────────────────────────────────────
// `portal-scope.ts` answers "WHO is this caller" (their clients, their project restriction, whether they
// may sign). This file answers the other half, "WHICH ROWS may a client see", as SQL fragments. Before
// PV3-02 that second half was inline SQL retyped across six controllers (`status <> 'draft'` eight times,
// `actor_side = 'client'` seven times, the project-scope clause everywhere), and a rule written N times
// is a rule that will disagree with itself. It also had to move here because the STAFF side is about to
// ask the same question: PV3-07 marks each staff row "Client sees this" or "Internal", and that marker is
// only honest if it is computed from exactly these predicates. A second hand-written copy on the staff
// side would drift from the portal (plan trap 9), and the marker would then lie in the one direction that
// matters: telling staff a row is internal when the client can read it.
//
// ── TWO KINDS OF BUILDER PER ENTITY ────────────────────────────────────────────────────────────────
//   * `<entity>ClientVisible(alias)` — the ROW-STATE half: what makes a row of the client's OWN visible
//     to a client-wide contact (not soft-deleted, not a draft, a client-side gate, not the report stage).
//     It binds no parameters, so the staff side can use it with `client_id IS NOT NULL` (PV3-07).
//   * `<entity>InPortalScope(alias, params)` — the full portal predicate: the row-state half AND the
//     caller's reach (layer 3 of the four in portal-scope.ts — their clients, and for a project-scoped
//     contact, their projects). Every portal read uses one of these.
// A handful of call sites compose the two halves themselves because their existing SQL already admitted
// the parent row elsewhere (for example a project's own milestones, read after the project passed
// PROJECT_SCOPE). Those compositions are deliberate and listed in the PV3-02 hand-back.
//
// ── PARAMETERS ARE POSITIONAL AND THE CALLER OWNS THEM ─────────────────────────────────────────────
// Every portal query passes its params as a positional array, and the scope arrays sit at different
// indexes in different queries (`$1/$2` in a list, `$2/$3` behind an id). So no builder assumes an
// index: the caller names them (`{ clients: 2, projects: 3 }`). The NULL handling of `projects` is the
// load-bearing part — `projectIds === null` means "every project of these clients" (portal-scope.ts),
// and it is expressed in SQL as `($n::uuid[] IS NULL OR …)` so no TypeScript `?? []` can invert it.
//
// ── ALIASES ────────────────────────────────────────────────────────────────────────────────────────
// `alias` is the table alias the caller's FROM clause uses ("k" for `contracts k`). An empty string
// means unqualified columns, for the few single-table queries written without an alias. Both the alias
// and the parameter indexes are validated, because they are interpolated into SQL text.
//
// ⚠ NOT THE SAME THING AS `core/client-filter.ts`. That file parses the STAFF `?clientId=` list facet and
// fails OPEN. Everything here is the portal's isolation boundary and fails CLOSED. Do not merge them.

/** Positional parameter indexes for the caller's scope, as passed to `pg`: `clients` binds
 *  `PortalScope.clientIds` (uuid[]), `projects` binds `PortalScope.projectIds` (uuid[] | null). */
export interface PortalScopeParams {
  clients: number;
  projects: number;
}

/** Entities whose portal reach is the client only (no project restriction applies to them). */
export type PortalClientParams = Pick<PortalScopeParams, "clients">;

const ALIAS_RE = /^(?:[a-z_][a-z0-9_]*)?$/;

/** `alias.column`, or the bare column for alias "". Refuses anything that is not a plain identifier. */
function col(alias: string, column: string): string {
  if (!ALIAS_RE.test(alias)) throw new Error(`portal-visibility: invalid table alias ${JSON.stringify(alias)}`);
  return alias ? `${alias}.${column}` : column;
}

/** `$n` for a positional parameter index. Refuses anything but a positive integer. */
function ph(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`portal-visibility: invalid parameter index ${String(n)}`);
  return `$${n}`;
}

/** The row belongs to one of the caller's clients: `alias.client_id = ANY($n::uuid[])`. The client half
 *  of layer 3, exported for the few call sites whose project half is already settled by a join. */
export function inCallerClients(alias: string, clients: number): string {
  return `${col(alias, "client_id")} = ANY(${ph(clients)}::uuid[])`;
}

/** The project half of layer 3 for a row's project column. `allowNullProject` admits rows with no
 *  project to a project-scoped contact (a master agreement, a client-wide change request). */
function inCallerProjects(column: string, projects: number, allowNullProject: boolean): string {
  const p = ph(projects);
  return allowNullProject
    ? `(${p}::uuid[] IS NULL OR ${column} = ANY(${p}::uuid[]) OR ${column} IS NULL)`
    : `(${p}::uuid[] IS NULL OR ${column} = ANY(${p}::uuid[]))`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Projects, milestones, deliverables — visible through the project
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A project row is visible unless soft-deleted. */
export function projectClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL`;
}

/** Layer 3 only for a project: one of the caller's clients, and one of their projects when the contact
 *  is project-scoped. No row-state. */
export function projectReach(alias: string, params: PortalScopeParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${inCallerProjects(col(alias, "id"), params.projects, false)}`;
}

/** The full portal predicate for a project. */
export function projectInPortalScope(alias: string, params: PortalScopeParams): string {
  return `${projectReach(alias, params)} AND ${projectClientVisible(alias)}`;
}

/** SQL predicate restricting `projects p` to the caller's scope. Binds $1 = clientIds uuid[],
 *  $2 = projectIds uuid[] | null. This is the exact text PortalWorkspaceController has always used,
 *  moved here and exported (its old comment already said "exported"; it was module-private). */
export const PROJECT_SCOPE = projectInPortalScope("p", { clients: 1, projects: 2 });

/** A milestone is visible unless soft-deleted; its reach is its project's (join to a project admitted
 *  by PROJECT_SCOPE / projectInPortalScope). */
export function milestoneClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL`;
}

/** A deliverable is visible unless soft-deleted. It has no visibility flag of its own, and its reach
 *  travels through its project because `deliverables.client_id` is nullable. */
export function deliverableClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Delivery runs, their stages and their gates
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A pipeline run is visible unless soft-deleted. */
export function runClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL`;
}

/** The full portal predicate for a run. A run with no project is visible to a client-wide contact only
 *  (no NULL-project admission for project-scoped contacts, unlike contracts). */
export function runInPortalScope(alias: string, params: PortalScopeParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${runClientVisible(alias)} AND ${inCallerProjects(col(alias, "project_id"), params.projects, false)}`;
}

/** A run's stages are visible except the internal `report` track. */
export function runStageClientVisible(alias: string): string {
  return `${col(alias, "track")} <> 'report'`;
}

/** A gate is visible only when it is a CLIENT-side gate and not soft-deleted. Internal review gates are
 *  abstracted into the run's plain-language blockage line and never listed. */
export function gateClientVisible(alias: string): string {
  return `${col(alias, "actor_side")} = 'client' AND ${col(alias, "deleted_at")} IS NULL`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Contracts, invoices, invoice payments
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A contract is visible unless soft-deleted or still a `draft` (the agency's internal working copy). */
export function contractClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL AND ${col(alias, "status")} <> 'draft'`;
}

/** The full portal predicate for a contract. A contract with no project is admitted for a
 *  project-scoped contact: a master agreement covers the whole relationship, including their project. */
export function contractInPortalScope(alias: string, params: PortalScopeParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${contractClientVisible(alias)} AND ${inCallerProjects(col(alias, "project_id"), params.projects, true)}`;
}

/** An invoice is visible unless soft-deleted, still a `draft` (a number the agency has not committed to),
 *  or `approved` (PV3-02d: the internal maker/checker step BEFORE the invoice is sent; the client must not
 *  see an invoice the agency has not yet issued). Visible: `sent`, `paid`, `void`. */
export function invoiceClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL AND ${col(alias, "status")} NOT IN ('draft','approved')`;
}

/** The full portal predicate for an invoice. Invoices carry no project, so reach is the client only. */
export function invoiceInPortalScope(alias: string, params: PortalClientParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${invoiceClientVisible(alias)}`;
}

/** The two contexts in which the portal shows an invoice payment.
 *  - `detail`: an invoice's payment history and its paid / pending-confirmation sums. Every
 *    non-deleted payment shows, pending and rejected included, because the client recorded some of them
 *    and must see their state. Reach is through the PARENT INVOICE: the caller correlates
 *    `pp.invoice_id` to an invoice already admitted by `invoiceInPortalScope`.
 *  - `timeline`: the relationship's history feed, which shows only `confirmed` payments (a claim is not
 *    a payment until finance confirms it). */
export type InvoicePaymentContext = "detail" | "timeline";

/** Row-state for an invoice payment in one of its two contexts. */
export function invoicePaymentClientVisible(alias: string, context: InvoicePaymentContext): string {
  if (context === "detail") return `${col(alias, "deleted_at")} IS NULL`;
  if (context === "timeline") return `${col(alias, "deleted_at")} IS NULL AND ${col(alias, "status")} = 'confirmed'`;
  throw new Error(`portal-visibility: unknown invoice payment context ${JSON.stringify(context)}`);
}

/** An invoice payment reached directly by its own (denormalised) `client_id` rather than through its
 *  invoice: the timeline feed, and the receipt download route. */
export function invoicePaymentInPortalScope(alias: string, context: InvoicePaymentContext, params: PortalClientParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${invoicePaymentClientVisible(alias, context)}`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Requests: web change requests and social post reviews
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A change request is visible unless soft-deleted. */
export function changeRequestClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL`;
}

/** The full portal predicate for a change request: the caller's clients, and for a project-scoped
 *  contact, their projects OR a client-wide request with no project. */
export function changeRequestInPortalScope(alias: string, params: PortalScopeParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${inCallerProjects(col(alias, "project_id"), params.projects, true)} AND ${changeRequestClientVisible(alias)}`;
}

/** A social post review is always visible to its client: the table has no soft-delete and no internal
 *  state. Returned as `TRUE` so the staff side can compose it like any other row-state predicate. */
export function postReviewClientVisible(alias: string): string {
  col(alias, "id"); // validate the alias like every other builder, even though no column is read
  return `TRUE`;
}

/** The full portal predicate for a social post review: the caller's clients only. Project scope does
 *  not apply (a review belongs to a client, not a project). */
export function postReviewInPortalScope(alias: string, params: PortalClientParams): string {
  return inCallerClients(alias, params.clients);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Client contacts — what the portal People area (`GET /portal/profile` → `contacts`, PV2-07) lists
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** A client contact is listed unless soft-deleted or `revoked`. Note this is VISIBILITY, not access:
 *  an `invited` contact is listed (the client should see who has been asked) but resolves to no portal
 *  scope until they accept (portal-scope.ts, `status = 'active'`). */
export function clientContactClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL AND ${col(alias, "status")} <> 'revoked'`;
}

/** The full portal predicate for a client contact: contacts of the caller's clients. */
export function clientContactInPortalScope(alias: string, params: PortalClientParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${clientContactClientVisible(alias)}`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Never visible to a client
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** Kinds that NO portal read returns, whatever their row state. PV3-07 answers `clientVisible: false`
 *  for these from this constant rather than from a predicate. */
export const NEVER_CLIENT_VISIBLE = ["task", "meeting", "note", "history"] as const;

export type NeverClientVisibleKind = (typeof NEVER_CLIENT_VISIBLE)[number];

/** Why each kind is never shown. Kept next to the list so removing a kind means confronting the reason. */
export const NEVER_CLIENT_VISIBLE_REASONS: Readonly<Record<NeverClientVisibleKind, string>> = {
  task:
    "pm_tasks carry internal titles, assignees, estimates and blocked reasons. The portal shows milestones " +
    "plus aggregate progress and per-status counts, never the task list (portal-workspace.controller.ts header).",
  meeting:
    "No portal read of meeting_recordings or meeting_participants exists. Meetings are internal records " +
    "(recordings, transcripts, attendees) and reach a client only through deliberate follow-up.",
  note:
    "comments are staff notes on an entity, written for colleagues. No portal read exists and none may be " +
    "added without a client-visible flag that the table does not have.",
  history:
    "activities records every internal verb by every actor. The portal timeline is composed from " +
    "client-visible OBJECTS instead, so a new internal verb can never leak into the client's feed.",
};

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
// index: the caller names them (`scopeAt(2)` = `{ clients: 2, wide: 3, projects: 4 }`, bound with
// `...scopeValues(scope)` from portal-scope.ts). The reach is PER CLIENT (portal scope kernel per client,
// 2026-10-13): a row is in reach when its client is one of the caller's clients AND (that client is one the
// caller reaches client-wide, `wide`, OR the row's project is one of the caller's explicit `projects`). There
// is no "NULL means every project" any more: the old flattened form let a contact who was client-wide on one
// client see every project of every OTHER client they were a project-scoped contact of.
//
// ── ALIASES ────────────────────────────────────────────────────────────────────────────────────────
// `alias` is the table alias the caller's FROM clause uses ("k" for `contracts k`). An empty string
// means unqualified columns, for the few single-table queries written without an alias. Both the alias
// and the parameter indexes are validated, because they are interpolated into SQL text.
//
// ⚠ NOT THE SAME THING AS `core/client-filter.ts`. That file parses the STAFF `?clientId=` list facet and
// fails OPEN. Everything here is the portal's isolation boundary and fails CLOSED. Do not merge them.

/** Positional parameter indexes for the caller's scope, as passed to `pg`: `clients` binds
 *  `PortalScope.clientIds`, `wide` binds `PortalScope.wideClientIds`, `projects` binds
 *  `PortalScope.projectIds` (all uuid[], never null). `wide` is REQUIRED: a project-scoped predicate
 *  without it cannot tell which of the caller's clients they reach client-wide. */
export interface PortalScopeParams {
  clients: number;
  wide: number;
  projects: number;
}

/** The conventional layout: the three scope arrays at `$n`, `$n+1`, `$n+2`, in `scopeValues(scope)` order. */
export function scopeAt(n: number): PortalScopeParams {
  return { clients: n, wide: n + 1, projects: n + 2 };
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

/** The project half of layer 3, PER CLIENT: the row's client (`clientAlias.client_id`) is one the caller
 *  reaches client-wide, or the row's project is one of the caller's explicit projects. `allowNullProject`
 *  admits rows with no project to a project-scoped contact of that client (a master agreement, a
 *  client-wide change request). Always AND-ed with `inCallerClients` on the same client column, which is
 *  what confines the NULL-project arm to the caller's own clients. */
function inCallerProjects(clientAlias: string, column: string, params: PortalScopeParams, allowNullProject: boolean): string {
  const w = ph(params.wide);
  const p = ph(params.projects);
  const wideArm = `${col(clientAlias, "client_id")} = ANY(${w}::uuid[])`;
  return allowNullProject
    ? `(${wideArm} OR ${column} = ANY(${p}::uuid[]) OR ${column} IS NULL)`
    : `(${wideArm} OR ${column} = ANY(${p}::uuid[]))`;
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
  return `${inCallerClients(alias, params.clients)} AND ${inCallerProjects(alias, col(alias, "id"), params, false)}`;
}

/** The full portal predicate for a project. */
export function projectInPortalScope(alias: string, params: PortalScopeParams): string {
  return `${projectReach(alias, params)} AND ${projectClientVisible(alias)}`;
}

/** SQL predicate restricting `projects p` to the caller's scope. Binds $1 = clientIds, $2 = wideClientIds,
 *  $3 = projectIds (all uuid[]; `scopeAt(1)`, so pass `...scopeValues(scope)` first and any further params
 *  from $4). This is the exact text PortalWorkspaceController has always used,
 *  moved here and exported (its old comment already said "exported"; it was module-private). */
export const PROJECT_SCOPE = projectInPortalScope("p", scopeAt(1));

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
  return `${inCallerClients(alias, params.clients)} AND ${runClientVisible(alias)} AND ${inCallerProjects(alias, col(alias, "project_id"), params, false)}`;
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
  return `${inCallerClients(alias, params.clients)} AND ${contractClientVisible(alias)} AND ${inCallerProjects(alias, col(alias, "project_id"), params, true)}`;
}

/** An invoice is visible unless soft-deleted, still a `draft` (a number the agency has not committed to),
 *  or `approved` (PV3-02d: the internal maker/checker step BEFORE the invoice is sent; the client must not
 *  see an invoice the agency has not yet issued). Visible: `sent`, `paid`, `void`.
 *  PV5-F1: a `void` invoice is visible only if the client was ever sent it, i.e. it was ISSUED (`issued_at`), or
 *  it predates PV-5 (`pre_pv5_legacy`, set by migration alone; keeps those rows' visibility as it was). A draft
 *  voided before it was issued never reached the client, so it must not appear in their list or documents. */
export function invoiceClientVisible(alias: string): string {
  const status = col(alias, "status");
  return `${col(alias, "deleted_at")} IS NULL AND ${status} NOT IN ('draft','approved') AND (${status} <> 'void' OR ${col(alias, "issued_at")} IS NOT NULL OR ${col(alias, "pre_pv5_legacy")})`;
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
  return `${inCallerClients(alias, params.clients)} AND ${inCallerProjects(alias, col(alias, "project_id"), params, true)} AND ${changeRequestClientVisible(alias)}`;
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

/** The full portal predicate for a client contact, PER CLIENT (owner ruling PV-D36, 2026-10-13):
 *  "A contact limited to some projects sees the client-wide contacts and the contacts on their own
 *  projects, never contacts on projects outside their reach (nor those contacts' project ids); a
 *  client-wide contact sees every contact of that client."
 *
 *  So, within the caller's clients: for a client the caller reaches client-wide (`wide`), every listed
 *  contact; for any other of their clients, the client-wide contacts (`project_id IS NULL`) plus the
 *  contacts whose project is one of the caller's own (`projects`). This is the same arm contracts and
 *  change requests use (a project-less row is admitted to a project-scoped contact of that client).
 *  A contact row outside the arm is not returned at all, so its `project_id` cannot leak either. */
export function clientContactInPortalScope(alias: string, params: PortalScopeParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${clientContactClientVisible(alias)} AND ${inCallerProjects(alias, col(alias, "project_id"), params, true)}`;
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
    "(recordings, transcripts, attendees) and reach a client only through deliberate follow-up: since PV4-05 " +
    "that follow-up is a separate object, `meeting_minutes`, with its own predicate (meetingMinutesInPortalScope).",
  note:
    "comments are staff notes on an entity, written for colleagues. No portal read exists and none may be " +
    "added without a client-visible flag that the table does not have.",
  history:
    "activities records every internal verb by every actor. The portal timeline is composed from " +
    "client-visible OBJECTS instead, so a new internal verb can never leak into the client's feed.",
};

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Staff side (PV3-07): the `clientVisible` flag on staff payloads
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// `clientVisible` answers ONE question: can a CLIENT-WIDE contact of the row's client read this row in
// the portal? It is composed only from the row-state builders above, never retyped, so the staff marker
// and the portal cannot disagree (plan trap 9). Three consequences a caller must keep:
//   * A row with no client is never client-visible: there is no contact who could read it.
//   * A row whose portal reach travels through a PARENT (deliverable -> project, gate/stage -> run,
//     payment -> invoice) is visible only when the parent is, and "the row's client" is the PARENT's
//     client, because that is the column the portal's own query filters on.
//   * A PROJECT-SCOPED contact sees a subset (only their projects, plus the project-less contracts and
//     change requests). The flag never claims to describe them; the BFF rows say so.
// The parity test (`client-visible-parity.db.test.ts`) proves every staff use of these against the
// ids the portal endpoints actually return.

/** `(alias.client_id IS NOT NULL AND <row-state>...)`, as a boolean SQL expression for a SELECT list.
 *  `clientAlias` is the table whose `client_id` names the row's client: the row itself, or the parent
 *  its visibility travels through. Each `rowState` argument must be the output of a row-state builder
 *  above (`<entity>ClientVisible`), never a hand-written predicate. */
export function staffClientVisible(clientAlias: string, ...rowState: string[]): string {
  if (rowState.length === 0) throw new Error("portal-visibility: staffClientVisible needs at least one row-state predicate");
  return `(${col(clientAlias, "client_id")} IS NOT NULL AND ${rowState.map((s) => `(${s})`).join(" AND ")})`;
}

/** A kind in NEVER_CLIENT_VISIBLE: the flag is the SQL constant FALSE, taken from that list (so a kind
 *  removed from it stops compiling here instead of silently staying false). */
export function staffNeverClientVisible(kind: NeverClientVisibleKind): string {
  if (!(NEVER_CLIENT_VISIBLE as readonly string[]).includes(kind)) {
    throw new Error(`portal-visibility: ${JSON.stringify(kind)} is not in NEVER_CLIENT_VISIBLE`);
  }
  return "FALSE";
}

/** A deliverable, through its project (`p` must be the deliverable's own project, LEFT JOINed: a
 *  deliverable with no project is never visible, since the portal reads deliverables by project). */
export function staffDeliverableClientVisible(deliverableAlias: string, projectAlias: string): string {
  return staffClientVisible(projectAlias, projectClientVisible(projectAlias), deliverableClientVisible(deliverableAlias));
}

/** A gate, through its run: a client-side, undeleted gate on a run the portal shows. */
export function staffGateClientVisible(gateAlias: string, runAlias: string): string {
  return staffClientVisible(runAlias, runClientVisible(runAlias), gateClientVisible(gateAlias));
}

/** A run stage, through its run: any track but `report`, on a run the portal shows. */
export function staffRunStageClientVisible(stageAlias: string, runAlias: string): string {
  return staffClientVisible(runAlias, runClientVisible(runAlias), runStageClientVisible(stageAlias));
}

/** An invoice payment, through its invoice, in the portal's "detail" context (an invoice's payment
 *  history, where pending and rejected claims show too). `i` must be the payment's own invoice. */
export function staffInvoicePaymentClientVisible(paymentAlias: string, invoiceAlias: string): string {
  return staffClientVisible(invoiceAlias, invoiceClientVisible(invoiceAlias), invoicePaymentClientVisible(paymentAlias, "detail"));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Conversation (PV4-03): threads, messages, attachments — and drafts, which are never visible
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-03; design decisions 3 and 4; PV4-Q1).
// Every `conversation_messages` row is client-visible by definition (§2.4: the table has no visibility
// column). What a client may REACH is decided by the THREAD, so a message and its
// attachments are all admitted through `conversationThreadInPortalScope` on the parent thread.

/** A thread is visible unless soft-deleted. Open and closed threads both show (a closed thread is
 *  history the client took part in). */
export function conversationThreadClientVisible(alias: string): string {
  return `${col(alias, "deleted_at")} IS NULL`;
}

/** The full portal predicate for a conversation thread.
 *
 *  ⚠ NO NULL-PROJECT ADMISSION, UNLIKE CONTRACTS AND CHANGE REQUESTS. `project_id IS NULL` is the
 *  client-wide ("general") thread (PV-D22), and PV4-Q1's default is that ONLY a client-wide contact may
 *  see it: a contact limited to some projects may be someone outside the client's organisation (an
 *  agency the client hired for one site), and the general thread is where the client's own people talk
 *  about everything. A master contract admits a project-scoped contact because the agreement covers
 *  their project too; a general conversation carries no such implication. So this is `allowNullProject =
 *  false`, the same shape as runs. Changing it to `true` would show a project-scoped contact the whole
 *  client-wide thread, history included. */
export function conversationThreadInPortalScope(alias: string, params: PortalScopeParams): string {
  return `${inCallerClients(alias, params.clients)} AND ${conversationThreadClientVisible(alias)} AND ${inCallerProjects(alias, col(alias, "project_id"), params, false)}`;
}

/** A message is always visible once its thread is: the table has no visibility state. Returned as `TRUE` after validating the
 *  alias so the staff side composes it like any other row-state predicate. */
export function conversationMessageClientVisible(alias: string): string {
  col(alias, "id");
  return `TRUE`;
}

/** A message's ATTACHMENTS are reachable only while the message is not retracted. Retraction was retired
 *  by PV-D34 (nothing sets `retracted_at` any more), so for every message posted since this is always true;
 *  the guard stays so a row retracted under the old 15-minute window keeps its files withdrawn. */
export function conversationAttachmentClientVisible(messageAlias: string): string {
  return `${col(messageAlias, "retracted_at")} IS NULL`;
}

/** Staff `clientVisible` for a thread: a live thread of a client (always true for a non-deleted row;
 *  every thread has a client by the NOT NULL column). */
export function staffConversationThreadClientVisible(threadAlias: string): string {
  return staffClientVisible(threadAlias, conversationThreadClientVisible(threadAlias));
}

/** Staff `clientVisible` for a message, through its thread (`t` must be the message's own thread). */
export function staffConversationMessageClientVisible(messageAlias: string, threadAlias: string): string {
  return staffClientVisible(threadAlias, conversationThreadClientVisible(threadAlias), conversationMessageClientVisible(messageAlias));
}

/** Staff `clientVisible` for a DRAFT: the SQL constant FALSE. Drafts live in their own table,
 *  `conversation_drafts`, which no portal route reads (design decision 3); a draft reaches a client
 *  only by being SENT, which creates a new `conversation_messages` row authored by the sender. */
export function staffConversationDraftClientVisible(draftAlias: string): string {
  col(draftAlias, "id");
  return "FALSE";
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Meeting minutes (PV4-05): the ONLY part of a meeting a client ever reads
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-05; finding 8; design decisions 8 and 9; PV4-Q1).
// `meeting` STAYS in NEVER_CLIENT_VISIBLE: the recording, transcript, participants and pipeline run are internal and no
// portal read names them. Minutes are a NEW object (`meeting_minutes`, PV4-01) that a staff member deliberately SHARES, and
// they are a visible kind of their own with their own predicate below.
//
// DESIGN DECISION 8: minutes carry NO client_id / project_id of their own. The client and the project are read THROUGH the
// meeting (`meeting_recordings`), so re-linking a meeting moves its minutes with it and nothing is ever a stale copy. Every
// builder here therefore takes TWO aliases: the minutes row and its meeting.

/** Minutes are visible once SHARED, and only while their meeting is live (a soft-deleted meeting takes its minutes with
 *  it). A `draft` is the agency's working copy, however complete: this is the clause that keeps an agent's or a colleague's
 *  half-written notes out of the portal. */
export function meetingMinutesClientVisible(minutesAlias: string, meetingAlias: string): string {
  return `${col(minutesAlias, "status")} = 'shared' AND ${col(meetingAlias, "deleted_at")} IS NULL`;
}

/** The full portal predicate for shared minutes: the caller's clients and, for a project-scoped contact, their projects,
 *  both taken from the MEETING (`meetingAlias` is the minutes' own `meeting_recordings` row, joined on
 *  `meeting_recording_id`).
 *
 *  ⚠ NO NULL-PROJECT ADMISSION, UNLIKE CONTRACTS AND CHANGE REQUESTS (PV4-Q1's default, applied to minutes). A meeting with no
 *  project is a client-wide meeting, and its minutes are visible only to a client-wide contact; a contact limited to some
 *  projects may be someone outside the client's organisation. Same shape as runs and conversation threads
 *  (`allowNullProject = false`). Changing it to `true` would show a project-scoped contact every client-wide meeting's minutes. */
export function meetingMinutesInPortalScope(minutesAlias: string, meetingAlias: string, params: PortalScopeParams): string {
  return `${inCallerClients(meetingAlias, params.clients)} AND ${meetingMinutesClientVisible(minutesAlias, meetingAlias)} AND ${inCallerProjects(meetingAlias, col(meetingAlias, "project_id"), params, false)}`;
}

/** Staff `clientVisible` for minutes: the meeting has a client AND the minutes are shared on a live meeting. `m` must be the
 *  minutes' own meeting (the client is the MEETING's, because that is the column the portal's own query filters on). */
export function staffMeetingMinutesClientVisible(minutesAlias: string, meetingAlias: string): string {
  return staffClientVisible(meetingAlias, meetingMinutesClientVisible(minutesAlias, meetingAlias));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Client health (PV7-02, BFF §54.5): client-wide material is told only to client-wide contacts
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PV-D33 and PV-D37: material that belongs to the whole client, not to one project, reaches only the contacts who reach the
// client client-wide. The portal's own lists are looser for contracts and change requests (`allowNullProject = true` admits a
// project-less row to a project-scoped contact), and the health read deliberately takes the STRICT reading, so a contact
// limited to some projects is told about their own projects and nothing else. Two reach builders carry it. They are REACH
// only: the row-state half is always an existing `<entity>ClientVisible`. They have no `staff*` mirror on purpose, because the
// staff `clientVisible` flag describes a CLIENT-WIDE contact, for whom both arms below are true by definition.

/** The row's client (`alias.client_id`) is one the caller reaches CLIENT-WIDE (`params.wide`). For rows that belong to the
 *  client rather than to a project: a payment, a post review. */
export function wideClientOnly(alias: string, params: PortalScopeParams): string {
  return `${col(alias, "client_id")} = ANY(${ph(params.wide)}::uuid[])`;
}

/** The project arm with NO null-project admission: the row's client is one the caller reaches client-wide, OR the row's
 *  project (`alias.project_id`) is one of the caller's own. A row with no project therefore reaches client-wide contacts only
 *  (the shape runs, conversation threads and minutes already have). Always AND-ed with `inCallerClients` (or a `client_id =
 *  ANY(<caller's clients>)` the query already carries) on the same client column. */
export function wideOrOwnProject(alias: string, params: PortalScopeParams): string {
  return inCallerProjects(alias, col(alias, "project_id"), params, false);
}

// PV7-02 — WHO HOLDS THE BALL, for one client or for a whole set of them (BFF §54; moved out of `clientOverview`).
//
// ── WHY THIS IS A FILE OF ITS OWN ────────────────────────────────────────────────────────────────────
// The hub overview (`GET :t/clients/:id/overview`, clients.controller.ts) used to build `needsUs` and `needsClient` with
// eight queries per client. The client health board asks the same question for every client of a company, and fanning
// the hub overview across 71 clients would cost ~500 queries. So the two lists live here, written SET-BASED over
// `clientIds[]` (a fixed number of queries whatever the count), and the hub overview calls this for ONE client. Its
// output must not change by a field: `client-ball-parity.db.test.ts` pins the old output and runs against this code.
//
// ── WHAT THE TWO LISTS MEAN (unchanged; the hub overview's own header carries the long version) ─────
// `needsUs`: outstanding items only WE can clear: a client-recorded payment nobody has confirmed, a post the client sent
//   back, a change request nobody has triaged, a drafted agreement we never sent, a client message waiting for our reply.
// `needsClient`: outstanding items only the CLIENT can clear: a pending client-side gate, a sent agreement they have not
//   signed, a post review they have not decided.
// Every item carries `clientVisible` (a client-wide contact of the client can read the row in the portal), computed in
// SQL from portal-visibility.ts so the staff marker and the portal cannot disagree (PV3-07).
//
// ── ⚠ MODULE SCOPE ───────────────────────────────────────────────────────────────────────────────────
// `social_post_client_reviews` carries the `social` third wall (`app_module_allowed('social')`). The CALLER's
// transaction must therefore be opened with `{ modules: ["social"] }`. Without it that one SELECT returns ZERO ROWS AND
// RAISES NOTHING: the hub would report "no post reviews outstanding" for a client with ten. Core tables carry no such
// predicate, so declaring the scope costs the other queries nothing. This file cannot open the transaction itself (it
// is handed a connection), so it cannot enforce this: every caller's `withTenants(..., { modules: ["social"] })` is the
// guard, and client-health.db.test.ts pins that the board's read finds a post review.
//
// ── THE PORTAL'S VIEW (`opts.portal`) ────────────────────────────────────────────────────────────────
// The same queries, narrowed to what a portal contact may be told and may reach, for `GET :t/portal/health`:
//   * rows are admitted only through the portal-visibility.ts builders (row-state AND reach);
//   * a row with NO PROJECT is client-wide material and reaches only the clients the caller reaches client-wide
//     (PV-D33, PV-D37), unlike contracts and change requests in the portal's own lists, which admit a project-less row
//     to a project-scoped contact. Health takes the stricter reading: a project-scoped contact is told about their own
//     projects only. Payments and post reviews belong to the client, not a project, so they are client-wide material;
//   * a drafted agreement is never listed (the client cannot see it).
// Each row carries `clientId` and `projectId` so the caller can group it; the hub overview strips both (`toHubItem`).
import type { PoolClient } from "pg";
import { portalPostRowVisibleSql } from "../social/pipeline/portal-post-sql";
import { awaitingReplySql } from "../../core/conversation-core";
import { staffThreadHref } from "../../core/conversation-notify";
import {
  changeRequestClientVisible, contractClientVisible, conversationThreadClientVisible, gateClientVisible, postReviewClientVisible,
  runInPortalScope, scopeAt, staffClientVisible, staffConversationThreadClientVisible, staffGateClientVisible,
  staffInvoicePaymentClientVisible, wideClientOnly, wideOrOwnProject,
} from "../../core/portal-visibility";

/** One item of either list, exactly as the hub overview has always returned it. */
export interface BallItem {
  /** `social_post` (SCP-2) appears in PORTAL mode only: a pipeline post waiting on the client, one item per POST (its `id` is the
   *  post id), where a Composer post's `review` is one item per variant review. The staff lists keep `review`. */
  kind: "payment" | "review" | "social_post" | "request" | "contract" | "conversation" | "gate";
  id: string;
  label: string;
  context: string;
  href: string;
  /** The instant the item started waiting (a Date from `pg`, an ISO string once serialised). */
  since: unknown;
  clientVisible: boolean;
}

/** An item plus what a caller needs to group it. */
export interface BallRow extends BallItem {
  clientId: string;
  /** The project the item belongs to, or null for client-wide material. */
  projectId: string | null;
}

export interface ClientBall { needsUs: BallRow[]; needsClient: BallRow[] }

/** The portal caller's scope arrays, as `scopeValues(scope)` returns them: clients, wide clients, project ids. The first is
 *  the same set as the `clientIds` argument (the caller's clients), which is bound as $1 and doubles as the clients array. */
export interface BallPortalOpts { params: [string[], string[], string[]] }

/** The hub overview's item shape: the row without the grouping columns. */
export function toHubItem(row: BallRow): BallItem {
  return {
    kind: row.kind, id: row.id, label: row.label, context: row.context, href: row.href,
    since: row.since, clientVisible: row.clientVisible,
  };
}

const GATE_LABEL: Record<string, string> = {
  prd_sign: "Sign off the project requirements",
  scope_signoff: "Sign the Scope Agreement",
  customer_feedback: "Share feedback",
};

/** Both lists for every client in `clientIds`, keyed by client id. A client with nothing outstanding maps to two empty
 *  lists; a client id that is not in `clientIds` is absent. Eight queries (seven in portal mode), whatever the count. */
export async function loadClientBall(
  c: PoolClient,
  clientIds: string[],
  opts: { portal?: BallPortalOpts } = {},
): Promise<Map<string, ClientBall>> {
  const out = new Map<string, ClientBall>();
  for (const id of clientIds) out.set(id, { needsUs: [], needsClient: [] });
  if (clientIds.length === 0) return out;

  const portal = opts.portal;
  // $1 is always the client set. In portal mode $2 is the caller's wide clients and $3 their projects, and $1 doubles as the
  // caller's clients (`scopeAt(1)`).
  //
  // ⚠ PARAMETERS MUST BE DENSE. Postgres refuses a statement whose text references $3 but not $2 ("could not determine data type
  // of parameter $2"), and one that is handed more values than it references. So each query gets exactly the prefix it uses:
  // `params2` for the client-wide-only reads (payments, post reviews: $1, $2), `params3` for every read that also reaches by
  // project (requests, threads, gates, contracts: $1, $2, $3). The first version bound four and every portal read failed.
  const params3: unknown[] = portal ? [clientIds, portal.params[1], portal.params[2]] : [clientIds];
  const params2: unknown[] = portal ? params3.slice(0, 2) : params3;
  const S = scopeAt(1);
  const only = (sql: string): string => (portal ? ` AND ${sql}` : "");
  // SCP-2: in the portal a pipeline post counts only while the portal would show it (not deleted, not archived, sent to the client):
  // an archived post whose reviews stay `changes_requested` keeps no dead `/portal/social?post=` item. A Composer post is unchanged.
  const pipelinePostVisible = `(pst.pipeline_status IS NULL OR (${portalPostRowVisibleSql("pst")}))`;

  const [payments, reviews, requests, drafts, threads, gates, contracts, pending] = await Promise.all([
    // ── needsUs ────────────────────────────────────────────────────────────────────────────────────
    c.query(
      `SELECT pp.id, pp.client_id AS "clientId", pp.invoice_id AS "invoiceId", pp.amount::float8 AS amount, pp.currency,
              pp.created_at AS "since", ${staffInvoicePaymentClientVisible("pp", "i")} AS "clientVisible"
         FROM invoice_payments pp LEFT JOIN invoices i ON i.id = pp.invoice_id
        WHERE pp.client_id = ANY($1::uuid[]) AND pp.status = 'pending' AND pp.deleted_at IS NULL${
          only(`${staffInvoicePaymentClientVisible("pp", "i")} AND ${wideClientOnly("pp", S)}`)}
        ORDER BY pp.created_at ASC, pp.id ASC`,
      params2,
    ),
    // The social third wall applies to this join: see the file header.
    c.query(
      `SELECT r.id, r.client_id AS "clientId", r.comment, r.decided_at AS "since", pst.title AS "postTitle",
              pst.id AS "postId", (pst.pipeline_status IS NOT NULL) AS "isPipeline",
              ${staffClientVisible("r", postReviewClientVisible("r"))} AS "clientVisible"
         FROM social_post_client_reviews r
         JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
         JOIN social_posts pst       ON pst.id = v.post_id  AND pst.tenant_id = v.tenant_id
        WHERE r.client_id = ANY($1::uuid[]) AND r.status = 'changes_requested'${
          only(`${postReviewClientVisible("r")} AND ${wideClientOnly("r", S)} AND ${pipelinePostVisible}`)}
        ORDER BY r.decided_at ASC, r.id ASC`,
      params2,
    ),
    c.query(
      `SELECT w.id, w.client_id AS "clientId", w.project_id AS "projectId", w.title, w.kind, w.created_at AS "since",
              ${staffClientVisible("w", changeRequestClientVisible("w"))} AS "clientVisible"
         FROM webdev_change_requests w
        WHERE w.client_id = ANY($1::uuid[]) AND w.status = 'new' AND w.deleted_at IS NULL${
          only(`${changeRequestClientVisible("w")} AND ${wideOrOwnProject("w", S)}`)}
        ORDER BY w.created_at ASC, w.id ASC`,
      params3,
    ),
    // A drafted agreement is the agency's own working copy: the portal never shows it, so portal mode skips the read.
    portal
      ? Promise.resolve({ rows: [] as Array<Record<string, unknown>> })
      : c.query(
          `SELECT k.id, k.client_id AS "clientId", k.project_id AS "projectId", k.title, k.created_at AS "since",
                  ${staffClientVisible("k", contractClientVisible("k"))} AS "clientVisible"
             FROM contracts k
            WHERE k.client_id = ANY($1::uuid[]) AND k.status = 'draft' AND k.deleted_at IS NULL
            ORDER BY k.created_at ASC, k.id ASC`,
          params3,
        ),
    // PV4-06: conversation threads waiting for our reply (open, last live message is the client's). The rule is
    // conversation-core.ts `awaitingReplySql`, the same one the staff Conversation list filters on.
    c.query(
      `SELECT t.id, t.client_id AS "clientId", t.project_id AS "projectId", t.subject, p.name AS "projectName",
              (SELECT max(um.created_at) FROM conversation_messages um
                WHERE um.thread_id = t.id AND um.author_side = 'client' AND um.retracted_at IS NULL) AS "since",
              ${staffConversationThreadClientVisible("t")} AS "clientVisible"
         FROM conversation_threads t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.client_id = ANY($1::uuid[]) AND t.deleted_at IS NULL AND ${awaitingReplySql("t")}${
          only(`${conversationThreadClientVisible("t")} AND ${wideOrOwnProject("t", S)}`)}
        ORDER BY "since" ASC, t.id ASC`,
      params3,
    ),
    // ── needsClient ────────────────────────────────────────────────────────────────────────────────
    c.query(
      `SELECT g.id, g.kind, g.created_at AS "since", r.id AS "runId", r.title AS "runTitle", r.client_id AS "clientId",
              r.project_id AS "projectId", ${staffGateClientVisible("g", "r")} AS "clientVisible"
         FROM pipeline_gates g JOIN pipeline_runs r ON r.id = g.run_id
        WHERE r.client_id = ANY($1::uuid[]) AND r.deleted_at IS NULL
          AND ${gateClientVisible("g")} AND g.status = 'pending'${
          only(runInPortalScope("r", S))}
        ORDER BY g.created_at ASC, g.id ASC`,
      params3,
    ),
    c.query(
      // Same "already countersigned by that side" exclusion the portal's own query carries: `status` flips only once BOTH
      // parties are in, so a row can read 'sent' while the client has signed.
      `SELECT k.id, k.client_id AS "clientId", k.project_id AS "projectId", k.title, k.created_at AS "since",
              ${staffClientVisible("k", contractClientVisible("k"))} AS "clientVisible"
         FROM contracts k
        WHERE k.client_id = ANY($1::uuid[]) AND k.deleted_at IS NULL AND k.status = 'sent'
          AND NOT EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'client')${
          only(`${contractClientVisible("k")} AND ${wideOrOwnProject("k", S)}`)}
        ORDER BY k.created_at ASC, k.id ASC`,
      params3,
    ),
    c.query(
      `SELECT r.id, r.client_id AS "clientId", r.requested_at AS "since", pst.title AS "postTitle",
              pst.id AS "postId", (pst.pipeline_status IS NOT NULL) AS "isPipeline",
              ${staffClientVisible("r", postReviewClientVisible("r"))} AS "clientVisible"
         FROM social_post_client_reviews r
         JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
         JOIN social_posts pst       ON pst.id = v.post_id  AND pst.tenant_id = v.tenant_id
        WHERE r.client_id = ANY($1::uuid[]) AND r.status = 'pending'${
          only(`${postReviewClientVisible("r")} AND ${wideClientOnly("r", S)} AND ${pipelinePostVisible}`)}
        ORDER BY r.requested_at ASC, r.id ASC`,
      params2,
    ),
  ]);

  type Row = Record<string, unknown>;
  const str = (v: unknown) => v as string;
  const pid = (r: Row) => (r.projectId as string | null | undefined) ?? null;
  const visible = (r: Row) => r.clientVisible === true;
  const us = (clientId: string) => out.get(clientId)!.needsUs;
  const them = (clientId: string) => out.get(clientId)!.needsClient;

  // Kind order is the contract the hub has always had: payments, reviews, requests, drafts, threads.
  for (const r of payments.rows as Row[]) {
    us(str(r.clientId)).push({
      kind: "payment", id: str(r.id),
      label: "Confirm a client-recorded payment",
      context: `${r.currency as string} ${r.amount as number}`,
      // PV3-07: payments are confirmed on the client's Contracts & billing page (PV3-08).
      href: `/clients/${str(r.clientId)}/billing`, since: r.since, clientVisible: visible(r),
      clientId: str(r.clientId), projectId: null,
    });
  }
  // SCP-2: in the portal, a pipeline post is decided per POST, so its several variant reviews are one waiting item (`social_post`,
  // the post id), which the portal opens on `/portal/social?post=<id>`. A Composer post's review stays one item per review.
  const asPost = (r: Row) => !!portal && r.isPipeline === true;
  const postSeenUs = new Set<string>();
  for (const r of reviews.rows as Row[]) {
    if (asPost(r)) {
      if (postSeenUs.has(str(r.postId))) continue;
      postSeenUs.add(str(r.postId));
    }
    us(str(r.clientId)).push({
      kind: asPost(r) ? "social_post" : "review", id: asPost(r) ? str(r.postId) : str(r.id),
      label: "Client asked for changes on a post",
      context: (r.postTitle as string) ?? "Social post",
      href: `/clients/${str(r.clientId)}/requests`, since: r.since, clientVisible: visible(r),
      clientId: str(r.clientId), projectId: null,
    });
  }
  for (const r of requests.rows as Row[]) {
    us(str(r.clientId)).push({
      kind: "request", id: str(r.id),
      label: "Triage a new change request",
      context: r.title as string,
      href: `/clients/${str(r.clientId)}/requests`, since: r.since, clientVisible: visible(r),
      clientId: str(r.clientId), projectId: pid(r),
    });
  }
  for (const r of drafts.rows as Row[]) {
    us(str(r.clientId)).push({
      kind: "contract", id: str(r.id),
      label: "Send a drafted agreement",
      context: r.title as string,
      href: `/clients/${str(r.clientId)}/billing`, since: r.since, clientVisible: visible(r),
      clientId: str(r.clientId), projectId: pid(r),
    });
  }
  for (const r of threads.rows as Row[]) {
    us(str(r.clientId)).push({
      kind: "conversation", id: str(r.id),
      label: "A client message is waiting for our reply",
      context: (r.subject as string | null) ?? (r.projectName as string | null) ?? "General conversation",
      href: staffThreadHref(str(r.clientId), str(r.id)), since: r.since, clientVisible: visible(r),
      clientId: str(r.clientId), projectId: pid(r),
    });
  }

  // needsClient: gates, then contracts, then post reviews.
  for (const g of gates.rows as Row[]) {
    them(str(g.clientId)).push({
      kind: "gate", id: str(g.id),
      label: GATE_LABEL[g.kind as string] ?? "Client input needed",
      context: (g.runTitle as string) ?? "Delivery run",
      href: `/pipeline/${str(g.runId)}`, since: g.since, clientVisible: visible(g),
      clientId: str(g.clientId), projectId: pid(g),
    });
  }
  for (const k of contracts.rows as Row[]) {
    them(str(k.clientId)).push({
      kind: "contract", id: str(k.id),
      label: "Awaiting client signature",
      context: k.title as string,
      href: `/clients/${str(k.clientId)}/billing`, since: k.since, clientVisible: visible(k),
      clientId: str(k.clientId), projectId: pid(k),
    });
  }
  const postSeenThem = new Set<string>();
  for (const r of pending.rows as Row[]) {
    if (asPost(r)) {
      if (postSeenThem.has(str(r.postId))) continue;
      postSeenThem.add(str(r.postId));
    }
    them(str(r.clientId)).push({
      kind: asPost(r) ? "social_post" : "review", id: asPost(r) ? str(r.postId) : str(r.id),
      label: "Awaiting client post approval",
      context: (r.postTitle as string) ?? "Social post",
      href: `/clients/${str(r.clientId)}/requests`, since: r.since, clientVisible: visible(r),
      clientId: str(r.clientId), projectId: null,
    });
  }
  return out;
}

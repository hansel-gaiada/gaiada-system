// PV4-04 — PV-D5's binding rule: a change request that changes the price cannot start until the
// amendment that records the new price is SIGNED, on both sides, in Contracts & billing.
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-04, finding 7).
//
// This file holds the pieces the triage route (webdev-change-requests.controller.ts), the contract
// create route (contracts.controller.ts) and the `contract.signed` handler (below) must agree on, so
// "what counts as signed", "what counts as dead" and "where an amendment points" are written ONCE.
//
// ── THE MODEL ────────────────────────────────────────────────────────────────────────────────────
//   * `webdev_change_requests.price_impact` is the triage answer: unassessed (every row that predates
//     PV4, grandfathered and never blocked) | none | changes_price.
//   * A `changes_price` request points at its amendment through `amendment_contract_id`, and the
//     contract points back through `contracts.change_request_id`. The FK pair is DEFERRABLE (PV4-01),
//     so one transaction inserts both halves in either order.
//   * The request is BLOCKED while it is `changes_price` and its linked contract is not `signed`
//     (`isStartBlocked`). A blocked request cannot start work: status `in_progress`, a route, a linked
//     pipeline run or PM task. Every code path that does one of those calls `assertAmendmentSigned`.
//   * A `declined`, `void` or `expired` amendment stays blocked (it is not `signed`) until staff
//     re-triage, which creates a FRESH draft and re-points `amendment_contract_id`.
//   * An amendment never voids or supersedes the contract it amends (`supersedes_id` keeps its
//     re-issue meaning); it only references it through `amends_id`.
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId } from "../db";
import { config } from "../config";
import { scrubText } from "./scrub";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A contract in one of these states can never become `signed` again, so a request waiting on it is
 *  waiting on nothing. (`draft` and `sent` are LIVE: still on their way to a signature.) */
const DEAD_CONTRACT_STATUSES = new Set(["declined", "void", "expired"]);

export const isDeadContractStatus = (status: string | null): boolean =>
  status === null || DEAD_CONTRACT_STATUSES.has(status);

/** The columns every reader of the gate needs on a change-request row, with its join. `ac` is the
 *  linked contract; a soft-deleted contract reads as absent, which is "dead", which is blocked. */
export const CR_AMENDMENT_COLUMNS = `cr.price_impact, cr.amendment_contract_id, ac.status AS amendment_status`;
export const CR_AMENDMENT_JOIN = `LEFT JOIN contracts ac ON ac.id = cr.amendment_contract_id AND ac.deleted_at IS NULL`;

export interface AmendmentGateRow {
  price_impact: string;
  amendment_contract_id: string | null;
  amendment_status: string | null;
}

/** Fails CLOSED: `changes_price` with no readable `signed` contract is blocked, including the
 *  impossible "changes_price but no link" row. */
export function isStartBlocked(cr: AmendmentGateRow): boolean {
  return cr.price_impact === "changes_price" && cr.amendment_status !== "signed";
}

/** The ONE refusal every work-starting path throws. `existing` rides the response (the HttpErrorFilter
 *  forwards it) so the caller can navigate to the contract that has to be signed. */
export function amendmentNotSigned(cr: AmendmentGateRow): ConflictException {
  return new ConflictException({
    message: "amendment_not_signed",
    existing: { amendmentContractId: cr.amendment_contract_id, amendmentStatus: cr.amendment_status },
  });
}

/** Throws 409 `amendment_not_signed` while the request waits on an unsigned amendment. */
export function assertAmendmentSigned(cr: AmendmentGateRow): void {
  if (isStartBlocked(cr)) throw amendmentNotSigned(cr);
}

/** An explicit `amendsId` must be a SIGNED contract of the SAME client (400 `amends_id_invalid`). One message for "not found",
 *  "other client's" and "not signed", so the answer is never an existence oracle for another client's
 *  (or another tenant's: RLS already hides those rows) contracts. */
export async function assertAmendable(c: PoolClient, clientId: string, amendsId: string): Promise<void> {
  const r = await c.query(
    `SELECT 1 FROM contracts WHERE id = $1 AND client_id = $2 AND status = 'signed' AND deleted_at IS NULL`,
    [amendsId, clientId],
  );
  if (!r.rows[0]) {
    throw new BadRequestException({
      message: "amends_id_invalid",
      field: "amendsId",
    });
  }
}

/** The contract a price change amends when the caller names none: the project's latest signed
 *  agreement, else the client's latest signed master agreement (`project_id IS NULL`).
 *
 *  Agreements only (`kind = 'agreement'`): amendments stack on the agreement they amend, so a second
 *  price change amends the agreement again instead of building an amendment-of-an-amendment chain. A
 *  re-issued agreement (`supersedes_id`) is found by recency, because the replaced row is never voided. */
export async function defaultAmendTarget(
  c: PoolClient, clientId: string, projectId: string | null,
): Promise<string | null> {
  if (projectId) {
    const p = await c.query<{ id: string }>(
      `SELECT id FROM contracts
        WHERE client_id = $1 AND project_id = $2 AND status = 'signed' AND kind = 'agreement' AND deleted_at IS NULL
        ORDER BY signed_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [clientId, projectId],
    );
    if (p.rows[0]) return p.rows[0].id;
  }
  const m = await c.query<{ id: string }>(
    `SELECT id FROM contracts
      WHERE client_id = $1 AND project_id IS NULL AND status = 'signed' AND kind = 'agreement' AND deleted_at IS NULL
      ORDER BY signed_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [clientId],
  );
  return m.rows[0]?.id ?? null;
}

/** Insert the DRAFT a price change lands in. Always `draft`: nothing reaches the client until staff
 *  write the terms and send it. `amendsId` null makes a `kind = 'agreement'` draft (the client has
 *  nothing signed to amend); otherwise `kind = 'amendment'`. The caller sets
 *  `webdev_change_requests.amendment_contract_id` in the same transaction. */
export async function insertAmendmentDraft(
  c: PoolClient,
  a: {
    tenantId: string; clientId: string; projectId: string | null; changeRequestId: string;
    requestTitle: string; amendsId: string | null; createdBy: string | null;
  },
): Promise<string> {
  const id = newId();
  const kind = a.amendsId ? "amendment" : "agreement";
  const title = scrubText(`${a.amendsId ? "Amendment" : "Agreement"}: ${a.requestTitle}`).text.slice(0, 300);
  await c.query(
    `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, kind, amends_id, change_request_id,
                            version, status, currency, created_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'draft', 'IDR', $9, $10)`,
    [id, a.tenantId, a.clientId, a.projectId, title, kind, a.amendsId, a.changeRequestId, a.createdBy, config.originSite],
  );
  return id;
}

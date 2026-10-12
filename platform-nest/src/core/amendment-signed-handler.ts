// PV4-04 — the `contract.signed` follow-up of PV-D5's binding rule (webdev-amendment.ts).
//
// When a contract becomes `signed`, any change request that was WAITING on it (`amendment_contract_id`,
// price_impact = 'changes_price') can start. This handler tells the person who triaged the request, so
// the unblocking is a notification and not something staff have to notice. IT CHANGES NO STATUS: the
// request stays `new` and the triager re-triages it (with a route) now that the gate is open. Starting
// work is a decision a person makes; the signature only removes the refusal.
//
// ── A CORE HANDLER ON PURPOSE ────────────────────────────────────────────────────────────────────
// Registered with `registerCoreEventHandler` (main.ts), not as a module handler: contracts and change
// requests are core, and a module handler only fires for a tenant with that module enabled. The
// `contract` stream is added to main.ts's consumer list in the same change, because a handler on a
// stream nobody drains is registered and never invoked (the SMM-14 trap).
//
// ── THE EVENT IS A HINT, NOT DATA ────────────────────────────────────────────────────────────────
// Every fact is re-read here under the tenant wall. A redelivered event must not notify twice (at-least-
// once delivery), so a notification for the same (recipient, request) is skipped when one exists. A
// failure THROWS, so the bus redelivers it; a request that is gone, no longer waiting on this contract
// or whose contract is no longer `signed` ends quietly.
import { withTenants } from "../db";
import { registerCoreEventHandler } from "../events/consumer.service";
import type { OutboxEvent } from "../events/types";
import { notify } from "./http";

export const AMENDMENT_UNBLOCKED_TYPE = "webdev.change_request.unblocked";

/** The staff request page: the Web Dev department's triage queue, with the request named. */
export const unblockedHref = (requestId: string): string => `/departments/web-dev/requests?request=${requestId}`;

export async function amendmentSignedHandler(event: OutboxEvent): Promise<void> {
  const { tenantId, entityId: contractId } = event;
  if (!tenantId || !contractId) return;
  const targets = await withTenants([tenantId], async (c) => {
    const r = await c.query<{ id: string; title: string; triaged_by: string | null }>(
      `SELECT cr.id, cr.title, cr.triaged_by
         FROM webdev_change_requests cr
         JOIN contracts k ON k.id = cr.amendment_contract_id
        WHERE cr.amendment_contract_id = $1 AND cr.price_impact = 'changes_price'
          AND cr.deleted_at IS NULL AND k.deleted_at IS NULL AND k.status = 'signed'
          AND cr.status = 'new' AND cr.triaged_by IS NOT NULL`,
      [contractId],
    );
    const out: Array<{ id: string; title: string; triagedBy: string }> = [];
    for (const row of r.rows) {
      const dup = await c.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2 AND payload->>'entityId' = $3 LIMIT 1`,
        [row.triaged_by, AMENDMENT_UNBLOCKED_TYPE, row.id],
      );
      if (!dup.rows[0]) out.push({ id: row.id, title: row.title, triagedBy: row.triaged_by as string });
    }
    return out;
  });
  for (const t of targets) {
    // actorId null: nobody "did" this to the triager, and notify() would otherwise skip a recipient who
    // is also the actor (a staff member who countersigned the contract they triaged for).
    await notify(tenantId, t.triagedBy, null, AMENDMENT_UNBLOCKED_TYPE, {
      title: "Amendment signed: this request can start",
      body: t.title,
      href: unblockedHref(t.id),
      entityType: "webdev_change_request",
      entityId: t.id,
      severity: "info",
    });
  }
}

/** Called once from main.ts, before the consumer loop starts reading. */
export function registerAmendmentEventHandlers(): void {
  registerCoreEventHandler("contract.signed", amendmentSignedHandler);
}

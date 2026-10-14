// PV5-11 — processing a claimed signature notice, and the sweep that makes it survive anything.
//
// The webhook (webhook.controller.ts) authenticates, claims the dedupe key in `provider_events` (kind 'signature') and
// answers 200. Everything else happens here, after commit, in the PV5-10 machinery:
//   * the claim emits `signature.notice.received` on the `provider_event` stream in the SAME transaction (outbox -> Redis
//     -> the in-process consumer -> `signatureNoticeHandler`);
//   * `sweepSignatureEvents` (a plain-Postgres loop) retries every signature notice still `received` whose retry time has
//     come, and RECONCILES: every open certified envelope is re-fetched from its provider now and then, so a notice that
//     never arrived (the loopback refused, a restart, a provider that does not retry) still records the signature.
//
// ── THE ORDER OF OPERATIONS IS THE SECURITY ─────────────────────────────────────────────────────────
// A notice names an envelope and nothing else is read from it. The envelope must belong to a contract of the company the
// claim is filed under; then syncEnvelope (certified-signing.ts) RE-FETCHES the envelope from the provider and writes
// only what the provider's status says. A notice that claims "completed" while the provider says otherwise writes nothing.
//
// Retry clock: 1, 2, 4 ... minutes after each failed attempt, capped at an hour; MAX_ATTEMPTS ~ a day, then `failed`.
import { withGlobal, withTenants } from "../db";
import { registerCoreEventHandler } from "../events/consumer.service";
import type { OutboxEvent } from "../events/types";
import { notify } from "../core/http";
import { certifiedSigningAccount, signatureAccountNamed } from "./registry";
import { syncEnvelope, type SyncOutcome } from "./certified-signing";

/** The outbox event the webhook emits with each claim. The stream is PV5-10's `provider_event`. */
export const SIGNATURE_NOTICE_EVENT = "signature.notice.received";

export const MAX_ATTEMPTS = 30;
/** A notice younger than this is left to the event consumer (the sweep only picks up what it missed). */
const SWEEP_GRACE_SECONDS = 20;
/** How often the sweep re-fetches every open envelope (the reconciliation), at most. */
export const RECONCILE_EVERY_MS = 5 * 60_000;
/** Envelopes older than this (since the contract was sent) are no longer reconciled automatically. */
const RECONCILE_WINDOW_DAYS = 60;

export type SignatureProcessOutcome =
  | { status: "skipped"; reason: string }
  | { status: "retry"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "ignored"; reason: string; outcome: string }
  | { status: "processed"; outcome: string; sync: SyncOutcome };

interface ClaimRow {
  id: string;
  provider: string;
  ref: string | null;
  status: string;
  attempts: number;
  notice: Record<string, string> | null;
}

async function finish(tenantId: string, eventId: string, status: "processed" | "ignored", outcome: string, error: string | null): Promise<boolean> {
  const r = await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE provider_events
          SET status = $2, outcome = $3, error = $4, processed_at = now(), last_error = NULL, next_attempt_at = NULL
        WHERE id = $1 AND status = 'received'`,
      [eventId, status, outcome.slice(0, 500), error],
    ),
  );
  return (r.rowCount ?? 0) > 0;
}

async function recordRetry(tenantId: string, ev: ClaimRow, reason: string): Promise<SignatureProcessOutcome> {
  const text = reason.slice(0, 500);
  const r = await withTenants([tenantId], (c) =>
    c.query<{ status: string; attempts: number }>(
      `UPDATE provider_events
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END,
              error = CASE WHEN attempts + 1 >= $3 THEN $2 ELSE error END,
              processed_at = CASE WHEN attempts + 1 >= $3 THEN now() ELSE processed_at END,
              next_attempt_at = CASE WHEN attempts + 1 >= $3 THEN NULL
                                     ELSE now() + make_interval(mins => LEAST(60, power(2, attempts)::int)) END
        WHERE id = $1 AND status = 'received'
        RETURNING status, attempts`,
      [ev.id, text, MAX_ATTEMPTS],
    ),
  );
  // eslint-disable-next-line no-console
  console.warn(`[signatures] ${ev.provider} notice ${ev.id} (envelope ${ev.ref}) not processed yet: ${text}`);
  const row = r.rows[0];
  if (!row) return { status: "skipped", reason: "the notice is no longer waiting" };
  if (row.status === "failed") {
    // eslint-disable-next-line no-console
    console.error(`[signatures] ${ev.provider} notice ${ev.id} FAILED after ${row.attempts} attempts: ${text}`);
    return { status: "failed", reason: text };
  }
  return { status: "retry", reason: text };
}

/** Tell the company's owners once that a certified signature could not be recorded (a person must look). */
async function tellOwners(tenantId: string, contractId: string, text: string): Promise<void> {
  try {
    const owners = await withGlobal((c) =>
      c.query<{ user_id: string }>(
        `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE r.name = 'owner' AND ur.scope_type = 'company' AND ur.scope_id = $1
            AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
        [tenantId],
      ),
    );
    for (const o of owners.rows) {
      await notify(tenantId, o.user_id, null, "contract.certified_signing_refused", {
        title: "A certified signature could not be recorded",
        body: text.slice(0, 500),
        href: "/clients",
        entityType: "contract",
        entityId: contractId,
        severity: "warning",
      }).catch(() => undefined);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[signatures] owner notice for contract ${contractId} failed:`, (err as Error)?.message ?? err);
  }
}

/** Process one claimed signature notice. Idempotent: anything but a `received` claim is left alone. */
export async function processSignatureEvent(tenantId: string, eventId: string): Promise<SignatureProcessOutcome> {
  const ev = (await withTenants([tenantId], (c) =>
    c.query<ClaimRow>(`SELECT id, provider, ref, status, attempts, notice FROM provider_events WHERE id = $1 AND kind = 'signature'`, [eventId]),
  )).rows[0];
  if (!ev) return { status: "skipped", reason: "no such signature notice in this company" };
  if (ev.status !== "received") return { status: "skipped", reason: `already ${ev.status}` };
  if (!ev.ref) return recordRetry(tenantId, ev, "the notice names no envelope to re-check");
  const account = signatureAccountNamed(ev.provider);
  if (!account) return recordRetry(tenantId, ev, `${ev.provider} is not configured`);

  // Only an envelope of a contract of THIS company is ever re-checked.
  const contract = (await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM contracts WHERE signature_provider = $1 AND provider_envelope_id = $2 AND deleted_at IS NULL`,
      [ev.provider, ev.ref],
    ),
  )).rows[0];
  if (!contract) {
    const outcome = `envelope ${ev.ref} is not a contract of this company; nothing was checked or written`;
    await finish(tenantId, ev.id, "ignored", outcome, "unknown_envelope");
    return { status: "ignored", reason: "unknown_envelope", outcome };
  }

  let sync: SyncOutcome;
  try {
    // The notice's own claims ride along for the outcome text only; syncEnvelope writes what the provider re-fetch says.
    sync = await syncEnvelope(account, tenantId, contract.id, ev.notice);
  } catch (e) {
    return recordRetry(tenantId, ev, `processing failed: ${(e as Error)?.message ?? String(e)}`);
  }
  switch (sync.status) {
    case "retry":
      return recordRetry(tenantId, ev, sync.reason);
    case "refused": {
      const done = await finish(tenantId, ev.id, "ignored", sync.outcome, sync.reason);
      if (done) await tellOwners(tenantId, contract.id, sync.outcome);
      return { status: "ignored", reason: sync.reason, outcome: sync.outcome };
    }
    case "skipped":
      await finish(tenantId, ev.id, "processed", `nothing to apply: ${sync.reason}`, null);
      return { status: "processed", outcome: sync.reason, sync };
    default:
      await finish(tenantId, ev.id, "processed", sync.outcome, null);
      return { status: "processed", outcome: sync.outcome, sync };
  }
}

export async function signatureNoticeHandler(event: OutboxEvent): Promise<void> {
  if (!event.tenantId || !event.entityId) return;
  await processSignatureEvent(event.tenantId, event.entityId);
}

/** Called once from main.ts before the consumer loop starts; the `provider_event` stream is already in its list. */
export function registerSignatureEventHandlers(): void {
  registerCoreEventHandler(SIGNATURE_NOTICE_EVENT, signatureNoticeHandler);
}

let lastReconcileAt = 0;

/**
 * One pass, for every company: each signature notice still `received` whose retry time has come, then (at most every
 * RECONCILE_EVERY_MS, or always with `reconcile: true`) every open certified envelope of the provider that is switched on.
 */
export async function sweepSignatureEvents(opts: { ignoreGrace?: boolean; reconcile?: boolean; limit?: number } = {}): Promise<SignatureProcessOutcome[]> {
  const out: SignatureProcessOutcome[] = [];
  const account = certifiedSigningAccount();
  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`));
  const reconcile = opts.reconcile === true || Date.now() - lastReconcileAt >= RECONCILE_EVERY_MS;
  if (reconcile) lastReconcileAt = Date.now();
  for (const co of companies.rows) {
    let due: string[] = [];
    try {
      due = (await withTenants([co.id], (c) =>
        c.query<{ id: string }>(
          `SELECT id FROM provider_events
            WHERE tenant_id = $1 AND kind = 'signature' AND status = 'received'
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
              AND ($2::boolean OR attempts > 0 OR received_at < now() - make_interval(secs => $3::int))
            ORDER BY received_at LIMIT $4`,
          [co.id, opts.ignoreGrace === true, SWEEP_GRACE_SECONDS, opts.limit ?? 50],
        ),
      )).rows.map((r) => r.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[signatures] sweep could not list company ${co.id}:`, (err as Error).message);
      continue;
    }
    for (const id of due) {
      try {
        out.push(await processSignatureEvent(co.id, id));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[signatures] sweep: notice ${id} failed to record:`, (err as Error).message);
      }
    }
    if (!reconcile || !account) continue;
    // RECONCILIATION: re-fetch every open envelope of this provider. Nothing here trusts anything but the provider.
    let open: string[] = [];
    try {
      open = (await withTenants([co.id], (c) =>
        c.query<{ id: string }>(
          `SELECT id FROM contracts
            WHERE status = 'sent' AND deleted_at IS NULL AND signature_tier = 'certified'
              AND signature_provider = $1 AND provider_envelope_id IS NOT NULL
              AND sent_at > now() - make_interval(days => $2::int)
            ORDER BY sent_at LIMIT 50`,
          [account.name, RECONCILE_WINDOW_DAYS],
        ),
      )).rows.map((r) => r.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[signatures] reconcile could not list company ${co.id}:`, (err as Error).message);
      continue;
    }
    for (const contractId of open) {
      try {
        const s = await syncEnvelope(account, co.id, contractId);
        if (s.status === "refused") {
          // eslint-disable-next-line no-console
          console.warn(`[signatures] reconcile: contract ${contractId}: ${s.outcome}`);
        }
        if (s.status === "completed" || (s.status === "pending" && s.newSignatures > 0)) {
          // eslint-disable-next-line no-console
          console.warn(`[signatures] reconcile: contract ${contractId} caught up with no notice: ${s.outcome}`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[signatures] reconcile: contract ${contractId} failed:`, (err as Error).message);
      }
    }
  }
  return out;
}

/** The sweep loop: self-rescheduling, so a slow pass never overlaps itself. */
export function startSignatureEventSweep(intervalMs: number, firstDelayMs = 20_000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (first: boolean) => {
    if (stopped) return;
    try {
      const r = await sweepSignatureEvents({ ignoreGrace: first, reconcile: first });
      if (r.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[signatures] sweep processed ${r.length}: ${r.map((o) => o.status).join(", ")}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[signatures] sweep failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(() => void tick(false), intervalMs);
  };
  timer = setTimeout(() => void tick(true), firstDelayMs);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

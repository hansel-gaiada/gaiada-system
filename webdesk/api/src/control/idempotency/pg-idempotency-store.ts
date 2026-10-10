// WSK-41 — the DURABLE idempotency store (migration 0009's control_idempotency_keys), replacing the
// in-memory IdempotencyStore for the content commands (write-plane design §3.3). M3 T5a moved the
// keys, lifecycle, schema.apply and release commands onto it too, through command-envelope.ts. Only
// the promotion and privacy commands still use ./idempotency-store.ts (T5b moves them).
//
// LIFECYCLE (per scope key):
//   begin()    — claims the key in its OWN short committed transaction: a row with status
//                `in_flight`. A concurrent second caller with the same key sees that row and waits
//                (bounded) for it to settle; it never runs the command a second time.
//   complete() — called INSIDE the command's own transaction, so the stored response and the
//                command's effect commit together or not at all. It is fenced: it updates the row
//                only while it is still this caller's `in_flight` claim, and throws otherwise, which
//                rolls the effect back. That is what makes taking over a stale claim (below) safe.
//   release()  — the command failed (its transaction rolled back): the claim is deleted so a retry
//                with the same key can run. Failures are never cached as responses.
//
// EXPIRY: rows past `expires_at` (default 7 days, the column default) are treated as ABSENT on every
// read: begin() deletes an expired row for its own key before claiming. An `in_flight` row older
// than STALE_IN_FLIGHT_MS is a claim whose process died between begin() and complete(); because
// complete() is atomic with the effect, such a claim has no committed effect, so it is taken over.
//
// RLS: the table is dual-mode (0009). Tenant rows are read and written under webdesk.tenant_ctx;
// platform rows (tenant_id IS NULL) under webdesk.platform_ctx. The app role cannot see across
// tenants, so sweepExpired() walks every tenant under its own tenant_ctx and then the platform rows
// once under platform_ctx. Wiring it to a scheduler is out of WSK-41's scope.
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../../db/db.service";
import { ControlProblem } from "../content/content-problem";

/** A claimed key. `rowId` is the fencing token complete() checks. */
export interface IdempotencyClaim {
  rowId: string;
  tenantId: string | null;
  scopeKey: string;
}

export type IdempotencyBegin<T> = { kind: "fresh"; claim: IdempotencyClaim } | { kind: "replay"; response: T };

/** A claim still `in_flight` after this long has no committed effect (see header) and is taken over. */
export const STALE_IN_FLIGHT_MS = 120_000;
/** How long a second caller waits for a concurrent first caller with the same key to settle. */
export const IN_FLIGHT_WAIT_MS = 15_000;
const POLL_MS = 50;

type Outcome<T> = IdempotencyBegin<T> | { kind: "in_flight" } | { kind: "retry" };

function keyMatch(tenantId: string | null, firstParam: number): { sql: string; params: unknown[] } {
  return tenantId === null
    ? { sql: `tenant_id IS NULL AND scope_key = $${firstParam}`, params: [] }
    : { sql: `tenant_id = $${firstParam + 1} AND scope_key = $${firstParam}`, params: [tenantId] };
}

@Injectable()
export class PgIdempotencyStore {
  constructor(private readonly db: DbService) {}

  /** Runs `fn` in a transaction under the scope that owns `tenantId`'s rows. */
  private inScope<T>(tenantId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (tenantId === null) {
      return this.db.withPlatformCtx(async (client) => {
        await client.query("BEGIN");
        try {
          const r = await fn(client);
          await client.query("COMMIT");
          return r;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
      });
    }
    return this.db.withTenant(tenantId, (db) => db.transaction(fn));
  }

  async begin<T = unknown>(opts: {
    tenantId: string | null;
    scopeKey: string;
    command: string;
    requestHash: string;
    ttlMs?: number;
  }): Promise<IdempotencyBegin<T>> {
    const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
    for (;;) {
      const outcome = await this.inScope<Outcome<T>>(opts.tenantId, async (client) => {
        const m = keyMatch(opts.tenantId, 1);
        // Expired rows and stale in-flight claims for THIS key are absent: remove them first.
        await client.query(
          `DELETE FROM control_idempotency_keys
            WHERE ${m.sql}
              AND (expires_at <= now()
                   OR (status = 'in_flight' AND created_at <= now() - ($${m.params.length + 2} || ' milliseconds')::interval))`,
          [opts.scopeKey, ...m.params, String(STALE_IN_FLIGHT_MS)],
        );
        const ttl = opts.ttlMs ?? null;
        const ins = await client.query<{ id: string }>(
          `INSERT INTO control_idempotency_keys (tenant_id, scope_key, command, request_hash, status, expires_at)
           VALUES ($1, $2, $3, $4, 'in_flight',
                   CASE WHEN $5::bigint IS NULL THEN now() + interval '7 days'
                        ELSE now() + ($5::bigint || ' milliseconds')::interval END)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [opts.tenantId, opts.scopeKey, opts.command, opts.requestHash, ttl],
        );
        if (ins.rows[0]) {
          return { kind: "fresh", claim: { rowId: ins.rows[0].id, tenantId: opts.tenantId, scopeKey: opts.scopeKey } };
        }
        const { rows } = await client.query<{ request_hash: string; status: string; response: T }>(
          `SELECT request_hash, status, response FROM control_idempotency_keys
            WHERE ${m.sql} AND expires_at > now()`,
          [opts.scopeKey, ...m.params],
        );
        const row = rows[0];
        if (!row) return { kind: "retry" }; // settled between our INSERT and SELECT — try again
        if (row.request_hash !== opts.requestHash) {
          throw new ControlProblem(
            409,
            "idempotency-key-reused",
            "Idempotency key reused",
            "This Idempotency-Key was already used for a different request. Use a fresh key for a new command.",
          );
        }
        if (row.status === "completed") return { kind: "replay", response: row.response };
        return { kind: "in_flight" };
      });

      if (outcome.kind === "fresh" || outcome.kind === "replay") return outcome;
      if (Date.now() > deadline) {
        throw new ControlProblem(
          409,
          "idempotency-key-in-flight",
          "Idempotency key in flight",
          "A request with this Idempotency-Key is still running. Retry with the same key once it has finished.",
        );
      }
      if (outcome.kind === "in_flight") await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  /**
   * Stores the response, inside the command's own transaction (`client` must be that transaction's
   * connection, under the same tenant/platform scope as the claim). Fenced on the claim's row id.
   */
  async complete(client: PoolClient, claim: IdempotencyClaim, response: unknown): Promise<void> {
    const { rowCount } = await client.query(
      `UPDATE control_idempotency_keys SET status = 'completed', response = $2::jsonb
        WHERE id = $1 AND status = 'in_flight'`,
      [claim.rowId, JSON.stringify(response)],
    );
    if (rowCount !== 1) {
      // Our claim was taken over (stale) or removed: another execution owns this key now. Throwing
      // rolls this transaction's effect back, so the key can never carry two committed effects.
      throw new ControlProblem(
        409,
        "idempotency-key-in-flight",
        "Idempotency key in flight",
        "This request's idempotency claim was superseded before it completed; nothing was written.",
      );
    }
  }

  /** The command failed and rolled back: drop the claim so a retry with the same key can run. */
  async release(claim: IdempotencyClaim): Promise<void> {
    await this.inScope(claim.tenantId, (client) =>
      client.query(`DELETE FROM control_idempotency_keys WHERE id = $1 AND status = 'in_flight'`, [claim.rowId]),
    ).catch(() => {
      /* best effort: an unreleased claim goes stale after STALE_IN_FLIGHT_MS and is taken over */
    });
  }

  /**
   * Deletes expired rows everywhere the app role can reach: each tenant under its own tenant_ctx,
   * then the platform rows under platform_ctx. Returns how many rows went, per scope kind.
   */
  async sweepExpired(): Promise<{ tenantsSwept: number; tenantRows: number; platformRows: number }> {
    const tenantIds = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM tenants`);
      return rows.map((r) => r.id);
    });
    let tenantRows = 0;
    for (const tenantId of tenantIds) {
      tenantRows += await this.inScope(tenantId, async (client) => {
        const { rowCount } = await client.query(
          `DELETE FROM control_idempotency_keys WHERE tenant_id = $1 AND expires_at <= now()`,
          [tenantId],
        );
        return rowCount ?? 0;
      });
    }
    const platformRows = await this.inScope(null, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM control_idempotency_keys WHERE tenant_id IS NULL AND expires_at <= now()`,
      );
      return rowCount ?? 0;
    });
    return { tenantsSwept: tenantIds.length, tenantRows, platformRows };
  }
}

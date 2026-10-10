// M3 T5a — the WSK-41 command envelope, shared by the older WSK-21 commands (keys, lifecycle,
// schema.apply, releases). content-commands.service.ts keeps its own private copy of this logic
// (T5a does not touch it); the duplication is a follow-up.
//
//   1. idempotency.begin()  — claims the scope key in its own short committed transaction. A replay
//      returns the stored response (`replayed: true`) and writes a `control.<cmd>.replay` audit row,
//      fail-soft: a replay changes nothing, so its audit row must never fail the replay.
//   2. ONE transaction, in this order:
//        a. the audit row `control.<cmd>` — FIRST, carrying `ws4_approval_id` on a HIGH command.
//           That insert CLAIMS the approval (0009 §3 ux_audit_entries_ws4_once, unique over
//           non-replay rows) before any side effect. A concurrent reuse of the same approval blocks
//           on the index until the first transaction commits, then fails 23505 and rolls back having
//           changed nothing (mapped to 403 ws4-approval-already-used).
//        b. the effect, on THE SAME CLIENT.
//        c. idempotency.complete(client, claim, response) — stores the replay record in the same
//           transaction, so effect, audit row and replay record commit together or not at all.
//   3. any error -> idempotency.release(claim) (the failure is never cached), then rethrow.
//   4. after commit: the fail-soft `after` step (enqueueing a job, ...). Never inside the transaction.
//
// WHY THE EFFECT MUST USE THE ENVELOPE'S CLIENT. PgIdempotencyStore takes over a stale `in_flight`
// claim on the premise that complete() commits atomically with the effect, so a stale claim has no
// committed effect. An effect that committed in its own transaction would break that premise: a
// takeover would run it a second time. For the same reason an effect must not check a second
// connection out of the pool while it holds this transaction's one: ten blocked approvals would
// hold ten connections, and an effect waiting for an eleventh would never get it.
//
// RESPONSE SEAL. The stored response of key.mint / key.rotate holds the plaintext api key (a replay
// must return the same key; the ERP retries a mint after a lost response). WSK-05's invariant is that
// only the key's hash ever reaches the database, so such a response is stored sealed
// (response-seal.ts) and opened on replay.
import { Injectable, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import { AuditService, type AuditArgs } from "../audit/audit.service";
import { COMMAND_REGISTRY, type CommandName } from "./command-types";
import { PgIdempotencyStore } from "./idempotency/pg-idempotency-store";
import { ControlProblem } from "./content/content-problem";

/** Which row-level-security scope the command's rows (audit, idempotency, effect) live under. */
export type EnvelopeScope = { kind: "tenant"; tenantId: string } | { kind: "platform" };

/** Encrypts/decrypts the response stored in control_idempotency_keys. `aad` is the scope key. */
export interface ResponseSeal<R> {
  seal(result: R, aad: string): unknown;
  open(stored: unknown, aad: string): R;
}

export interface EffectOutcome<R> {
  /** The response body (without `replayed`). It is what a replay returns, so it must be JSON-safe. */
  result: R;
  /** Post-commit, fail-soft side effects. A failure here is logged and never undoes the command. */
  after?: () => Promise<void>;
}

export interface EnvelopeInput<R extends object> {
  command: CommandName;
  scope: EnvelopeScope;
  /** Same format as before the move: `${tenantSlug|platform}:${command}:${idempotencyKey}`. */
  scopeKey: string;
  requestHash: string;
  actor: string;
  /** Known BEFORE the effect runs, because the audit row is the first statement. Pre-generate ids. */
  auditArgs: AuditArgs;
  ws4ApprovalId: string | null;
  /** Runs inside the envelope's transaction on `client`. Throw to roll everything back. */
  effect: (client: PoolClient) => Promise<EffectOutcome<R>>;
  seal?: ResponseSeal<R>;
}

/** The single-use refusal. Also what a concurrent reuse of one approval gets when it loses the race. */
export function ws4AlreadyUsedProblem(): ControlProblem {
  return new ControlProblem(
    403,
    "ws4-approval-already-used",
    "WS4 approval already used",
    "This WS4 approval has already authorised a command; an approval is single-use. Nothing was changed.",
  );
}

function mapEnvelopeError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === "23505" && e.constraint === "ux_audit_entries_ws4_once") return ws4AlreadyUsedProblem();
  return err;
}

@Injectable()
export class CommandEnvelope {
  private readonly logger = new Logger(CommandEnvelope.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: PgIdempotencyStore,
  ) {}

  /** One transaction under the scope that owns the command's rows. */
  private transact<T>(scope: EnvelopeScope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (scope.kind === "tenant") return this.db.withTenant(scope.tenantId, (db) => db.transaction(fn));
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

  async run<R extends object>(input: EnvelopeInput<R>): Promise<R & { replayed: boolean }> {
    const meta = COMMAND_REGISTRY[input.command];
    const ws4ApprovalId = meta.impactClass === "high" ? input.ws4ApprovalId : null;
    if (meta.impactClass === "high" && !ws4ApprovalId) {
      // Defence in depth: CommandAuthorizationGuard already refuses a HIGH command without a
      // verified WS4 assertion; the service never runs one without an approval id to claim. This
      // is before begin(), so it claims no idempotency key and writes no audit row.
      throw new ControlProblem(403, "ws4-approval-required", "WS4 approval required", `${input.command} is HIGH-impact and needs a WS4 approval.`);
    }

    const tenantId = input.scope.kind === "tenant" ? input.scope.tenantId : null;
    const begin = await this.idempotency.begin<unknown>({
      tenantId,
      scopeKey: input.scopeKey,
      command: input.command,
      requestHash: input.requestHash,
    });

    if (begin.kind === "replay") {
      let stored: R;
      try {
        stored = input.seal ? input.seal.open(begin.response, input.scopeKey) : (begin.response as R);
      } catch {
        throw new ControlProblem(
          409,
          "idempotency-response-unreadable",
          "Stored response unreadable",
          "The response stored for this Idempotency-Key cannot be read back. Nothing was changed; retry with a fresh Idempotency-Key.",
        );
      }
      // A replay changes nothing; it is recorded as such (`.replay` rows are outside the WS4
      // single-use index).
      await this.transact(input.scope, (client) =>
        this.audit.record(client, {
          tenantId,
          actor: input.actor,
          action: `control.${input.command}.replay`,
          args: input.auditArgs,
          ws4ApprovalId,
        }),
      ).catch((err) => this.logger.warn(`replay audit row failed for ${input.command}: ${String(err)}`));
      return { ...stored, replayed: true };
    }

    let after: (() => Promise<void>) | undefined;
    let result: R;
    try {
      result = await this.transact(input.scope, async (client) => {
        // FIRST statement: claims the WS4 approval id (unique over non-replay rows) before any
        // side effect. A concurrent reuse blocks here, then fails and rolls back untouched.
        await this.audit.record(client, {
          tenantId,
          actor: input.actor,
          action: `control.${input.command}`,
          args: input.auditArgs,
          ws4ApprovalId,
        });
        const outcome = await input.effect(client);
        after = outcome.after;
        await this.idempotency.complete(
          client,
          begin.claim,
          input.seal ? input.seal.seal(outcome.result, input.scopeKey) : outcome.result,
        );
        return outcome.result;
      });
    } catch (err) {
      await this.idempotency.release(begin.claim);
      throw mapEnvelopeError(err);
    }

    if (after) {
      await after().catch((err) => this.logger.warn(`post-commit side effect failed for ${input.command}: ${String(err)}`));
    }
    return { ...result, replayed: false };
  }
}

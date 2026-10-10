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
// T5b (promotion, privacy) uses this envelope too, with two small generic extensions:
//   - `impactClass`: a command that is not in COMMAND_REGISTRY (the privacy commands live in their own
//     shadow registry) names its own impact class. Without it the class comes from COMMAND_REGISTRY, and
//     a command in neither is refused loudly rather than treated as unguarded.
//   - `resolveReplay`: a command whose stored record is a REFERENCE (promotion stores a run id, then the
//     saga continues after the envelope's transaction) turns the stored record into the replay body, or
//     refuses (409 promotion-in-progress). It runs before the replay audit row, so a refusal writes none.
//
// WITHHELD RESPONSES. key.mint / key.rotate return the plaintext api key exactly once. WSK-66's rule
// is that the key plaintext is never persisted, so those commands pass `withhold`: the replay record
// stores the response WITHOUT the secret (and nothing recoverable from it, no ciphertext either), plus
// `secretWithheld: true`. A replay that finds that marker answers 409 idempotency-response-withheld
// (nothing changed; mint or rotate again under a new approval). The replay writes no audit row: it
// served nothing, and a `.replay` row would claim a successful replay. In production the real PDP
// refuses a reused HIGH approval before the service runs, so such a replay is not reachable there.
import { Injectable, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import { AuditService, type AuditArgs } from "../audit/audit.service";
import { COMMAND_REGISTRY, type CommandName, type ImpactClass } from "./command-types";
import { PgIdempotencyStore } from "./idempotency/pg-idempotency-store";
import { ControlProblem } from "./content/content-problem";

/** Which row-level-security scope the command's rows (audit, idempotency, effect) live under. */
export type EnvelopeScope = { kind: "tenant"; tenantId: string } | { kind: "platform" };

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
  /**
   * Opt-in for a response that carries a one-time secret. Returns the object to store in its place
   * (the response minus the secret and anything derived from it); the envelope adds
   * `secretWithheld: true`. The caller still receives the full result on the fresh run.
   */
  withhold?: (result: R) => { stored: object };
  /** What a replay of a withheld response says (409 detail). Defaults to the one-time-secret wording. */
  withheldDetail?: string;
  /**
   * For a command that is not in COMMAND_REGISTRY: its impact class. Refused loudly when absent and
   * the command is unregistered, so a missing class can never read as "not HIGH".
   */
  impactClass?: ImpactClass;
  /**
   * Turns a stored record into the replay body (or throws to refuse the replay). Default: the stored
   * record is the body. Runs BEFORE the replay audit row, so a refusal writes no row.
   */
  resolveReplay?: (stored: unknown) => R | Promise<R>;
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
    const impactClass = input.impactClass ?? COMMAND_REGISTRY[input.command]?.impactClass;
    if (!impactClass) throw new Error(`command envelope: ${input.command} is not in COMMAND_REGISTRY and names no impactClass`);
    const ws4ApprovalId = impactClass === "high" ? input.ws4ApprovalId : null;
    if (impactClass === "high" && !ws4ApprovalId) {
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
      if ((begin.response as { secretWithheld?: unknown } | null)?.secretWithheld === true) {
        throw new ControlProblem(
          409,
          "idempotency-response-withheld",
          "Response withheld",
          input.withheldDetail ??
            "This command's response carried a one-time secret, which is never stored. Nothing was changed. Mint or rotate again under a new approval.",
        );
      }
      const stored = input.resolveReplay ? await input.resolveReplay(begin.response) : (begin.response as R);
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
          input.withhold ? { ...input.withhold(outcome.result).stored, secretWithheld: true } : outcome.result,
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

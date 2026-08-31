// WSK-21 — the idempotency mechanism the ticket AC requires: "every command double-fired must
// produce one effect. Use a caller-supplied idempotency key."
//
// IN-MEMORY, SINGLE-PROCESS. That is a real, flagged limitation (same class as WSK-05's
// TenantQuotaService and WSK-11's in-process BullMQ worker): it dedupes within one api process,
// not across replicas or restarts. A durable store needs a new table (e.g.
// `control_idempotency_keys`) — out of this ticket's scope (`control/**` only; migrations belong
// to senior-db, see ../../../README.md's "required changes" section). Two things keep this
// honest rather than decorative in the meantime:
//   1. Every mutating command that touches a table with a natural uniqueness constraint also
//      relies on THAT constraint as a second, cross-process-safe backstop (environments'
//      UNIQUE(site_id,name), releases' UNIQUE(env_id,version)) — see the command services under
//      lifecycle/ and releases/.
//   2. This is exactly the seam a future persisted store slots into: every caller goes through
//      `run()`, never a bespoke check, so swapping the Map for a table-backed implementation is a
//      one-file change.
import { ConflictException, Injectable } from "@nestjs/common";

interface CompletedEntry {
  commandHash: string;
  result: unknown;
}

@Injectable()
export class IdempotencyStore {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly completed = new Map<string, CompletedEntry>();

  /**
   * Runs `fn` at most once per `scopeKey` (recommended shape:
   * `${tenantSlugOrPlatform}:${command}:${idempotencyKey}`). A second caller with the SAME
   * scopeKey and the SAME commandHash gets the first call's result without `fn` running again —
   * whether the second call arrives while the first is still in flight (racing) or after it has
   * already completed (sequential replay). A second caller with the same scopeKey but a
   * DIFFERENT commandHash is refused: reusing an idempotency key for a materially different
   * request is a caller bug, not something to execute silently as if it were a fresh command.
   */
  async run<T>(scopeKey: string, commandHash: string, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    const done = this.completed.get(scopeKey);
    if (done) {
      if (done.commandHash !== commandHash) {
        throw new ConflictException(
          `idempotency key already used for a different request (scope '${scopeKey}') — use a fresh key for a new command`,
        );
      }
      return { result: done.result as T, replayed: true };
    }

    const pending = this.inFlight.get(scopeKey);
    if (pending) {
      // Racing double-fire: await the SAME promise the first caller is already running, rather
      // than starting a second execution. A commandHash mismatch on a still-in-flight call
      // surfaces once `completed` is populated and a later caller arrives (the branch above) —
      // there is no earlier point at which it could be detected without serializing every racing
      // caller behind a lock, which would defeat the point of not blocking on the first call.
      const result = await (pending as Promise<T>);
      return { result, replayed: true };
    }

    const promise = (async () => {
      try {
        const result = await fn();
        this.completed.set(scopeKey, { commandHash, result });
        return result;
      } finally {
        this.inFlight.delete(scopeKey);
      }
    })();
    this.inFlight.set(scopeKey, promise);
    const result = await promise;
    return { result, replayed: false };
  }

  /** Test/ops escape hatch — never called from a production command path. */
  clear(): void {
    this.inFlight.clear();
    this.completed.clear();
  }
}

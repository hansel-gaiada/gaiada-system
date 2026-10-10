// WSK-40 — single use of an editorial assertion's `jti` (write-plane design §5, "Replay store").
//
// The store is the webdesk project's own queue store (the compose `redis` service, REDIS_URL; the
// Valkey swap OQ-3.3 records does not change the protocol). One command, atomic:
//
//   SET wd:edjti:<jti> 1 NX PX <ttlMs>
//
// "OK" → first use. A null reply → the jti was already consumed → the caller answers 401
// editorial-assertion-replayed. The key lives until the assertion could no longer verify anyway
// (exp + the 10 s clock tolerance), so the store never grows without bound and never forgets a jti
// that could still be replayed.
//
// FAIL CLOSED: any store error (unreachable, timeout, auth, a reply that is neither OK nor null)
// THROWS JtiReplayStoreUnavailableError, and the caller answers 503. It never degrades to "allow".
// The client is built so that an outage surfaces promptly instead of hanging the request: at most one
// retry per command and a 2 s command timeout (FormRateLimitService's reasoning: the BullMQ-only
// `maxRetriesPerRequest: null` would make a dead store hang a write forever).
//
// SHUTDOWN IS ORDERED (M3 T8). close() does three things in a fixed order: (1) refuse new commands (a
// consume() after this point throws JtiReplayStoreUnavailableError without touching the client, so
// nothing is issued on a closing connection); (2) wait for the commands already in flight to settle (each
// is bounded by the 2 s command timeout; the wait itself is bounded too); (3) quit the client, or
// disconnect it when it is not ready. A command in flight is therefore finished, not cut off, and one that
// still fails is turned into JtiReplayStoreUnavailableError inside consume(), where its caller handles it.
import Redis from "ioredis";
import { redisConnectionOptions } from "../../queue/redis-connection";

export const JTI_KEY_PREFIX = "wd:edjti:";

export interface JtiReplayStore {
  /** true = first use (now consumed); false = already consumed. Throws JtiReplayStoreUnavailableError on any store failure. */
  consume(jti: string, ttlMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export class JtiReplayStoreUnavailableError extends Error {
  constructor(cause: string) {
    super(`editorial jti replay store unavailable: ${cause}`);
    this.name = "JtiReplayStoreUnavailableError";
  }
}

/** close() waits at most this long for in-flight commands (their own timeout is 2 s). */
const CLOSE_DRAIN_MS = 3_000;

export class RedisJtiReplayStore implements JtiReplayStore {
  private readonly redis: Redis;
  /** One entry per command in flight; each settles (never rejects) when its command does. */
  private readonly inFlight = new Set<Promise<void>>();
  private closing?: Promise<void>;

  constructor(redis?: Redis) {
    this.redis =
      redis ??
      new Redis({
        ...redisConnectionOptions(),
        maxRetriesPerRequest: 1,
        commandTimeout: 2_000,
        connectTimeout: 2_000,
        lazyConnect: false,
      });
    // ioredis emits 'error' on every failed reconnect; without a listener Node prints each one as an
    // unhandled error event. The failure that matters is the one a command sees, handled below.
    this.redis.on("error", () => undefined);
  }

  async consume(jti: string, ttlMs: number): Promise<boolean> {
    // Fail closed, and issue nothing: after close() began the client is quitting or gone.
    if (this.closing) throw new JtiReplayStoreUnavailableError("the store is closed");
    const px = Math.max(1_000, Math.ceil(ttlMs));
    let reply: unknown;
    try {
      const command = this.redis.set(`${JTI_KEY_PREFIX}${jti}`, "1", "PX", px, "NX");
      const settled = command.then(
        () => undefined,
        () => undefined,
      );
      this.inFlight.add(settled);
      void settled.then(() => this.inFlight.delete(settled));
      reply = await command;
    } catch (err) {
      throw new JtiReplayStoreUnavailableError((err as Error)?.message ?? String(err));
    }
    if (reply === "OK") return true;
    if (reply === null) return false;
    throw new JtiReplayStoreUnavailableError(`unexpected SET NX reply ${JSON.stringify(reply)}`);
  }

  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    // 1. close() stores this promise in `closing` before any other code can run (this function only yields
    //    at the await below), so from here on consume() refuses.
    // 2. Let the commands already issued finish (bounded), so none is cut off by the quit/disconnect.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...this.inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_DRAIN_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    // 3. quit() on a client that is still reconnecting to a dead store would queue behind the retries.
    if (this.redis.status !== "ready") {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

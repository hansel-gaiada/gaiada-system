// WSK-05 — the pool-layer half of the GUC mechanism. Generalizes
// webdesk/spike-rls/payload/src/tenant-pg.mjs's TenantAwarePool for a plain pg.Pool consumer (no
// Drizzle/Payload underneath): every checkout stamps `webdesk.tenant_ctx` (and
// `webdesk.platform_ctx`) from whatever is active in the ALS at that instant; every release
// scrubs both, unconditionally, before the physical connection goes back to the pool. This is the
// SESSION strategy (webdesk-design.md §04/WSK-D16): it works for both `pool.query()`'s plain,
// non-transactional convenience path and explicit `pool.connect()` + manual
// BEGIN/COMMIT — the same reason the spike pushed it to this one chokepoint instead of asking
// every call site to remember to wrap itself.
import { Pool, type PoolConfig, type PoolClient } from "pg";
import { tenantContextStore } from "./tenant-context";

const TENANT_GUC = process.env.TENANT_GUC_NAME || "webdesk.tenant_ctx";
const PLATFORM_GUC = "webdesk.platform_ctx";

/**
 * Exposed for tests only (mirrors the spike's `tenantCheckoutLog`): every checkout/release this
 * pool performs, in order, so a test can assert directly that no physical connection ever carries
 * a stale tenant value forward to the next borrower — the single most important safety property
 * in this file, and the one WSK-00's P13 negative control existed to prove is actually checkable.
 */
export type TenantCheckoutEvent =
  | { phase: "checkout"; connId: string; tenantId: string | null; platformCtx: boolean }
  | { phase: "release"; connId: string };

export class TenantAwarePool extends Pool {
  readonly checkoutLog: TenantCheckoutEvent[] = [];
  #connIds = new WeakMap<PoolClient, string>();
  #connCounter = 0;

  constructor(config: PoolConfig) {
    super(config);
  }

  #idFor(client: PoolClient): string {
    let id = this.#connIds.get(client);
    if (!id) {
      id = `conn-${++this.#connCounter}`;
      this.#connIds.set(client, id);
    }
    return id;
  }

  // node-postgres's Pool#connect has two call conventions — the promise form (used by explicit
  // `await pool.connect()`, e.g. for a manual transaction) and the callback form (used internally
  // by `pg-pool`'s own `query()` convenience method, which is what a plain non-transactional call
  // resolves to). Both must carry the stamp; the spike's own history (FINDINGS.md's operational
  // hazards) is the reason both are handled explicitly rather than assuming one "covers" the
  // other.
  connect(): Promise<PoolClient>;
  connect(callback: (err: Error | undefined, client: PoolClient, done: (release?: unknown) => void) => void): void;
  connect(
    callback?: (err: Error | undefined, client: PoolClient, done: (release?: unknown) => void) => void,
  ): Promise<PoolClient> | void {
    const promise = this.#tenantAwareConnect();
    if (typeof callback === "function") {
      promise.then(
        // `client.release` is already the scrubbing wrapper installed below (a closure, not a
        // method that needs `this`), so handing it straight through — the same thing pg-pool's
        // own `query()` convenience path does with the client it gets back — keeps the
        // poisoned-connection case (`done(err)` removing the client instead of pooling it)
        // working through our wrapper too.
        (client) => callback(undefined, client, (err) => client.release(err as Error | boolean | undefined)),
        (err) => callback(err, undefined as unknown as PoolClient, () => {}),
      );
      return undefined;
    }
    return promise;
  }

  async #tenantAwareConnect(): Promise<PoolClient> {
    const client = await super.connect();
    const store = tenantContextStore.getStore();
    const tenantId = store?.tenantId ?? null;
    const platformCtx = store?.platformCtx ?? false;
    const connId = this.#idFor(client);

    this.checkoutLog.push({ phase: "checkout", connId, tenantId, platformCtx });

    // Stamp (or explicitly clear) BOTH GUCs on every checkout, unconditionally — a physical
    // connection may carry a previous borrower's value, and "no ALS context" must mean
    // fail-closed (empty GUC), never "whatever was left over".
    await client.query("select set_config($1, $2, false), set_config($3, $4, false)", [
      TENANT_GUC,
      tenantId ?? "",
      PLATFORM_GUC,
      platformCtx ? "true" : "",
    ]);

    const originalRelease = client.release.bind(client);
    client.release = ((err?: Error | boolean) => {
      // Scrub BEFORE the connection is visible to the next borrower. Fire-and-forget is
      // deliberate here (mirrors the spike): release() itself is synchronous-looking to callers,
      // but we still issue the scrub query first and only hand the connection back once it
      // settles, via the promise chain below — never releasing before the scrub lands.
      return client
        .query("select set_config($1, '', false), set_config($2, '', false)", [TENANT_GUC, PLATFORM_GUC])
        .catch(() => {
          /* connection may already be dead/ending — nothing more to scrub */
        })
        .finally(() => {
          this.checkoutLog.push({ phase: "release", connId });
          originalRelease(err as never);
        });
    }) as typeof client.release;

    return client;
  }
}

export function createTenantAwarePool(config: PoolConfig): TenantAwarePool {
  return new TenantAwarePool(config);
}

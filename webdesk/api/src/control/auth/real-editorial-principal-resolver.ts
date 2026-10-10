// WSK-40 — the production EditorialPrincipalResolver (write-plane design §5; ruling WSK-D39). Bound in
// ../control.module.ts for every environment except NODE_ENV=test (where WSK-41's dev header stub
// stays bound for the existing specs).
//
// Runs at Layer 2e, AFTER L1 mTLS, L2 token, L3 scope and L4 WS4 (EditorialAssertionGuard is the
// third guard on every content route), and before body validation. So the cheaper refusals never
// touch the replay store, and because `cmh` binds route params ∪ body, the body the handler validates
// and executes is exactly the body the ERP signed.
//
// Configuration:
//   WEBDESK_EDITORIAL_JWKS_FILE  the pinned PUBLIC key set (./editorial-jwks.ts). Absent → every
//                                content write answers 503 editorial-keys-not-configured. Present
//                                and invalid → construction throws → boot refused.
//   REDIS_URL                    the project's queue store, which holds consumed jtis
//                                (./jti-replay-store.ts). Down → 503, never fail-open.
//
// Tests construct it directly with injected keys, store and clock (the EDITORIAL_RESOLVER_DEPS
// token is never provided by the module, so Nest passes `undefined` and the env path is used).
import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { COMMAND_REGISTRY, type CommandName } from "../command-types";
import type { ControlRequest } from "./control-request";
import type { EditorialPrincipal, EditorialPrincipalResolver } from "./editorial-principal";
import { loadEditorialJwks, type EditorialKeySet } from "./editorial-jwks";
import { JtiReplayStoreUnavailableError, RedisJtiReplayStore, type JtiReplayStore } from "./jti-replay-store";
import {
  EDITORIAL_ASSERTION_HEADER,
  EDITORIAL_CLOCK_TOLERANCE_SEC,
  EDITORIAL_SLUG,
  editorialProblem,
  verifyEditorialAssertion,
  ws4ApprovalIdOf,
} from "./editorial-assertion";

export const EDITORIAL_RESOLVER_DEPS: unique symbol = Symbol("EDITORIAL_RESOLVER_DEPS");

export interface EditorialResolverDeps {
  /** null = not configured (503 on every write). Omitted = load from WEBDESK_EDITORIAL_JWKS_FILE. */
  keys?: EditorialKeySet | null;
  /** Omitted = a Redis store on REDIS_URL (created only when keys are configured). */
  store?: JtiReplayStore;
  /** Unix seconds. */
  now?: () => number;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class RealEditorialPrincipalResolver implements EditorialPrincipalResolver, OnModuleDestroy {
  private readonly logger = new Logger("EditorialAssertion");
  private readonly keys: EditorialKeySet | null;
  private readonly store: JtiReplayStore | null;
  private readonly ownsStore: boolean;
  private readonly now: () => number;

  constructor(@Optional() @Inject(EDITORIAL_RESOLVER_DEPS) deps?: EditorialResolverDeps) {
    if (deps && deps.keys !== undefined) {
      this.keys = deps.keys;
    } else {
      const loaded = loadEditorialJwks(); // throws on a present-but-invalid file: boot refused
      if (loaded.state === "configured") {
        this.keys = loaded.keys;
        this.logger.log(`editorial JWKS loaded from ${loaded.source}: kid(s) ${[...loaded.keys.keys()].join(", ")}`);
      } else {
        this.keys = null;
        this.logger.warn(`editorial keys not configured (${loaded.reason}); every content write will answer 503 editorial-keys-not-configured`);
      }
    }
    if (deps?.store) {
      this.store = deps.store;
      this.ownsStore = false;
    } else {
      this.store = this.keys ? new RedisJtiReplayStore() : null;
      this.ownsStore = this.store !== null;
    }
    this.now = deps?.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async resolve(req: ControlRequest, command: CommandName, args: Record<string, unknown>): Promise<EditorialPrincipal> {
    if (!this.keys || !this.store) {
      throw editorialProblem(
        503,
        EDITORIAL_SLUG.keysNotConfigured,
        "Content writes need a verified editorial assertion, and this instance has no editorial verification keys " +
          "configured (WEBDESK_EDITORIAL_JWKS_FILE). Nothing was written.",
      );
    }
    const params = (req.params ?? {}) as Record<string, unknown>;
    const nowSec = this.now();
    const claims = await verifyEditorialAssertion(
      firstHeader(req.headers[EDITORIAL_ASSERTION_HEADER]),
      this.keys,
      {
        tenantSlug: typeof params.tenantSlug === "string" ? params.tenantSlug : null,
        siteId: typeof params.siteId === "string" ? params.siteId : null,
        command,
        args,
        high: COMMAND_REGISTRY[command].impactClass === "high",
        ws4ApprovalId: ws4ApprovalIdOf(firstHeader(req.headers["x-ws4-assertion"])),
      },
      nowSec,
    );

    // Single use. The key outlives the assertion's own validity window (exp + tolerance), never less.
    const ttlMs = (claims.exp + EDITORIAL_CLOCK_TOLERANCE_SEC - nowSec) * 1000;
    let first: boolean;
    try {
      first = await this.store.consume(claims.jti, ttlMs);
    } catch (err) {
      const reason = err instanceof JtiReplayStoreUnavailableError ? err.message : "replay store error";
      this.logger.error(`refusing a content write: ${reason}`);
      throw editorialProblem(
        503,
        EDITORIAL_SLUG.storeUnavailable,
        "The editorial replay store is unreachable, so single use cannot be enforced. Nothing was written; retry later.",
      );
    }
    if (!first) {
      throw editorialProblem(401, EDITORIAL_SLUG.replayed, "This editorial assertion (jti) has already been used.");
    }

    const principal: EditorialPrincipal = { sub: claims.sub, pk: claims.pk, jti: claims.jti };
    if (claims.agt !== undefined) principal.agt = claims.agt;
    if (claims.req !== undefined) principal.req = claims.req;
    if (claims.apr !== undefined) principal.apr = claims.apr;
    return principal;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsStore) await this.store?.close();
  }
}

// PV6-02 — the composer: runs every service builder for one client and assembles the BusinessResults payload.
// BOTH routes (staff and portal) call this one function, so the two payloads cannot disagree (the parity test pins it).
//
// Three outcomes per service, never conflated:
//   * the company has not enabled a module the service needs  -> the service is ABSENT ("not offered"), not listed;
//   * the builder ran and the client has nothing there         -> ABSENT as well (no cards), not listed;
//   * the builder threw                                        -> logged, and the service key is in `unavailable`,
//                                                                 while every other service still returns.
// A failure is never turned into an empty list: an empty list is a claim.
//
// Each builder reads through `ctx.read(modules, fn)`, which opens its OWN transaction declaring exactly the modules
// the builder names. A failed query therefore aborts only that builder's transaction, and a builder that forgets to
// name its module reads zero rows (the module wall) instead of borrowing a neighbour's scope.
import { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../../../db";
import { enabledModuleKeys } from "../../../registry";
import { socialBuilder } from "./social";
import { searchBuilder } from "./search";
import { searchAdsBuilder } from "./search-ads";
import { analyticsBuilder } from "./analytics";
import { websiteBuilder } from "./website";
import { SERVICE_KEYS, type BuildContext, type BusinessResults, type ResultsBuilder, type ServiceCard, type ServiceKey } from "./types";

const logger = new Logger("CentreResults");

/** One builder per service, in the order the cards are listed. */
export const RESULTS_BUILDERS: readonly ResultsBuilder[] = [socialBuilder, searchBuilder, searchAdsBuilder, analyticsBuilder, websiteBuilder];

export interface ComposeDeps {
  builders?: readonly ResultsBuilder[];
  now?: Date;
  /** Override the enabled-module lookup (tests). */
  enabled?: ReadonlySet<string>;
  /** Override how a builder opens its scoped transaction (tests prove the scope is load-bearing by dropping it). */
  read?: (tenantId: string, modules: string[], fn: (c: PoolClient) => Promise<unknown>) => Promise<unknown>;
}

export async function composeBusinessResults(tenantId: string, clientId: string, deps: ComposeDeps = {}): Promise<BusinessResults> {
  const builders = deps.builders ?? RESULTS_BUILDERS;
  const now = deps.now ?? new Date();
  const enabled = deps.enabled ?? new Set(await enabledModuleKeys(tenantId));
  const open = deps.read ?? ((t: string, modules: string[], fn: (c: PoolClient) => Promise<unknown>) => withTenants([t], fn, { modules }));
  const ctx: BuildContext = {
    tenantId, clientId, now, enabled,
    read: <T>(modules: string[], fn: (c: PoolClient) => Promise<T>) => open(tenantId, modules, fn) as Promise<T>,
  };

  const services: ServiceCard[] = [];
  const unavailable: ServiceKey[] = [];
  for (const b of builders) {
    if (!b.requires.every((m) => enabled.has(m))) continue; // not offered
    try {
      services.push(...(await b.build(ctx)));
    } catch (e) {
      // The message can carry SQL detail: log it, never return it.
      logger.warn(`results builder "${b.service}" failed for client ${clientId}: ${e instanceof Error ? e.message : String(e)}`);
      unavailable.push(b.service);
    }
  }
  const order = (s: ServiceKey) => SERVICE_KEYS.indexOf(s);
  return {
    clientId,
    generatedAt: now.toISOString(),
    visible: true,
    services: services.sort((a, b) => order(a.service) - order(b.service)),
    unavailable: unavailable.sort((a, b) => order(a) - order(b)),
  };
}

/** The portal payload for a contact who is in scope but not client-wide for this client (PV-D33). */
export function hiddenBusinessResults(clientId: string, now: Date = new Date()): BusinessResults {
  return { clientId, generatedAt: now.toISOString(), visible: false, services: [], unavailable: [] };
}

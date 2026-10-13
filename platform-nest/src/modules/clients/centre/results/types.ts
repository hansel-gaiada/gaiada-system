// PV6-02 — Services & results: the payload both the staff and the portal route return.
// Plan: docs/plans/2026-10-13-pv6-business-areas-tickets.md (PV6-02). The wire contract is the one in the ticket;
// it is also recorded in docs/FRONTEND-BFF-CONTRACT.md §25.
//
// THE RULE EVERY FIELD HERE OBEYS: unknown is `null`, never 0. A figure nobody measured, a window with no rows, a
// target nobody set, a suppressed small cell: all `null`. A zero is only ever a real, counted zero.
import type { PoolClient } from "pg";

export type ServiceKey = "social" | "search" | "search_ads" | "analytics" | "website";

export const SERVICE_KEYS: readonly ServiceKey[] = ["social", "search", "search_ads", "analytics", "website"];

export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  unit: "count" | "percent" | "position" | "ratio";
  /** The window `value` covers (inclusive ISO dates). Null for a point-in-time reading with no window. */
  period: { from: string; to: string } | null;
  /** The same figure for the window before `period`; null when that window has no data. */
  previous: number | null;
  /** The committed target, when one exists for this figure. */
  target: number | null;
  /** The date of the newest data point behind `value` (ISO date), null when unknown. */
  asOf: string | null;
}

export interface ServiceCardItem {
  label: string;
  detail: string | null;
}

export interface ServiceCard {
  service: ServiceKey;
  /** A registry area or sub-area id, from the area map. */
  areaId: string;
  title: string;
  status: "active" | "paused" | "setting_up" | "ended";
  since: string | null;
  items: ServiceCardItem[];
  kpis: Kpi[];
  /** Every card is a figure the client itself sees; a card that is not client-visible is never built. */
  clientVisible: true;
}

export interface BusinessResults {
  clientId: string;
  generatedAt: string;
  /** False only on the portal, for a contact who is in scope but not client-wide for this client (PV-D33). */
  visible: boolean;
  services: ServiceCard[];
  /** Services whose read failed. A service the company has not enabled is absent, not listed here. */
  unavailable: ServiceKey[];
}

/** What a builder is handed. `read` is the ONLY way a builder touches the database: it opens the transaction
 *  with the module scope the builder names, so a builder that forgets to name its module reads ZERO rows (the
 *  module wall) and its tests go red. `now` is injected so tests are deterministic. */
export interface BuildContext {
  tenantId: string;
  clientId: string;
  now: Date;
  /** Module keys enabled for the company (own list plus active service assignments). */
  enabled: ReadonlySet<string>;
  read<T>(modules: string[], fn: (c: PoolClient) => Promise<T>): Promise<T>;
}

export interface ResultsBuilder {
  service: ServiceKey;
  /** Module keys that must be ENABLED for the company for this service to be offered at all. A company that has
   *  not enabled one of them is simply not offered the service (absent, not "unavailable"). */
  requires: string[];
  build(ctx: BuildContext): Promise<ServiceCard[]>;
}

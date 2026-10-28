// SCP-3f (BFF §63.7 `GET overview`): the Social Media Overview's Pulse tiles, pure side. One read answers every pipeline tile, so the Pulse reads it ONCE
// and each tile picks its figure (`readingOfOverview`). A failed or refused read is the tile's "Unavailable" or "No access", never a 0.
import type { ReadResult } from "./readResult";
import type { PulseReading } from "./overviewPulse";

export interface SocialOverviewTiles {
  inProduction: number;
  withClient: number;
  late: number;
  scheduledThisWeek: number;
  failedPosts: number;
  /** Boosts requested, plus approved and not yet started (§63.7). */
  boostsWaiting: number;
}
export interface SocialOverview {
  tiles: SocialOverviewTiles;
  /** True while the simulator switch is on: the tiles count simulated rows. */
  simulatedIncluded: boolean;
}

/** The tiles the Pulse draws from this read. */
export type OverviewTileKey = "inProduction" | "withClient" | "late" | "scheduledThisWeek" | "failedPosts" | "boostsWaiting";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`overview: ${name} is not a count`);
  return v;
};

/** `GET overview`. Throws on a body that is not one (the reader turns that into "cannot tell", never a zero). */
export function asOverview(raw: unknown): SocialOverview {
  if (!isObj(raw) || !isObj(raw.tiles) || typeof raw.simulatedIncluded !== "boolean") throw new Error("overview: not an overview");
  const t = raw.tiles;
  return {
    tiles: {
      inProduction: count(t.inProduction, "inProduction"), withClient: count(t.withClient, "withClient"), late: count(t.late, "late"),
      scheduledThisWeek: count(t.scheduledThisWeek, "scheduledThisWeek"), failedPosts: count(t.failedPosts, "failedPosts"),
      boostsWaiting: count(t.boostsWaiting, "boostsWaiting"),
    },
    simulatedIncluded: raw.simulatedIncluded,
  };
}

/** One tile's reading from the shared read: its count, marked SIMULATED while the server says the tiles count simulated rows. */
export function readingOfOverview(r: ReadResult<SocialOverview>, key: OverviewTileKey): PulseReading {
  if (r.kind === "forbidden") return { kind: "forbidden" };
  if (r.kind !== "ok") return { kind: "unavailable" };
  return { kind: "ok", value: r.data.tiles[key], ...(r.data.simulatedIncluded ? { simulated: true as const } : {}) };
}

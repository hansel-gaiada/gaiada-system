import type { OverviewWidgetProps } from "./index";
import type { PulseSource, PulseTile } from "@/lib/workspaces";
import { listChangeRequests } from "@/lib/webdevChangeRequests-data";
import { listInternalPendingGates } from "@/lib/pipeline";
import { getSummary } from "@/lib/monitoring";
import { listPosts } from "@/lib/social";
import { listAccounts } from "@/lib/it-accounts";
import {
  UNAVAILABLE_READING, everyTileFailed, pulseHref, readingOfAccounts, readingOfGuarded, readingOfResult, readingOfSummary,
  runsWaiting, type PulseReading, type PulseTileModel,
} from "@/lib/overviewPulse";
import { PulseBlock } from "./PulseBlock";

// DW-3e: "Pulse", the Department band's block: the workspace's own tiles, only the ones an honest reader feeds
// (the registry's `source`; every other tile stays planned and is never drawn). Each tile reads its own source,
// all at once, and answers for itself: a refused read says "No access" and any other failure says "Unavailable",
// never 0, and one tile failing does not blank the others. The block throws, so the frame's boundary says
// "Unavailable", only when EVERY tile failed.
const READERS: Record<PulseSource, (userId: string, tenantId: string) => Promise<PulseReading>> = {
  "change-requests-new": async (u, t) => readingOfResult(await listChangeRequests(u, t, { status: "new" }), (rows) => ({ value: rows.length })),
  "pipeline-gates-pending": async (u, t) => readingOfResult(await listInternalPendingGates(u, t), (gates) => ({ value: runsWaiting(gates) })),
  "monitoring-problem-sites": async (u, t) => readingOfSummary(await getSummary(u, t)),
  "social-posts-scheduled": async (u, t) => readingOfGuarded(await listPosts(u, t, { status: "scheduled" })),
  "social-posts-failed": async (u, t) => readingOfGuarded(await listPosts(u, t, { status: "failed" })),
  "it-account-requests": async (u, t) => readingOfAccounts(await listAccounts(u, t)),
};

/** One tile's reading. A reader that throws (a 5xx, a timeout) is this tile's failure, not the block's. */
async function readTile(tile: PulseTile, userId: string, tenantId: string): Promise<PulseReading> {
  const read = tile.source ? READERS[tile.source] : undefined;
  if (!read) return UNAVAILABLE_READING;
  try {
    return await read(userId, tenantId);
  } catch {
    return UNAVAILABLE_READING;
  }
}

export async function Pulse({ me, tenantId, deptId, pulse }: OverviewWidgetProps) {
  const tiles = pulse ?? [];
  // A workspace with no built tile draws no Pulse (the frame does not even place it).
  if (tiles.length === 0) return null;
  const readings = await Promise.all(tiles.map((t) => readTile(t, me.userId, tenantId)));
  const models: PulseTileModel[] = tiles.map((t, i) => ({
    key: t.key, label: t.label, href: pulseHref(t, { deptId, companyId: tenantId }), reading: readings[i],
  }));
  if (everyTileFailed(models)) throw new Error("Pulse: every tile failed to read");
  return <PulseBlock tiles={models} />;
}

// M5-V6-b — viewing session recordings in the ERP (design 2026-10-12 §6.3; routes in replays.controller.ts; the collector side is V6-a).
//
// WHAT IS GUARANTEED HERE
//   * A recording is reachable only through a LIVE, VERIFIED profile of this property. The ERP keeps no recording table: a recording's
//     visitor id and consent id are checked against `search_visitor_profiles` (a row exists only after WebDesk's consent log proved
//     `analytics:true`, and V3-e's sweep deletes it the moment that stops being true). No profile, or a profile with ANOTHER consent id,
//     means "not found": the content that was fetched to find out is dropped, never returned.
//   * LIST is metadata only (date, length, pages, chunk count). The consent id and the byte size stay on the server.
//   * CONTENT is released page by page (`from` = the first chunk seq wanted). Every page re-checks the profile, so a withdrawal cuts a replay
//     off at the next page. Opening a recording (the first page, `from` = 0) writes ONE activity row BEFORE any content is returned: who,
//     which recording, which property; never content, never a visitor id. If the row cannot be written, nothing is returned.
//   * No file, no link to the collector, no download: the browser only ever talks to the BFF.
//   * A collector that cannot answer is a typed 503 in words, never an empty list (an empty list is a claim).
//
// FORGETTING. The collector's `forget` already deletes a visitor's recordings with their events (deleted:{events, recordings}), and V3-e's
// ingest and sweep already send forget for every withdrawn visitor, absent consent id and tombstoned id: visitor-jobs.ts needed no change
// for that (replays.db.test.ts drives the real sweep against a fake collector holding recordings to prove it). What the jobs cannot see is a
// recording whose consent id never appears on an ingested event: the collector offers no list of recordings without a visitor id. So the one
// place the ERP meets such a recording is here: a recording listed under a live visitor with a consent id that is NOT the profile's is
// unverified, so it is hidden and its consent id is forgotten (best effort, the delete-only path, mode withdraw). The visitor id is never
// forgotten from here: that would tombstone a live profile.
//
// TENANCY. Every read goes through withTenants([tenant], fn, {modules:['search']}); a property or profile of another company is invisible.
import { withTenants } from "../../db";
import { writeActivity } from "../../core/http";
import {
  InsightsError, REPLAY_CHUNKS_DEFAULT, forgetAtCollector, insightsSettings, readReplayChunks, readReplaySessions,
  type InsightsOpts, type ReplayChunk,
} from "./insights-client";

const SEARCH = { modules: ["search"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A recording cannot be read right now. Rendered as a 503 with `reason` (typed) and `message` (words). */
export class ReplayUnavailableError extends Error {
  constructor(readonly reason: "not_configured" | "no_website" | "collector_unreachable" | "collector_rejected", message: string) {
    super(message);
    this.name = "ReplayUnavailableError";
  }
}
/** The request is not valid (after authorization). Rendered as a 400 with `reason`. */
export class ReplayRequestError extends Error {
  constructor(readonly reason: string, message: string) { super(message); this.name = "ReplayRequestError"; }
}

export const REPLAY_WORDS = {
  not_configured: "Session recordings cannot be read: the visitor collector is not set up on this server yet (its address and keys are missing).",
  no_website: "Session recordings cannot be read: this property is not linked to a collector website.",
  collector_unreachable: "Session recordings cannot be read right now: the visitor collector did not answer. Try again in a moment. This is not an empty list.",
  collector_rejected: "Session recordings cannot be read: the visitor collector refused the ERP's key or does not know this website.",
} as const;

/** Maps a typed collector failure to words. Anything that is not an InsightsError is rethrown by the caller. */
export function unavailableFrom(e: InsightsError): ReplayUnavailableError {
  switch (e.kind) {
    case "not_configured": return new ReplayUnavailableError("not_configured", REPLAY_WORDS.not_configured);
    case "rejected":
    case "not_found": return new ReplayUnavailableError("collector_rejected", REPLAY_WORDS.collector_rejected);
    default: return new ReplayUnavailableError("collector_unreachable", REPLAY_WORDS.collector_unreachable);
  }
}

export interface ReplayDeps { insights?: InsightsOpts }

export interface RecordingRow {
  recordingId: string;
  startedAt: string;
  lastChunkAt: string;
  durationSeconds: number;
  /** Paths only (the collector reduced each page to origin + path). */
  pages: string[];
  /** How many chunks (about 10 s each) the recording has; the player pages through them. */
  chunks: number;
}

export interface RecordingsList { propertyId: string; visitorId: string; recordings: RecordingRow[] }

export interface ChunksPage {
  propertyId: string;
  recordingId: string;
  from: number;
  chunks: Array<{ seq: number; receivedAt: string; events: unknown[] }>;
  more: boolean;
  /** The `from` to ask for next; null when `more` is false. */
  nextFrom: number | null;
  /** True when this page opened the recording (and an activity row was written). */
  opened: boolean;
}

export const RECORDING_ACTIVITY_ENTITY = "search_replay_recording";
export const RECORDING_ACTIVITY_VERB = "opened";

interface PropRow { website: string | null }

async function readProperty(tenantId: string, propertyId: string): Promise<PropRow | null> {
  return withTenants([tenantId], async (c) => {
    const r = await c.query<{ website: string | null }>(
      `SELECT umami_site_id::text AS website FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId],
    );
    return r.rows[0] ? { website: r.rows[0].website } : null;
  }, SEARCH);
}

function websiteOrThrow(p: PropRow, opts: ReplayDeps): string {
  const settings = opts.insights?.settings === undefined ? insightsSettings() : opts.insights.settings;
  if (!settings) throw new ReplayUnavailableError("not_configured", REPLAY_WORDS.not_configured);
  if (!p.website || !UUID_RE.test(p.website)) throw new ReplayUnavailableError("no_website", REPLAY_WORDS.no_website);
  return p.website.toLowerCase();
}

/**
 * A visitor's recordings (metadata only). `propertyFound:false` = 404 property; `visitorFound:false` = no live profile for this visitor on
 * this property (never consented, withdrawn, erased, or another property's).
 */
export async function listRecordings(
  tenantId: string, propertyId: string, visitorId: string, deps: ReplayDeps = {},
): Promise<{ propertyFound: false } | { propertyFound: true; visitorFound: false } | { propertyFound: true; visitorFound: true; list: RecordingsList }> {
  const prop = await readProperty(tenantId, propertyId);
  if (!prop) return { propertyFound: false };
  const consentId = await withTenants([tenantId], async (c) => {
    const r = await c.query<{ consent_id: string }>(
      `SELECT consent_id::text AS consent_id FROM search_visitor_profiles WHERE tenant_id = $1 AND property_id = $2 AND visitor_id = $3`,
      [tenantId, propertyId, visitorId],
    );
    return r.rows[0]?.consent_id.toLowerCase() ?? null;
  }, SEARCH);
  if (!consentId) return { propertyFound: true, visitorFound: false };
  const website = websiteOrThrow(prop, deps);
  let sessions;
  try {
    sessions = await readReplaySessions(website, visitorId, 200, deps.insights);
  } catch (e) {
    if (e instanceof InsightsError) throw unavailableFrom(e);
    throw e;
  }
  const verified = sessions.filter((s) => s.consentId === consentId);
  const strays = [...new Set(sessions.filter((s) => s.consentId !== consentId).map((s) => s.consentId))];
  if (strays.length > 0) {
    // Unverified: hidden above; forgotten here by CONSENT id only (never the visitor id: that would tombstone the live profile). Best effort.
    try {
      await forgetAtCollector(website, { visitorIds: [], consentIds: strays }, "withdraw", deps.insights);
    } catch (e) {
      if (!(e instanceof InsightsError)) throw e;
      console.error(`[SEARCH-REPLAY] could not forget ${strays.length} unverified recording consent id(s) for property ${propertyId}: ${e.kind}`);
    }
  }
  return {
    propertyFound: true, visitorFound: true,
    list: {
      propertyId, visitorId,
      recordings: verified.map((s) => ({
        recordingId: s.id, startedAt: s.startedAt, lastChunkAt: s.lastChunkAt, durationSeconds: s.durationSeconds, pages: s.pages, chunks: s.chunks,
      })),
    },
  };
}

/**
 * One page of a recording's content. `from` is the first chunk seq wanted (0 = from the start = an opening). Returns null for "not found"
 * (an unknown recording, one of another property, or one whose visitor has no live verified profile): all the same answer, no oracle.
 * `actorId` is written to the activity row on an opening.
 */
export async function readRecordingChunks(
  tenantId: string, propertyId: string, recordingId: string, from: number, actorId: string | null, deps: ReplayDeps = {},
): Promise<{ propertyFound: false } | { propertyFound: true; page: ChunksPage | null }> {
  const prop = await readProperty(tenantId, propertyId);
  if (!prop) return { propertyFound: false };
  const website = websiteOrThrow(prop, deps);
  let rec;
  try {
    rec = await readReplayChunks(website, recordingId, from - 1, REPLAY_CHUNKS_DEFAULT, deps.insights);
  } catch (e) {
    if (e instanceof InsightsError) {
      if (e.kind === "not_found") return { propertyFound: true, page: null };
      throw unavailableFrom(e);
    }
    throw e;
  }
  // The content is in memory but not released until the recording's visitor is proven to have a live profile with this very consent id.
  const live = await withTenants([tenantId], async (c) => {
    const r = await c.query(
      `SELECT 1 FROM search_visitor_profiles WHERE tenant_id = $1 AND property_id = $2 AND visitor_id = $3 AND consent_id = $4`,
      [tenantId, propertyId, rec.visitorId, rec.consentId],
    );
    return r.rows.length > 0;
  }, SEARCH);
  if (!live) return { propertyFound: true, page: null };
  const opened = from === 0;
  if (opened) {
    // Metadata carries the recording and property ids only: no visitor id, no consent id, no content, no page paths.
    await writeActivity(tenantId, actorId, RECORDING_ACTIVITY_VERB, RECORDING_ACTIVITY_ENTITY, rec.recordingId, { propertyId, recordingId: rec.recordingId });
  }
  const chunks = rec.chunks.map((c: ReplayChunk) => ({ seq: c.seq, receivedAt: c.receivedAt, events: c.events }));
  const last = chunks.length > 0 ? chunks[chunks.length - 1]!.seq : from - 1;
  return {
    propertyFound: true,
    page: { propertyId, recordingId: rec.recordingId, from, chunks, more: rec.more, nextFrom: rec.more ? last + 1 : null, opened },
  };
}

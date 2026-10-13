// M5-V6-c — session recordings in the ERP: the shapes of platform-nest's replay API (docs/FRONTEND-BFF-CONTRACT.md §28g,
// platform-nest/src/modules/search/replays.{controller,service}.ts), STRICT parsers, the words the screens say, and the paging state
// machine that plays one recording. Pure: no server-only imports, so the browser (the player) and the tests can use it.
//
// Rules the screens rest on:
//   * a recording is opened by ONE first page (`from` absent) per Play; its `openingId` is kept for the whole Play and sent back with
//     every later page (`from=nextFrom&opening=<openingId>`). A second Play is a second opening and a second activity row;
//   * 409 `not_opened` means the opening is gone (a paused Play older than an hour): stop and offer "start again" (a NEW opening);
//   * a 404 at any page means the recording is no longer available (withdrawn, forgotten, aged out): stop and say so, never play half;
//   * a 503 is words by `reason`, never an empty list, and an empty `recordings` array means the collector answered and there are none;
//   * a body that is off-contract is a contract defect (ReplaysShapeError), not an empty screen;
//   * nothing here stores, exposes or downloads the events: they live in the player's memory for one Play.

export class ReplaysShapeError extends Error {}

/** One rrweb event. Opaque to us beyond the two fields the replayer itself requires; the player is the only reader. */
export interface ReplayEvent { type: number; timestamp: number; data?: unknown; [k: string]: unknown }
export interface Recording { recordingId: string; startedAt: string; lastChunkAt: string; durationSeconds: number; pages: string[]; chunks: number }
export interface RecordingList { propertyId: string; visitorId: string; recordings: Recording[] }
export interface ReplayChunk { seq: number; receivedAt: string; events: ReplayEvent[] }
export interface ChunksPage {
  propertyId: string; recordingId: string; from: number; chunks: ReplayChunk[];
  more: boolean; nextFrom: number | null; opened: boolean; openingId: string | null;
}

// ── strict readers ───────────────────────────────────────────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, at: string): Record<string, unknown> => { if (!isObj(v)) throw new ReplaysShapeError(`${at}: expected an object`); return v; };
const arr = (v: unknown, at: string): unknown[] => { if (!Array.isArray(v)) throw new ReplaysShapeError(`${at}: expected an array`); return v; };
const str = (v: unknown, at: string): string => { if (typeof v !== "string") throw new ReplaysShapeError(`${at}: expected a string`); return v; };
const bool = (v: unknown, at: string): boolean => { if (typeof v !== "boolean") throw new ReplaysShapeError(`${at}: expected true or false`); return v; };
const int = (v: unknown, at: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ReplaysShapeError(`${at}: expected a whole number of 0 or more`);
  return v;
};
const secs = (v: unknown, at: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ReplaysShapeError(`${at}: expected a number of seconds of 0 or more`);
  return v;
};
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, at: string): string => { const s = str(v, at); if (!UUID_RE.test(s)) throw new ReplaysShapeError(`${at}: expected an id`); return s; };
const iso = (v: unknown, at: string): string => { const s = str(v, at); if (Number.isNaN(Date.parse(s))) throw new ReplaysShapeError(`${at}: expected a date`); return s; };

export function parseRecordingList(body: unknown): RecordingList {
  const o = obj(body, "recordings");
  const recordings = arr(o.recordings, "recordings.recordings").map((r, i): Recording => {
    const at = `recordings[${i}]`;
    const x = obj(r, at);
    return {
      recordingId: uuid(x.recordingId, `${at}.recordingId`), startedAt: iso(x.startedAt, `${at}.startedAt`), lastChunkAt: iso(x.lastChunkAt, `${at}.lastChunkAt`),
      durationSeconds: secs(x.durationSeconds, `${at}.durationSeconds`),
      pages: arr(x.pages, `${at}.pages`).map((p, j) => str(p, `${at}.pages[${j}]`)),
      chunks: int(x.chunks, `${at}.chunks`),
    };
  });
  return { propertyId: uuid(o.propertyId, "recordings.propertyId"), visitorId: uuid(o.visitorId, "recordings.visitorId"), recordings };
}

export function parseChunksPage(body: unknown): ChunksPage {
  const o = obj(body, "chunks");
  const chunks = arr(o.chunks, "chunks.chunks").map((c, i): ReplayChunk => {
    const at = `chunks[${i}]`;
    const x = obj(c, at);
    const events = arr(x.events, `${at}.events`).map((e, j): ReplayEvent => {
      const ev = obj(e, `${at}.events[${j}]`);
      // The replayer needs a numeric `type` and `timestamp` on every event; anything else would throw inside it, far from the cause.
      if (typeof ev.type !== "number" || !Number.isInteger(ev.type) || typeof ev.timestamp !== "number" || !Number.isFinite(ev.timestamp)) {
        throw new ReplaysShapeError(`${at}.events[${j}]: expected an rrweb event with a numeric type and timestamp`);
      }
      return ev as ReplayEvent;
    });
    return { seq: int(x.seq, `${at}.seq`), receivedAt: iso(x.receivedAt, `${at}.receivedAt`), events };
  });
  const more = bool(o.more, "chunks.more");
  const nextFrom = o.nextFrom === null || o.nextFrom === undefined ? null : int(o.nextFrom, "chunks.nextFrom");
  if (more && nextFrom === null) throw new ReplaysShapeError("chunks.nextFrom: a page with more to read must say where the next one starts");
  if (!more && nextFrom !== null) throw new ReplaysShapeError("chunks.nextFrom: the last page must not name a next one");
  const opened = bool(o.opened, "chunks.opened");
  const openingId = o.openingId === null || o.openingId === undefined ? null : uuid(o.openingId, "chunks.openingId");
  // The contract: an opening page carries the opening's id, every later page carries none.
  if (opened && openingId === null) throw new ReplaysShapeError("chunks.openingId: an opening page must carry the opening id");
  if (!opened && openingId !== null) throw new ReplaysShapeError("chunks.openingId: only an opening page carries an opening id");
  return { propertyId: uuid(o.propertyId, "chunks.propertyId"), recordingId: uuid(o.recordingId, "chunks.recordingId"), from: int(o.from, "chunks.from"), chunks, more, nextFrom, opened, openingId };
}

// ── failures, in words ───────────────────────────────────────────────────────────────────────────────────────────
/** What a refused read means, by HTTP status and the API's machine `reason`. The player and the list both speak from this. */
export type ReplayFailure =
  | { kind: "forbidden" }
  | { kind: "signed_out" }
  | { kind: "not_found"; reason: string | null }
  | { kind: "not_opened" }
  | { kind: "bad_request" }
  | { kind: "unavailable"; reason: string | null; message: string };

/** The 503 sentences, by the API's `reason`. Words, never the code; the server's own `error` sentence is not relied on. */
const UNAVAILABLE_WORDS: Record<string, string> = {
  collector_unreachable: "The recording store did not answer, so recordings cannot be read right now. Try again in a moment.",
  collector_rejected: "The recording store refused the ERP's request. Trying again will not help: an administrator has to look at the collector's keys.",
  not_configured: "Session recordings are not set up on this ERP yet.",
  no_website: "This site has no collector website linked, so there are no recordings to read.",
};
export const UNAVAILABLE_FALLBACK_WORDS = "Recordings could not be read just now. Try again in a moment.";
export const unavailableWords = (reason: string | null | undefined): string => (reason && UNAVAILABLE_WORDS[reason]) || UNAVAILABLE_FALLBACK_WORDS;

export function classifyReplayFailure(status: number, reason: string | null | undefined): ReplayFailure {
  const r = reason ?? null;
  if (status === 401) return { kind: "signed_out" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found", reason: r };
  if (status === 409 && r === "not_opened") return { kind: "not_opened" };
  if (status === 400) return { kind: "bad_request" };
  return { kind: "unavailable", reason: status === 503 ? r : null, message: unavailableWords(status === 503 ? r : null) };
}

export const GONE_WORDS = "This recording is no longer available. The visitor may have withdrawn consent, or it passed its 30 days. Nothing was played.";
export const NOT_OPENED_WORDS = "This viewing could not be continued: its opening has expired, so no more of the recording was loaded. Start again to open it from the beginning (that is a new opening and is logged as one).";
export const EMPTY_WORDS = "This recording holds too little to play (the player needs at least two events).";
export const FORBIDDEN_WORDS = "You are not allowed to watch session recordings.";
export const SIGNED_OUT_WORDS = "Your session has ended. Sign in again, then start the recording.";
export const BAD_REQUEST_WORDS = "The recording could not be requested. Go back to the visitor and open it from the list.";
export const LIST_NOTE = "Recordings are a sample of visits, kept for 30 days on our own server. Typed text is never recorded and forms appear as blank boxes. Playing one writes an entry in the activity log (who, which recording, when) and nothing about its content.";
export const NO_RECORDINGS_WORDS = "No recordings are stored for this visitor. Only a sample of visits is recorded, and only after the visitor accepted analytics.";

// ── the list's words ─────────────────────────────────────────────────────────────────────────────────────────────
/** "45 s", "3 min 20 s", "1 h 02 min": a duration for a person, rounded to whole seconds. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

/** The pages a recording covered: the first three, then how many more. Origin plus path only, as the server sends them. */
export function pagesLabel(pages: string[], shown = 3): string {
  if (pages.length === 0) return "no pages recorded";
  const head = pages.slice(0, shown).join(", ");
  return pages.length > shown ? `${head} and ${pages.length - shown} more` : head;
}

// ── the paging state machine ─────────────────────────────────────────────────────────────────────────────────────
/** One page, as the player's fetcher reports it. `drift` is a body that did not match the contract (a defect, said as one). */
export type PageResult = { kind: "ok"; page: ChunksPage } | ReplayFailure | { kind: "drift"; message: string };
export type PageFetcher = (from: number, opening: string | null) => Promise<PageResult>;

export type PlayStop =
  | { kind: "not_opened" }                                   // offer "start again": a new opening
  | { kind: "gone" }                                         // a 404: the recording is no longer available
  | { kind: "forbidden" } | { kind: "signed_out" } | { kind: "bad_request" }
  | { kind: "unavailable"; reason: string | null; message: string }
  | { kind: "drift"; message: string }
  | { kind: "empty" }
  | { kind: "cancelled" };
export type PlayOutcome = { kind: "ready"; events: ReplayEvent[]; chunks: number; pages: number } | PlayStop;

/** More pages than a recording can have (1000 chunks, up to 20 a page, so 50), with slack: a server that keeps saying `more` is a defect. */
export const MAX_PAGES = 60;

export interface PlayOptions { onProgress?: (p: { pages: number; chunks: number }) => void; isCancelled?: () => boolean }

/**
 * Plays one recording from the beginning: page 1 with `from` absent (that is the opening, and writes the one activity row), then
 * `from = nextFrom` with the `openingId` page 1 returned, until `more` is false. Nothing is played until every page is in: a
 * recording that disappears halfway therefore never half-plays.
 *
 *   409 not_opened at any page  -> { not_opened }  (the caller offers "start again", which calls this again = a NEW opening)
 *   404 at any page             -> { gone }
 *   503                         -> { unavailable } with the sentence for its reason
 *   a page that breaks the contract (no opening id on page 1, `nextFrom` that does not advance, too many pages) -> { drift }
 */
export async function playRecording(fetchPage: PageFetcher, opts: PlayOptions = {}): Promise<PlayOutcome> {
  const events: ReplayEvent[] = [];
  let chunks = 0;
  let pages = 0;
  let from = 0;
  let openingId: string | null = null;
  for (;;) {
    if (opts.isCancelled?.()) return { kind: "cancelled" };
    // Page 1 is asked for with from = 0 and no opening: the fetcher omits `from` for 0, which the API reads as the opening.
    const r: PageResult = await fetchPage(from, openingId);
    if (opts.isCancelled?.()) return { kind: "cancelled" };
    if (r.kind === "not_found") return { kind: "gone" };
    if (r.kind !== "ok") return r;
    const p = r.page;
    if (pages === 0) {
      if (!p.opened || !p.openingId) return { kind: "drift", message: "The first page of the recording did not carry an opening id." };
      openingId = p.openingId;
    }
    pages += 1;
    for (const c of p.chunks) { for (const e of c.events) events.push(e); chunks += 1; }
    opts.onProgress?.({ pages, chunks });
    if (!p.more) break;
    if (p.nextFrom === null || p.nextFrom <= from) return { kind: "drift", message: "The recording's next page did not move forward." };
    if (pages >= MAX_PAGES) return { kind: "drift", message: "The recording had more pages than a recording can have." };
    from = p.nextFrom;
  }
  if (events.length < 2) return { kind: "empty" };
  return { kind: "ready", events, chunks, pages };
}

/** The sentence for a stop. `cancelled` is silent. */
export function stopWords(s: PlayStop): string {
  switch (s.kind) {
    case "not_opened": return NOT_OPENED_WORDS;
    case "gone": return GONE_WORDS;
    case "forbidden": return FORBIDDEN_WORDS;
    case "signed_out": return SIGNED_OUT_WORDS;
    case "bad_request": return BAD_REQUEST_WORDS;
    case "unavailable": return s.message;
    case "drift": return `The recording API answered with something unexpected (${s.message}). This is a defect to report, not an empty recording.`;
    case "empty": return EMPTY_WORDS;
    case "cancelled": return "";
  }
}

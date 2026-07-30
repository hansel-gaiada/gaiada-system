// Group SUBJECT resolution for the auto-discovery list.
//
// Why this exists: WAHA's `message` webhook carries the sender's push name (`notifyName`),
// never the group's subject — so `noteDiscovered()` can only record a JID, and the ERP's
// "discovered groups" list renders nameless rows. Names therefore have to be fetched
// out-of-band from WAHA and late-bound onto the discovery entries (setDiscoveredName).
//
// Kept out of waha.ts / the ChatGateway contract on purpose: this is a read-only,
// best-effort enrichment of an operator-facing list, not part of the message path. Every
// failure mode (WAHA down, session not paired, engine without the endpoint) degrades to
// "no name yet" — the JID is still shown by the UI and the group is still addable.
import { config } from "./config";
import { discoveredGroups, setDiscoveredName } from "./groups";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
/** Don't hammer WAHA's per-group endpoint when a bulk list came back partial. */
const MAX_SINGLE_LOOKUPS = 25;

let cache: { at: number; names: Map<string, string> } | null = null;
let inFlight: Promise<Map<string, string>> | null = null;

/** WAHA ids are a bare string on NOWEB and a {_serialized} object on WEBJS. */
function idOf(raw: unknown): string {
  const r = raw as { id?: unknown };
  const id = r?.id;
  if (typeof id === "string") return id;
  if (id && typeof id === "object") return String((id as { _serialized?: unknown })._serialized ?? "");
  return "";
}

/** Engine-tolerant subject: WEBJS says `name`, NOWEB (Baileys) says `subject`. */
function nameOf(raw: unknown): string {
  const r = raw as Record<string, any>;
  return String(r?.name ?? r?.subject ?? r?.groupMetadata?.subject ?? r?._data?.subject ?? "").trim();
}

async function getJson(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${config.wahaUrl}${path}`, {
      headers: config.wahaApiKey ? { "X-Api-Key": config.wahaApiKey } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Shape-tolerant: `/chats` answers with an array, while `/groups` (NOWEB) answers with an
 *  object KEYED BY JID — verified against the live WAHA 2026.x/NOWEB session. */
function collect(into: Map<string, string>, payload: unknown): void {
  const entries: Array<[string, unknown]> = Array.isArray(payload)
    ? payload.map((v) => ["", v])
    : payload && typeof payload === "object"
      ? Object.entries(payload as Record<string, unknown>)
      : [];
  for (const [key, entry] of entries) {
    const id = idOf(entry) || key;
    const name = nameOf(entry);
    if (id.endsWith("@g.us") && name) into.set(id, name);
  }
}

/** One bulk sweep of WAHA for group subjects, cached briefly and de-duplicated in-flight. */
async function fetchAllNames(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.names;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const names = new Map<string, string>();
    collect(names, await getJson(`/api/${config.wahaSession}/groups?limit=500`));
    // Fallback for engines/versions without the groups endpoint: the chats overview
    // carries the same subject for group chats.
    if (names.size === 0) collect(names, await getJson(`/api/${config.wahaSession}/chats?limit=500`));
    cache = { at: Date.now(), names };
    inFlight = null;
    return names;
  })();
  return inFlight;
}

/** Resolve a single group's subject, preferring the cached bulk sweep. */
async function lookupOne(chatId: string): Promise<string> {
  const bulk = await fetchAllNames();
  const hit = bulk.get(chatId);
  if (hit) return hit;
  const one = await getJson(`/api/${config.wahaSession}/groups/${encodeURIComponent(chatId)}`);
  return one ? nameOf(one) : "";
}

/** Fire-and-forget enrichment for one group; a no-op once the name is known. */
export async function ensureGroupName(chatId: string): Promise<void> {
  if (!chatId.endsWith("@g.us")) return; // Telegram / DMs are out of scope
  const known = discoveredGroups().find((g) => g.id === chatId);
  if (!known || known.name) return;
  const name = await lookupOne(chatId);
  if (name) setDiscoveredName(chatId, name);
}

/**
 * Fill in every nameless discovered group in one bulk sweep. Called when the ERP reads
 * `GET /admin/groups`, so the operator sees real names on the first page load rather than
 * having to wait for each group's next message. Returns how many names were filled.
 */
export async function backfillDiscoveredNames(): Promise<number> {
  const nameless = discoveredGroups().filter((g) => g.id.endsWith("@g.us") && !g.name);
  if (nameless.length === 0) return 0;
  const bulk = await fetchAllNames();
  let filled = 0;
  const stillNameless: string[] = [];
  for (const g of nameless) {
    const name = bulk.get(g.id);
    if (name) {
      if (setDiscoveredName(g.id, name)) filled++;
    } else {
      stillNameless.push(g.id);
    }
  }
  // Bulk list missed some (paging, or a group the session can't enumerate) — probe those
  // individually, bounded so a large stale list can't stall the admin request.
  for (const id of stillNameless.slice(0, MAX_SINGLE_LOOKUPS)) {
    const one = await getJson(`/api/${config.wahaSession}/groups/${encodeURIComponent(id)}`);
    const name = one ? nameOf(one) : "";
    if (name && setDiscoveredName(id, name)) filled++;
  }
  return filled;
}

/** Test seam: drop the bulk-sweep cache. */
export function resetGroupNameCache(): void {
  cache = null;
  inFlight = null;
}

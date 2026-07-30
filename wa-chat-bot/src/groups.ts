// Group registry (Task 1.1): which groups the bot monitors, from config/groups.yaml.
// Hot-reloads on file change. When the file is absent the registry is INACTIVE and the
// bot falls back to trial behavior (monitor every group it is in).
// Unlisted groups are never silently dropped — they are logged once (auto-discovery).
//
// A2: the registry is now bot-writable (moved to the writable data volume in compose).
// writeGroups() validates + atomically writes (tmp file + rename) so a crash mid-write
// never corrupts the file the hot-reload watcher is reading; ensureGroupsSeed() copies a
// read-only seed file into place on first boot when the writable file doesn't exist yet.
import { readFileSync, statSync, existsSync, mkdirSync, copyFileSync, writeFileSync, renameSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { config } from "./config";

export interface GroupConfig {
  id: string;
  name: string;
  category: string;
  optIn: boolean; // post this group's own digest back into it
  isManagement: boolean;
}

export interface DiscoveredGroup {
  id: string;
  name: string;
  firstSeenAt: number;
}

/** Field-level validation error, per design doc §2.3 — never a bare 500/throw. */
export interface WriteGroupsError {
  error: string;
  field?: string;
}

interface Cache {
  path: string;
  mtimeMs: number;
  size: number;
  groups: GroupConfig[];
}

const GROUP_ID_RE = /^\d+(-\d+)?@g\.us$/;

/**
 * A DIGEST DELIVERY TARGET may be a group OR a direct chat — the management "group" is only ever
 * sent to, never ingested, so restricting it to `@g.us` needlessly blocked the most useful and
 * lowest-risk setup: deliver the digest to the operator's own number (WhatsApp's "message
 * yourself"), where it can be read without posting into any real group.
 *   <digits>[-<digits>]@g.us   group (incl. legacy hyphenated ids)
 *   <digits>@c.us / @lid       direct chat (a person, or the bot's own number)
 *   tg:<numeric>               Telegram chat (digests route by chatId prefix via SurfaceRouter)
 * A MONITORED entry still must be a real group — only the delivery target is widened.
 */
const MGMT_TARGET_RE = /^(\d+(-\d+)?@(g\.us|c\.us|lid)|tg:-?\d+)$/;
const MAX_NAME_LEN = 200;
const MAX_CATEGORY_LEN = 64;
const MAX_GROUPS = 500;
/** Cap on the persisted discovery list; oldest-first eviction keeps the file bounded. */
const MAX_DISCOVERED = 500;

let cache: Cache | null = null;
const discovered = new Map<string, DiscoveredGroup>();
let discoveredLoaded = false;

/** 1a: ignore list — a chatId in here is dropped before storage in BOTH registry modes.
 *  Kept as its own persisted set (not a boolean on DiscoveredGroup) because a full-replace
 *  PUT can name ids the bot has never seen (an operator pre-blocking a known group id), and
 *  because ignoring must never mutate the discovery record's firstSeenAt/name. */
interface IgnoredEntry {
  id: string;
  ignoredAt: number;
}
const ignored = new Map<string, IgnoredEntry>();
let ignoredLoaded = false;
/** Cap on the persisted ignore list; oldest-first eviction keeps the file bounded. */
const MAX_IGNORED = 500;

export function resetRegistryCache(): void {
  cache = null;
  discovered.clear();
  ignored.clear();
  // Not a wipe: the next read re-hydrates from the persisted file (which is keyed off
  // config.groupsFile, so tests pointing at a temp dir still start empty).
  discoveredLoaded = false;
  ignoredLoaded = false;
  digestTargetLoaded = false;
  digestTargetValue = "";
}

/** Where the digest delivery target is persisted — explicit env, else alongside the groups file. */
function digestTargetFile(): string {
  return config.digestTargetFile || join(dirname(config.groupsFile), "digest-target.json");
}

let digestTargetValue = "";
let digestTargetLoaded = false;

function loadDigestTarget(): void {
  if (digestTargetLoaded) return;
  digestTargetLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(digestTargetFile(), "utf8")) as { target?: unknown };
    digestTargetValue = typeof raw?.target === "string" ? raw.target : "";
  } catch {
    digestTargetValue = "";
  }
}

/**
 * The standalone digest delivery target, or "" when unset.
 *
 * This exists because the target used to be stored as a `isManagement` row in the group registry.
 * Creating that row made `loadGroups()` non-null, which flips the bot from trial mode (ingest every
 * group) into registry mode (ingest ONLY listed groups) — with zero monitored groups, so it
 * silently stopped storing everything. Choosing where a digest is DELIVERED must never change what
 * the bot READS.
 */
export function digestTarget(): string {
  loadDigestTarget();
  return digestTargetValue;
}

/** Atomically persist the delivery target (tmp + rename). Best-effort, like the sibling stores. */
function persistDigestTarget(): void {
  const path = digestTargetFile();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ target: digestTargetValue }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[groups] could not persist the digest target to ${path}: ${(err as Error).message}`);
  }
}

/** Where the discovery list is persisted — explicit env, else alongside the groups file. */
function discoveredFile(): string {
  return config.discoveredGroupsFile || join(dirname(config.groupsFile), "discovered-groups.json");
}

/** Where the ignore list is persisted — explicit env, else alongside the groups file. */
function ignoredFile(): string {
  return config.ignoredGroupsFile || join(dirname(config.groupsFile), "ignored-groups.json");
}

/** Hydrate the in-memory ignore set from disk once per (reset) cycle. A missing or corrupt
 *  file is not an error — the ignore list simply starts empty and rewrites it. */
function loadIgnored(): void {
  if (ignoredLoaded) return;
  ignoredLoaded = true;
  let raw: { ids?: Array<Record<string, unknown>> } | null = null;
  try {
    raw = JSON.parse(readFileSync(ignoredFile(), "utf8"));
  } catch {
    return;
  }
  for (const e of raw?.ids ?? []) {
    const id = String(e?.id ?? "");
    if (!id) continue;
    ignored.set(id, { id, ignoredAt: Number(e?.ignoredAt) || Date.now() });
  }
}

/** Atomically persist the ignore list (tmp + rename). Best-effort: a read-only volume
 *  degrades to in-memory-only ignoring rather than breaking the inbound path. */
function persistIgnored(): void {
  const path = ignoredFile();
  try {
    if (ignored.size > MAX_IGNORED) {
      const oldest = [...ignored.values()]
        .sort((a, b) => a.ignoredAt - b.ignoredAt)
        .slice(0, ignored.size - MAX_IGNORED);
      for (const e of oldest) ignored.delete(e.id);
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ ids: [...ignored.values()] }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[groups] could not persist ignored groups to ${path}: ${(err as Error).message}`);
  }
}

/** Is this chatId on the ignore list? Checked before storage in every mode (bot.ts) and
 *  before digest delivery in trial mode (schedule.ts). */
export function isIgnored(chatId: string): boolean {
  loadIgnored();
  return ignored.has(chatId);
}

/** Toggle a single id. Returns true iff the set actually changed (idempotent no-ops return
 *  false, mirroring setDiscoveredName's convention). */
export function setIgnored(chatId: string, ignoredFlag: boolean): boolean {
  loadIgnored();
  if (ignoredFlag) {
    if (ignored.has(chatId)) return false;
    ignored.set(chatId, { id: chatId, ignoredAt: Date.now() });
  } else {
    if (!ignored.has(chatId)) return false;
    ignored.delete(chatId);
  }
  persistIgnored();
  return true;
}

/** Currently-ignored groups, shaped like DiscoveredGroup so the ERP can render them in the
 *  same list component as "discovered" — name/firstSeenAt come from the discovery record
 *  when known (the common case: you can only ignore what you've seen), else the registry
 *  name, else the bare id; firstSeenAt falls back to when it was ignored. */
export function ignoredGroups(): DiscoveredGroup[] {
  loadIgnored();
  loadDiscovered();
  const registryName = (id: string) => (loadGroups() ?? []).find((g) => g.id === id)?.name;
  return [...ignored.values()].map((e) => {
    const d = discovered.get(e.id);
    if (d) return d;
    return { id: e.id, name: registryName(e.id) ?? "", firstSeenAt: e.ignoredAt };
  });
}

/** Validate then atomically full-replace the ignore list (same shape/semantics as
 *  writeGroups): each id must match the group-id regex; previously-ignored ids keep their
 *  original ignoredAt so re-saving the same set is idempotent. Never throws. */
export async function writeIgnoredGroups(ids: unknown): Promise<WriteGroupsError | null> {
  if (!Array.isArray(ids)) return { error: "ids must be an array", field: "ids" };
  if (ids.length > MAX_GROUPS) return { error: `too many ids (max ${MAX_GROUPS})`, field: "ids" };

  const normalized: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i] ?? "");
    if (!GROUP_ID_RE.test(id)) {
      return { error: `invalid group id: "${id}" (expected "<digits>@g.us")`, field: `ids[${i}]` };
    }
    normalized.push(id);
  }

  loadIgnored();
  const prev = new Map(ignored);
  ignored.clear();
  const now = Date.now();
  for (const id of new Set(normalized)) {
    ignored.set(id, prev.get(id) ?? { id, ignoredAt: now });
  }
  persistIgnored();
  return null;
}

/** Hydrate the in-memory discovery map from disk once per (reset) cycle. A missing or
 *  corrupt file is not an error — discovery simply starts empty and rewrites it. */
function loadDiscovered(): void {
  if (discoveredLoaded) return;
  discoveredLoaded = true;
  let raw: { groups?: Array<Record<string, unknown>> } | null = null;
  try {
    raw = JSON.parse(readFileSync(discoveredFile(), "utf8"));
  } catch {
    return;
  }
  for (const g of raw?.groups ?? []) {
    const id = String(g?.id ?? "");
    if (!id) continue;
    discovered.set(id, {
      id,
      name: String(g?.name ?? "").slice(0, MAX_NAME_LEN),
      firstSeenAt: Number(g?.firstSeenAt) || Date.now(),
    });
  }
}

/** Atomically persist the discovery list (tmp + rename). Best-effort: a read-only volume
 *  degrades to in-memory-only discovery rather than breaking the inbound path. */
function persistDiscovered(): void {
  const path = discoveredFile();
  try {
    if (discovered.size > MAX_DISCOVERED) {
      const oldest = [...discovered.values()]
        .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
        .slice(0, discovered.size - MAX_DISCOVERED);
      for (const g of oldest) discovered.delete(g.id);
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ groups: [...discovered.values()] }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[groups] could not persist discovered groups to ${path}: ${(err as Error).message}`);
  }
}

/** All configured groups, or null when no groups file exists (registry inactive). */
export function loadGroups(): GroupConfig[] | null {
  const path = config.groupsFile;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!cache || cache.path !== path || cache.mtimeMs !== stat.mtimeMs || cache.size !== stat.size) {
    const raw = parse(readFileSync(path, "utf8")) as { groups?: Array<Record<string, unknown>> } | null;
    const groups = (raw?.groups ?? []).map(
      (g): GroupConfig => ({
        id: String(g.id ?? ""),
        name: String(g.name ?? g.id ?? ""),
        category: String(g.category ?? "general"),
        optIn: Boolean(g.optIn ?? false),
        isManagement: Boolean(g.isManagement ?? false),
      }),
    );
    cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, groups };
  }
  return cache.groups;
}

/** Groups whose messages are ingested and digested (management is delivery-only). */
export function monitoredGroups(): GroupConfig[] {
  return (loadGroups() ?? []).filter((g) => !g.isManagement);
}

export function isMonitored(chatId: string): boolean {
  return monitoredGroups().some((g) => g.id === chatId);
}

/** Registry management group, falling back to MANAGEMENT_GROUP_ID when inactive/unset. */
/** Digest delivery target, in precedence order: a registry row explicitly flagged isManagement
 *  (the Groups tab's per-row radio) > the standalone target (Config tab / API) > MANAGEMENT_GROUP_ID. */
export function managementGroupId(): string {
  const fromFile = (loadGroups() ?? []).find((g) => g.isManagement)?.id;
  if (fromFile) return fromFile;
  return digestTarget() || config.managementGroupId;
}

/**
 * Display name for a group: the registry entry first (the operator's own label), then the
 * subject auto-discovered from WAHA, and only then the bare JID.
 *
 * The discovery fallback matters because the registry is usually EMPTY (trial mode monitors
 * every group), which used to make the ERP's Chats tab — and digest headers — show raw
 * "1203...@g.us" ids for groups the Groups tab was already naming correctly.
 */
export function groupName(chatId: string): string {
  const fromRegistry = (loadGroups() ?? []).find((g) => g.id === chatId)?.name;
  if (fromRegistry) return fromRegistry;
  loadDiscovered();
  return discovered.get(chatId)?.name || chatId;
}

export function groupCategory(chatId: string): string {
  return (loadGroups() ?? []).find((g) => g.id === chatId)?.category ?? "general";
}

export function groupOptIn(chatId: string): boolean {
  return (loadGroups() ?? []).find((g) => g.id === chatId)?.optIn ?? false;
}

/**
 * Auto-discovery: record an unlisted group the bot can see. Logged once per process so
 * the drop is observable (add it to groups.yaml to start monitoring). Returns true the
 * first time this group is noted.
 */
export function noteDiscovered(chatId: string, name = ""): boolean {
  loadDiscovered();
  const known = discovered.get(chatId);
  if (known) {
    // Already seen (possibly in an earlier process): only ever fill in a missing name.
    if (name && !known.name) setDiscoveredName(chatId, name);
    return false;
  }
  discovered.set(chatId, { id: chatId, name: name.slice(0, MAX_NAME_LEN), firstSeenAt: Date.now() });
  persistDiscovered();
  console.warn(
    `[groups] discovered unlisted group ${chatId}${name ? ` (“${name}”)` : ""} — not monitored; add it to ${config.groupsFile} to enable`,
  );
  return true;
}

/**
 * Late-bind a discovered group's display name. The WAHA `message` webhook carries the
 * SENDER's push name, never the group subject, so names arrive out-of-band (group-names.ts)
 * after the group was first noted. Returns true iff a name was actually written.
 */
export function setDiscoveredName(chatId: string, name: string): boolean {
  loadDiscovered();
  const known = discovered.get(chatId);
  const clean = name.trim().slice(0, MAX_NAME_LEN);
  if (!known || !clean || known.name === clean) return false;
  discovered.set(chatId, { ...known, name: clean });
  persistDiscovered();
  return true;
}

/** Groups noted via noteDiscovered but not (yet) in the monitored registry. */
export function discoveredGroups(): DiscoveredGroup[] {
  loadDiscovered();
  return [...discovered.values()];
}

/** Validate a candidate group list per design doc §2.3. Returns the normalized list on
 *  success, or a field-level error — never throws on bad input. */
function validateGroups(groups: unknown): WriteGroupsError | { ok: true; groups: GroupConfig[] } {
  if (!Array.isArray(groups)) return { error: "groups must be an array", field: "groups" };
  if (groups.length > MAX_GROUPS) return { error: `too many groups (max ${MAX_GROUPS})`, field: "groups" };

  const seenIds = new Set<string>();
  let managementCount = 0;
  const normalized: GroupConfig[] = [];

  for (let i = 0; i < groups.length; i++) {
    const g = (groups[i] ?? {}) as Partial<GroupConfig>;
    const id = String(g.id ?? "");
    // The management entry is a delivery target (send-only, never ingested), so it may be a direct
    // chat — e.g. the operator's own number. Everything else is ingested and must be a real group.
    const isMgmt = Boolean(g.isManagement);
    if (!(isMgmt ? MGMT_TARGET_RE : GROUP_ID_RE).test(id)) {
      return {
        error: isMgmt
          ? `invalid digest target: "${id}" (expected a group "<digits>@g.us" or a chat "<digits>@c.us")`
          : `invalid group id: "${id}" (expected "<digits>@g.us")`,
        field: `groups[${i}].id`,
      };
    }
    if (seenIds.has(id)) {
      return { error: `duplicate group id: "${id}"`, field: `groups[${i}].id` };
    }
    seenIds.add(id);

    const name = String(g.name ?? id);
    if (name.length > MAX_NAME_LEN) {
      return { error: `name exceeds ${MAX_NAME_LEN} characters`, field: `groups[${i}].name` };
    }

    const category = String(g.category ?? "general");
    if (category.length > MAX_CATEGORY_LEN) {
      return { error: `category exceeds ${MAX_CATEGORY_LEN} characters`, field: `groups[${i}].category` };
    }

    const isManagement = Boolean(g.isManagement);
    if (isManagement) managementCount++;

    normalized.push({ id, name, category, optIn: Boolean(g.optIn), isManagement });
  }

  if (managementCount > 1) {
    return { error: "at most one group may be the management group", field: "groups" };
  }

  return { ok: true, groups: normalized };
}

/** Validate then atomically write the full registry (tmp file + rename), then reset the
 *  in-memory cache so the existing mtime hot-reload picks the new file up on next read.
 *  Returns null on success, or a field-level error on validation failure — never throws. */
export async function writeGroups(groups: unknown): Promise<WriteGroupsError | null> {
  const validated = validateGroups(groups);
  if (!("ok" in validated)) return validated;

  const path = config.groupsFile;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const yamlOut = stringify({ groups: validated.groups });
  await writeFile(tmp, yamlOut, "utf8");
  await rename(tmp, path);
  resetRegistryCache();
  return null;
}

/**
 * Rewrite the registry so exactly one group (or none) is the management group, per design
 * doc §2.3: setting `id` clears isManagement everywhere else and sets it on that id (adding
 * a minimal entry if `id` is unknown); an empty string just clears every isManagement flag,
 * falling back to MANAGEMENT_GROUP_ID (env) via managementGroupId().
 */
export async function setManagementGroupId(id: string): Promise<WriteGroupsError | null> {
  const trimmed = id.trim();
  if (trimmed && !MGMT_TARGET_RE.test(trimmed)) {
    return {
      error: `invalid digest target: "${trimmed}" (expected a group "<digits>@g.us" or a chat "<digits>@c.us")`,
      field: "managementGroupId",
    };
  }

  // Store the target in its OWN file. This used to push a row into the group registry, which made
  // `loadGroups()` non-null and flipped the bot from trial mode into registry mode with zero
  // monitored groups — silently dropping every group message. Setting a DELIVERY target must never
  // change what the bot READS.
  loadDigestTarget();
  digestTargetValue = trimmed;
  persistDigestTarget();

  // Keep the two sources from disagreeing: a registry row flagged isManagement takes precedence in
  // managementGroupId(), so clear any such flag here. Only rewrite an EXISTING registry — never
  // create one, which is the mode-flip this function just stopped causing.
  const existing = loadGroups();
  if (existing?.some((g) => g.isManagement)) {
    return writeGroups(existing.map((g) => ({ ...g, isManagement: false })));
  }
  return null;
}

/** Snapshot shape for GET/PUT /admin/groups (design doc §2.3). 1a: `ignored` lists the
 *  currently-ignored groups; `discovered` excludes them (an ignored group still stops
 *  showing up as "needs a decision" once the operator has made one). */
export function groupsSnapshot(): {
  registryActive: boolean;
  groups: GroupConfig[];
  discovered: DiscoveredGroup[];
  ignored: DiscoveredGroup[];
  managementGroupId: string;
} {
  const ignoredList = ignoredGroups();
  const ignoredIds = new Set(ignoredList.map((g) => g.id));
  return {
    registryActive: loadGroups() !== null,
    groups: loadGroups() ?? [],
    discovered: discoveredGroups().filter((g) => !ignoredIds.has(g.id)),
    ignored: ignoredList,
    managementGroupId: managementGroupId(),
  };
}

/**
 * First-boot seed-copy (design doc §2.6): when the writable groups file doesn't exist yet
 * but a read-only seed does, copy the seed into place once and let the hot-reload path take
 * it from there. Returns true iff a copy was performed (so callers can log one line).
 */
export function ensureGroupsSeed(): boolean {
  const seed = config.groupsSeedFile;
  if (!seed) return false;
  if (existsSync(config.groupsFile)) return false;
  if (!existsSync(seed)) return false;
  // Guard: a bind-mount whose host source is missing shows up as a DIRECTORY here, and
  // copyFileSync on a dir throws EISDIR and crash-loops the bot. Only seed from a real file.
  if (!statSync(seed).isFile()) return false;
  mkdirSync(dirname(config.groupsFile), { recursive: true });
  copyFileSync(seed, config.groupsFile);
  resetRegistryCache();
  return true;
}

// Group registry (Task 1.1): which groups the bot monitors, from config/groups.yaml.
// Hot-reloads on file change. When the file is absent the registry is INACTIVE and the
// bot falls back to trial behavior (monitor every group it is in).
// Unlisted groups are never silently dropped — they are logged once (auto-discovery).
//
// A2: the registry is now bot-writable (moved to the writable data volume in compose).
// writeGroups() validates + atomically writes (tmp file + rename) so a crash mid-write
// never corrupts the file the hot-reload watcher is reading; ensureGroupsSeed() copies a
// read-only seed file into place on first boot when the writable file doesn't exist yet.
import { readFileSync, statSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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

const GROUP_ID_RE = /^\d+@g\.us$/;
const MAX_NAME_LEN = 200;
const MAX_CATEGORY_LEN = 64;
const MAX_GROUPS = 500;

let cache: Cache | null = null;
const discovered = new Map<string, DiscoveredGroup>();

export function resetRegistryCache(): void {
  cache = null;
  discovered.clear();
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
export function managementGroupId(): string {
  const fromFile = (loadGroups() ?? []).find((g) => g.isManagement)?.id;
  return fromFile ?? config.managementGroupId;
}

export function groupName(chatId: string): string {
  return (loadGroups() ?? []).find((g) => g.id === chatId)?.name ?? chatId;
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
  if (discovered.has(chatId)) return false;
  discovered.set(chatId, { id: chatId, name, firstSeenAt: Date.now() });
  console.warn(
    `[groups] discovered unlisted group ${chatId}${name ? ` (“${name}”)` : ""} — not monitored; add it to ${config.groupsFile} to enable`,
  );
  return true;
}

/** Groups noted via noteDiscovered but not (yet) in the monitored registry. */
export function discoveredGroups(): DiscoveredGroup[] {
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
    if (!GROUP_ID_RE.test(id)) {
      return { error: `invalid group id: "${id}" (expected "<digits>@g.us")`, field: `groups[${i}].id` };
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
  if (trimmed && !GROUP_ID_RE.test(trimmed)) {
    return { error: `invalid group id: "${trimmed}" (expected "<digits>@g.us")`, field: "managementGroupId" };
  }

  const current = (loadGroups() ?? []).map((g) => ({ ...g, isManagement: false }));
  if (trimmed) {
    const idx = current.findIndex((g) => g.id === trimmed);
    if (idx >= 0) {
      current[idx] = { ...current[idx], isManagement: true };
    } else {
      current.push({ id: trimmed, name: trimmed, category: "general", optIn: false, isManagement: true });
    }
  }
  return writeGroups(current);
}

/** Snapshot shape for GET/PUT /admin/groups (design doc §2.3). */
export function groupsSnapshot(): {
  registryActive: boolean;
  groups: GroupConfig[];
  discovered: DiscoveredGroup[];
  managementGroupId: string;
} {
  return {
    registryActive: loadGroups() !== null,
    groups: loadGroups() ?? [],
    discovered: discoveredGroups(),
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

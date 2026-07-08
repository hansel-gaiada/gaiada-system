// Group registry (Task 1.1): which groups the bot monitors, from config/groups.yaml.
// Hot-reloads on file change. When the file is absent the registry is INACTIVE and the
// bot falls back to trial behavior (monitor every group it is in).
// Unlisted groups are never silently dropped — they are logged once (auto-discovery).
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { config } from "./config";

export interface GroupConfig {
  id: string;
  name: string;
  category: string;
  optIn: boolean; // post this group's own digest back into it
  isManagement: boolean;
}

interface Cache {
  path: string;
  mtimeMs: number;
  size: number;
  groups: GroupConfig[];
}

let cache: Cache | null = null;
const discovered = new Set<string>();

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
  discovered.add(chatId);
  console.warn(
    `[groups] discovered unlisted group ${chatId}${name ? ` (“${name}”)` : ""} — not monitored; add it to ${config.groupsFile} to enable`,
  );
  return true;
}

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { writeFileSync, utimesSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import {
  loadGroups,
  monitoredGroups,
  isMonitored,
  managementGroupId,
  groupName,
  noteDiscovered,
  discoveredGroups,
  resetRegistryCache,
  writeGroups,
  setManagementGroupId,
  groupsSnapshot,
  ensureGroupsSeed,
} from "./groups";

const DIR = "data/test-groups";
const FILE = join(DIR, "groups.yaml");

const YAML = `
groups:
  - id: "111@g.us"
    name: Site A — Construction
    category: construction
    optIn: true
  - id: "222@g.us"
    name: Back Office
    category: office
    optIn: false
  - id: "999@g.us"
    name: Management
    isManagement: true
`;

function writeYaml(content: string, mtimeSec: number): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, content);
  utimesSync(FILE, mtimeSec, mtimeSec); // force a distinct mtime for hot-reload
}

describe("group registry", () => {
  beforeEach(() => {
    config.groupsFile = FILE;
    resetRegistryCache();
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("parses monitored groups and the management group", () => {
    writeYaml(YAML, 1_000_000);
    const groups = monitoredGroups();
    expect(groups.map((g) => g.id)).toEqual(["111@g.us", "222@g.us"]);
    expect(groups[0].optIn).toBe(true);
    expect(groups[1].optIn).toBe(false);
    expect(managementGroupId()).toBe("999@g.us");
    expect(groupName("111@g.us")).toBe("Site A — Construction");
  });

  it("only listed (non-management) groups are monitored", () => {
    writeYaml(YAML, 1_000_001);
    expect(isMonitored("111@g.us")).toBe(true);
    expect(isMonitored("999@g.us")).toBe(false); // management is a delivery target, not ingested
    expect(isMonitored("unlisted@g.us")).toBe(false);
  });

  it("hot-reloads when the file changes", () => {
    writeYaml(YAML, 1_000_002);
    expect(isMonitored("333@g.us")).toBe(false);
    writeYaml(YAML + `  - id: "333@g.us"\n    name: New Site\n`, 1_000_003);
    expect(isMonitored("333@g.us")).toBe(true);
  });

  it("registry is inactive (null) when the file does not exist", () => {
    config.groupsFile = join(DIR, "missing.yaml");
    resetRegistryCache();
    expect(loadGroups()).toBeNull();
    expect(managementGroupId()).toBe(config.managementGroupId); // env fallback
  });

  it("logs an unlisted discovered group once (observable drop)", () => {
    writeYaml(YAML, 1_000_004);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(noteDiscovered("new@g.us", "Fresh Group")).toBe(true);
    expect(noteDiscovered("new@g.us", "Fresh Group")).toBe(false); // only once
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toContain("new@g.us");
    warn.mockRestore();
  });

  it("discoveredGroups() surfaces noted-but-unmonitored groups with a firstSeenAt", () => {
    writeYaml(YAML, 1_000_005);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(discoveredGroups()).toEqual([]);
    noteDiscovered("disc@g.us", "Discovered Group");
    const found = discoveredGroups();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "disc@g.us", name: "Discovered Group" });
    expect(typeof found[0]?.firstSeenAt).toBe("number");
    warn.mockRestore();
  });
});

describe("writeGroups (A2 full-replace, validation + atomic write + hot-reload)", () => {
  beforeEach(() => {
    config.groupsFile = FILE;
    resetRegistryCache();
    rmSync(DIR, { recursive: true, force: true });
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("rejects a malformed group id with a field-level error", async () => {
    const err = await writeGroups([{ id: "not-a-group-id", name: "Bad" }]);
    expect(err).not.toBeNull();
    expect(err?.error).toMatch(/invalid group id/i);
    expect(err?.field).toBe("groups[0].id");
  });

  it("rejects a plain WhatsApp DM id (c.us) — only g.us groups are valid", async () => {
    const err = await writeGroups([{ id: "123@c.us", name: "Not a group" }]);
    expect(err).not.toBeNull();
    expect(err?.field).toBe("groups[0].id");
  });

  it("rejects two management groups", async () => {
    const err = await writeGroups([
      { id: "1@g.us", name: "A", isManagement: true },
      { id: "2@g.us", name: "B", isManagement: true },
    ]);
    expect(err).not.toBeNull();
    expect(err?.error).toMatch(/at most one/i);
    expect(err?.field).toBe("groups");
  });

  it("rejects a duplicate group id", async () => {
    const err = await writeGroups([
      { id: "1@g.us", name: "A" },
      { id: "1@g.us", name: "A again" },
    ]);
    expect(err).not.toBeNull();
    expect(err?.field).toBe("groups[1].id");
  });

  it("rejects a name over 200 chars and a category over 64 chars", async () => {
    const longName = await writeGroups([{ id: "1@g.us", name: "x".repeat(201) }]);
    expect(longName?.field).toBe("groups[0].name");

    const longCategory = await writeGroups([{ id: "1@g.us", name: "ok", category: "x".repeat(65) }]);
    expect(longCategory?.field).toBe("groups[0].category");
  });

  it("rejects more than 500 groups", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `${i}@g.us`, name: `G${i}` }));
    const err = await writeGroups(many);
    expect(err).not.toBeNull();
    expect(err?.field).toBe("groups");
  });

  it("rejects a non-array body", async () => {
    const err = await writeGroups({ not: "an array" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("groups");
  });

  it("atomically writes valid groups and the hot-reload path (loadGroups) picks it up, with no tmp file left behind", async () => {
    const err = await writeGroups([
      { id: "111@g.us", name: "Site A", category: "construction", optIn: true },
      { id: "999@g.us", name: "Mgmt", isManagement: true },
    ]);
    expect(err).toBeNull();

    // loadGroups() re-reads via the existing mtime hot-reload (writeGroups reset the cache).
    const groups = loadGroups();
    expect(groups?.map((g) => g.id).sort()).toEqual(["111@g.us", "999@g.us"]);
    expect(isMonitored("111@g.us")).toBe(true);
    expect(managementGroupId()).toBe("999@g.us");

    // No stray tmp-* files left in the directory after the rename.
    const leftovers = readdirSync(DIR).filter((f: string) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("full-replace is idempotent: writing the same set twice yields the same snapshot", async () => {
    const list = [{ id: "5@g.us", name: "Five", category: "general", optIn: false, isManagement: false }];
    expect(await writeGroups(list)).toBeNull();
    const first = groupsSnapshot();
    expect(await writeGroups(list)).toBeNull();
    const second = groupsSnapshot();
    expect(second.groups).toEqual(first.groups);
  });
});

describe("setManagementGroupId (A2 rewrite semantics)", () => {
  beforeEach(() => {
    config.groupsFile = FILE;
    config.managementGroupId = "envfallback@g.us";
    resetRegistryCache();
    rmSync(DIR, { recursive: true, force: true });
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("sets isManagement on a known group and clears it elsewhere", async () => {
    await writeGroups([
      { id: "1@g.us", name: "A", isManagement: true },
      { id: "2@g.us", name: "B" },
    ]);
    const err = await setManagementGroupId("2@g.us");
    expect(err).toBeNull();
    const groups = loadGroups() ?? [];
    expect(groups.find((g) => g.id === "1@g.us")?.isManagement).toBe(false);
    expect(groups.find((g) => g.id === "2@g.us")?.isManagement).toBe(true);
    expect(managementGroupId()).toBe("2@g.us");
  });

  it("adds a minimal entry when the id is unknown to the registry", async () => {
    await writeGroups([{ id: "1@g.us", name: "A" }]);
    const err = await setManagementGroupId("999@g.us");
    expect(err).toBeNull();
    const groups = loadGroups() ?? [];
    expect(groups.find((g) => g.id === "999@g.us")).toMatchObject({ isManagement: true });
    expect(managementGroupId()).toBe("999@g.us");
  });

  it("empty string clears isManagement everywhere and falls back to the env id", async () => {
    await writeGroups([{ id: "1@g.us", name: "A", isManagement: true }]);
    const err = await setManagementGroupId("");
    expect(err).toBeNull();
    const groups = loadGroups() ?? [];
    expect(groups.every((g) => !g.isManagement)).toBe(true);
    expect(managementGroupId()).toBe("envfallback@g.us");
  });

  it("rejects a malformed id with a field-level error and does not write", async () => {
    await writeGroups([{ id: "1@g.us", name: "A" }]);
    const before = groupsSnapshot();
    const err = await setManagementGroupId("not-valid");
    expect(err).not.toBeNull();
    expect(err?.field).toBe("managementGroupId");
    expect(groupsSnapshot()).toEqual(before);
  });
});

describe("ensureGroupsSeed (A2 first-boot seed-copy)", () => {
  const SEED_DIR = "data/test-groups-seed";
  const SEED_FILE = join(SEED_DIR, "groups.seed.yaml");

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    rmSync(SEED_DIR, { recursive: true, force: true });
    config.groupsFile = FILE;
    config.groupsSeedFile = "";
    resetRegistryCache();
  });
  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    rmSync(SEED_DIR, { recursive: true, force: true });
    config.groupsSeedFile = "";
  });

  it("copies the seed into place when the groups file is absent and a seed is configured", () => {
    mkdirSync(SEED_DIR, { recursive: true });
    writeFileSync(SEED_FILE, YAML);
    config.groupsSeedFile = SEED_FILE;

    expect(existsSync(FILE)).toBe(false);
    const copied = ensureGroupsSeed();
    expect(copied).toBe(true);
    expect(existsSync(FILE)).toBe(true);
    expect(readFileSync(FILE, "utf8")).toBe(YAML);

    // Hot-reload observes it immediately (cache was reset by ensureGroupsSeed()).
    expect(managementGroupId()).toBe("999@g.us");
  });

  it("does nothing when the groups file already exists (never clobbers real edits)", () => {
    writeYaml("groups: []\n", 2_000_000);
    mkdirSync(SEED_DIR, { recursive: true });
    writeFileSync(SEED_FILE, YAML);
    config.groupsSeedFile = SEED_FILE;

    const copied = ensureGroupsSeed();
    expect(copied).toBe(false);
    expect(readFileSync(FILE, "utf8")).toBe("groups: []\n");
  });

  it("does nothing when no seed file is configured", () => {
    config.groupsSeedFile = "";
    expect(ensureGroupsSeed()).toBe(false);
    expect(existsSync(FILE)).toBe(false);
  });

  it("does nothing when the configured seed file itself doesn't exist", () => {
    config.groupsSeedFile = SEED_FILE; // never written in this test
    expect(ensureGroupsSeed()).toBe(false);
    expect(existsSync(FILE)).toBe(false);
  });
});

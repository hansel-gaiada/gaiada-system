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
  setDiscoveredName,
  resetRegistryCache,
  writeGroups,
  setManagementGroupId,
  groupsSnapshot,
  ensureGroupsSeed,
  isIgnored,
  setIgnored,
  ignoredGroups,
  writeIgnoredGroups,
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
    // Discovery now persists next to the groups file — drop it so each test starts clean.
    rmSync(join(DIR, "discovered-groups.json"), { force: true });
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

  it("groupName falls back to the discovered subject before the bare JID", () => {
    writeYaml(YAML, 1_000_008);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(groupName("111@g.us")).toBe("Site A — Construction"); // registry wins
    expect(groupName("555@g.us")).toBe("555@g.us"); // unknown -> JID

    noteDiscovered("555@g.us", "Warehouse Ops");
    expect(groupName("555@g.us")).toBe("Warehouse Ops"); // discovery fills the gap

    // A registry entry still overrides discovery (it's the operator's own label).
    noteDiscovered("111@g.us", "Upstream Name");
    expect(groupName("111@g.us")).toBe("Site A — Construction");
    warn.mockRestore();
  });

  it("persists discovered groups so the list survives a restart", () => {
    writeYaml(YAML, 1_000_006);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    noteDiscovered("777@g.us");
    const persisted = join(DIR, "discovered-groups.json");
    expect(existsSync(persisted)).toBe(true);

    // Simulate a process restart: in-memory map cleared, file left in place.
    resetRegistryCache();
    const found = discoveredGroups();
    expect(found.map((g) => g.id)).toEqual(["777@g.us"]);
    // ...and it is NOT re-announced as new after the restart.
    expect(noteDiscovered("777@g.us")).toBe(false);
    warn.mockRestore();
  });

  it("setDiscoveredName late-binds a subject onto an already-discovered group", () => {
    writeYaml(YAML, 1_000_007);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    noteDiscovered("888@g.us"); // webhook only ever gives us the JID
    expect(discoveredGroups()[0]?.name).toBe("");

    expect(setDiscoveredName("888@g.us", "  Ops Room  ")).toBe(true);
    expect(discoveredGroups()[0]?.name).toBe("Ops Room");
    expect(setDiscoveredName("888@g.us", "Ops Room")).toBe(false); // idempotent
    expect(setDiscoveredName("888@g.us", "   ")).toBe(false); // never blank an existing name
    expect(setDiscoveredName("unknown@g.us", "Nope")).toBe(false); // only known groups

    resetRegistryCache();
    expect(discoveredGroups()[0]?.name).toBe("Ops Room"); // the name persisted too
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

  it("rejects a plain WhatsApp DM id (c.us) for a MONITORED entry — only g.us groups are ingested", async () => {
    const err = await writeGroups([{ id: "123@c.us", name: "Not a group" }]);
    expect(err).not.toBeNull();
    expect(err?.field).toBe("groups[0].id");
  });

  it("ACCEPTS a direct chat as the management entry — a digest target is send-only, never ingested", async () => {
    // The most useful (and lowest-risk) setup: deliver the digest to the operator's own number
    // instead of posting into a real group. Blocking @c.us here made that impossible.
    for (const target of ["628111546034@c.us", "54202772525222@lid", "628123894471-1606911325@g.us"]) {
      const err = await writeGroups([
        { id: "111@g.us", name: "Site A" },
        { id: target, name: "Digest target", isManagement: true },
      ]);
      expect(err, `target ${target} should be accepted`).toBeNull();
      expect(managementGroupId()).toBe(target);
      // ...and it is NOT monitored: the bot must never ingest its own delivery target.
      expect(monitoredGroups().map((g) => g.id)).toEqual(["111@g.us"]);
    }
  });

  it("setManagementGroupId accepts a direct chat and still rejects junk", async () => {
    expect(await setManagementGroupId("628111546034@c.us")).toBeNull();
    expect(managementGroupId()).toBe("628111546034@c.us");

    const bad = await setManagementGroupId("not-a-chat");
    expect(bad).not.toBeNull();
    expect(bad?.field).toBe("managementGroupId");
    expect(bad?.error).toMatch(/invalid digest target/i);
  });

  it("setting a delivery target must NOT activate the registry (it used to stop ALL ingestion)", async () => {
    // The bug this pins: writing the target as a registry row made loadGroups() non-null, which
    // flips the bot from trial mode (ingest every group) to registry mode (ingest only listed
    // groups) with ZERO monitored groups — so the bot silently stored nothing at all.
    expect(loadGroups()).toBeNull(); // trial mode, no registry file

    expect(await setManagementGroupId("628111546034@c.us")).toBeNull();

    expect(loadGroups()).toBeNull(); // STILL trial mode — no registry was created
    expect(managementGroupId()).toBe("628111546034@c.us"); // ...and the target took effect
    expect(isMonitored("anything@g.us")).toBe(false);
    expect(monitoredGroups()).toEqual([]);
  });

  it("the target survives a restart and a registry isManagement row still wins", async () => {
    await setManagementGroupId("628111546034@c.us");
    resetRegistryCache();
    expect(managementGroupId()).toBe("628111546034@c.us"); // re-read from its own file

    // An explicit registry row (the Groups tab radio) takes precedence over the standalone target.
    await writeGroups([{ id: "999@g.us", name: "Mgmt group", isManagement: true }]);
    expect(managementGroupId()).toBe("999@g.us");
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

  // CONTRACT CHANGE (deliberate): setManagementGroupId no longer writes the registry. It used to
  // add/flag a row, which made loadGroups() non-null and flipped the bot from trial mode into
  // registry mode — with zero monitored groups, silently ending ALL ingestion. The target now lives
  // in its own file; a registry isManagement row (set via the Groups tab) still takes precedence.
  it("takes effect WITHOUT adding a registry row, and clears any existing isManagement flag", async () => {
    await writeGroups([
      { id: "1@g.us", name: "A", isManagement: true },
      { id: "2@g.us", name: "B" },
    ]);
    const err = await setManagementGroupId("2@g.us");
    expect(err).toBeNull();
    const groups = loadGroups() ?? [];
    // The stale flag is cleared so the two sources cannot disagree...
    expect(groups.every((g) => !g.isManagement)).toBe(true);
    // ...no row was added or removed...
    expect(groups.map((g) => g.id)).toEqual(["1@g.us", "2@g.us"]);
    // ...and the target is in effect.
    expect(managementGroupId()).toBe("2@g.us");
  });

  it("an id unknown to the registry does NOT get a registry entry invented for it", async () => {
    await writeGroups([{ id: "1@g.us", name: "A" }]);
    const err = await setManagementGroupId("999@g.us");
    expect(err).toBeNull();
    const groups = loadGroups() ?? [];
    expect(groups.map((g) => g.id)).toEqual(["1@g.us"]); // unchanged — no phantom entry
    expect(groups.some((g) => g.isManagement)).toBe(false);
    expect(managementGroupId()).toBe("999@g.us"); // still delivered there
    // Crucially, monitoring is untouched: 1@g.us is still the only monitored group.
    expect(monitoredGroups().map((g) => g.id)).toEqual(["1@g.us"]);
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

describe("ignore list (1a: monitor everything except these)", () => {
  beforeEach(() => {
    config.groupsFile = FILE;
    rmSync(DIR, { recursive: true, force: true });
    resetRegistryCache();
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("isIgnored is false for a group never mentioned", () => {
    expect(isIgnored("never-seen@g.us")).toBe(false);
  });

  it("setIgnored toggles and is idempotent (returns false on a no-op)", () => {
    expect(setIgnored("111@g.us", true)).toBe(true);
    expect(isIgnored("111@g.us")).toBe(true);
    expect(setIgnored("111@g.us", true)).toBe(false); // already ignored -> no-op
    expect(setIgnored("111@g.us", false)).toBe(true);
    expect(isIgnored("111@g.us")).toBe(false);
    expect(setIgnored("111@g.us", false)).toBe(false); // already un-ignored -> no-op
  });

  it("ignoredGroups() prefers the discovered name, falling back to the registry name, then the bare id", () => {
    writeYaml(YAML, 2_000_001);
    noteDiscovered("disc@g.us", "Discovered Name");
    setIgnored("disc@g.us", true); // has a discovery record -> uses its name
    setIgnored("111@g.us", true); // no discovery record, but IS in the registry -> registry name
    setIgnored("bare@g.us", true); // neither -> bare id

    const byId = Object.fromEntries(ignoredGroups().map((g) => [g.id, g.name]));
    expect(byId["disc@g.us"]).toBe("Discovered Name");
    expect(byId["111@g.us"]).toBe("Site A — Construction");
    expect(byId["bare@g.us"]).toBe("");
  });

  it("groupsSnapshot(): discovered excludes ignored entries, ignored lists them", () => {
    noteDiscovered("keep@g.us", "Keep");
    noteDiscovered("drop@g.us", "Drop");
    setIgnored("drop@g.us", true);

    const snap = groupsSnapshot();
    expect(snap.discovered.map((g) => g.id)).toEqual(["keep@g.us"]);
    expect(snap.ignored.map((g) => g.id)).toEqual(["drop@g.us"]);
  });

  it("persists across a restart (cache reset)", () => {
    setIgnored("777@g.us", true);
    resetRegistryCache();
    expect(isIgnored("777@g.us")).toBe(true);
    expect(ignoredGroups().map((g) => g.id)).toEqual(["777@g.us"]);
  });

  describe("writeIgnoredGroups (full-replace)", () => {
    it("rejects a non-array body", async () => {
      const err = await writeIgnoredGroups({ not: "an array" });
      expect(err).not.toBeNull();
      expect(err?.field).toBe("ids");
    });

    it("rejects a malformed group id with a field-level error", async () => {
      const err = await writeIgnoredGroups(["not-a-group-id"]);
      expect(err).not.toBeNull();
      expect(err?.error).toMatch(/invalid group id/i);
      expect(err?.field).toBe("ids[0]");
    });

    it("rejects more than 500 ids", async () => {
      const many = Array.from({ length: 501 }, (_, i) => `${i}@g.us`);
      const err = await writeIgnoredGroups(many);
      expect(err).not.toBeNull();
      expect(err?.field).toBe("ids");
    });

    it("does not mutate state on a validation failure", async () => {
      await writeIgnoredGroups(["1@g.us"]);
      const before = ignoredGroups().map((g) => g.id);
      await writeIgnoredGroups(["bad-id"]);
      expect(ignoredGroups().map((g) => g.id)).toEqual(before);
    });

    it("full-replaces the set: a previously-ignored id not in the new list is un-ignored", async () => {
      expect(await writeIgnoredGroups(["1@g.us", "2@g.us"])).toBeNull();
      expect(isIgnored("1@g.us")).toBe(true);
      expect(isIgnored("2@g.us")).toBe(true);

      expect(await writeIgnoredGroups(["2@g.us"])).toBeNull();
      expect(isIgnored("1@g.us")).toBe(false); // dropped from the replace -> un-ignored
      expect(isIgnored("2@g.us")).toBe(true);
    });

    it("an empty array un-ignores everything", async () => {
      await writeIgnoredGroups(["1@g.us"]);
      expect(await writeIgnoredGroups([])).toBeNull();
      expect(ignoredGroups()).toEqual([]);
    });

    it("preserves the original ignoredAt (firstSeenAt in the response) across a re-save of the same set", async () => {
      await writeIgnoredGroups(["1@g.us"]);
      const first = ignoredGroups()[0]?.firstSeenAt;
      await new Promise((r) => setTimeout(r, 5));
      await writeIgnoredGroups(["1@g.us"]);
      expect(ignoredGroups()[0]?.firstSeenAt).toBe(first);
    });

    it("returned groupsSnapshot() reflects the write immediately", async () => {
      const err = await writeIgnoredGroups(["9@g.us"]);
      expect(err).toBeNull();
      expect(groupsSnapshot().ignored.map((g) => g.id)).toEqual(["9@g.us"]);
    });
  });
});

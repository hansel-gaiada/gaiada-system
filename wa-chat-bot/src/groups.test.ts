import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { writeFileSync, utimesSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import {
  loadGroups,
  monitoredGroups,
  isMonitored,
  managementGroupId,
  groupName,
  noteDiscovered,
  resetRegistryCache,
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
});

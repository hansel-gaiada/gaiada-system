// Client Centre registry v2 (PV6-01): Business areas, no leaf pages. Pure, no DB. The UI carries a
// byte-identical copy of this registry (platform-ui `clientCentre.test.ts` pins the parity); this suite pins
// the SHAPE and the sections helpers that read it.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import registry from "./registry.json";
import { allAreas, allSections, settingsDef, connectionIdsFor } from "./sections";
import { connectionsConnectedSummary, fieldsFilledSummary, emptyProfileState } from "./store";

interface Area { id: string; name: string; subAreas?: Array<{ id: string; name: string }> }
const areas = registry.areas as Area[];

function keysDeep(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

describe("registry v2 shape", () => {
  it("is version 2 with `areas` and `defaultOffAreas`, and no `departments` keys left", () => {
    expect(registry.version).toBe(2);
    expect(Array.isArray(registry.areas)).toBe(true);
    expect(registry.defaultOffAreas).toBeTypeOf("object");
    const all = keysDeep(registry);
    expect(all.has("departments")).toBe(false);
    expect(all.has("defaultOffDepartments")).toBe(false);
  });

  it("has no `pages` key anywhere: every leaf 'Coming soon' page is gone", () => {
    expect(keysDeep(registry).has("pages")).toBe(false);
  });

  it("has 9 business areas, each {id, name, subAreas?}, and only Marketing has sub-areas (19, `se` included)", () => {
    expect(areas.map((a) => a.id)).toEqual(["rs", "mk", "fi", "hr", "lg", "sa", "cs", "it", "op"]);
    for (const a of areas) {
      expect(Object.keys(a).every((k) => ["id", "name", "subAreas"].includes(k))).toBe(true);
      if (a.id !== "mk") expect(a.subAreas).toBeUndefined();
    }
    const mk = areas.find((a) => a.id === "mk")!;
    expect(mk.subAreas).toHaveLength(19);
    expect(mk.subAreas!.map((s) => s.id)).toContain("se");
    for (const s of mk.subAreas!) expect(Object.keys(s).sort()).toEqual(["id", "name"]);
  });

  it("every industry area is {id: 'ix', name, settings}", () => {
    for (const m of Object.values(registry.industryModules) as Array<Record<string, unknown>>) {
      expect(Object.keys(m).sort()).toEqual(["id", "name", "settings"]);
      expect(m.id).toBe("ix");
    }
  });

  it("every sectionSettings key is an area or a sub-area id, and every area and sub-area has one", () => {
    const ids = new Set<string>();
    for (const a of areas) { ids.add(a.id); for (const s of a.subAreas ?? []) ids.add(s.id); }
    expect([...Object.keys(registry.sectionSettings)].sort()).toEqual([...ids].sort());
  });

  it("every defaultOffAreas entry is a real area id of a real business type", () => {
    const types = new Set(registry.businessTypes.map((b) => b.id));
    const ids = new Set(areas.map((a) => a.id));
    for (const [bt, off] of Object.entries(registry.defaultOffAreas as Record<string, string[]>)) {
      expect(types.has(bt)).toBe(true);
      for (const id of off) expect(ids.has(id)).toBe(true);
    }
  });

  it("the transform is idempotent: scripts/cmc/registry-v2.mjs --check finds both copies already v2", () => {
    const script = path.resolve(__dirname, "../../../../../scripts/cmc/registry-v2.mjs");
    if (!existsSync(script)) return; // a partial checkout (the Nest image) has no scripts/
    const out = execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(out).toContain("already v2");
  });
});

describe("sections helpers (the industry area is reachable)", () => {
  it("allAreas puts the industry area first, then the nine", () => {
    expect(allAreas("hotel").map((a) => a.id)).toEqual(["ix", "rs", "mk", "fi", "hr", "lg", "sa", "cs", "it", "op"]);
    expect(allAreas("other").map((a) => a.id)).toEqual(["rs", "mk", "fi", "hr", "lg", "sa", "cs", "it", "op"]);
    expect(allAreas("hotel")[0].name).toBe("Hotel Operations");
  });

  it("allSections is each area followed by its sub-areas (28 for `other`, 29 with an industry area)", () => {
    expect(allSections("other")).toHaveLength(28);
    expect(allSections("hotel")).toHaveLength(29);
  });

  it("settingsDef('ix', hotel) is the Hotel Operations settings: 9 fields, 9 connections", () => {
    const def = settingsDef({ id: "ix", name: "Hotel Operations" }, "hotel");
    expect(def.fields).toEqual(["rooms", "rating", "checkin", "adr", "seasonality", "capacity", "hours", "gm", "reviews"]);
    expect(def.connections).toHaveLength(9);
    // a different business type's `ix` is ITS settings, never hotel's
    expect(settingsDef({ id: "ix", name: "x" }, "restaurant").fields).not.toEqual(def.fields);
    // a business type with no industry area has none
    expect(settingsDef({ id: "ix", name: "x" }, "other")).toEqual({ fields: [], connections: [] });
  });

  it("an ordinary area still reads sectionSettings", () => {
    expect(settingsDef({ id: "rs", name: "Reservations" }, "hotel")).toEqual(registry.sectionSettings.rs);
  });

  it("connectionIdsFor appends custom ids for `ix`", () => {
    const def = settingsDef({ id: "ix", name: "x" }, "hotel");
    expect(connectionIdsFor("ix", def, { ix: [{ id: "xixtool1", name: "n" }] })).toEqual([...def.connections, "xixtool1"]);
  });

  it("the list summaries count the industry area's own connections: `other` 98 (no industry area), `hotel` 103", () => {
    expect(connectionsConnectedSummary(emptyProfileState("other")).total).toBe(98);
    expect(connectionsConnectedSummary(emptyProfileState("hotel")).total).toBe(103);
    expect(fieldsFilledSummary(emptyProfileState("hotel")).total).toBe(fieldsFilledSummary(emptyProfileState("other")).total);
  });
});

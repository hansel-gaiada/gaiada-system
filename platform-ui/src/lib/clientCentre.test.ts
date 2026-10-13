import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  registry,
  allAreas,
  areaEnabled,
  activeAreas,
  findArea,
  allSections,
  findSection,
  parentOf,
  settingsDef,
  sectionStats,
  usedBy,
  groupedFields,
  fieldsFilledCount,
  connectionIdsFor,
  connectionsConnectedCount,
  parseSectionRoute,
  sectionHref,
  legacySectionRedirect,
  kpiChange,
  targetMet,
  cardsForSection,
  runningServicesByArea,
  type BusinessResults,
  type ResultsServiceCard,
  centreChangeLabel,
  isAreaTogglePath,
  buildProfilePatch,
  buildConnectionsPatch,
  buildAreasPatch,
  buildCustomConnectionsPatch,
  buildCentrePatch,
  applyPatchToDraft,
  businessTypeLabel,
  draftFromProfile,
  type ClientCentreRegistry,
  type CentreDraft,
  type CentreProfile,
} from "./clientCentre";

// ── Registry parity ──────────────────────────────────────────────────────────────────────────────
// `clientCentreRegistry.json` (this package) must be byte-identical to platform-nest's
// `src/modules/clients/centre/registry.json` — both are written by the SAME script
// (`scripts/cmc/registry-v2.mjs`), and the plan calls the nest copy "the single source". Same
// relative-path precedent as `rbac-capability-parity.test.ts` reading platform-nest files from
// platform-ui's test tree.
// `new URL(literal, import.meta.url)` is intercepted by Vite's static asset-URL transform when the
// path is a string LITERAL in the call — it rewrites the expression to a dev-server `http://` asset
// path instead of leaving it as a runtime file:// URL, and `readFileSync` then refuses it ("The URL
// must be of scheme file"). Routing the path through a variable (as `rbac-capability-parity.test.ts`
// already does) is not just style here — it is what keeps this a real filesystem read.
function readFileAt(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("registry parity with platform-nest", () => {
  it("is byte-identical to the nest copy", () => {
    const nestRaw = readFileAt("../../../platform-nest/src/modules/clients/centre/registry.json");
    const uiRaw = readFileAt("./clientCentreRegistry.json");
    expect(uiRaw).toBe(nestRaw);
  });
});

/** Every key that appears anywhere in the registry JSON. */
function keysDeep(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

describe("registry v2 (Business areas)", () => {
  it("is version 2 with 28 section settings entries", () => {
    expect(registry.version).toBe(2);
    expect(Object.keys(registry.sectionSettings)).toHaveLength(28);
  });
  it("has no leaf pages anywhere: no `pages` key, no `departments` keys", () => {
    const keys = keysDeep(registry);
    expect(keys.has("pages")).toBe(false);
    expect(keys.has("departments")).toBe(false);
    expect(keys.has("defaultOffDepartments")).toBe(false);
  });
  it("has 9 areas; only Marketing has sub-areas (19, `se` included)", () => {
    expect(registry.areas.map((a) => a.id)).toEqual(["rs", "mk", "fi", "hr", "lg", "sa", "cs", "it", "op"]);
    expect(registry.areas.filter((a) => a.subAreas).map((a) => a.id)).toEqual(["mk"]);
    const mk = registry.areas.find((a) => a.id === "mk")!;
    expect(mk.subAreas).toHaveLength(19);
    expect(mk.subAreas!.map((s) => s.id)).toContain("se");
  });
  it("every sectionSettings key is an area or a sub-area id", () => {
    const ids = new Set<string>();
    for (const a of registry.areas) { ids.add(a.id); for (const s of a.subAreas ?? []) ids.add(s.id); }
    expect([...Object.keys(registry.sectionSettings)].sort()).toEqual([...ids].sort());
  });
  it("every industry area is {id: 'ix', name, settings}", () => {
    for (const m of Object.values(registry.industryModules)) {
      expect(Object.keys(m).sort()).toEqual(["id", "name", "settings"]);
      expect(m.id).toBe("ix");
    }
  });
});

describe("allAreas / areaEnabled / activeAreas", () => {
  it("prepends the industry area for a business type that has one", () => {
    const areas = allAreas(registry, "hotel");
    expect(areas[0]).toEqual({ id: "ix", name: "Hotel Operations" });
    expect(areas.slice(1)).toEqual(registry.areas);
  });
  it("has no industry area for a business type without one (other)", () => {
    expect(allAreas(registry, "other")).toEqual(registry.areas);
  });
  it("an area not overridden and not in defaultOff is enabled; a default-off one is not", () => {
    expect(areaEnabled(registry, "hotel", {}, "rs")).toBe(true);
    expect(areaEnabled(registry, "agency", {}, "rs")).toBe(false);
  });
  it("an explicit override wins over the default-off list either way", () => {
    expect(areaEnabled(registry, "hotel", { rs: false }, "rs")).toBe(false);
    expect(areaEnabled(registry, "agency", { rs: true }, "rs")).toBe(true);
  });
  it("activeAreas filters allAreas by areaEnabled", () => {
    const active = activeAreas(registry, "hotel", { rs: false });
    expect(active.find((d) => d.id === "rs")).toBeUndefined();
    expect(active.find((d) => d.id === "ix")).toBeDefined();
  });
  it("findArea locates an area by id, including the industry area", () => {
    expect(findArea(registry, "hotel", "ix")?.name).toBe("Hotel Operations");
    expect(findArea(registry, "hotel", "mk")?.name).toBe("Marketing");
    expect(findArea(registry, "other", "ix")).toBeUndefined();
  });
});

describe("allSections / findSection / parentOf", () => {
  it("includes every sub-area alongside its parent area", () => {
    const sections = allSections(registry, "hotel");
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("mk");
    expect(ids).toContain("se"); // SEO sub-area nested under Marketing
    expect(ids).toContain("mk_strat");
    expect(ids).toHaveLength(29);
    // No duplicates, no double-count of the industry area.
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("finds a sub-area by id directly, without needing its parent", () => {
    expect(findSection(registry, "hotel", "se")?.name).toBe("SEO, AEO & GEO");
  });
  it("parentOf resolves a sub-area's owning area, and is idempotent on a top-level id", () => {
    expect(parentOf(registry, "hotel", "se")?.id).toBe("mk");
    expect(parentOf(registry, "hotel", "mk_strat")?.id).toBe("mk");
    expect(parentOf(registry, "hotel", "mk")?.id).toBe("mk");
  });
});

describe("settingsDef / usedBy / groupedFields", () => {
  it("returns the fields/connections list for a section, empty for an unknown one", () => {
    const rs = findArea(registry, "hotel", "rs")!;
    expect(settingsDef(registry, "hotel", rs).fields.length).toBeGreaterThan(0);
    expect(settingsDef(registry, "hotel", { id: "nope", name: "x" })).toEqual({ fields: [], connections: [] });
  });
  it("the industry area's Setup is the business type's own settings: a hotel's `ix` lists the 9 Hotel Operations fields", () => {
    // Before PV6-01 `ix` fell through to the empty default ("0 of 0"; finding 2).
    const ix = findArea(registry, "hotel", "ix")!;
    const def = settingsDef(registry, "hotel", ix);
    expect(def.fields).toEqual(["rooms", "rating", "checkin", "adr", "seasonality", "capacity", "hours", "gm", "reviews"]);
    expect(def.connections).toHaveLength(9);
    expect(settingsDef(registry, "restaurant", { id: "ix", name: "x" }).fields).not.toEqual(def.fields);
    expect(settingsDef(registry, "other", { id: "ix", name: "x" })).toEqual({ fields: [], connections: [] });
  });
  it("sectionStats counts an area's fields and connections against its own definition", () => {
    const ix = findArea(registry, "hotel", "ix")!;
    const stats = sectionStats(registry, "hotel", ix, {
      profile: { rooms: "42", rating: "  " },
      connections: { pms: { status: "Connected" } },
      customConnections: { ix: [{ id: "xixtool1", name: "n" }] },
    });
    expect(stats).toEqual({ fieldsFilled: 1, fieldsTotal: 9, connectionsConnected: 1, connectionsTotal: 10 });
  });
  it("usedBy counts the industry area as a sharer (a field the hotel area shares with Reservations)", () => {
    const others = usedBy(registry, "hotel", "fields", "capacity", "rs");
    expect(others).toContain("Hotel Operations");
  });
  it("usedBy lists every OTHER section sharing a field, excluding the current one", () => {
    // `trading` (Trading name / brand) is used by rs (Reservations) among others.
    const others = usedBy(registry, "hotel", "fields", "trading", "rs");
    expect(others).not.toContain("Reservations");
    expect(others.length).toBeGreaterThan(0);
  });
  it("groupedFields orders keys by fieldGroups' display order and drops unknown keys", () => {
    const grouped = groupedFields(registry, ["trading", "unknown-key-xyz", "legal"]);
    // Both `trading` and `legal` are Identity-group fields — same group, one bucket.
    expect(grouped).toEqual([["Identity", ["trading", "legal"]]]);
  });
});

describe("completion counts", () => {
  it("fieldsFilledCount only counts non-blank values", () => {
    expect(fieldsFilledCount({ a: "x", b: "  ", c: "" }, ["a", "b", "c", "d"])).toBe(1);
  });
  it("connectionIdsFor appends custom connections for that section", () => {
    const def = { fields: [], connections: ["ga4"] };
    const ids = connectionIdsFor("mk", def, { mk: [{ id: "xabc1", name: "Custom" }] });
    expect(ids).toEqual(["ga4", "xabc1"]);
  });
  it("connectionsConnectedCount only counts status === Connected", () => {
    const conns = { ga4: { status: "Connected" }, gsc: { status: "Not connected" } };
    expect(connectionsConnectedCount(conns, ["ga4", "gsc", "missing"])).toBe(1);
  });
});

describe("route model", () => {
  it("parses every segment shape", () => {
    expect(parseSectionRoute(undefined)).toEqual({ kind: "home" });
    expect(parseSectionRoute([])).toEqual({ kind: "home" });
    expect(parseSectionRoute(["company"])).toEqual({ kind: "company" });
    expect(parseSectionRoute(["mk"])).toEqual({ kind: "section", sectionId: "mk", part: "setup" });
    expect(parseSectionRoute(["rs", "connections"])).toEqual({ kind: "section", sectionId: "rs", part: "connections" });
    expect(parseSectionRoute(["se", "connections"])).toEqual({ kind: "section", sectionId: "se", part: "connections" });
    expect(parseSectionRoute(["mk", "results"])).toEqual({ kind: "section", sectionId: "mk", part: "results" });
  });
  it("falls back to home on a malformed or not-yet-built route rather than throwing", () => {
    expect(parseSectionRoute(["mk", "not-a-part"])).toEqual({ kind: "home" });
    expect(parseSectionRoute(["mk", "connections", "extra"])).toEqual({ kind: "home" });
    expect(parseSectionRoute(["mk", "results", "extra"])).toEqual({ kind: "home" });
  });
  it("round-trips through sectionHref", () => {
    const base = "/clients/cl-1/profile";
    for (const segs of [undefined, ["company"], ["mk"], ["rs", "connections"], ["se", "connections"], ["mk_social", "results"]]) {
      const route = parseSectionRoute(segs as string[] | undefined);
      expect(parseSectionRoute(sectionHref(base, route).slice(base.length + 1).split("/").filter(Boolean))).toEqual(route);
    }
  });
  it("builds the documented URLs", () => {
    const base = "/portal/company";
    expect(sectionHref(base, { kind: "section", sectionId: "rs", part: "setup" })).toBe("/portal/company/rs");
    expect(sectionHref(base, { kind: "section", sectionId: "rs", part: "connections" })).toBe("/portal/company/rs/connections");
    expect(sectionHref(base, { kind: "section", sectionId: "rs", part: "results" })).toBe("/portal/company/rs/results");
  });
  it("an old `<area>/settings` and an old leaf `<area>/<n>` redirect to the area's Setup, on both bases", () => {
    expect(legacySectionRedirect("/portal/company", ["rs", "settings"])).toBe("/portal/company/rs");
    expect(legacySectionRedirect("/clients/cl-1/profile", ["mk", "3"])).toBe("/clients/cl-1/profile/mk");
    expect(legacySectionRedirect("/clients/cl-1/profile", ["se", "settings"])).toBe("/clients/cl-1/profile/se");
  });
  it("a current URL is never redirected", () => {
    for (const segs of [undefined, [], ["company"], ["rs"], ["rs", "connections"], ["rs", "settings", "x"], ["a", "b", "c"]]) {
      expect(legacySectionRedirect("/x", segs as string[] | undefined)).toBeNull();
    }
  });
});

describe("patch builders — only changed keys, null/'' deletes", () => {
  it("buildProfilePatch emits only changed keys, deleting on blank", () => {
    const patch = buildProfilePatch({ a: "1", b: "2", c: "3" }, { a: "1", b: "2b", c: "" });
    expect(patch).toEqual({ b: "2b", c: null });
  });
  it("buildProfilePatch emits a brand-new key", () => {
    expect(buildProfilePatch({}, { legal: "Acme Ltd" })).toEqual({ legal: "Acme Ltd" });
  });
  it("buildConnectionsPatch diffs sub-keys and deletes the whole entry when removed", () => {
    const before = { ga4: { status: "Not connected", account: "" } };
    const after = { ga4: { status: "Connected", account: "GA-123" }, gsc: {} } as Record<string, { status?: string; account?: string }>;
    const patch = buildConnectionsPatch(before, after);
    expect(patch.ga4).toEqual({ status: "Connected", account: "GA-123" });
    expect(patch.gsc).toBeUndefined(); // an all-empty entry is not a change worth sending
    const removed = buildConnectionsPatch({ ga4: { status: "Connected" } }, {});
    expect(removed).toEqual({ ga4: null });
  });
  it("buildAreasPatch: null means 'back to default' (key removed), not false", () => {
    expect(buildAreasPatch({ mk: false }, {})).toEqual({ mk: null });
    expect(buildAreasPatch({}, { mk: true })).toEqual({ mk: true });
    expect(buildAreasPatch({ mk: true }, { mk: true })).toEqual({});
  });
  it("buildCustomConnectionsPatch replaces the whole list only when it changed", () => {
    const before = { mk: [{ id: "x1", name: "A" }] };
    const afterSame = { mk: [{ id: "x1", name: "A" }] };
    const afterChanged = { mk: [{ id: "x1", name: "A" }, { id: "x2", name: "B" }] };
    expect(buildCustomConnectionsPatch(before, afterSame)).toEqual({});
    expect(buildCustomConnectionsPatch(before, afterChanged)).toEqual({ mk: afterChanged.mk });
  });
  it("buildCentrePatch composes all four and returns null when nothing changed", () => {
    const draft: CentreDraft = {
      businessType: "hotel", profile: { legal: "Acme" }, connections: {}, areas: {}, customConnections: {},
    };
    expect(buildCentrePatch(draft, { ...draft })).toBeNull();
    const changed = buildCentrePatch(draft, { ...draft, businessType: "restaurant", profile: { legal: "" } });
    expect(changed).toEqual({ businessType: "restaurant", profile: { legal: null } });
  });
  it("applyPatchToDraft is the inverse merge buildCentrePatch expects", () => {
    const draft: CentreDraft = {
      businessType: "hotel", profile: { legal: "Acme" }, connections: { ga4: { status: "Not connected" } },
      areas: {}, customConnections: {},
    };
    const patch = buildCentrePatch(draft, {
      ...draft, profile: { legal: "Acme Ltd" }, connections: { ga4: { status: "Connected" } }, areas: { mk: false },
    })!;
    const applied = applyPatchToDraft(draft, patch);
    expect(applied.profile.legal).toBe("Acme Ltd");
    expect(applied.connections.ga4.status).toBe("Connected");
    expect(applied.areas.mk).toBe(false);
    // Round trip: diffing draft -> applied now yields nothing further to send.
    expect(buildCentrePatch(draft, applied)).toEqual(patch);
  });
});

describe("draftFromProfile", () => {
  it("produces an independent, deep-enough copy (mutating it never touches the source profile)", () => {
    const profile: CentreProfile = {
      clientId: "cl-1", clientName: "Demo Harbour Hotel", clientStatus: "active", businessType: "hotel",
      profile: { legal: "Demo Harbour Hotel Ltd" },
      connections: { ga4: { status: "Connected" } },
      areas: {},
      customConnections: { mk: [{ id: "x1", name: "Custom" }] },
      revision: 1, updatedAt: null, updatedBy: null, canEdit: true,
    };
    const draft = draftFromProfile(profile);
    draft.profile.legal = "Changed";
    draft.connections.ga4.status = "Not connected";
    draft.customConnections.mk[0].name = "Changed";
    expect(profile.profile.legal).toBe("Demo Harbour Hotel Ltd");
    expect(profile.connections.ga4.status).toBe("Connected");
    expect(profile.customConnections.mk[0].name).toBe("Custom");
  });
});

describe("History labels (PV6-01 finding 4)", () => {
  it("shows a field's label, a connection's name, and the business type, never the raw path", () => {
    expect(centreChangeLabel(registry, "profile.city")).toBe(registry.fields.city.label);
    expect(centreChangeLabel(registry, "connections.ga4")).toBe(registry.connections.ga4.name);
    expect(centreChangeLabel(registry, "businessType")).toBe("Business type");
    expect(centreChangeLabel(registry, "connections.xabcd1")).toBe("Custom connection");
  });
  it("labels both `areas.<id>` and an old `departments.<id>` row as a Business area", () => {
    expect(centreChangeLabel(registry, "areas.rs")).toBe("Business area Reservations");
    expect(centreChangeLabel(registry, "departments.rs")).toBe("Business area Reservations");
    expect(centreChangeLabel(registry, "areas.mk")).toBe("Business area Marketing");
    expect(centreChangeLabel(registry, "areas.ix")).toBe("Business area Industry area");
    expect(isAreaTogglePath("areas.rs")).toBe(true);
    expect(isAreaTogglePath("departments.rs")).toBe(true);
    expect(isAreaTogglePath("profile.city")).toBe(false);
  });
  it("falls back to the key, never to an empty label", () => {
    expect(centreChangeLabel(registry, "profile.nope")).toBe("nope");
    expect(centreChangeLabel(registry, "areas.zzz")).toBe("Business area zzz");
  });
});

describe("businessTypeLabel", () => {
  it("looks up the label, falling back to Other", () => {
    expect(businessTypeLabel(registry, "hotel")).toBe("Hotel / villa / accommodation");
    expect(businessTypeLabel(registry, "not-a-real-type")).toBe("Other");
  });
});

// Type-only smoke check that the imported registry satisfies its declared shape.
const _typeCheck: ClientCentreRegistry = registry;
void _typeCheck;

describe("Services & results helpers (PV6-03)", () => {
  const card = (service: ResultsServiceCard["service"], areaId: string, status: ResultsServiceCard["status"] = "active"): ResultsServiceCard => ({
    service, areaId, title: service, status, since: null, items: [], kpis: [], clientVisible: true,
  });
  const results = (services: ResultsServiceCard[], over: Partial<BusinessResults> = {}): BusinessResults => ({
    clientId: "cl-1", generatedAt: "2026-10-13T00:00:00Z", visible: true, services, unavailable: [], ...over,
  });

  it("kpiChange: up, down, flat; a missing previous or value is `none`, never a change against 0", () => {
    expect(kpiChange({ value: 12, previous: 10 })).toEqual({ direction: "up", delta: 2 });
    expect(kpiChange({ value: 8, previous: 10 })).toEqual({ direction: "down", delta: -2 });
    expect(kpiChange({ value: 10, previous: 10 })).toEqual({ direction: "flat", delta: 0 });
    expect(kpiChange({ value: 10, previous: null })).toEqual({ direction: "none" });
    expect(kpiChange({ value: null, previous: 10 })).toEqual({ direction: "none" });
    expect(kpiChange({ value: 0, previous: 5 })).toEqual({ direction: "down", delta: -5 }); // a real zero is a figure
  });
  it("targetMet: null without a target or a figure; a lower position is better", () => {
    expect(targetMet({ value: 10, target: 8, unit: "count" })).toBe(true);
    expect(targetMet({ value: 7, target: 8, unit: "count" })).toBe(false);
    expect(targetMet({ value: 3, target: 5, unit: "position" })).toBe(true);
    expect(targetMet({ value: 9, target: 5, unit: "position" })).toBe(false);
    expect(targetMet({ value: null, target: 5, unit: "count" })).toBeNull();
    expect(targetMet({ value: 5, target: null, unit: "count" })).toBeNull();
  });
  it("cardsForSection: Marketing rolls up its sub-areas; a sub-area shows only its own", () => {
    const r = results([card("social", "mk_social"), card("search", "se"), card("website", "mk_web")]);
    const mk = findArea(registry, "hotel", "mk")!;
    expect(cardsForSection(r, mk).map((c) => c.areaId)).toEqual(["mk_social", "se", "mk_web"]);
    expect(cardsForSection(r, findSection(registry, "hotel", "se")!).map((c) => c.areaId)).toEqual(["se"]);
    expect(cardsForSection(r, findArea(registry, "hotel", "rs")!)).toEqual([]);
  });
  it("runningServicesByArea counts only active services, per owning area, from one read; hidden or absent reads count nothing", () => {
    const r = results([card("social", "mk_social"), card("search", "se"), card("search_ads", "mk_paid", "paused")]);
    expect(runningServicesByArea(registry, "hotel", r)).toEqual({ mk: 2 });
    expect(runningServicesByArea(registry, "hotel", results(r.services, { visible: false }))).toEqual({});
    expect(runningServicesByArea(registry, "hotel", null)).toEqual({});
    expect(runningServicesByArea(registry, "hotel", undefined)).toEqual({});
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COVERAGE, gmHiddenSections, keepsSection, type CoverageEntry, type LegacyPage,
} from "./overviewCoverage";
import {
  WORKSPACES, GENERIC_WORKSPACE, hrefFor, isPlanned, sidebarRows, type Gate, type Workspace, type WorkspaceTab,
} from "./workspaces";
import { workLinks } from "./overviewWork";

// DW-3z: the inventory of what stays under the Overview (plan §3.8) is data, and each claim in it is pinned here to the registry:
// a "covered" section names an Overview block that is built and placed for every workspace the page renders for, and a "reachable"
// one names registry tabs that exist (and a page file that serves them). The pages' own `keeps(...)` calls are tied back to it.

const APP = resolve(__dirname, "../app/(app)");
const GM = WORKSPACES.find((w) => w.key === "gm")!;
const bySlug = (key: string) => WORKSPACES.find((w) => w.key === key)!;

/** The workspaces each legacy page renders for. */
const RENDERS_FOR: Record<LegacyPage, readonly Workspace[]> = {
  "department-home": [...WORKSPACES.filter((w) => w.kind === "department"), GENERIC_WORKSPACE],
  "gm-cockpit": [GM],
  hr: [bySlug("hr")],
  finance: [bySlug("finance")],
  it: [bySlug("it")],
};

/** The source files whose section ids must match the inventory. */
const SOURCES: Record<LegacyPage, readonly string[]> = {
  "department-home": ["departments/[deptId]/page.tsx"],
  "gm-cockpit": ["../../components/departments/gm/GmCockpit.tsx"],
  hr: ["hr/page.tsx"],
  finance: ["finance/page.tsx"],
  it: ["it/page.tsx"],
};

const tabsOf = (ws: Workspace): WorkspaceTab[] => {
  const m = sidebarRows(ws);
  return [...m.top, ...m.work, ...m.performance, ...m.you].flatMap((r) => r.tabs);
};
const rowGateOf = (ws: Workspace, tab: WorkspaceTab): Gate | undefined =>
  [...sidebarRows(ws).work].find((r) => r.tabs.includes(tab))?.gate;
const moduleOnly = (g: Gate | undefined): boolean => g === undefined || g.kind === "module";
const pageFile = (href: string): string =>
  resolve(APP, `.${href.split(/[?#]/)[0].replaceAll("{dept}", "[deptId]").replaceAll("{company}", "[companyId]")}`, "page.tsx");

// DW-7a/7b: three tabs a card's verdict names are gated on what their own page reads, so a person who lacks it is offered
// neither the tab nor the card (the card was a link to a page that only refuses them). Pinned exactly, so no other tab
// slips past "no stricter gate than the module".
const READ_GATED: Record<string, Gate> = {
  "/hr/people": { kind: "any", gates: [{ kind: "cap", cap: "people.directory" }, { kind: "elevated" }] },
  "/hr/onboarding": { kind: "cap", cap: "hr.view" },
  "/finance/receivables": { kind: "cap", cap: "finance.ar.view" },
};

const PAGES = [...new Set(COVERAGE.map((e) => e.page))] as LegacyPage[];
const entriesOf = (page: LegacyPage): CoverageEntry[] => COVERAGE.filter((e) => e.page === page);

describe("the coverage inventory (plan §3.8)", () => {
  it("has every page, one entry per section, and a reason for each", () => {
    expect(PAGES.sort()).toEqual(["department-home", "finance", "gm-cockpit", "hr", "it"]);
    const keys = COVERAGE.map((e) => `${e.page}/${e.section}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of COVERAGE) expect(e.by.length, `${e.page}/${e.section}`).toBeGreaterThan(20);
  });

  it("a covered section names its Overview block and a reachable one its tabs: nothing else carries either", () => {
    for (const e of COVERAGE) {
      const k = `${e.page}/${e.section}`;
      if (e.verdict === "covered") expect(e.widget, k).toBeTruthy();
      if (e.verdict === "reachable") expect(e.hrefs?.length, k).toBeGreaterThan(0);
      if (e.verdict === "stays") { expect(e.widget, k).toBeUndefined(); expect(e.hrefs, k).toBeUndefined(); expect(e.when, k).toBeUndefined(); }
    }
  });

  it("every Overview block a verdict names is built and placed in each workspace the page renders for", () => {
    for (const e of COVERAGE.filter((x) => x.widget)) {
      for (const ws of RENDERS_FOR[e.page]) {
        const w = ws.overview.find((o) => o.key === e.widget);
        expect(w, `${e.page}/${e.section} -> ${e.widget} in ${ws.key}`).toBeDefined();
        expect(isPlanned(w!), `${e.page}/${e.section} -> ${e.widget} in ${ws.key}`).toBe(false);
      }
    }
  });

  it("every tab a verdict names exists in each workspace the page renders for, behind no stricter gate than the module (bar the three tabs gated on their page's own read), and its page is served", () => {
    for (const e of COVERAGE.filter((x) => x.hrefs)) {
      for (const href of e.hrefs!) {
        expect(existsSync(pageFile(href)), `${e.page}/${e.section}: no page file for ${href}`).toBe(true);
        for (const ws of RENDERS_FOR[e.page]) {
          const tab = tabsOf(ws).find((t) => t.href === href);
          expect(tab, `${e.page}/${e.section}: ${href} in ${ws.key}`).toBeDefined();
          expect(tab!.ticket, `${href} in ${ws.key}`).toBeUndefined();
          if (href in READ_GATED) expect(tab!.gate, `${href} tab gate in ${ws.key}`).toEqual(READ_GATED[href]);
          else expect(moduleOnly(tab!.gate), `${href} tab gate in ${ws.key}`).toBe(true);
          expect(moduleOnly(rowGateOf(ws, tab!)), `${href} row gate in ${ws.key}`).toBe(true);
        }
      }
    }
  });

  it("Project health leaves because the Projects block links to the rest: every department workspace, the generic one included", () => {
    const e = COVERAGE.find((x) => x.page === "department-home" && x.section === "project-health")!;
    for (const ws of RENDERS_FOR["department-home"]) {
      expect(workLinks({ workspaceKey: ws.key, deptId: "d-1" }).projects, ws.key).toBe(hrefFor(e.hrefs![0], { deptId: "d-1" }));
    }
  });

  it("the Company block carries the links its covered cockpit sections lean on: the Company report and Finance's statements", () => {
    const src = readFileSync(resolve(APP, "../../components/overview/widgets/Company.tsx"), "utf8");
    expect(src).toContain("/reports/company");
    expect(src).toContain('financeHref="/finance/reports"');
    expect(tabsOf(bySlug("finance")).some((t) => t.href === "/finance/reports")).toBe(true);
    expect(GM.ownedRoutes).toContain("/reports/company");
  });

  it("the pages' own section ids are the inventory's, both ways", () => {
    const used = (page: LegacyPage): Set<string> => {
      const ids = new Set<string>();
      for (const rel of SOURCES[page]) {
        const src = readFileSync(resolve(APP, rel), "utf8");
        for (const m of src.matchAll(/(?:keeps|shows)\("([a-z-]+)"\)|section: "([a-z-]+)"/g)) ids.add(m[1] ?? m[2]);
      }
      return ids;
    };
    for (const page of PAGES) {
      const inventory = entriesOf(page);
      const removable = inventory.filter((e) => e.verdict !== "stays").map((e) => e.section).sort();
      const wired = [...used(page)].filter((id) => inventory.some((e) => e.section === id)).sort();
      // Everything the inventory lets go is wired in the page, and the page wires nothing the inventory does not name.
      for (const s of removable) expect(wired, `${page}/${s} is not wired in the page`).toContain(s);
      for (const id of [...used(page)]) {
        const hit = inventory.find((e) => e.section === id);
        expect(hit && hit.verdict !== "stays", `${page}/${id} is removed in the page but not inventoried as covered or reachable`).toBe(true);
      }
    }
  });
});

describe("DW-7e-3: what the new Pulse tiles cover", () => {
  const tiles = (slug: string) => bySlug(slug).pulse.filter((t) => t.source);
  const sources = (slug: string) => tiles(slug).map((t) => t.source);
  const PULSE = readFileSync(resolve(APP, "../../components/overview/widgets/Pulse.tsx"), "utf8");

  it("only the Finance close gate leaves: Pulse's Close progress reads the current period and links the Close tab", () => {
    const e = COVERAGE.find((x) => x.page === "finance" && x.section === "close-readiness")!;
    expect(e.verdict).toBe("covered");
    expect(e.widget).toBe("pulse");
    const tile = bySlug("finance").pulse.find((t) => t.source === "finance-close-progress")!;
    expect(tile.ticket).toBeUndefined();
    expect(e.hrefs).toContain(tile.href);
    // The tile's reader takes the period that contains today, as the card did.
    expect(PULSE).toMatch(/"finance-close-progress":[\s\S]*?currentPeriod\(/);
    expect(keepsSection("finance", "close-readiness", { framed: true })).toBe(false);
    expect(keepsSection("finance", "close-readiness", { framed: false })).toBe(true);
  });

  it("everything else the tiles touch stays: no tile shows the same information as a whole section", () => {
    // Every section below is something a tile only partly shows: HR's four counts (two have no tile), Finance's four totals
    // (no tile shows one), the Integrity verdicts (the tile is the number of failures), IT's five counts (only Offline).
    expect(sources("hr")).toEqual(expect.arrayContaining(["hr-leave-pending", "hr-cases-open"]));
    expect(sources("it")).toContain("it-devices-offline");
    expect(sources("finance")).toContain("finance-integrity-findings");
    for (const [page, section] of [["hr", "kpis"], ["finance", "kpis"], ["finance", "integrity"], ["it", "kpis"]] as const) {
      const e = COVERAGE.find((x) => x.page === page && x.section === section)!;
      expect(e.verdict, `${page}/${section}`).toBe("stays");
      expect(e.by, `${page}/${section}`).toContain("DW-7e-3");
    }
  });

  it("the Integrity tile links to /finance, the page that is the only place listing the failing checks", () => {
    expect(bySlug("finance").pulse.find((t) => t.source === "finance-integrity-findings")!.href).toBe("/finance");
  });
});

describe("keepsSection", () => {
  it("keeps everything for a classic page, whatever the inventory says", () => {
    for (const e of COVERAGE) expect(keepsSection(e.page, e.section, { framed: false, access: { numbers: true, money: true } }), `${e.page}/${e.section}`).toBe(true);
  });

  it("under the frame drops exactly the covered and reachable sections, and keeps what stays and what it does not know", () => {
    const all = { numbers: true, money: true };
    for (const e of COVERAGE) expect(keepsSection(e.page, e.section, { framed: true, access: all }), `${e.page}/${e.section}`).toBe(e.verdict === "stays");
    expect(keepsSection("department-home", "something-new", { framed: true })).toBe(true);
  });

  it("keeps the HR counts and note, the Finance integrity verdicts and totals, the IT page whole, the Home's Team and KPIs", () => {
    for (const [page, section] of [
      ["hr", "kpis"], ["hr", "scope-note"], ["finance", "kpis"], ["finance", "integrity"],
      ["it", "kpis"], ["it", "device-events"], ["department-home", "kpis"], ["department-home", "team"], ["department-home", "serviced"],
      ["gm-cockpit", "monitoring"], ["gm-cockpit", "narrowed-notice"],
    ] as const) expect(keepsSection(page, section, { framed: true, access: { numbers: true, money: true } }), `${page}/${section}`).toBe(true);
  });

  it("drops the cockpit's sections only for the person the Overview block is placed for", () => {
    expect(gmHiddenSections({ numbers: true, money: true })).toEqual(["provenance", "business", "departments", "money"]);
    expect(gmHiddenSections({ numbers: true, money: false })).toEqual(["provenance", "business", "departments"]);
    // A department lead (narrowed): no company blocks, so the strip and its line stay; money only if the Company block draws it.
    expect(gmHiddenSections({ numbers: false, money: true })).toEqual(["money"]);
    expect(gmHiddenSections({ numbers: false, money: false })).toEqual([]);
  });

  it("without any access given, a conditional section stays", () => {
    expect(keepsSection("gm-cockpit", "business", { framed: true })).toBe(true);
    expect(keepsSection("gm-cockpit", "money", { framed: true })).toBe(true);
  });
});

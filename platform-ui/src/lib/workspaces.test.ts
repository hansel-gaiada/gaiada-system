import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKS } from "./packs";
import { bespokeToolkit, deptTabs } from "./deptToolkits";
import {
  WORKSPACES, GENERIC_WORKSPACE, PERFORMANCE_ROWS, YOU_ROWS, COMPANY_ROWS, ADMIN_ROWS, TOOLS_ROW,
  OVERVIEW_BANDS, REPORT_PERIODS, workspaceFor, workspaceBySlug, hrefFor, isPlanned, sidebarRows,
  type Gate, type Workspace, type WorkspaceRow, type WorkspaceTab,
} from "./workspaces";

const APP = resolve(__dirname, "../app/(app)");
const ALL = [...WORKSPACES, GENERIC_WORKSPACE];

function rowsOf(ws: Workspace): WorkspaceRow[] {
  const m = sidebarRows(ws);
  return [...m.top, ...m.work, ...m.performance, ...m.you];
}
function tabsOf(rows: readonly WorkspaceRow[]): WorkspaceTab[] {
  return rows.flatMap((r) => r.tabs);
}
function hrefsOf(ws: Workspace): Set<string> {
  return new Set([...tabsOf(rowsOf(ws)).map((t) => t.href), ...ws.quickActions.map((a) => a.href)]);
}
/** Every registry row, with the gate of the row it sits in. */
function everyRow(): WorkspaceRow[] {
  return [...ALL.flatMap(rowsOf), ...COMPANY_ROWS, ...ADMIN_ROWS];
}
function gateMentions(gate: Gate | undefined, pred: (g: Gate) => boolean): boolean {
  if (!gate) return false;
  if (pred(gate)) return true;
  if (gate.kind === "all" || gate.kind === "any") return gate.gates.some((g) => gateMentions(g, pred));
  return false;
}
/** The page file an href lands on: `{dept}` is `[deptId]`, `{company}` is `[companyId]`. */
function pageFile(href: string): string {
  const path = href.split(/[?#]/)[0].replaceAll("{dept}", "[deptId]").replaceAll("{company}", "[companyId]");
  return resolve(APP, `.${path}`, "page.tsx");
}
/** Static page routes under a console's folder (dynamic record pages excluded). */
function staticRoutes(prefix: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const dir = resolve(APP, `.${rel}`);
    if (existsSync(resolve(dir, "page.tsx"))) out.push(rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith("[")) walk(`${rel}/${entry.name}`);
    }
  };
  walk(prefix);
  return out;
}

describe("the registry's shape", () => {
  it("has one workspace per key", () => {
    const keys = ALL.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every workspace the same skeleton (plan §2.2)", () => {
    for (const ws of ALL) {
      const m = sidebarRows(ws);
      expect(m.top.map((r) => r.key), ws.key).toEqual(["overview", "assistant"]);
      expect(m.work.at(-1), ws.key).toBe(TOOLS_ROW);
      expect(m.performance.map((r) => r.key), ws.key).toEqual(["reports", "analytics", "appraisals", "learning"]);
      expect(m.you, ws.key).toBe(YOU_ROWS);
    }
  });

  it("keeps keys unique: rows per block, tabs per row, tiles, actions and KPIs per workspace", () => {
    const unique = (keys: string[], what: string) => expect(new Set(keys).size, what).toBe(keys.length);
    for (const ws of ALL) {
      const m = sidebarRows(ws);
      for (const [name, block] of Object.entries(m)) unique(block.map((r: WorkspaceRow) => r.key), `${ws.key} ${name}`);
      for (const row of rowsOf(ws)) unique(row.tabs.map((t) => t.key), `${ws.key}/${row.key}`);
      unique(ws.pulse.map((p) => p.key), `${ws.key} pulse`);
      unique(ws.quickActions.map((a) => a.key), `${ws.key} actions`);
      unique(ws.kpis.map((k) => k.key), `${ws.key} kpis`);
      unique(ws.overview.map((w) => w.key), `${ws.key} overview`);
    }
    for (const [name, rows] of [["company", COMPANY_ROWS], ["admin", ADMIN_ROWS]] as const) {
      unique(rows.map((r) => r.key), name);
      for (const row of rows) unique(row.tabs.map((t) => t.key), `${name}/${row.key}`);
    }
  });

  it("uses absolute hrefs everywhere", () => {
    for (const row of everyRow()) for (const tab of row.tabs) expect(tab.href.startsWith("/"), `${row.key}/${tab.key}`).toBe(true);
    for (const ws of ALL) for (const a of ws.quickActions) expect(a.href.startsWith("/"), `${ws.key}/${a.key}`).toBe(true);
  });

  it("names no company (PV-D13)", () => {
    expect(readFileSync(resolve(__dirname, "workspaces.ts"), "utf8")).not.toMatch(/gaiada/i);
  });
});

describe("URLs never move (plan §2.6)", () => {
  // A tab or action that is not planned must land on a page that exists today. A planned one carries the
  // ticket that builds it, and the shell never renders it.
  it("points every built tab and quick action at an existing page file", () => {
    const missing: string[] = [];
    for (const row of everyRow()) {
      if (isPlanned(row)) continue;
      for (const tab of row.tabs) if (!isPlanned(tab) && !existsSync(pageFile(tab.href))) missing.push(`${row.key}/${tab.key} -> ${tab.href}`);
    }
    for (const ws of ALL) {
      for (const a of ws.quickActions) if (!isPlanned(a) && !existsSync(pageFile(a.href))) missing.push(`${ws.key} action ${a.key} -> ${a.href}`);
      if (!existsSync(pageFile(ws.overviewHref))) missing.push(`${ws.key} overview -> ${ws.overviewHref}`);
    }
    expect(missing).toEqual([]);
  });

  it("names a DW ticket on everything not built yet", () => {
    const tickets: string[] = [];
    for (const row of everyRow()) {
      if (row.ticket) tickets.push(row.ticket);
      for (const tab of row.tabs) if (tab.ticket) tickets.push(tab.ticket);
    }
    for (const ws of ALL) {
      for (const x of [...ws.overview, ...ws.pulse, ...ws.quickActions, ...ws.connections]) if (x.ticket) tickets.push(x.ticket);
    }
    expect(tickets.length).toBeGreaterThan(0);
    for (const t of tickets) expect(t).toMatch(/^DW-\d+[a-z]?\b/);
  });
});

describe("nothing loses its home (plan §2.6 rule 1)", () => {
  it("carries every tab of every agency toolkit into its workspace", () => {
    for (const slug of PACKS.agency.toolkitDepartments) {
      const ws = workspaceBySlug(slug);
      expect(ws, slug).toBeDefined();
      const hrefs = hrefsOf(ws!);
      for (const tab of deptTabs(bespokeToolkit(slug)!)) {
        const href = tab.path ? `/departments/{dept}/${tab.path}` : "/departments/{dept}";
        expect(hrefs.has(href), `${slug}/${tab.key} (${href})`).toBe(true);
      }
    }
  });

  it.each([
    ["hr", "/hr"],
    ["finance", "/finance"],
    ["it", "/it"],
  ])("carries every page of the %s console", (slug, prefix) => {
    const hrefs = hrefsOf(workspaceBySlug(slug)!);
    for (const route of staticRoutes(prefix)) expect(hrefs.has(route), route).toBe(true);
  });

  it("owns the routes outside /departments that only one workspace uses", () => {
    expect(workspaceBySlug("web-dev")!.ownedRoutes).toEqual(["/pipeline", "/monitoring"]);
    expect(workspaceBySlug("hr")!.ownedRoutes).toEqual(["/hr", "/appraisals/cycles"]);
    expect(workspaceBySlug("finance")!.ownedRoutes).toEqual(["/finance", "/invoices", "/billing"]);
    expect(workspaceBySlug("it")!.ownedRoutes).toEqual(["/it"]);
    expect(workspaceBySlug("gm")!.ownedRoutes).toEqual(["/reports/company"]);
  });
});

describe("gates are carried as data, unchanged (plan §2.6 rule 4)", () => {
  const tab = (rows: readonly WorkspaceRow[], rowKey: string, tabKey: string) => {
    const row = rows.find((r) => r.key === rowKey)!;
    return { row, tab: row.tabs.find((t) => t.key === tabKey)! };
  };

  it("keeps nav.ts's agency-row gate on every row it gates today", () => {
    const AGENCY_ROWS: Record<string, string> = {
      "/clients": "clients", "/deliverables": "deliverables", "/timesheets": "timesheets", "/invoices": "invoices",
      "/agency": "agency", "/meetings": "meetings", "/pipeline": "pipeline", "/monitoring": "monitoring",
    };
    for (const row of everyRow()) {
      for (const t of row.tabs) {
        const key = AGENCY_ROWS[t.href];
        if (!key) continue;
        const gated = [t.gate, row.gate].some((g) => gateMentions(g, (x) => x.kind === "agencyRow" && x.row === key));
        expect(gated, `${row.key}/${t.key} -> ${t.href}`).toBe(true);
      }
    }
  });

  it("keeps the toolkit's requires gate on Visitors", () => {
    const { tab: visitors } = tab(workspaceBySlug("web-dev")!.work, "website", "visitors");
    expect(visitors.gate).toEqual({ kind: "cap", cap: "search.visitors.read" });
  });

  it("keeps Invoices behind company.manage, as Business › Invoices is today", () => {
    const { tab: invoices } = tab(workspaceBySlug("finance")!.work, "receivables", "invoices");
    expect(gateMentions(invoices.gate, (g) => g.kind === "cap" && g.cap === "company.manage")).toBe(true);
  });

  it("keeps HR's Pay row behind hr.payroll.view and every HR row behind the hr module", () => {
    const hr = workspaceBySlug("hr")!;
    const pay = hr.work.find((r) => r.key === "pay")!;
    expect(gateMentions(pay.gate, (g) => g.kind === "cap" && g.cap === "hr.payroll.view")).toBe(true);
    for (const row of hr.work.filter((r) => r.key !== "pm")) {
      expect(gateMentions(row.gate, (g) => g.kind === "module" && g.module === "hr"), row.key).toBe(true);
    }
  });

  it("gives heads their unit views through unitCap only (DW-D15), never a wider company gate", () => {
    const learning = PERFORMANCE_ROWS.find((r) => r.key === "learning")!;
    expect(learning.tabs.find((t) => t.key === "add")!.gate).toEqual({ kind: "unitCap", cap: "lms.authoring" });
    expect(learning.tabs.find((t) => t.key === "team")!.gate).toEqual({ kind: "unitCap", cap: "lms.progress.view" });
    expect(learning.tabs.find((t) => t.key === "mine")!.gate).toBeUndefined();
    const team = PERFORMANCE_ROWS.find((r) => r.key === "appraisals")!.tabs.find((t) => t.key === "team")!;
    expect(gateMentions(team.gate, (g) => g.kind === "cap" && g.cap === "appraisal.score")).toBe(true);
    expect(gateMentions(team.gate, (g) => g.kind === "unitCap" && g.cap === "appraisal.read")).toBe(true);
  });

  it("keeps the Admin area's gates from nav.ts", () => {
    expect(ADMIN_ROWS.map((r) => [r.key, r.gate])).toEqual([
      ["settings", { kind: "cap", cap: "admin.access" }],
      ["group", { kind: "rootGroup" }],
      ["platform", { kind: "platformOperator" }],
    ]);
  });
});

describe("workspaceFor", () => {
  it("gives an agency company its bespoke workspaces", () => {
    expect(workspaceFor("agency", "Web Dev").key).toBe("web-dev");
    expect(workspaceFor("agency", "Social Media").key).toBe("social-media");
    expect(workspaceFor("agency", "GM").kind).toBe("office");
  });

  it("gives the same department name in another vertical the generic workspace, under its own name (PV-D15)", () => {
    const ws = workspaceFor("hospitality", "Web Dev");
    expect(ws.key).toBe("generic");
    expect(ws.label).toBe("Web Dev");
    expect(workspaceFor(null, "Housekeeping").label).toBe("Housekeeping");
  });

  it("gives HR, Finance and IT their functional workspaces in every vertical", () => {
    for (const vertical of ["agency", "hospitality", "general", null]) {
      expect(workspaceFor(vertical, "HR").key).toBe("hr");
      expect(workspaceFor(vertical, "Finance").key).toBe("finance");
      expect(workspaceFor(vertical, "IT").key).toBe("it");
    }
  });
});

describe("hrefFor", () => {
  it("fills the department and company ids", () => {
    expect(hrefFor("/departments/{dept}/board", { deptId: "d-web" })).toBe("/departments/d-web/board");
    expect(hrefFor("/companies/{company}/org", { companyId: "co-1" })).toBe("/companies/co-1/org");
    expect(hrefFor("/hr/leave", {})).toBe("/hr/leave");
  });

  it("returns null when an id is missing, so the link is not offered", () => {
    expect(hrefFor("/departments/{dept}/board", { deptId: null })).toBeNull();
    expect(hrefFor("/companies/{company}/org", {})).toBeNull();
  });

  it("encodes the ids", () => {
    expect(hrefFor("/departments/{dept}", { deptId: "a/b" })).toBe("/departments/a%2Fb");
  });
});

describe("the Overview, Performance and tools data", () => {
  it("lists Overview widgets in the fixed band order (plan §3.1)", () => {
    for (const ws of ALL) {
      const order = ws.overview.map((w) => OVERVIEW_BANDS.indexOf(w.band));
      expect(order, ws.key).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("offers all six report periods, none waiting on a ticket (DW-4a built them in the backend)", () => {
    expect(REPORT_PERIODS.map((p) => p.key)).toEqual(["day", "week", "month", "quarter", "semester", "year"]);
    expect(REPORT_PERIODS.filter((p) => p.ticket)).toEqual([]);
  });

  it("gives every workspace a KPI starting set (plan §5.5)", () => {
    for (const ws of ALL) expect(ws.kpis.length, ws.key).toBeGreaterThanOrEqual(3);
  });

  it("holds each department's tool set (plan §4.1)", () => {
    const tools = Object.fromEntries(ALL.map((w) => [w.key, w.tools.map((t) => t.key)]));
    expect(tools).toEqual({
      "web-dev": ["claude-code", "claude", "claude-design", "github", "figma", "vscode"],
      seo: ["gsc", "ga4", "google-ads", "looker", "claude"],
      "social-media": ["claude", "claude-design", "drive"],
      creatives: ["figma", "photopea", "claude-design", "drive"],
      gm: ["claude", "drive", "looker"],
      hr: ["drive", "claude"],
      finance: ["drive", "claude"],
      it: ["unifi", "google-admin", "n8n"],
      generic: [],
    });
  });
});

describe("a workspace's own create actions (DW-2f)", () => {
  it("names only quickActions the workspace has", () => {
    for (const ws of ALL) {
      for (const key of ws.creates) expect(ws.quickActions.map((a) => a.key), `${ws.key} creates ${key}`).toContain(key);
    }
  });
});

// DW-2h: the assistant's empty state suggests prompts for the department it was opened from.
describe("assistant prompts (DW-2h)", () => {
  it.each(ALL.map((w) => [w.key, w] as const))("%s has 3 to 4 starter prompts, each with a label and a prompt", (_key, ws) => {
    expect(ws.assistantPrompts.length).toBeGreaterThanOrEqual(3);
    expect(ws.assistantPrompts.length).toBeLessThanOrEqual(4);
    for (const p of ws.assistantPrompts) {
      expect(p.label.trim()).not.toBe("");
      expect(p.prompt.trim()).not.toBe("");
    }
    expect(new Set(ws.assistantPrompts.map((p) => p.label)).size).toBe(ws.assistantPrompts.length);
  });

  it("covers every workspace, and keeps the plan's own examples", () => {
    expect(ALL.map((w) => w.key).sort()).toEqual(["creatives", "finance", "generic", "gm", "hr", "it", "seo", "social-media", "web-dev"]);
    expect(workspaceBySlug("web-dev")!.assistantPrompts.map((p) => p.label)).toContain("Summarise this week's requests");
    expect(workspaceBySlug("seo")!.assistantPrompts.map((p) => p.label)).toContain("Which keywords dropped?");
  });

  it("the generic workspace's prompts come with every department that has no workspace of its own", () => {
    expect(workspaceFor("agency", "Brand Studio").assistantPrompts).toEqual(GENERIC_WORKSPACE.assistantPrompts);
  });
});

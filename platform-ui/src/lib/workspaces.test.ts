import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKS } from "./packs";
import { bespokeToolkit, deptTabs } from "./deptToolkits";
import {
  WORKSPACES, GENERIC_WORKSPACE, PERFORMANCE_ROWS, YOU_ROWS, COMPANY_ROWS, ADMIN_ROWS, TOOLS_ROW,
  OVERVIEW_BANDS, REPORT_PERIODS, workspaceFor, workspaceBySlug, hrefFor, isPlanned, sidebarRows, departmentOverviewHref, deptCalendarTab,
  type Gate, type Workspace, type WorkspaceRow, type WorkspaceTab,
} from "./workspaces";
import { SKINS } from "./skins";
import { SKIN_PERSONAS, modelFor } from "./skinTestKit";

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
      expect(m.performance.map((r) => r.key), ws.key).toEqual(["performance", "reports", "analytics", "appraisals", "learning"]);
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

  it("names a DW or SCP ticket on everything not built yet", () => {
    const tickets: string[] = [];
    for (const row of everyRow()) {
      if (row.ticket) tickets.push(row.ticket);
      for (const tab of row.tabs) if (tab.ticket) tickets.push(tab.ticket);
    }
    for (const ws of ALL) {
      for (const x of [...ws.overview, ...ws.pulse, ...ws.quickActions, ...ws.connections]) if (x.ticket) tickets.push(x.ticket);
    }
    expect(tickets.length).toBeGreaterThan(0);
    for (const t of tickets) expect(t).toMatch(/^(DW|SCP)-\d+[a-z]?\b/);
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

  it("PV7-05: every Clients row (the GM's Clients & sales and the department Clients row) has a Health tab at /clients/health under the same gate, and the Clients tab is unchanged", () => {
    const rows = everyRow().filter((r) => r.tabs.some((t) => t.href === "/clients"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const clients = row.tabs.find((t) => t.href === "/clients")!;
      const health = row.tabs.find((t) => t.href === "/clients/health");
      expect(health, `${row.key} has a Health tab`).toBeDefined();
      expect(health!.label).toBe("Health");
      expect(clients.label).toBe("Clients");
      // The same gate as the Clients tab: on the tab, or inherited from the row it sits in.
      expect(health!.gate ?? row.gate).toEqual(clients.gate ?? row.gate);
    }
  });

  it("keeps the retired classic nav's agency-row gate on every row it gates today", () => {
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
    // DW-4g: a head's two tabs open the page for THEIR department (BFF §38), not the company-wide one.
    expect(learning.tabs.find((t) => t.key === "add")!.href).toBe("/learning/authoring?unit={dept}");
    expect(learning.tabs.find((t) => t.key === "team")!.href).toBe("/learning/compliance?unit={dept}");
    // PV7-05: the Reports row gains a Client tab (the project report's read tiers, and only where the company has clients).
    const reportsClient = PERFORMANCE_ROWS.find((r) => r.key === "reports")!.tabs.find((t) => t.key === "client")!;
    expect(reportsClient.href).toBe("/reports/client");
    expect(reportsClient.gate).toEqual({ kind: "all", gates: [{ kind: "cap", cap: "reports.project.view" }, { kind: "agencyRow", row: "clients" }] });
    expect(PERFORMANCE_ROWS.find((r) => r.key === "reports")!.tabs.map((t) => t.key)).toEqual(["mine", "team", "department", "client"]);
    const reportsTeam = PERFORMANCE_ROWS.find((r) => r.key === "reports")!.tabs.find((t) => t.key === "team")!;
    expect(reportsTeam.gate).toEqual({ kind: "unitCap", cap: "reports.department.view" });
    expect(reportsTeam.href).toBe("/reports/team?unit={dept}");
    expect(reportsTeam.ticket).toBeUndefined(); // DW-4b built it: /reports/team
    // DW-4e-2: the Department tab is built (no ticket) and opens the KPI page for THEIR department (BFF §40).
    const apprDept = PERFORMANCE_ROWS.find((r) => r.key === "appraisals")!.tabs.find((t) => t.key === "department")!;
    expect(apprDept.href).toBe("/appraisals/department?unit={dept}");
    expect(apprDept.ticket).toBeUndefined();
    expect(apprDept.gate).toEqual({ kind: "unitCap", cap: "reports.department.view" });
    const team = PERFORMANCE_ROWS.find((r) => r.key === "appraisals")!.tabs.find((t) => t.key === "team")!;
    expect(gateMentions(team.gate, (g) => g.kind === "cap" && g.cap === "appraisal.score")).toBe(true);
    expect(gateMentions(team.gate, (g) => g.kind === "unitCap" && g.cap === "appraisal.read")).toBe(true);
  });

  it("keeps the Admin area's gates from the retired classic nav", () => {
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

describe("department analytics (DW-4c)", () => {
  it("offers only analytics pages that exist; one page, one row", () => {
    // Web Dev's site health is Run › Portfolio and Monitoring; SEO's rankings trend is Optimize › Rankings.
    expect(workspaceBySlug("web-dev")!.analytics.map((t) => t.key)).toEqual(["website"]);
    expect(workspaceBySlug("seo")!.analytics.map((t) => t.key)).toEqual(["gsc-ga4"]);
    // Finance's money analytics (DW-7b-2) is built: no ticket, and gated like the statements, the page's first read.
    expect(workspaceBySlug("finance")!.analytics.map((t) => [t.key, t.ticket, t.gate])).toEqual([["money", undefined, { kind: "cap", cap: "finance.statement.view" }]]);
  });
});

describe("Analytics activity tabs (DW-4i, BFF section 44.9)", () => {
  const analytics = PERFORMANCE_ROWS.find((r) => r.key === "analytics")!;

  it("offers My activity to everyone, and Team activity to a head of THIS department, through the same gate as the Team report", () => {
    const mine = analytics.tabs.find((t) => t.key === "activity")!;
    expect([mine.href, mine.gate, mine.ticket]).toEqual(["/analytics/activity", undefined, undefined]);
    const team = analytics.tabs.find((t) => t.key === "team-activity")!;
    expect(team.href).toBe("/analytics/activity/team?unit={dept}");
    expect(team.gate).toEqual({ kind: "unitCap", cap: "reports.department.view" });
    expect(team.ticket).toBeUndefined();
    const reportsTeam = PERFORMANCE_ROWS.find((r) => r.key === "reports")!.tabs.find((t) => t.key === "team")!;
    expect(team.gate).toEqual(reportsTeam.gate);
  });

  it("keeps Work first and puts both in every workspace's Analytics row, ahead of the department's own analytics tabs", () => {
    expect(analytics.tabs.map((t) => t.key)).toEqual(["work", "activity", "team-activity"]);
    for (const ws of ALL) {
      const row = sidebarRows(ws).performance.find((r) => r.key === "analytics")!;
      expect(row.tabs.map((t) => t.key).slice(0, 3), ws.key).toEqual(["work", "activity", "team-activity"]);
    }
  });
});

describe("the Overview, Performance and tools data", () => {
  it("opens the Performance block with an ungated My performance row (PV7-06), and moves no other href", () => {
    const [first, ...rest] = PERFORMANCE_ROWS;
    expect(first.key).toBe("performance");
    expect(first.tabs).toEqual([{ key: "mine", label: "My performance", href: "/me/performance", icon: "pulse" }]);
    expect(first.gate).toBeUndefined();
    expect(first.tabs[0].gate).toBeUndefined();
    expect(rest.map((r) => r.key)).toEqual(["reports", "analytics", "appraisals", "learning"]);
    expect(rest.find((r) => r.key === "reports")!.tabs[0].href).toBe("/reports/person");
    expect(rest.find((r) => r.key === "appraisals")!.tabs[0].href).toBe("/appraisals/mine");
    expect(rest.find((r) => r.key === "learning")!.tabs[0].href).toBe("/me/learning");
  });

  it("lists Overview widgets in the fixed band order (plan §3.1)", () => {
    for (const ws of ALL) {
      const order = ws.overview.map((w) => OVERVIEW_BANDS.indexOf(w.band));
      expect(order, ws.key).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("marks exactly Needs you, the department condition, the company's decisions and the two notice blocks as fixed (DW-D34, DW-10a-2)", () => {
    const fixed = new Set<string>();
    for (const ws of ALL) for (const w of ws.overview) if (w.placement === "fixed") fixed.add(w.key);
    expect([...fixed].sort()).toEqual(["company-notices", "condition", "decisions", "needs-you", "notices"]);
    // The same key is never fixed in one list and not in another.
    for (const ws of ALL) for (const w of ws.overview) expect(w.placement === "fixed", `${ws.key}/${w.key}`).toBe(fixed.has(w.key));
  });

  it("makes Client health the only optional block, gated like the Clients row, in the Work band after Requests (DW-D34)", () => {
    for (const ws of ALL) {
      const optional = ws.overview.filter((w) => w.placement === "optional");
      // The company list has its own key (`company-client-health`, never narrowed); every department list has `client-health`.
      expect(optional.map((w) => w.key), ws.key).toEqual([ws.key === "gm" ? "company-client-health" : "client-health"]);
      const ch = optional[0];
      expect(ch.band).toBe("work");
      expect(ch.ticket).toBeUndefined();
      // Department lists: right after Requests, gated by the Clients row's own gate.
      if (ws.key !== "gm") {
        const keys = ws.overview.map((w) => w.key);
        expect(keys[keys.indexOf("requests") + 1], ws.key).toBe("client-health");
        expect(ch.gate, ws.key).toEqual({ kind: "agencyRow", row: "clients" });
      } else {
        // The company list keeps the cockpit's gate and adds the Clients row's.
        expect(gateMentions(ch.gate, (g) => g.kind === "agencyRow" && g.row === "clients")).toBe(true);
        expect(gateMentions(ch.gate, (g) => g.kind === "cap" && g.cap === "reports.department.view")).toBe(true);
      }
    }
  });

  it("every placement is one of the three words, and an absent one means default", () => {
    for (const ws of ALL) for (const w of ws.overview) expect([undefined, "fixed", "default", "optional"], `${ws.key}/${w.key}`).toContain(w.placement);
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

describe("departmentOverviewHref (DW-8e)", () => {
  it("opens HR, Finance and IT on their own consoles and every other department on its Overview", () => {
    expect(departmentOverviewHref("agency", { id: "d-hr-co-a", name: "HR" }, "co-a")).toBe("/hr");
    expect(departmentOverviewHref("agency", { id: "d-finance-co-a", name: "Finance" }, "co-a")).toBe("/finance");
    expect(departmentOverviewHref("agency", { id: "d-it-co-a", name: "IT" }, "co-a")).toBe("/it");
    expect(departmentOverviewHref("agency", { id: "d-web", name: "Web Dev" }, "co-a")).toBe("/departments/d-web");
    expect(departmentOverviewHref("hospitality", { id: "d-hk", name: "Housekeeping" }, "co-h")).toBe("/departments/d-hk");
  });
});

describe("the Notices tab on the Overview row (DW-10a-2, BFF section 57.8)", () => {
  const overviewRow = (ws: Workspace) => sidebarRows(ws).top.find((r) => r.key === "overview")!;

  it("follows Overview in every workspace, ungated, and is built (no ticket)", () => {
    for (const ws of ALL) {
      const tabs = overviewRow(ws).tabs;
      // DW-10c-3 adds the Department calendar after Notices on every workspace but the Office of the GM (the next block).
      expect(tabs.map((t) => t.key).slice(0, 2), ws.key).toEqual(["overview", "notices"]);
      expect(tabs[0].href, ws.key).toBe(ws.overviewHref);
      expect(tabs[1].gate, ws.key).toBeUndefined();
      expect(isPlanned(tabs[1]), ws.key).toBe(false);
      expect(isPlanned(overviewRow(ws)), ws.key).toBe(false);
    }
  });

  it("opens the unit's board for a department workspace, HR, Finance and IT included, and the company-wide board for the Office of the GM", () => {
    for (const ws of ALL) {
      const href = overviewRow(ws).tabs[1].href;
      expect(href, ws.key).toBe(ws.kind === "office" ? "/notices" : "/departments/{dept}/notices");
    }
    expect(hrefFor("/departments/{dept}/notices", { deptId: "d-hr" })).toBe("/departments/d-hr/notices");
  });

  it("is dropped by hrefFor when the workspace has no department id, so it is never offered a link to nowhere", () => {
    expect(hrefFor(overviewRow(workspaceBySlug("hr")!).tabs[1].href, { deptId: null })).toBeNull();
    expect(hrefFor(overviewRow(workspaceBySlug("gm")!).tabs[1].href, { deptId: null })).toBe("/notices");
  });

  it("lands on page files that exist", () => {
    expect(existsSync(pageFile("/departments/{dept}/notices"))).toBe(true);
    expect(existsSync(pageFile("/notices"))).toBe(true);
  });
});

describe("the Department calendar tab on the Overview row (DW-10c-3, BFF section 59.4)", () => {
  const overviewRow = (ws: Workspace) => sidebarRows(ws).top.find((r) => r.key === "overview")!;

  it("follows Notices on every department workspace, ungated and built, at the unit's schedule page", () => {
    for (const ws of ALL.filter((w) => w.kind !== "office")) {
      const tabs = overviewRow(ws).tabs;
      expect(tabs.map((t) => t.key), ws.key).toEqual(["overview", "notices", "schedule"]);
      expect(tabs[2].label, ws.key).toBe("Department calendar");
      expect(tabs[2].href, ws.key).toBe("/departments/{dept}/schedule");
      expect(tabs[2].gate, ws.key).toBeUndefined();
      expect(isPlanned(tabs[2]), ws.key).toBe(false);
    }
  });

  it("is absent from the Office of the GM, whose Overview is the company's", () => {
    const gm = ALL.filter((w) => w.kind === "office");
    expect(gm.length).toBeGreaterThan(0);
    for (const ws of gm) expect(overviewRow(ws).tabs.map((t) => t.key), ws.key).toEqual(["overview", "notices"]);
    expect(deptCalendarTab({ kind: "office" })).toBeNull();
    expect(deptCalendarTab({ kind: "department" })?.href).toBe("/departments/{dept}/schedule");
  });

  it("is dropped by hrefFor when the workspace has no department id, and filled with the id when it has one", () => {
    expect(hrefFor("/departments/{dept}/schedule", { deptId: null })).toBeNull();
    expect(hrefFor("/departments/{dept}/schedule", { deptId: "d-hr" })).toBe("/departments/d-hr/schedule");
  });

  it("lands on a page file that exists, and not on /calendar, which is Social Media's posts calendar", () => {
    expect(existsSync(pageFile("/departments/{dept}/schedule"))).toBe(true);
    expect(overviewRow(workspaceBySlug("social-media")!).tabs.map((t) => t.href)).not.toContain("/departments/{dept}/calendar");
    // Social Media's own Calendar tab is still at /calendar.
    expect(rowsOf(workspaceBySlug("social-media")!).flatMap((r) => r.tabs).some((t) => t.href === "/departments/{dept}/calendar")).toBe(true);
  });
});

// ── SCP-Kf (plan §8): nothing loses its home in the Social skin ───────────────────────────────────────────────────────────────────────
// The Social skin rearranges the menu (a pinned list, then More). The registry's rows must still each have a place in it, and what it pins must
// be pages that exist.
describe("nothing loses its home in the Social skin (plan §8)", () => {
  const social = workspaceBySlug("social-media")!;
  const reg = sidebarRows(social);

  it("gives every row of the Social Media menu a place: the top rows are pinned, the rest are listed by More", () => {
    const pinnedRows = new Set(SKINS.social.pinned!.filter((p) => p.kind === "row").map((p) => (p as { row: string }).row));
    // Overview and the AI Assistant lead the menu as Home and AI Assistant; Work, Performance and You are More's three groups.
    for (const row of reg.top) expect(pinnedRows.has(row.key), `top row ${row.key}`).toBe(true);
    const more = new Set([...reg.work, ...reg.performance, ...reg.you].map((r) => r.key));
    for (const row of [...reg.work, ...reg.performance, ...reg.you]) expect(more.has(row.key), row.key).toBe(true);
    expect(more.size).toBe(reg.work.length + reg.performance.length + reg.you.length);
  });

  it("pins only tabs the registry has, and every built one lands on a page file that exists", () => {
    const rows = [...reg.top, ...reg.work, ...reg.performance, ...reg.you];
    const missing: string[] = [];
    for (const p of SKINS.social.pinned!) {
      if (p.kind !== "row" || p.ticket) continue;
      const row = rows.find((r) => r.key === p.row);
      if (!row) { missing.push(`${p.key}: no row ${p.row}`); continue; }
      // A fallback pin (Reports) opens the row's first tab until the tab it names exists.
      const tab = (p.tab ? row.tabs.find((t) => t.key === p.tab) : row.tabs[0]) ?? (p.tabFallback ? row.tabs[0] : undefined);
      if (!tab) { missing.push(`${p.key}: no tab ${p.row}/${p.tab}`); continue; }
      if (!isPlanned(tab) && !existsSync(pageFile(tab.href))) missing.push(`${p.key} -> ${tab.href}`);
    }
    expect(missing).toEqual([]);
  });

  // SCP-5d (BFF §63.17): the Team dashboard is the registry's `dashboard` row, gated on `canLeadSocial` like Settings, with one built tab on a page file that exists. Its
  // key is unique in the workspace (the Social skin's pin names it), and the Reports > Team block is NOT a row (it sits on the shared `reports` row's existing `team` page).
  it("has the Team dashboard row: `dashboard`, gated on leadSocial, one built tab at {dept}/dashboard", () => {
    const rows = [...reg.top, ...reg.work, ...reg.performance, ...reg.you];
    const hits = rows.filter((r) => r.key === "dashboard");
    expect(hits).toHaveLength(1);
    const row = hits[0];
    expect(row.gate).toEqual({ kind: "leadSocial" });
    expect(row.tabs.map((t) => [t.key, t.href])).toEqual([["dashboard", "/departments/{dept}/dashboard"]]);
    expect(isPlanned(row.tabs[0])).toBe(false);
    expect(existsSync(pageFile(row.tabs[0].href))).toBe(true);
    // Settings has the same gate; no other Social row is leadSocial-gated.
    expect(rows.filter((r) => r.gate?.kind === "leadSocial").map((r) => r.key).sort()).toEqual(["dashboard", "settings"]);
  });

  it("keeps the Asset Library the Saved pin opens a built, gated-as-before page of the Social Media toolkit", () => {
    const assets = reg.work.find((r) => r.key === "publish")!.tabs.find((t) => t.key === "assets")!;
    expect(assets.href).toBe("/departments/{dept}/assets");
    expect(isPlanned(assets)).toBe(false);
    expect(existsSync(pageFile(assets.href))).toBe(true);
  });

  it.each(SKIN_PERSONAS)("offers a person every row the registry gives them, in both skins: $name", (persona) => {
    const std = modelFor(persona, undefined);
    const soc = modelFor(persona, { on: ["standard", "social"] });
    for (const ws of std.workspaces) {
      const other = soc.workspaces.find((w) => w.id === ws.id)!;
      expect(other.rows, ws.key).toEqual(ws.rows);
      expect(other.creates, ws.key).toEqual(ws.creates);
      expect(other.withheld, ws.key).toEqual(ws.withheld);
    }
    expect(soc.company).toEqual(std.company);
    expect(soc.admin).toEqual(std.admin);
  });
});

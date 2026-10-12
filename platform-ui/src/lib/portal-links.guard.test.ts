import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { activePortalNav } from "./portalNav";

// PV2-08 guard: every link the backend sends a client opens a real portal page, inside one of the five
// areas (PV-D4). The links live in platform-nest (notification hrefs and the dashboard's "needs you"
// items), so this test reads that source. A link to a page that does not exist, or to a path no area
// claims, fails here instead of in a client's inbox.
//
// It runs with the platform-ui suite, so a platform-nest-only change is caught at the next ui run or
// release gate, not in that change's own CI job.
const UI_SRC = path.resolve(__dirname, "..");
const NEST_SRC = path.resolve(__dirname, "../../../platform-nest/src");
const PORTAL_APP = path.join(UI_SRC, "app", "(portal)");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every `/portal…` string literal on a line that sets an `href`, with `${…}` as one dynamic segment. */
function backendPortalLinks(): Map<string, string[]> {
  const links = new Map<string, string[]>();
  const files = walk(NEST_SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!line.includes("href")) return;
      for (const m of line.matchAll(/(["'`])(\/portal(?:\/[^"'`]*)?)\1/g)) {
        const link = m[2].replace(/\$\{[^}]*\}/g, ":id");
        const where = `${path.relative(NEST_SRC, file)}:${i + 1}`;
        links.set(link, [...(links.get(link) ?? []), where]);
      }
    });
  }
  return links;
}

/** Does `/portal/a/:id` resolve to a page in the (portal) route group, through static, `[x]` or
 *  `[[...x]]` / `[...x]` folders? */
function routeExists(link: string): boolean {
  const segments = link.split("/").filter(Boolean);
  const resolve = (dir: string, rest: string[]): boolean => {
    if (rest.length === 0) {
      if (existsSync(path.join(dir, "page.tsx"))) return true;
      // An optional catch-all also answers its parent path.
      return readdirSync(dir).some((n) => /^\[\[\.\.\..+\]\]$/.test(n) && existsSync(path.join(dir, n, "page.tsx")));
    }
    const [head, ...tail] = rest;
    if (!existsSync(dir)) return false;
    const entries = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory());
    if (head !== ":id" && entries.includes(head) && resolve(path.join(dir, head), tail)) return true;
    for (const n of entries) {
      if (/^\[\[?\.\.\..+\]\]?$/.test(n) && existsSync(path.join(dir, n, "page.tsx"))) return true;
      if (/^\[[^.\]]+\]$/.test(n) && resolve(path.join(dir, n), tail)) return true;
    }
    return false;
  };
  return resolve(PORTAL_APP, segments);
}

// Links the backend ALREADY sends whose portal page is built by a later ticket. Each entry names both tickets, and a test below
// fails the moment the page exists (delete the entry then, so the two real checks cover the link) or the backend stops sending
// the link (the entry is stale). It is a ledger of a known gap, not a way to skip the guard: nothing is exempt silently.
// Empty since PV4-08 built `/portal/conversation/:id` (sent by PV4-06) and `/portal/meetings/:id` (sent by PV4-05); both now go
// through the two real checks below (a page exists, and it sits in an area).
const AWAITING_PAGE: Record<string, string> = {};

describe("links the backend sends clients open a portal page in an area", () => {
  const all = backendPortalLinks();
  const links = new Map([...all].filter(([link]) => !(link in AWAITING_PAGE)));

  it("finds the backend's portal links (the guard is not vacuous)", () => {
    // 2026-10-11: /portal, /portal/approvals/:id, /portal/contracts/:id, /portal/invoices/:id,
    // /portal/requests, /portal/social-reviews.
    expect(links.size).toBeGreaterThanOrEqual(6);
    expect([...links.keys()]).toContain("/portal/approvals/:id");
  });

  it("the awaiting-page ledger is exact: every entry is still sent by the backend and still has no page", () => {
    for (const link of Object.keys(AWAITING_PAGE)) {
      expect([...all.keys()], `${link} is no longer sent by the backend: delete its AWAITING_PAGE entry`).toContain(link);
      expect(routeExists(link), `${link} now has a page: delete its AWAITING_PAGE entry so the real checks cover it`).toBe(false);
    }
  });

  it("every link resolves to a page in the (portal) route group", () => {
    const missing = [...links].filter(([link]) => !routeExists(link)).map(([link, at]) => `${link} (${at.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("every link sits inside one of the five areas", () => {
    const orphaned = [...links]
      .filter(([link]) => activePortalNav(link.replace(/:id/g, "x")).areaKey === null)
      .map(([link, at]) => `${link} (${at.join(", ")})`);
    expect(orphaned).toEqual([]);
  });

  it("the route check itself rejects a page that does not exist", () => {
    expect(routeExists("/portal/approvals/:id")).toBe(true);
    expect(routeExists("/portal/runs/:id")).toBe(false);
    expect(activePortalNav("/portal/runs/x").areaKey).toBeNull();
  });
});

// WSK-49d — the Website area's OWN links (built by the pages and the editor from `portalWebsiteHref`) resolve to pages in the
// portal route group, inside the Business area. The BFF sends no `/portal/website` links (§16j "what is deliberately NOT done": no
// notification links into /portal yet), so the backend scan above cannot see them; this pins the in-app ones instead.
describe("the Website area's links open a portal page in an area", () => {
  const links = [
    "/portal/website",
    "/portal/website/:id/:id", // a site
    "/portal/website/:id/:id/:id", // a collection
    "/portal/website/:id/:id/:id/:id", // a page (the editor)
    "/portal/website/:id/:id/:id/:id/history",
    "/portal/website/:id/:id/:id/~new",
    "/portal/website/:id/:id/~media",
  ];
  it.each(links)("%s resolves to a page", (link) => {
    expect(routeExists(link)).toBe(true);
  });
  it.each(links)("%s sits in the Business area", (link) => {
    expect(activePortalNav(link.replace(/:id/g, "x")).areaKey).toBe("business");
  });
  it("the Website routes live in the portal route group, never the staff one", () => {
    expect(existsSync(path.join(UI_SRC, "app", "(app)", "portal"))).toBe(false);
  });
});

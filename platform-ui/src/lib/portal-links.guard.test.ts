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

describe("links the backend sends clients open a portal page in an area", () => {
  const links = backendPortalLinks();

  it("finds the backend's portal links (the guard is not vacuous)", () => {
    // 2026-10-11: /portal, /portal/approvals/:id, /portal/contracts/:id, /portal/invoices/:id,
    // /portal/requests, /portal/social-reviews.
    expect(links.size).toBeGreaterThanOrEqual(6);
    expect([...links.keys()]).toContain("/portal/approvals/:id");
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

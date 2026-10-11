import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { wpSiteFiles, WP_SDK_PATH } from "./wp-site";

// Drift gate (M6-P5a). The canonical headless theme lives in ../webdesk/wordpress/theme/gaiada-webdesk/
// (a sibling project); this template vendors it as strings. Any edit to the canonical theme that is
// not followed by `node scripts/sync-wp-theme.mjs` fails here. CRLF -> LF on read: git stores LF,
// a Windows checkout may not.
const CANONICAL = path.resolve(__dirname, "../../../../webdesk/wordpress/theme/gaiada-webdesk");

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}
const lf = (s: string) => s.replace(/\r\n/g, "\n");

const args = {
  tenantSlug: "acme",
  sdkPhpSource: "<?php // THIS TENANT'S OWN sdk.php\n",
  contractVersion: "1.4.0",
  vocabularyVersion: "1.2.0",
};

describe("wp site template drift gate", () => {
  const emitted = new Map(wpSiteFiles(args).map((f) => [f.path, f.content]));

  it("the canonical theme directory exists and is complete", () => {
    const canonical = walk(CANONICAL);
    for (const required of ["style.css", "index.php", "functions.php", "inc/router.php", "inc/config.php", "inc/block-renderer.php", WP_SDK_PATH]) {
      expect(canonical).toContain(required);
    }
  });

  it("emits exactly the canonical file set (plus the scaffold README), no more, no fewer", () => {
    const canonical = walk(CANONICAL).sort();
    const emittedPaths = [...emitted.keys()].filter((p) => p !== "README.md").sort();
    expect(emittedPaths).toEqual(canonical);
  });

  it("every emitted file except sdk.php is byte-for-byte the canonical file", () => {
    for (const p of walk(CANONICAL)) {
      if (p === WP_SDK_PATH) continue;
      expect(emitted.get(p), `drift in ${p} — run: node scripts/sync-wp-theme.mjs`).toBe(lf(fs.readFileSync(path.join(CANONICAL, p), "utf8")));
    }
  });

  it("sdk.php is the tenant's own bytes, never the canonical FIXTURE", () => {
    expect(emitted.get(WP_SDK_PATH)).toBe(args.sdkPhpSource);
    expect(emitted.get(WP_SDK_PATH)).not.toBe(lf(fs.readFileSync(path.join(CANONICAL, WP_SDK_PATH), "utf8")));
  });

  it("the canonical sdk.php carries the FIXTURE header", () => {
    expect(fs.readFileSync(path.join(CANONICAL, WP_SDK_PATH), "utf8")).toMatch(/^<\?php\r?\n\/\/ FIXTURE/);
  });

  it("the theme keeps configuration out of the database", () => {
    for (const [p, content] of emitted) {
      if (p.endsWith(".php") && p !== WP_SDK_PATH) {
        expect(content, p).not.toMatch(/\b(get_option|update_option|add_option|register_setting)\s*\(/);
      }
    }
  });

  it("the old page.php (options fallback, no router) is not emitted", () => {
    expect(emitted.has("page.php")).toBe(false);
  });
});

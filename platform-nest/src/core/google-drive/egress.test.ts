// DW-6i — the egress inventory of core/google-drive, in the shape of core/google-oauth/egress.test.ts (which it extends in spirit).
//
//   1. exactly ONE production file here originates an outbound call, and it is client.ts (the Drive `files.get` client);
//   2. that file refuses any request that fails `isDriveApiUrl` (exact host `www.googleapis.com`, https, `/drive/v3/`);
//   3. the only host written as a URL anywhere in production code here is `www.googleapis.com` (comment lines excluded);
//   4. nothing here reads another vendor's config namespace, and the service holds no network primitive of its own: it reaches
//      Google only through the shared token client and client.ts.
// Static, for the reason core/google-oauth/egress.test.ts gives: it sees every call site that EXISTS, executed or not.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = __dirname;
const APPROVED_EGRESS: Record<string, string> = {
  "client.ts": "Google Drive v3 files.get with the person's own access token (www.googleapis.com/drive/v3/ only).",
};
const FOREIGN_CONFIG_NAMESPACES = [
  "config.services.gateway", "config.services.knowledge", "config.search.dataforseo", "config.search.semrush", "config.search.ahrefs",
];

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...productionFiles(full)); continue; }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(relative(ROOT, full).split("\\").join("/"));
  }
  return out;
}
/** Same detector as core/google-oauth/egress.test.ts: any call whose callee name ends in fetch/Fetch, or `?? fetch`. */
function networkLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/typeof\s+fetch/g, "");
    if (/\b\w*[fF]etch\w*\s*\(/.test(code) || /\?\?\s*fetch\b/.test(code)) lines.push(i + 1);
  });
  return lines;
}
/** Every `https://host` written in CODE (whole-line comments, and block-comment bodies, skipped). */
function hostsInCode(text: string): string[] {
  const hosts = new Set<string>();
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (inBlock) { if (t.includes("*/")) inBlock = false; continue; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; continue; }
    if (t.startsWith("//") || t.startsWith("*")) continue;
    for (const m of raw.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) hosts.add(m[1].toLowerCase());
  }
  return [...hosts];
}

describe("core/google-drive egress inventory (DW-6i)", () => {
  const files = productionFiles(ROOT);

  it("the scanner actually walked files", () => {
    expect(files).toEqual(expect.arrayContaining(["client.ts", "service.ts", "surface.ts", "google-drive.controller.ts"]));
  });
  it("only client.ts originates outbound calls", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const hits = networkLines(readFileSync(join(ROOT, rel), "utf8"));
      if (hits.length && !(rel in APPROVED_EGRESS)) offenders.push(`${rel}:${hits.join(",")}`);
    }
    expect(offenders).toEqual([]);
  });
  it("the approved file really does contain egress, so the allow-list row is not stale", () => {
    for (const rel of Object.keys(APPROVED_EGRESS)) {
      expect(networkLines(readFileSync(join(ROOT, rel), "utf8")).length, rel).toBeGreaterThan(0);
    }
  });
  it("client.ts refuses a request that fails isDriveApiUrl, and imports the predicate from the shared hosts file", () => {
    const text = readFileSync(join(ROOT, "client.ts"), "utf8");
    expect(text).toContain("isDriveApiUrl(url)");
    expect(text).toMatch(/import \{[^}]*isDriveApiUrl[^}]*\} from "\.\.\/google-oauth\/hosts"/);
  });
  it("the only host written as a URL in production code here is www.googleapis.com", () => {
    const seen = new Set<string>();
    for (const rel of files) for (const h of hostsInCode(readFileSync(join(ROOT, rel), "utf8"))) seen.add(h);
    expect([...seen]).toEqual(["www.googleapis.com"]);
  });
  it("no foreign config namespace is referenced, and service.ts holds no network primitive", () => {
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const ns of FOREIGN_CONFIG_NAMESPACES) expect(text, `${rel} must not reference ${ns}`).not.toContain(ns);
    }
    expect(networkLines(readFileSync(join(ROOT, "service.ts"), "utf8"))).toEqual([]);
    expect(networkLines(readFileSync(join(ROOT, "google-drive.controller.ts"), "utf8"))).toEqual([]);
  });
});

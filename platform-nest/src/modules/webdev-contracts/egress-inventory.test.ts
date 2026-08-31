// WSK-19 — the egress inventory for `src/modules/webdev-contracts/` (the SM-39 §A5 / WD-23A-1
// pattern, same discipline `src/modules/webdev/egress-inventory.test.ts` applies to the sibling
// provision seam — see `contract-fetch-provider.ts`'s header for why this is a SEPARATE directory
// and therefore a separate copy of this test, not an edit to that one).
//
//   1. EXACTLY ONE production file here originates outbound calls: `contract-fetch-http.ts`.
//   2. That file reads its OWN config namespace (`config.webdevControl`) and no other.
//   3. NO file here hardcodes a webdesk-control host — fail-closed on unset env, no default.
//   4. NO bearer token literal or the provision seam's own credential fields leak into a file that
//      is not the driver.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = __dirname;

const APPROVED_EGRESS: Record<string, string> = {
  "contract-fetch-http.ts":
    "webdev-control (Zone B, the control plane): GET /control/v1/tenants/:slug/contract, plus "
    + "per-artifact pre-signed GET downloads (config.webdevControl). Bearer-token stub only — no "
    + "mTLS client cert, no Keycloak client-credentials flow (WSK-22/23's job; see config.ts's own "
    + "header on this).",
};

const FOREIGN_CONFIG_NAMESPACES = [
  "config.provision.", "config.services.gateway", "config.services.knowledge", "config.services.hub",
];

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(relative(ROOT, full).split("\\").join("/"));
  }
  return out;
}

/** Strips `/* … *‍/` block comments FIRST (line-by-line only, matching `modules/webdev`'s own
 *  copy, misses `//` comments too — same tradeoff), then scans for a network call by NAME rather
 *  than by literal `fetch(`. This directory's own identifiers (`WebdevControlProvider`,
 *  `createWebdevControlHttpDriver`, …) were deliberately renamed AWAY from containing the
 *  substring "fetch" specifically so this scanner's broad by-name heuristic stays meaningful
 *  instead of being loosened — the one file that DOES perform egress keeps a name built around
 *  "fetch" on purpose (`getContractBundle`/`downloadArtifact` on `WebdevControlHttpDriver`, in
 *  `contract-fetch-http.ts`), and nothing else in this directory needs that word in an identifier. */
function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function networkLines(text: string): number[] {
  const lines: number[] = [];
  stripBlockComments(text).split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/typeof\s+fetch/g, "");
    if (/\b\w*[fF]etch\w*\s*\(/.test(code) || /\?\?\s*fetch\b/.test(code)) lines.push(i + 1);
  });
  return lines;
}

describe("modules/webdev-contracts egress inventory (WSK-19, mirroring modules/webdev's own)", () => {
  const files = productionFiles(ROOT);

  it("the scanner actually walked files — one that finds nothing proves nothing", () => {
    expect(files.length).toBeGreaterThan(2);
    expect(files).toContain("contract-fetch-http.ts");
    expect(files).toContain("contract-snapshot.service.ts");
    expect(files).toContain("contract-snapshots.controller.ts");
  });

  it("only the approved file originates outbound calls", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const hits = networkLines(readFileSync(join(ROOT, rel), "utf8"));
      if (hits.length && !(rel in APPROVED_EGRESS)) offenders.push(`${rel}:${hits.join(",")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the approved file really does contain egress — a stale allowlist row is a lie", () => {
    for (const rel of Object.keys(APPROVED_EGRESS)) {
      expect(files, `${rel} is listed as approved egress but was not found`).toContain(rel);
      const hits = networkLines(readFileSync(join(ROOT, rel), "utf8"));
      expect(hits.length, `${rel} is listed as approved egress but contains no network reference`).toBeGreaterThan(0);
    }
  });

  it("the driver reads its OWN config namespace and no foreign one", () => {
    const text = readFileSync(join(ROOT, "contract-fetch-http.ts"), "utf8");
    expect(text).toContain("config.webdevControl");
    for (const ns of FOREIGN_CONFIG_NAMESPACES) {
      expect(text, `contract-fetch-http.ts must not reference ${ns}`).not.toContain(ns);
    }
  });

  it("NO file hardcodes a webdesk-control host — fail-closed on unset env, no default", () => {
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const code = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(code, `${rel} hardcodes a webdesk/webdesk-control host`).not.toMatch(/webdesk[a-z0-9.-]*\.(gaiada|online)/i);
    }
  });

  it("no file leaks the OTHER egress seam's credential field names (provision)", () => {
    for (const rel of files) {
      const code = readFileSync(join(ROOT, rel), "utf8")
        .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(code, `${rel} reads the provision service password`).not.toContain("servicePassword");
      expect(code, `${rel} reads the provision service email`).not.toContain("serviceEmail");
    }
  });
});

// PRV-02 — the egress inventory for `src/modules/webdev/` (the SM-39 §A5 / WD-23A-1 pattern).
//
// House rule, restated by this ticket: when network code appears, the inventory row appears with it.
// This module is the ERP's ONLY caller of `provision.gaiada.online` — a real cross-host hop to a box
// that holds an org-admin GitHub PAT and the fleet deploy SSH key and runs `sudo`. The control this
// file enforces is narrow and checkable:
//
//   1. EXACTLY ONE production file here originates outbound calls, and it is `provision-http.ts`.
//   2. That file reads its OWN config namespace (`config.provision`) and no other vendor namespace.
//   3. NO file here hardcodes a provision host. The seam is fail-closed on unset env, and a default
//      endpoint would convert "never configured" into "silently provisions against production".
//   4. NO file here references the Zone B′ credentials that must never enter Zone A (the GitHub PAT
//      and the fleet deploy SSH key, design D-P4). Those live in provision's own `.env` on gda-s01.
//
// Static, not dynamic, for the reason the original states: an AST-ish walk sees every call site that
// EXISTS; a runtime trace only proves what the fixtures happened to reach.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = __dirname;

/** The one file allowed to talk outward from modules/webdev, and why. */
const APPROVED_EGRESS: Record<string, string> = {
  "provision-http.ts":
    "provision (Zone B′, gda-s01): POST /api/users/login, POST /api/provision, GET /api/projects/:id, "
    + "GET /api/projects?where[name][equals]= (config.provision). Service-account auth only; holds no "
    + "provider credential of any kind.",
};

/** Namespaces that would indicate cross-contamination if this module referenced them. */
const FOREIGN_CONFIG_NAMESPACES = [
  "config.services.gateway",
  "config.services.knowledge",
  "config.services.hub",
  "config.search.dataforseo",
  "config.search.semrush",
  "config.search.ahrefs",
  "config.google",
];

/** Zone B′ secrets. Their NAMES appearing anywhere in Zone A code is the tripwire — a seam that has
 *  started reading a PAT is a seam that has stopped being one-way. */
const ZONE_B_SECRET_NAMES = [
  "GITHUB_TOKEN",
  "DEPLOY_SSH_PRIVATE_KEY",
  "GCP_SSH_PRIVATE_KEY",
  "DEPLOY_SSH_PRIVATE_KEY_B64",
];

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionFiles(full));
      continue;
    }
    // Test files legitimately hold fetch-shaped fakes and mock origins; including them would make
    // this test's own fixtures the majority of its findings.
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(relative(ROOT, full).split("\\").join("/"));
  }
  return out;
}

/** A network reference. Wider than `fetch(` on purpose — the WD-23A-1 original MISSED the real call
 *  because the token client aliased the global (`const doFetch = fetchImpl ?? fetch`). Matches any
 *  call whose callee name ends in fetch/Fetch, plus the `?? fetch` default-injection idiom.
 *  `typeof fetch` is stripped first: that is a TYPE reference, not an outbound call. */
function networkLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/typeof\s+fetch/g, "");
    if (/\b\w*[fF]etch\w*\s*\(/.test(code) || /\?\?\s*fetch\b/.test(code)) lines.push(i + 1);
  });
  return lines;
}

describe("modules/webdev egress inventory (PRV-02, mirroring WD-23A-1 / SM-39 §A5)", () => {
  const files = productionFiles(ROOT);

  it("the scanner actually walked files — one that finds nothing proves nothing", () => {
    expect(files.length).toBeGreaterThan(3);
    expect(files).toContain("provision-http.ts");
    expect(files).toContain("provisioning.service.ts");
    expect(files).toContain("webdev.controller.ts");
  });

  it("only the approved file originates outbound calls", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const hits = networkLines(readFileSync(join(ROOT, rel), "utf8"));
      if (hits.length && !(rel in APPROVED_EGRESS)) offenders.push(`${rel}:${hits.join(",")}`);
    }
    // Fails BY NAME if someone adds a fetch to the service, the controller or the slug helper.
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
    const text = readFileSync(join(ROOT, "provision-http.ts"), "utf8");
    expect(text).toContain("config.provision");
    for (const ns of FOREIGN_CONFIG_NAMESPACES) {
      expect(text, `provision-http.ts must not reference ${ns}`).not.toContain(ns);
    }
  });

  it("NO file hardcodes a provision host — the seam is fail-closed on unset env, with no default", () => {
    // The exact accident this prevents: a `?? "https://provision.gaiada.online"` fallback that turns
    // an unconfigured dev box or CI job into a caller that creates real repos and real vhosts.
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const code = text
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // comments may name the host; code may not
        .join("\n");
      expect(code, `${rel} hardcodes a provision host`).not.toMatch(/provision\.gaiada\.online/);
      expect(code, `${rel} hardcodes a gda-s01 address`).not.toMatch(/gda-s01/);
    }
  });

  it("NO file references a Zone B′ credential (the PAT / fleet SSH key never enter Zone A)", () => {
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const code = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      for (const secret of ZONE_B_SECRET_NAMES) {
        expect(code, `${rel} references ${secret}`).not.toContain(secret);
      }
    }
  });

  it("the service and controller never touch the provision credential directly", () => {
    // Credential handling is confined to the one egress file. A service that reads
    // `config.provision.servicePassword` would be a second place to leak it from.
    for (const rel of files.filter((f) => f !== "provision-http.ts")) {
      const code = readFileSync(join(ROOT, rel), "utf8")
        .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(code, `${rel} reads the provision service password`).not.toContain("servicePassword");
      expect(code, `${rel} reads the provision service email`).not.toContain("serviceEmail");
    }
  });
});

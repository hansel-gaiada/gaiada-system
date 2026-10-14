// PV5-11 — the egress inventory for src/signatures/ (the src/payments discipline, applied here):
//   1. exactly ONE file originates outbound network calls: simulated-psre.ts, and only to THIS process over the loopback
//      (the simulated PSrE delivering its notice to our own webhook);
//   2. no other host is named anywhere here;
//   3. nothing logs the notice credential or a key.
// A real PSrE adapter (VIDA) is a deliberate new row in APPROVED_EGRESS, never a silent one.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = __dirname;

const APPROVED_EGRESS: Record<string, string[]> = {
  "simulated-psre.ts": ["http://127.0.0.1"],
};

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

function code(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, ""));
}

function networkLines(text: string): number[] {
  const hits: number[] = [];
  code(text).forEach((line, i) => {
    const l = line.replace(/typeof\s+fetch/g, "");
    if (/(^|\W)fetch\s*\(/.test(l) || /\bhttps?\.request\b|\bnode:https?\b|\bundici\b|\baxios\b|XMLHttpRequest/.test(l)) hits.push(i + 1);
  });
  return hits;
}

describe("src/signatures egress inventory (PV5-11)", () => {
  const files = productionFiles(ROOT);

  it("the scanner actually walked files", () => {
    expect(files).toEqual(expect.arrayContaining([
      "provider.ts", "registry.ts", "simulated-psre.ts", "simulated-provider.ts", "certified-signing.ts", "process.ts", "webhook.controller.ts",
    ]));
  });

  it("only the simulator originates outbound calls", () => {
    const offenders = files
      .map((rel) => ({ rel, hits: networkLines(readFileSync(join(ROOT, rel), "utf8")) }))
      .filter((f) => f.hits.length > 0 && !(f.rel in APPROVED_EGRESS))
      .map((f) => `${f.rel}:${f.hits.join(",")}`);
    expect(offenders).toEqual([]);
    for (const rel of Object.keys(APPROVED_EGRESS)) {
      expect(networkLines(readFileSync(join(ROOT, rel), "utf8")).length, `${rel} is allow-listed but has no egress`).toBeGreaterThan(0);
    }
  });

  it("names no host but the loopback", () => {
    for (const rel of files) {
      const urls = code(readFileSync(join(ROOT, rel), "utf8")).join("\n").match(/https?:\/\/[A-Za-z0-9.-]+/g) ?? [];
      const allowed = APPROVED_EGRESS[rel] ?? [];
      for (const u of urls) expect(allowed, `${rel} names ${u}`).toContain(u);
    }
  });

  it("never logs the notice credential or a key", () => {
    const suspicious = /console\.(log|warn|error|info|debug)\([^)]*\b(authorization|noticeSecret|privateKey|simulatedNoticeAuthorization)\b/i;
    for (const rel of files) {
      code(readFileSync(join(ROOT, rel), "utf8")).forEach((line, i) => {
        expect(suspicious.test(line), `${rel}:${i + 1} looks like it logs a secret: ${line.trim()}`).toBe(false);
      });
    }
  });
});

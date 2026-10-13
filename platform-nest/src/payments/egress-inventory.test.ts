// PV5-10 — the egress inventory for src/payments/ (the core/github/egress-inventory.test.ts discipline, applied here):
//   1. exactly ONE file originates outbound network calls: midtrans.ts (the adapter);
//   2. the only hosts it may name are Midtrans' four (Snap and API, sandbox and production), and only over https;
//   3. no production file here logs the server key, and the key never appears in an error message template.
// A second adapter (a provider exit, design decision 14) is a deliberate new row in APPROVED_EGRESS, never a silent one.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MIDTRANS_HOSTS } from "./midtrans";

const ROOT = __dirname;

const APPROVED_EGRESS: Record<string, string[]> = {
  "midtrans.ts": [
    "https://app.sandbox.midtrans.com", "https://api.sandbox.midtrans.com",
    "https://app.midtrans.com", "https://api.midtrans.com",
  ],
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

/** Comment-stripped code (split on /\r?\n/: a CRLF checkout must strip comments too, see the GitHub inventory). */
function code(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, ""));
}

/** A bare or member `fetch(` call, the adapter's injected `fetchImpl(`, the `?? fetch` default, or any other HTTP client.
 *  Narrower than the GitHub detector on ONE point, on purpose: `fetchStatus(` (the PaymentProvider method every caller
 *  uses) is an interface call, not egress; the adapter's real call is caught by `fetchImpl(`. */
function networkLines(text: string): number[] {
  const hits: number[] = [];
  code(text).forEach((line, i) => {
    const l = line.replace(/typeof\s+fetch/g, "");
    if (/(^|\W)fetch\s*\(/.test(l) || /\bfetchImpl\s*\(/.test(l) || /\?\?\s*\(?\s*fetch\b/.test(l)
        || /\bhttps?\.request\b|\bnode:https?\b|\bundici\b|\baxios\b|XMLHttpRequest/.test(l)) hits.push(i + 1);
  });
  return hits;
}

describe("src/payments egress inventory (PV5-10)", () => {
  const files = productionFiles(ROOT);

  it("the scanner actually walked files", () => {
    expect(files).toEqual(expect.arrayContaining(["midtrans.ts", "provider.ts", "registry.ts", "process.ts", "checkout.ts", "webhook.controller.ts"]));
  });

  it("only the adapter originates outbound calls", () => {
    const offenders = files
      .map((rel) => ({ rel, hits: networkLines(readFileSync(join(ROOT, rel), "utf8")) }))
      .filter((f) => f.hits.length > 0 && !(f.rel in APPROVED_EGRESS))
      .map((f) => `${f.rel}:${f.hits.join(",")}`);
    expect(offenders).toEqual([]);
  });

  it("the adapter really does contain egress (a stale allowlist row is a lie)", () => {
    for (const rel of Object.keys(APPROVED_EGRESS)) {
      expect(networkLines(readFileSync(join(ROOT, rel), "utf8")).length).toBeGreaterThan(0);
    }
  });

  it("names no host but the provider's own four, all https", () => {
    for (const rel of files) {
      const urls = code(readFileSync(join(ROOT, rel), "utf8")).join("\n").match(/https?:\/\/[A-Za-z0-9.-]+/g) ?? [];
      const allowed = APPROVED_EGRESS[rel] ?? [];
      for (const u of urls) expect(allowed, `${rel} names ${u}`).toContain(u);
    }
    const pinned = Object.values(MIDTRANS_HOSTS).flatMap((h) => [h.snap, h.api]).sort();
    expect(pinned).toEqual([...APPROVED_EGRESS["midtrans.ts"]].sort());
  });

  it("never logs the server key", () => {
    const suspicious = /console\.(log|warn|error|info|debug)\([^)]*\b(serverKey|server_key|MIDTRANS_SERVER_KEY|authorization)\b/i;
    for (const rel of files) {
      code(readFileSync(join(ROOT, rel), "utf8")).forEach((line, i) => {
        expect(suspicious.test(line), `${rel}:${i + 1} looks like it logs the key: ${line.trim()}`).toBe(false);
      });
    }
  });
});

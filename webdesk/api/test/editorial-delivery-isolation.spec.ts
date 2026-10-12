// M5-W2b (writers' room design 4.6, D11) — /v1 never sees review data. Static, no database: nothing under
// src/delivery/** may name an editorial_* table or import the control/editorial modules, so no delivery response
// can carry review state, events, comments, assignees, policies or snapshots. (W2a's migration test does the
// table-name half; this adds the import half and the member names, now that the control code exists.)
// Also pins that the tenant-webhook layer has no editorial event kind.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("/v1 never sees review data", () => {
  const delivery = walk(join(SRC, "delivery"));

  it("finds the delivery sources (the scan is not vacuous)", () => {
    expect(delivery.length).toBeGreaterThan(5);
  });

  it("no delivery file names an editorial_* table", () => {
    const hits = delivery.filter((f) => /editorial_(policies|items|events|comments)/.test(strip(readFileSync(f, "utf8"))));
    expect(hits.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("no delivery file imports anything from control/editorial", () => {
    const hits = delivery.filter((f) => /from\s+["'][^"']*control\/editorial/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("no delivery file reads a review member (reviewRequired, seoSignoff, approvedVersion, authorSub)", () => {
    const hits = delivery.filter((f) => /\b(reviewRequired|seoSignoffRequired|approvedVersion|approved_version|submittedVersion|authorSub)\b/.test(strip(readFileSync(f, "utf8"))));
    expect(hits.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("the tenant-webhook layer has no editorial event kind (review data never leaves the control plane)", () => {
    const hits = walk(join(SRC, "tenant-webhooks")).filter((f) => /["'`]editorial\.|["'`]review\./.test(strip(readFileSync(f, "utf8"))));
    expect(hits.map((f) => relative(SRC, f))).toEqual([]);
  });
});

// WSK-48a — the vendored vocabulary under src/delivery/vocabulary/ must never silently diverge from
// the real source of truth, webdesk/payload/vocabulary/ (frozen, design §05). The copies are produced
// mechanically by src/delivery/vocabulary/vendor.mjs (LF + `.ts` import extensions stripped + a
// banner — nothing else); `--check` regenerates each file in memory and byte-compares it to what is
// committed. Same pattern as WSK-16's webdesk/blocks `vendor:check` + its vendor-drift test.
//
// This test needs the repo checkout (it reads ../payload/vocabulary). It stops being meaningful the
// day WSK-48b deletes webdesk/payload: at that point the vendored copy BECOMES the source of truth
// and this spec (plus vendor.mjs) should be deleted with it — see the WSK-48a report.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "..", "..");
const VENDOR = path.join(API_ROOT, "src", "delivery", "vocabulary", "vendor.mjs");
const SOURCE_DIR = path.resolve(API_ROOT, "..", "payload", "vocabulary");

describe("WSK-48a vocabulary vendoring", () => {
  it("every vendored file is exactly what vendor.mjs derives from webdesk/payload/vocabulary/", () => {
    expect(fs.existsSync(SOURCE_DIR), `${SOURCE_DIR} must exist in a repo checkout`).toBe(true);
    let out = "";
    try {
      out = execFileSync(process.execPath, [VENDOR, "--check"], { stdio: "pipe" }).toString();
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `vendored vocabulary has DRIFTED from webdesk/payload/vocabulary — run ` +
          `\`node src/delivery/vocabulary/vendor.mjs\` in webdesk/api and commit the result.\n` +
          `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`,
      );
    }
    // WSK-64: 7 read-path files + composition.ts + item-fields.ts (vocabulary 1.1.0).
    // WSK-41: + breaking-change.ts (schema.apply rates the change it commits).
    expect(out.match(/^OK /gm)?.length).toBe(10);
  });

  it("the check can fail: a mutated copy is reported as drift (negative control)", () => {
    const file = path.join(API_ROOT, "src", "delivery", "vocabulary", "cache-tags.ts");
    const original = fs.readFileSync(file, "utf8");
    try {
      fs.writeFileSync(file, original.replace("t:${input.tenantSlug}", "T:${input.tenantSlug}"));
      expect(() => execFileSync(process.execPath, [VENDOR, "--check"], { stdio: "pipe" })).toThrow();
    } finally {
      fs.writeFileSync(file, original);
    }
    expect(() => execFileSync(process.execPath, [VENDOR, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

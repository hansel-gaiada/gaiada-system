// MAIL-16D AC — "Zero persistence of message content anywhere (M14 pre-enforced in the fixture
// impl)". Two independent checks: (1) a STATIC source-text scan of every file in this seam for any
// filesystem/DB write primitive, so a future edit that adds one fails CI immediately rather than
// waiting to be caught by a runtime probe that might not exercise the exact code path added; (2) a
// RUNTIME probe that drives every `GmailClient` method through a full request cycle and confirms
// the on-disk fixture corpus is byte-identical before and after (nothing was written back) and that
// reads are pure (repeated reads return identical content). Node's `fs.writeFileSync` is a
// non-configurable export in this runtime, so it cannot be `vi.spyOn`'d directly — the mtime/byte
// comparison below is the equivalent runtime guarantee without relying on a spy that Node refuses
// to install.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureGmailClient } from "./fixture-client";

const SEAM_DIR = __dirname;
const FIXTURES_DIR = join(SEAM_DIR, "fixtures");

const FORBIDDEN_PATTERNS = [
  /\bfs\.write/, // fs.writeFile / fs.writeFileSync via a namespace import
  /\bwriteFile(Sync)?\s*\(/, // named import form
  /\bappendFile(Sync)?\s*\(/,
  /\bINSERT\s+INTO\b/i, // any accidental SQL literal
  /\bUPDATE\s+.+\bSET\b/i,
  /\bredis\b/i,
  /\bwithTenants\b/, // this seam has no DB access point at all — not even the house pg helper
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(join(dir, entry.name));
    if (!entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts")) return []; // test files themselves may legitimately use fs
    return [join(dir, entry.name)];
  });
}

describe("MAIL-16D — zero persistence (M14)", () => {
  it("static scan: no file in the gmail seam contains a write/DB primitive", () => {
    const files = sourceFiles(SEAM_DIR);
    expect(files.length).toBeGreaterThan(0); // guard against the scan silently finding nothing
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(pattern.test(text), `${file} matched forbidden pattern ${pattern}`).toBe(false);
      }
    }
  });

  describe("runtime: driving every method leaves the corpus and every read untouched", () => {
    function snapshotFixtureFiles(): Record<string, { size: number; mtimeMs: number; content: string }> {
      const out: Record<string, { size: number; mtimeMs: number; content: string }> = {};
      for (const name of readdirSync(FIXTURES_DIR)) {
        const full = join(FIXTURES_DIR, name);
        const st = statSync(full);
        out[name] = { size: st.size, mtimeMs: st.mtimeMs, content: readFileSync(full, "utf8") };
      }
      return out;
    }

    it("listThreads / getThread / getMessage / listLabels leave the on-disk fixture corpus byte-identical", async () => {
      const before = snapshotFixtureFiles();
      const client = createFixtureGmailClient({ pageSize: 2 });

      const page = await client.listThreads();
      await client.getThread(page.threads[0].id);
      await client.getMessage(page.threads[0].messageIds[0]);
      await client.listLabels();

      const after = snapshotFixtureFiles();
      expect(after).toEqual(before);
    });

    it("reading the same message twice returns byte-identical content (no mutation on read)", async () => {
      const client = createFixtureGmailClient();
      const page = await client.listThreads();
      const messageId = page.threads[0].messageIds[0];

      const first = await client.getMessage(messageId);
      const second = await client.getMessage(messageId);

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
  });
});

// MAIL-04 — A12 grep gate, wired into the suite (not just a manual `rg` run) so it re-runs on
// every CI pass, exactly like MAIL-18 is expected to re-assert later. Zero real-root-domain
// literals (the live `.com`/`.online` TLDs on the company's actual domain name) anywhere under
// `src/mail/` — tests and fixtures included. Every domain/FROM/link-base must come from config
// with a `*.gaiada.invalid` (reserved-TLD) compiled default. NOTE: this file deliberately never
// spells the forbidden string out literally in a comment (see the regex below for what it means)
// — doing so would trip this very gate.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Built from parts so this file's own source never contains the literal substring it forbids.
const FORBIDDEN = new RegExp(["gaiada", "\\.", "(com|online)"].join(""));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("mail — A12 grep gate", () => {
  it('rg -n "gaiada\\.(com|online)" src/mail/ returns ZERO matches', () => {
    const mailDir = join(__dirname); // this file lives at src/mail/grep-gate.test.ts
    const files = walk(mailDir);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

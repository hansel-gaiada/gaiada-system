// DW-8j (DW-D24, §48.1) — EXECUTABLE PROOF that the simulated mailbox cannot send anything off the box: a static scan of every file the
// simulated path is made of for a network, mail, process or filesystem primitive, and for any import of the live adapter. (The runtime half,
// "a full session makes no fetch call", is in simulated-mailboxes.test.ts; the wiring half, "simulated mode never builds the live client", is in
// core/gmail/gmail.test.ts.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The files a simulated mailbox is made of. api-client.ts (the live adapter) is deliberately NOT in this list.
const SIMULATED_FILES = ["fixture-client.ts", "simulated-mailboxes.ts", "send-validation.ts", "types.ts", "errors.ts"];

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "a fetch call"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/from\s+["'](?:node:)?(?:net|tls|http|https|http2|dgram|dns|child_process|worker_threads|cluster)["']/, "a node network or process module"],
  [/from\s+["'](?:node:)?fs(?:\/promises)?["']/, "the filesystem"],
  [/\b(?:nodemailer|undici|axios|got|node-fetch|ioredis|redis|pg)\b/i, "a mail, HTTP, cache or database library"],
  [/from\s+["']\.\/api-client["']/, "the live adapter"],
  [/from\s+["'][./]+(?:\.\.\/)*(?:db|mail|config)(?:\/[^"']*)?["']/, "the database, the mail module or the config"],
];

// Strip comments first: the headers of these files legitimately say "no `fetch`" in prose.
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("DW-8j — the simulated mailbox is isolated from every way out", () => {
  for (const file of SIMULATED_FILES) {
    it(`${file} contains no network, mail, process, filesystem, database or live-adapter reference`, () => {
      const text = code(readFileSync(join(__dirname, file), "utf8"));
      for (const [pattern, what] of FORBIDDEN) {
        expect(pattern.test(text), `${file} matched ${what} (${pattern})`).toBe(false);
      }
    });
  }

  it("the scan is not vacuous: every pattern fires on a sample of what it forbids, and the live adapter is outside the scanned list", () => {
    const samples = [
      "await fetch(url)", "new XMLHttpRequest()", 'import net from "node:net"', 'import { readFileSync } from "node:fs"',
      'import nodemailer from "nodemailer"', 'import { createGmailApiClient } from "./api-client"', 'import { withTenants } from "../../db"',
    ];
    FORBIDDEN.forEach(([pattern], i) => expect(pattern.test(samples[i]), String(pattern)).toBe(true));
    expect(SIMULATED_FILES).not.toContain("api-client.ts");
    // and the live adapter really is the file that reaches for the network
    expect(code(readFileSync(join(__dirname, "api-client.ts"), "utf8"))).toMatch(/globalThis\.fetch/);
  });

  it("the only Node import in the simulated path is crypto, for ids", () => {
    for (const file of SIMULATED_FILES) {
      const imports = [...code(readFileSync(join(__dirname, file), "utf8")).matchAll(/from\s+["'](node:[^"']+)["']/g)].map((m) => m[1]);
      for (const i of imports) expect(i, file).toBe("node:crypto");
    }
  });
});

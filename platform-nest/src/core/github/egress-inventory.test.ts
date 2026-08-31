// GH-01 §4.9 — the egress inventory for src/core/github/, the SM-39 §A5 / WD-23A-1 pattern applied
// here (see core/google-oauth/egress.test.ts's header for the full rationale — this is a direct copy
// of that discipline, not a new one):
//   1. exactly ONE file originates outbound network calls: http-client.ts (both the token exchange
//      AND the general API request wrapper live there together — see that file's own header for why
//      splitting them would only move the fetch call, not eliminate a second egress point).
//   2. no OTHER file in this directory references `fetch` at all — jwt.ts, token-cache.ts,
//      rate-limiter.ts, apps.ts, credential-store.ts, errors.ts, github-app.service.ts are all pure
//      or DB-only.
//   3. §2.3's absolute rule made mechanical: no production file (test files excluded, same rule as
//      the original) contains what LOOKS like a minted installation token or a raw PEM body — the
//      literal strings this subsystem's whole design exists to keep out of logs/responses.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = __dirname;

const APPROVED_EGRESS: Record<string, string> = {
  "http-client.ts":
    "GitHub REST API (api.github.com): the installation-token exchange (§2.3) and every subsequent " +
    "authenticated call (§4.7). The one chokepoint (§4.1) — no other file here or in github-app.service.ts " +
    "constructs its own fetch.",
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

/** Same detector as core/google-oauth/egress.test.ts — matches any `xFetch(` call plus the
 *  `?? fetch` default-injection idiom, not just a bare `fetch(`, because that file's own history
 *  records a detector that missed the real call by being narrower than this. */
// ⚠ EVERY comment-strip in this file splits on /\r?\n/, never on "\n". A plain "\n" split leaves a
// trailing "\r" on a CRLF checkout, and `.` in a JS regex does NOT match "\r" — so
// `line.replace(/\/\/.*$/, "")` silently strips NOTHING, leaving this file's own explanatory prose
// in the scanned text. That produced a real false positive: the toJSON check below tripped on the
// WORDS "toJSON()" inside the comment that exists to explain why there is no toJSON override.
// It reproduces on any fresh Windows checkout (git converts to CRLF) and not on Linux CI, which is
// the worst shape for a hygiene test — it fails where nobody is looking and passes where they are.
function networkLines(text: string): number[] {
  const lines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/typeof\s+fetch/g, "");
    if (/\b\w*[fF]etch\w*\s*\(/.test(code) || /\?\?\s*fetch\b/.test(code)) lines.push(i + 1);
  });
  return lines;
}

describe("core/github egress inventory (GH-01 §4.9, mirroring SM-39 §A5)", () => {
  const files = productionFiles(ROOT);

  it("the scanner actually walked files — one that finds nothing proves nothing", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("http-client.ts");
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
});

describe("core/github secret hygiene (§2.3, §4.9 — extended per the blueprint's PEM/token instruction)", () => {
  const files = productionFiles(ROOT);

  it("no production file contains a hardcoded PEM body (a real key accidentally committed)", () => {
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      // A real PEM body is many base64 lines; a match on the BEGIN marker followed by actual key
      // material (not merely the marker string appearing in a comment/type, which errors.ts and
      // credential-store.ts's own doc comments legitimately do) is the signal. Look for the marker
      // immediately followed by base64-looking content on the same or next non-comment line.
      const beginIdx = text.indexOf("-----BEGIN");
      if (beginIdx === -1) continue;
      const after = text.slice(beginIdx, beginIdx + 400);
      const looksLikeRealKeyMaterial = /-----BEGIN [A-Z ]+-----\s*\n[A-Za-z0-9+/=]{40,}/.test(after);
      expect(looksLikeRealKeyMaterial, `${rel} appears to contain real PEM key material`).toBe(false);
    }
  });

  it("no production file logs a token/PEM/secret variable via console.*", () => {
    const suspicious = /console\.(log|warn|error|info|debug)\([^)]*\b(pem|privateKeyPem|token|jwt|secret)\b/i;
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        expect(suspicious.test(code), `${rel}:${i + 1} looks like it logs secret material: ${line.trim()}`).toBe(false);
      });
    }
  });

  it("InstallationTokenCache and the credential-loading types carry no toJSON/inspect override that would make a stray log safe (i.e. lull a developer into logging them)", () => {
    // Strip line comments first — this file's own doc comment explains, in prose, why no such
    // override exists, which would otherwise trip this exact check on the WORDS "toJSON(" appearing
    // in an English sentence rather than in code.
    const code = readFileSync(join(ROOT, "token-cache.ts"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(code).not.toMatch(/toJSON\s*\(/);
    expect(code).not.toMatch(/\[util\.inspect\.custom\]/);
  });

  it("GithubSurfaceError.detail never carries the literal field names access_token_enc/refresh_token_enc/privateKeyPem", () => {
    const text = readFileSync(join(ROOT, "errors.ts"), "utf8");
    for (const forbidden of ["access_token_enc", "refresh_token_enc", "privateKeyPem"]) {
      expect(text, `errors.ts must not surface ${forbidden} in a detail object`).not.toContain(forbidden);
    }
  });
});

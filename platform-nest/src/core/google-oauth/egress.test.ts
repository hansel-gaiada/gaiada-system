// The CORE half of SM-39's egress inventory (design addendum §A5), created by WD-23A-1.
//
// `modules/search/egress-inventory.test.ts` answers "what in the search module talks outward". When the
// Google OAuth token client moved into core, that scanner legitimately stopped owning it — its scope is
// production files under `src/modules/search/`. Deleting the row and stopping there would have quietly
// retired a security control during a refactor, which is the failure this file prevents: the guarantee
// moved WITH the code instead of evaporating.
//
// Same two properties as the search original, applied to `src/core/google-oauth/`:
//   1. exactly ONE file here originates outbound network calls, and it is the token endpoint client;
//   2. it reads its OWN config namespace (`config.google`) and no other vendor namespace — the
//      cross-contamination guard, so this file cannot quietly gain a second egress target.
//
// Static, not dynamic, for the reason the original states at length: an AST walk sees every call site
// that EXISTS, executed or not, whereas a runtime fetch trace only proves what the fixtures happened to
// reach.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { GOOGLE_DRIVE_API_HOST, isDriveApiUrl, isGoogleHost } from "./hosts";

const ROOT = __dirname;

/** The one file allowed to talk outward from core/google-oauth, and why. */
const APPROVED_EGRESS: Record<string, string> = {
  "token-endpoint-client.ts":
    "Google OAuth issuer: authorization-code exchange, refresh, RFC-7009 revocation (config.google). " +
    "Client-private, $0 — no vendor meter, so no USD ledger row.",
};

/** Namespaces that would indicate cross-contamination if this file referenced them. */
const FOREIGN_CONFIG_NAMESPACES = [
  "config.services.gateway",
  "config.services.knowledge",
  "config.search.dataforseo",
  "config.search.semrush",
  "config.search.ahrefs",
];

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionFiles(full));
      continue;
    }
    // Test files legitimately hold fetch-shaped fakes; including them would make this test's own
    // fixtures the majority of its findings — the original's reasoning, kept.
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(relative(ROOT, full).split("\\").join("/"));
  }
  return out;
}

/** A network reference.
 *
 *  Deliberately wider than `fetch(`, because the first version of this detector MISSED the real call and
 *  this suite's own "a stale allowlist row is a lie" test caught it: the token client does
 *  `const doFetch = fetchImpl ?? fetch;` and then calls `doFetch(...)`. A detector matching only
 *  `fetch(` reported ZERO egress in the one file that has it — passing the allowlist while proving
 *  nothing, which is precisely the failure mode this suite exists to prevent.
 *
 *  So: any CALL whose callee name ends in fetch/Fetch (`fetch(`, `doFetch(`, `fetchImpl(`), plus the
 *  `?? fetch` default-injection idiom that turns the global into a local. `typeof fetch` is stripped
 *  first — that is a TYPE reference (the `FetchImpl` alias), not an outbound call, and counting it would
 *  flag every file that merely passes the seam through. */
function networkLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/typeof\s+fetch/g, "");
    if (/\b\w*[fF]etch\w*\s*\(/.test(code) || /\?\?\s*fetch\b/.test(code)) lines.push(i + 1);
  });
  return lines;
}

describe("core/google-oauth egress inventory (WD-23A-1, mirroring SM-39 §A5)", () => {
  const files = productionFiles(ROOT);

  it("the scanner actually walked files — one that finds nothing proves nothing", () => {
    // The original's own sanity clause. Without it, a broken path would render every assertion vacuous.
    expect(files.length).toBeGreaterThan(3);
    expect(files).toContain("token-endpoint-client.ts");
  });

  it("only the approved file originates outbound calls", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const hits = networkLines(readFileSync(join(ROOT, rel), "utf8"));
      if (hits.length && !(rel in APPROVED_EGRESS)) offenders.push(`${rel}:${hits.join(",")}`);
    }
    // Fails BY NAME on the next run if someone adds a fetch to state.ts, flow.ts or the registry.
    expect(offenders).toEqual([]);
  });

  it("the approved file really does contain egress — a stale allowlist row is a lie", () => {
    // The exact defect this file was born from: the search inventory kept listing a path that had become
    // a 4-line shim, so the row asserted nothing while looking like coverage.
    for (const rel of Object.keys(APPROVED_EGRESS)) {
      expect(files, `${rel} is listed as approved egress but was not found`).toContain(rel);
      const hits = networkLines(readFileSync(join(ROOT, rel), "utf8"));
      expect(hits.length, `${rel} is listed as approved egress but contains no network reference`).toBeGreaterThan(0);
    }
  });

  it("the token client reads its OWN config namespace and no foreign one", () => {
    const text = readFileSync(join(ROOT, "token-endpoint-client.ts"), "utf8");
    expect(text).toContain("config.google");
    for (const ns of FOREIGN_CONFIG_NAMESPACES) {
      expect(text, `token-endpoint-client.ts must not reference ${ns}`).not.toContain(ns);
    }
  });
});

// ── DW-6i · Google Drive's API host is allowed DELIBERATELY ─────────────────────────────────────────
// Drive's `files.get` carries a person's access token to www.googleapis.com. That host is added here by name (hosts.ts:
// GOOGLE_DRIVE_API_HOST + isDriveApiUrl), not by the loose `.googleapis.com` suffix, and these tests pin both what passes and
// the look-alikes that must not. The fetch itself lives in core/google-drive/client.ts, whose own egress.test.ts pins that it is
// the only file there that talks to the network.
describe("DW-6i · the Drive API host allow-list", () => {
  it("Drive's documented files.get URL is allowed", () => {
    expect(isDriveApiUrl("https://www.googleapis.com/drive/v3/files/1AbC_dEf-GhIj?fields=id,name,mimeType,webViewLink")).toBe(true);
    expect(GOOGLE_DRIVE_API_HOST).toBe("www.googleapis.com");
  });
  it("the same host is also recognised as Google's by the label predicate", () => {
    expect(isGoogleHost("https://www.googleapis.com/drive/v3/files/x")).toBe(true);
  });
  it("refuses every look-alike, another scheme, another path and embedded credentials", () => {
    const bad = [
      "http://www.googleapis.com/drive/v3/files/x",
      "https://www.googleapis.com.evil.test/drive/v3/files/x",
      "https://evil.test/www.googleapis.com/drive/v3/files/x",
      "https://evilwww.googleapis.com/drive/v3/files/x",
      "https://drive.googleapis.com/drive/v3/files/x",
      "https://googleapis.com/drive/v3/files/x",
      "https://www.googleapis.com@evil.test/drive/v3/files/x",
      "https://user:pw@www.googleapis.com/drive/v3/files/x",
      "https://www.googleapis.com:8443/drive/v3/files/x",
      "https://www.googleapis.com/oauth2/v1/userinfo",
      "https://www.googleapis.com/upload/drive/v3/files",
      "javascript:alert(1)",
      "not a url",
      "",
    ];
    for (const u of bad) expect(isDriveApiUrl(u), u).toBe(false);
  });
  it("the shared token client still refuses to be the Drive client: it never names the Drive host", () => {
    const text = readFileSync(join(ROOT, "token-endpoint-client.ts"), "utf8");
    expect(text).not.toContain("drive/v3");
  });
  it("id-token.ts is pure: it has no network reference at all", () => {
    expect(networkLines(readFileSync(join(ROOT, "id-token.ts"), "utf8"))).toEqual([]);
  });
});

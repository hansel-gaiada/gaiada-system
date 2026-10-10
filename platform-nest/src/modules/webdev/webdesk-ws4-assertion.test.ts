// WSK-63b — the ERP's WS4 minting, pinned to WebDesk's verifier by SHARED LITERALS.
//
// The vectors below appear verbatim in `webdesk/api/test/ws4-assertion-vectors.spec.ts`, which runs
// them through WebDesk's real `computeCommandHash` / `mintWs4Assertion` / `verifyWs4Signature`. If
// either side drifts, the test on the side that drifted fails. Change a literal only on both sides.
//
// Pure: no database, no Cerbos, no network.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandArgsAsZoneBSeesThem,
  computeCommandHash,
  mintWs4Assertion,
  mintWs4ForCommand,
} from "./webdesk-ws4-assertion";

const WS4_COMMAND_HASH_VECTORS = [
  {
    name: "flat route params (tenant.archive)",
    command: "tenant.archive",
    args: { tenantSlug: "acme" },
    hash: "3ba7dad4d2e8cdc9f210754d5af57f23ef6b758cc14e80c58088458d4840288b",
  },
  {
    name: "nested object, unsorted keys, array order kept, escaped unicode (release.promote)",
    command: "release.promote",
    args: {
      tenantSlug: "gaiada",
      envId: "env_01",
      releaseId: "rel-2026.10.10",
      options: { tags: ["b", "a"], notes: 'Rilis "Ü" ✓\n', dryRun: false },
    },
    hash: "d8bbaf983865c34d6634bdddb493ed80a2e2712046bc9b71ac4fe93c51f0a7d2",
  },
  {
    name: "array of objects, null, fraction, negative zero (key.rotate)",
    command: "key.rotate",
    args: { tenantSlug: "t-1", apiKeyId: "k_9", scopes: [{ z: 1, a: 2 }, { m: null }], ratio: 0.5, n: -0 },
    hash: "fdfb9f8869879277a305ce23050a0f9c298a8273712bf0a456954dcc8b3454cb",
  },
] as const;

const WS4_MINT_VECTOR = {
  key: "wsk63b-vector-key-not-a-secret",
  claims: {
    approvalId: "00000000-0000-4000-8000-000000000063",
    commandHash: "3ba7dad4d2e8cdc9f210754d5af57f23ef6b758cc14e80c58088458d4840288b",
    exp: 4102444800, // 2100-01-01T00:00:00Z
  },
  header:
    "eyJhcHByb3ZhbElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDYzIiwiY29tbWFuZEhhc2giOiIzYmE3ZGFkNGQyZThjZGM5ZjIxMDc1NGQ1YWY1N2YyM2VmNmI3NThjYzE0ZTgwYzU4MDg4NDU4ZDQ4NDAyODhiIiwiZXhwIjo0MTAyNDQ0ODAwfQ" +
    ".b4f68d0a2068e7b409aab28e688d3b306658d194adeafcb6ecc46e90129ff748",
} as const;

describe("WSK-63b WS4 minting (ERP side) — shared vectors", () => {
  for (const v of WS4_COMMAND_HASH_VECTORS) {
    it(`computeCommandHash: ${v.name}`, () => {
      expect(computeCommandHash(v.command, v.args)).toBe(v.hash);
    });
  }

  it("mintWs4Assertion produces the pinned header bytes", () => {
    expect(mintWs4Assertion({ ...WS4_MINT_VECTOR.claims }, WS4_MINT_VECTOR.key)).toBe(WS4_MINT_VECTOR.header);
  });

  it("mintWs4ForCommand builds the claims in WebDesk's key order and lands on the same bytes", () => {
    const header = mintWs4ForCommand({
      key: WS4_MINT_VECTOR.key,
      approvalId: WS4_MINT_VECTOR.claims.approvalId,
      command: "tenant.archive",
      args: { tenantSlug: "acme" },
      nowSec: WS4_MINT_VECTOR.claims.exp - 60,
      ttlSec: 60,
    });
    expect(header).toBe(WS4_MINT_VECTOR.header);
  });

  it("the payload is exactly {approvalId, commandHash, exp} in that order, and the signature is lowercase hex", () => {
    const [payload, sig] = WS4_MINT_VECTOR.header.split(".");
    expect(Buffer.from(payload, "base64url").toString("utf8")).toBe(JSON.stringify(WS4_MINT_VECTOR.claims));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to mint without a key, an approvalId, or with an out-of-range TTL", () => {
    const base = { key: "k", approvalId: "a", command: "tenant.archive", args: {} };
    expect(() => mintWs4ForCommand({ ...base, key: "" })).toThrow(/no assertion key/);
    expect(() => mintWs4ForCommand({ ...base, approvalId: "" })).toThrow(/approvalId/);
    expect(() => mintWs4ForCommand({ ...base, ttlSec: 0 })).toThrow(/ttlSec/);
    expect(() => mintWs4ForCommand({ ...base, ttlSec: 301 })).toThrow(/ttlSec/);
    expect(() => mintWs4ForCommand({ ...base, ttlSec: 1.5 })).toThrow(/ttlSec/);
  });
});

describe("WSK-63b commandArgsAsZoneBSeesThem — the args WebDesk's guard will hash", () => {
  it("merges params FIRST and body SECOND (a body key wins), like `{...request.params, ...request.body}`", () => {
    expect(commandArgsAsZoneBSeesThem({ tenantSlug: "acme", envId: "e1" }, { envId: "body-wins", x: 1 })).toEqual({
      tenantSlug: "acme",
      envId: "body-wins",
      x: 1,
    });
  });

  it("hashes the body as it will look on the wire (JSON round-trip), not as it looks in memory", () => {
    const when = new Date("2026-10-10T00:00:00.000Z");
    const args = commandArgsAsZoneBSeesThem({ tenantSlug: "acme" }, { dropped: undefined, when, nested: { u: undefined, k: 1 } });
    expect(args).toEqual({ tenantSlug: "acme", when: "2026-10-10T00:00:00.000Z", nested: { k: 1 } });
    expect(Object.prototype.hasOwnProperty.call(args, "dropped")).toBe(false);
    // The same hash WebDesk computes from the parsed request body.
    const parsed = { tenantSlug: "acme", ...JSON.parse(JSON.stringify({ dropped: undefined, when, nested: { u: undefined, k: 1 } })) };
    expect(computeCommandHash("release.promote", args)).toBe(computeCommandHash("release.promote", parsed));
  });

  it("no body ⇒ params only", () => {
    expect(commandArgsAsZoneBSeesThem({ tenantSlug: "acme" }, undefined)).toEqual({ tenantSlug: "acme" });
  });
});

// Source drift: the three primitives must be statement-for-statement WebDesk's. Behavioural vectors
// catch most drift; this catches the rest (e.g. a canonicalize() change no vector happens to hit).
// Runs whenever the webdesk tree sits beside platform-nest (the repo layout); skipped visibly otherwise.
const WEBDESK_WS4 = join(__dirname, "../../../../webdesk/api/src/control/auth/ws4-assertion.ts");

function fnSource(text: string, signature: string): string {
  const t = text.replace(/\r\n/g, "\n");
  const start = t.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  const end = t.indexOf("\n}\n", start);
  return t.slice(start, end + 2);
}

describe("WSK-63b WS4 primitives are a verbatim copy of WebDesk's", () => {
  it.skipIf(!existsSync(WEBDESK_WS4))("mintWs4Assertion, computeCommandHash and canonicalize match webdesk/api byte for byte", () => {
    const theirs = readFileSync(WEBDESK_WS4, "utf8");
    const ours = readFileSync(join(__dirname, "webdesk-ws4-assertion.ts"), "utf8");
    for (const sig of [
      "export function mintWs4Assertion(",
      "export function computeCommandHash(",
      "function canonicalize(value: unknown): string {",
    ]) {
      expect(fnSource(ours, sig), sig).toBe(fnSource(theirs, sig));
    }
  });
});

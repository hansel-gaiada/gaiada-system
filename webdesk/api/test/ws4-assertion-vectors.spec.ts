// WSK-63b — the WS4 wire format pinned by fixed vectors, asserted on BOTH sides of the control channel.
//
// The ERP mints (`platform-nest/src/modules/webdev/webdesk-ws4-assertion.ts`); this repo verifies
// (`src/control/auth/ws4-assertion.ts`). The two cannot share code, so they share LITERALS: the three
// `computeCommandHash` vectors and the one minted header below appear verbatim in
// `platform-nest/src/modules/webdev/webdesk-ws4-assertion.test.ts`. If either implementation drifts,
// the test on the side that drifted fails. Change a literal here only together with that file.
//
// Pure: no database, no app, no network. It only imports ws4-assertion.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeCommandHash, mintWs4Assertion, verifyWs4Signature } from "../src/control/auth/ws4-assertion";

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
    exp: 4102444800, // 2100-01-01T00:00:00Z, so the literal stays verifiable
  },
  header:
    "eyJhcHByb3ZhbElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDYzIiwiY29tbWFuZEhhc2giOiIzYmE3ZGFkNGQyZThjZGM5ZjIxMDc1NGQ1YWY1N2YyM2VmNmI3NThjYzE0ZTgwYzU4MDg4NDU4ZDQ4NDAyODhiIiwiZXhwIjo0MTAyNDQ0ODAwfQ" +
    ".b4f68d0a2068e7b409aab28e688d3b306658d194adeafcb6ecc46e90129ff748",
} as const;

describe("WSK-63b WS4 cross-repo vectors (Zone B side)", () => {
  for (const v of WS4_COMMAND_HASH_VECTORS) {
    it(`computeCommandHash: ${v.name}`, () => {
      expect(computeCommandHash(v.command, v.args)).toBe(v.hash);
    });
  }

  it("mintWs4Assertion produces the pinned header bytes", () => {
    expect(mintWs4Assertion({ ...WS4_MINT_VECTOR.claims }, WS4_MINT_VECTOR.key)).toBe(WS4_MINT_VECTOR.header);
  });

  it("verifyWs4Signature accepts the pinned header (the ERP mints this exact string)", () => {
    const r = verifyWs4Signature(WS4_MINT_VECTOR.header, WS4_MINT_VECTOR.key);
    expect(r).toEqual({ ok: true, claims: WS4_MINT_VECTOR.claims });
  });

  it("negative control: the same header under a different key is refused", () => {
    const r = verifyWs4Signature(WS4_MINT_VECTOR.header, `${WS4_MINT_VECTOR.key}x`);
    expect(r.ok).toBe(false);
  });

  // Live cross-check: the ERP test writes a FRESHLY minted assertion (real clock, random approvalId,
  // args built the way the ERP client builds them) when WSK63B_WS4_FIXTURE_OUT is set; pointing this
  // variable at that file verifies it here with the real verifier and recomputes the hash from args.
  // Skipped (visibly) when the variable is unset.
  const fixturePath = process.env.WSK63B_WS4_FIXTURE_IN;
  it.skipIf(!fixturePath)("an assertion minted by platform-nest verifies with the real verifyWs4Signature", () => {
    const f = JSON.parse(readFileSync(fixturePath as string, "utf8")) as {
      key: string;
      header: string;
      command: string;
      args: unknown;
      approvalId: string;
    };
    const r = verifyWs4Signature(f.header, f.key);
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.claims.approvalId).toBe(f.approvalId);
    expect(r.claims.commandHash).toBe(computeCommandHash(f.command, f.args));
    const now = Math.floor(Date.now() / 1000);
    expect(r.claims.exp).toBeGreaterThan(now);
    expect(r.claims.exp - now).toBeLessThanOrEqual(60);
  });
});

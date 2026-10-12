// M6-P4o — WebDesk's side of the content-hash parity pin.
//
// The ERP's mirror recomputes `contentHash` over the artifact bytes it fetches and refuses a pin on any difference
// (platform-nest `contract-snapshot.service.ts`, `contentHashFromDigests`). Until 2026-10-13 the two sides hashed
// different text (the ERP: compact JSON with key `openapi`), so no live pin ever passed. These constants are the
// live values read that day (tenant `m6-gate-static-prd`, contract 1.0.0); the ERP's
// `contract-content-hash.test.ts` pins the same ones. If this generator's canonical form ever changes, this fails
// here, and the ERP must change in the same release.
import { describe, expect, it } from "vitest";
import { stableStringify, sha256Hex } from "../src/codegen/generator/canonical-json.mts";

const LIVE_DIGESTS = {
  openapiJson: "7cd0939f367bf3186cdd111a6f7d50ed7368cf4d3d80a5b9d03711c90dec0a6c",
  sdkTs: "4e4a64a13d6c275db3f2392c64f8f96a8ba8fb20088b2dfd425b6cd3432e4ce1",
  sdkPhp: "c050df39cc2674cc93fb3a29047d844c6e29ce494a0b314baeaa0077c24d6b05",
  contractMd: "bc3dde251995424e092c6a5ee6968ebb874dce4dcd5cda36a10d3aba7bc09f5e",
};
const LIVE_CONTENT_HASH = "sha256:a0e75f24e6fe0d757a65eea1a7037c292195139afbab5aaef0e5582c72492a73";

describe("contract contentHash canonical form (parity with the ERP mirror, M6-P4o)", () => {
  it("hashes stableStringify of the four digests to the value the ERP pins", () => {
    // The same construction as build-artifacts.mts: `sha256:` + sha256Hex(stableStringify(hashes)).
    expect(`sha256:${sha256Hex(stableStringify(LIVE_DIGESTS))}`).toBe(LIVE_CONTENT_HASH);
  });

  it("stableStringify is sorted keys, 2-space indent and a trailing newline (what the ERP reproduces)", () => {
    expect(stableStringify({ b: "2", a: "1" })).toBe('{\n  "a": "1",\n  "b": "2"\n}\n');
  });
});

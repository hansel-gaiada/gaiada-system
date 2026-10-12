// M6-P4o — the mirror's content hash must be WebDesk's content hash, byte for byte.
//
// The golden values below were read from the LIVE WebDesk on 2026-10-13 over the four-layer control channel
// (tenant `m6-gate-static-prd`, contract 1.0.0, the M6 P4 gate's throwaway site): the four per-artifact sha256
// digests of the bytes `contract.read`'s artifact route served, and the `contentHash` WebDesk claimed for them.
// The ERP's old form (compact JSON, key `openapi`) produced sha256:5618a218… for the same digests, so every live pin
// was refused as `hash_mismatch`. `webdesk/api/test/contract-content-hash-parity.spec.ts` pins the same constants
// against WebDesk's own `stableStringify`, so a change on either side fails a test on that side.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { computeContentHash, contentHashFromDigests } from "./contract-snapshot.service";

const LIVE = {
  digests: {
    contractMd: "bc3dde251995424e092c6a5ee6968ebb874dce4dcd5cda36a10d3aba7bc09f5e",
    openapi: "7cd0939f367bf3186cdd111a6f7d50ed7368cf4d3d80a5b9d03711c90dec0a6c",
    sdkPhp: "c050df39cc2674cc93fb3a29047d844c6e29ce494a0b314baeaa0077c24d6b05",
    sdkTs: "4e4a64a13d6c275db3f2392c64f8f96a8ba8fb20088b2dfd425b6cd3432e4ce1",
  },
  contentHash: "sha256:a0e75f24e6fe0d757a65eea1a7037c292195139afbab5aaef0e5582c72492a73",
};

describe("contract content hash = WebDesk's (M6-P4o)", () => {
  it("reproduces the hash the live WebDesk claimed for those exact digests", () => {
    expect(contentHashFromDigests(LIVE.digests)).toBe(LIVE.contentHash);
  });

  it("is NOT the old ERP form (compact JSON, key `openapi`), which no live pin could ever pass", () => {
    const old = JSON.stringify(LIVE.digests, Object.keys(LIVE.digests).sort());
    expect(`sha256:${createHash("sha256").update(old, "utf8").digest("hex")}`).not.toBe(LIVE.contentHash);
  });

  it("computeContentHash hashes the artifact bytes the same way, and keeps the ERP's own manifest keys", () => {
    const set = { contractMd: Buffer.from("# c\n"), openapi: Buffer.from("{}\n"), sdkPhp: Buffer.from("<?php\n"), sdkTs: Buffer.from("export {};\n") };
    const { manifest, contentHash } = computeContentHash(set);
    expect(Object.keys(manifest).sort()).toEqual(["contractMd", "openapi", "sdkPhp", "sdkTs"]);
    expect(contentHash).toBe(
      contentHashFromDigests({ contractMd: manifest.contractMd!, openapi: manifest.openapi!, sdkPhp: manifest.sdkPhp, sdkTs: manifest.sdkTs! }),
    );
  });

  it("hashes exactly WebDesk's stableStringify text: sorted keys, 2-space indent, trailing newline, openapiJson", () => {
    const text =
      "{\n" +
      `  "contractMd": "${LIVE.digests.contractMd}",\n` +
      `  "openapiJson": "${LIVE.digests.openapi}",\n` +
      `  "sdkPhp": "${LIVE.digests.sdkPhp}",\n` +
      `  "sdkTs": "${LIVE.digests.sdkTs}"\n` +
      "}\n";
    expect(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`).toBe(LIVE.contentHash);
  });

  it("omits sdkPhp from the manifest when a generation has none (WebDesk before WSK-34 had no such key)", () => {
    const { sdkPhp: _drop, ...three } = LIVE.digests;
    const text = JSON.stringify({ contractMd: three.contractMd, openapiJson: three.openapi, sdkTs: three.sdkTs }, null, 2) + "\n";
    expect(contentHashFromDigests({ ...three, sdkPhp: null })).toBe(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`);
  });
});

// M6-P4b0 -- ContractReadService answers `artifacts.blockLibraryUrl`: presigned when the pointer names the shared
// object, `null` for an older pointer (additive, the WSK-34 sdkPhpUrl precedent). NO services: a fake StorageAdapter.
import { describe, expect, it } from "vitest";
import { ContractReadService } from "../src/codegen/contract-read.service";
import type { StorageAdapter } from "../src/storage/storage.types";
import type { LatestContractPointer } from "../src/codegen/contract-manifest.types";

function pointer(extra: Partial<LatestContractPointer> = {}, keys: Record<string, string> = {}): LatestContractPointer {
  return {
    contractVersion: "1.0.0",
    vocabularyVersion: "1.2.0",
    blockLibrary: { package: "@gaiada/webdesk-blocks", version: "0.1.0", range: "^0.1.0" },
    contentHash: `sha256:${"c".repeat(64)}`,
    generatedAt: "2026-10-12T00:00:00.000Z",
    artifactKeys: {
      openapiJson: "contracts/acme/1.0.0/openapi.v1.json",
      sdkTs: "contracts/acme/1.0.0/sdk.d.ts",
      sdkPhp: "contracts/acme/1.0.0/sdk.php",
      contractMd: "contracts/acme/1.0.0/CONTENT-CONTRACT.md",
      ...keys,
    },
    hashes: { openapiJson: "a", sdkTs: "b", sdkPhp: "c", contractMd: "d" },
    compositionSnapshot: {},
    ...extra,
  };
}

function fakeStorage(p: LatestContractPointer): { storage: StorageAdapter; presigned: string[] } {
  const presigned: string[] = [];
  const storage = {
    providerName: "fake",
    headObject: async () => ({}),
    getObject: async () => ({ body: Buffer.from(JSON.stringify(p)) }),
    presignGetObject: async (_b: string, key: string) => {
      presigned.push(key);
      return `https://rustfs.example/${key}?X-Amz-Signature=sig`;
    },
  } as unknown as StorageAdapter;
  return { storage, presigned };
}

describe("ContractReadService: artifacts.blockLibraryUrl", () => {
  it("is a presigned URL for the SHARED key when the pointer names one", async () => {
    const key = "blocks/0.1.0/gaiada-webdesk-blocks-0.1.0.tgz";
    const { storage, presigned } = fakeStorage(pointer({ blockLibrarySha256: "e".repeat(64) }, { blockLibrary: key }));
    const res = await new ContractReadService(storage).readLatest("acme");
    expect(res!.artifacts.blockLibraryUrl).toBe(`https://rustfs.example/${key}?X-Amz-Signature=sig`);
    expect(res!.artifacts.blockLibrarySha256).toBe("e".repeat(64));
    expect(presigned).toContain(key);
    // The four existing artifacts are untouched.
    expect(res!.artifacts.sdkTsUrl).toContain("contracts/acme/1.0.0/sdk.d.ts");
    expect(res!.artifacts.sdkPhpUrl).toContain("contracts/acme/1.0.0/sdk.php");
    expect(res!.artifacts.openapiUrl).toContain("openapi.v1.json");
    expect(res!.artifacts.contractMdUrl).toContain("CONTENT-CONTRACT.md");
    expect(res!.blockLibrary).toEqual({ package: "@gaiada/webdesk-blocks", version: "0.1.0", range: "^0.1.0" });
  });

  it("is null for a pointer written before M6-P4b0 (no artifactKeys.blockLibrary), and nothing is presigned for it", async () => {
    const { storage, presigned } = fakeStorage(pointer());
    const res = await new ContractReadService(storage).readLatest("acme");
    expect(res!.artifacts.blockLibraryUrl).toBeNull();
    expect(res!.artifacts.blockLibrarySha256).toBeNull();
    expect(presigned.some((k) => k.startsWith("blocks/"))).toBe(false);
    expect(res!.artifacts.sdkTsUrl).toContain("sdk.d.ts");
  });

  // M6-P4b0b — artifacts.blockLibrarySha256: the pointer's own value, only when a tarball is named and it is 64 lowercase hex.
  describe("artifacts.blockLibrarySha256", () => {
    const key = "blocks/0.1.0/gaiada-webdesk-blocks-0.1.0.tgz";
    const read = async (extra: Partial<LatestContractPointer>, keys: Record<string, string> = { blockLibrary: key }) =>
      (await new ContractReadService(fakeStorage(pointer(extra, keys)).storage).readLatest("acme"))!;

    it("is the pointer's hash when a tarball is named and the value is 64 lowercase hex", async () => {
      const hash = "0123456789abcdef".repeat(4);
      expect((await read({ blockLibrarySha256: hash })).artifacts.blockLibrarySha256).toBe(hash);
    });

    it("is null when the pointer names a tarball but records no hash (never fabricated)", async () => {
      const res = await read({});
      expect(res.artifacts.blockLibraryUrl).not.toBeNull();
      expect(res.artifacts.blockLibrarySha256).toBeNull();
    });

    it("is null when no tarball is named, even if the pointer carries a hash", async () => {
      const res = await read({ blockLibrarySha256: "e".repeat(64) }, {});
      expect(res.artifacts.blockLibraryUrl).toBeNull();
      expect(res.artifacts.blockLibrarySha256).toBeNull();
    });

    it.each([
      ["too short", "e".repeat(63)],
      ["too long", "e".repeat(65)],
      ["uppercase", "E".repeat(64)],
      ["non-hex", "g".repeat(64)],
      ["sha256:-prefixed", `sha256:${"e".repeat(64)}`],
      ["empty", ""],
      ["not a string", 12345 as unknown as string],
    ])("is null for a malformed pointer value (%s)", async (_label, bad) => {
      const res = await read({ blockLibrarySha256: bad });
      expect(res.artifacts.blockLibraryUrl).not.toBeNull(); // the URL is unaffected; only the hash is withheld
      expect(res.artifacts.blockLibrarySha256).toBeNull();
    });
  });
});

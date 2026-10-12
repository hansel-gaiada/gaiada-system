// M6-P4b0 -- the block library as the fifth contract artifact: reading the baked tarball and the upload rule.
// NO services: a temp directory stands in for /app/artifacts/blocks and an in-memory map for the artifacts bucket.
// The same rule against real RustFS is in codegen-block-library-live.spec.ts.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlockLibraryHashConflictError,
  DEFAULT_BLOCKS_ARTIFACT_DIR,
  blockLibraryChecksumKey,
  blockLibraryObjectKey,
  ensureBlockLibraryUploaded,
  readBakedBlockLibrary,
  resolveBlocksArtifactDir,
  type BlockLibraryStorage,
} from "../src/codegen/generator/block-library.mts";
import { buildContractArtifacts, type BuildArtifactsInput } from "../src/codegen/generator/build-artifacts.mts";

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bake(version: string, bytes: Buffer, opts: { sums?: string | null; filename?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "blocks-baked-"));
  dirs.push(dir);
  const filename = opts.filename ?? `gaiada-webdesk-blocks-${version}.tgz`;
  writeFileSync(join(dir, filename), bytes);
  if (opts.sums !== null) writeFileSync(join(dir, "SHA256SUMS"), opts.sums ?? `${sha(bytes)}  ${filename}\n`);
  return dir;
}

class MemoryStorage implements BlockLibraryStorage {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  async putObject(_bucket: string, key: string, body: Buffer): Promise<unknown> {
    this.puts.push(key);
    this.objects.set(key, body);
    return {};
  }
  async getObject(_bucket: string, key: string): Promise<{ body: Buffer }> {
    const body = this.objects.get(key);
    if (!body) throw new Error(`NoSuchKey ${key}`);
    return { body };
  }
  async headObject(_bucket: string, key: string): Promise<unknown> {
    return this.objects.has(key) ? { contentLength: this.objects.get(key)!.length } : null;
  }
}

const BYTES = Buffer.from("tarball-bytes-v1");

describe("readBakedBlockLibrary", () => {
  it("returns null when the directory does not exist (dev, tests): nothing is invented", () => {
    expect(readBakedBlockLibrary(join(tmpdir(), "no-such-blocks-dir-m6p4b0"))).toBeNull();
  });

  it("returns null when the directory holds no tarball", () => {
    const dir = mkdtempSync(join(tmpdir(), "blocks-empty-"));
    dirs.push(dir);
    expect(readBakedBlockLibrary(dir)).toBeNull();
  });

  it("reads the version from the filename and the sha256 from the bytes, agreeing with SHA256SUMS", () => {
    const dir = bake("0.1.0", BYTES);
    const baked = readBakedBlockLibrary(dir)!;
    expect(baked.version).toBe("0.1.0");
    expect(baked.filename).toBe("gaiada-webdesk-blocks-0.1.0.tgz");
    expect(baked.sha256).toBe(sha(BYTES));
    expect(baked.bytes.equals(BYTES)).toBe(true);
    expect(baked.ref).toEqual({ package: "@gaiada/webdesk-blocks", version: "0.1.0", range: "^0.1.0" });
  });

  it("accepts a prerelease version and the binary-mode `*name` SHA256SUMS form", () => {
    const filename = "gaiada-webdesk-blocks-1.0.0-alpha.2.tgz";
    const dir = bake("1.0.0-alpha.2", BYTES, { sums: `${sha(BYTES).toUpperCase()} *${filename}\n` });
    expect(readBakedBlockLibrary(dir)!.version).toBe("1.0.0-alpha.2");
  });

  it("refuses a tarball with no SHA256SUMS, with a line for another file, or with a contradicting hash", () => {
    expect(() => readBakedBlockLibrary(bake("0.1.0", BYTES, { sums: null }))).toThrow(/without .*SHA256SUMS/);
    expect(() => readBakedBlockLibrary(bake("0.1.0", BYTES, { sums: `${sha(BYTES)}  other.tgz\n` }))).toThrow(/no sha256 line/);
    expect(() => readBakedBlockLibrary(bake("0.1.0", BYTES, { sums: `${"0".repeat(64)}  gaiada-webdesk-blocks-0.1.0.tgz\n` }))).toThrow(
      /baked layer is damaged/,
    );
  });

  it("refuses two tarballs (the image bakes exactly one)", () => {
    const dir = bake("0.1.0", BYTES);
    writeFileSync(join(dir, "gaiada-webdesk-blocks-0.2.0.tgz"), BYTES);
    expect(() => readBakedBlockLibrary(dir)).toThrow(/2 tarballs/);
  });

  it("ignores a file that only looks like a tarball (a path-shaped version never becomes a key)", () => {
    const dir = bake("0.1.0", BYTES, { filename: "gaiada-webdesk-blocks-..-evil.tgz", sums: null });
    expect(readBakedBlockLibrary(dir)).toBeNull();
  });

  it("the directory defaults to /app/artifacts/blocks and WEBDESK_BLOCKS_ARTIFACT_DIR moves it (empty means default)", () => {
    expect(resolveBlocksArtifactDir({})).toBe(DEFAULT_BLOCKS_ARTIFACT_DIR);
    expect(DEFAULT_BLOCKS_ARTIFACT_DIR).toBe("/app/artifacts/blocks");
    expect(resolveBlocksArtifactDir({ WEBDESK_BLOCKS_ARTIFACT_DIR: "" })).toBe(DEFAULT_BLOCKS_ARTIFACT_DIR);
    expect(resolveBlocksArtifactDir({ WEBDESK_BLOCKS_ARTIFACT_DIR: "/srv/blocks" })).toBe("/srv/blocks");
  });
});

describe("ensureBlockLibraryUploaded -- the upload rule", () => {
  const baked = () => readBakedBlockLibrary(bake("0.1.0", BYTES))!;

  it("absent: uploads the tarball under the SHARED key, then the sidecar", async () => {
    const storage = new MemoryStorage();
    const out = await ensureBlockLibraryUploaded(storage, "artifacts", baked());
    expect(out.status).toBe("uploaded");
    expect(out.key).toBe("blocks/0.1.0/gaiada-webdesk-blocks-0.1.0.tgz");
    expect(out.key).toBe(blockLibraryObjectKey("0.1.0"));
    expect(out.sha256).toBe(sha(BYTES));
    expect(storage.puts).toEqual([blockLibraryObjectKey("0.1.0"), blockLibraryChecksumKey("0.1.0")]);
    expect(storage.objects.get(blockLibraryObjectKey("0.1.0"))!.equals(BYTES)).toBe(true);
    expect(storage.objects.get(blockLibraryChecksumKey("0.1.0"))!.toString()).toBe(`${sha(BYTES)}\n`);
  });

  it("the key carries no tenant: it is shared by every tenant and every contract version", () => {
    expect(blockLibraryObjectKey("0.1.0")).not.toMatch(/contracts\//);
  });

  it("present with the same sha256: a no-op (no put at all)", async () => {
    const storage = new MemoryStorage();
    await ensureBlockLibraryUploaded(storage, "artifacts", baked());
    storage.puts.length = 0;
    const again = await ensureBlockLibraryUploaded(storage, "artifacts", baked());
    expect(again.status).toBe("unchanged");
    expect(storage.puts).toEqual([]);
  });

  it("present with a DIFFERENT sha256: fails loudly and never overwrites", async () => {
    const storage = new MemoryStorage();
    await ensureBlockLibraryUploaded(storage, "artifacts", baked());
    storage.puts.length = 0;
    const other = readBakedBlockLibrary(bake("0.1.0", Buffer.from("tarball-bytes-CHANGED")))!;
    const err = await ensureBlockLibraryUploaded(storage, "artifacts", other).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockLibraryHashConflictError);
    expect((err as Error).message).toMatch(/Refusing to overwrite/);
    expect((err as Error).message).toMatch(/Bump the version/);
    expect(storage.puts).toEqual([]);
    expect(storage.objects.get(blockLibraryObjectKey("0.1.0"))!.equals(BYTES)).toBe(true);
  });

  it("a tarball with no sidecar (a run died between the two puts) is repaired when the bytes match", async () => {
    const storage = new MemoryStorage();
    storage.objects.set(blockLibraryObjectKey("0.1.0"), BYTES);
    const out = await ensureBlockLibraryUploaded(storage, "artifacts", baked());
    expect(out.status).toBe("unchanged");
    expect(storage.puts).toEqual([blockLibraryChecksumKey("0.1.0")]);
  });

  it("a tarball with no sidecar and DIFFERENT bytes is a conflict: the stored bytes are the authority", async () => {
    const storage = new MemoryStorage();
    storage.objects.set(blockLibraryObjectKey("0.1.0"), Buffer.from("something else entirely"));
    await expect(ensureBlockLibraryUploaded(storage, "artifacts", baked())).rejects.toBeInstanceOf(BlockLibraryHashConflictError);
    expect(storage.puts).toEqual([]);
  });

  it("a new library version uploads beside the old one, never over it", async () => {
    const storage = new MemoryStorage();
    await ensureBlockLibraryUploaded(storage, "artifacts", baked());
    const v2 = readBakedBlockLibrary(bake("0.2.0", Buffer.from("v2 bytes")))!;
    expect((await ensureBlockLibraryUploaded(storage, "artifacts", v2)).status).toBe("uploaded");
    expect(storage.objects.get(blockLibraryObjectKey("0.1.0"))!.equals(BYTES)).toBe(true);
    expect(storage.objects.has(blockLibraryObjectKey("0.2.0"))).toBe(true);
  });
});

describe("determinism: the block library never reaches the hash manifest", () => {
  const input: BuildArtifactsInput = {
    tenantSlug: "acme",
    defaultLocale: "en-US",
    locales: ["en-US"],
    composition: { article: { blocks: ["richText"] } },
    previous: null,
  };

  it("contentHash and every artifact hash are identical with the real ref, the placeholder, or a different library", async () => {
    const plain = await buildContractArtifacts({ ...input });
    const withLib = await buildContractArtifacts({
      ...input,
      blockLibrary: { package: "@gaiada/webdesk-blocks", version: "0.1.0", range: "^0.1.0" },
    });
    const otherLib = await buildContractArtifacts({
      ...input,
      blockLibrary: { package: "@gaiada/webdesk-blocks", version: "9.9.9", range: "^9.9.9" },
    });
    expect(withLib.contentHash).toBe(plain.contentHash);
    expect(otherLib.contentHash).toBe(plain.contentHash);
    expect(withLib.hashManifestJson).toBe(plain.hashManifestJson);
    expect(JSON.parse(plain.hashManifestJson)).not.toHaveProperty("blockLibrary");
    expect(withLib.blockLibrary.version).toBe("0.1.0");
    expect(plain.blockLibrary.version).toBe("0.0.0-pending-wsk16"); // no tarball: the documented placeholder, nothing invented
  });
});

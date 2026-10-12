import { describe, it, expect } from "vitest";
import { HubContractSnapshotProvider, FakeContractSnapshotProvider, SnapshotNotFoundError, type ContractSnapshotMeta } from "./contract-snapshot-provider";
import type { ToolCaller } from "./hub-client";
import type { Envelope } from "../agent";

const envelope: Envelope = { provider: "test", externalId: "user-1" };

const meta: ContractSnapshotMeta = {
  id: "snap-1",
  tenantId: "t1",
  webdeskTenantSlug: "acme",
  contractVersion: "1.4.0",
  vocabularyVersion: "1.2.0",
  contentHash: "sha256:abc",
  artifacts: {
    sdkTs: "file-sdk",
    sdkPhp: null,
    openapi: "file-openapi",
    contractMd: "file-md",
    blockLibrary: { package: "@gaiada/webdesk-blocks", version: "1.3.2", range: "^1.3" },
    blockLibraryFile: "file-blocks",
  },
};

describe("FakeContractSnapshotProvider", () => {
  it("returns the fixture for a matching id", async () => {
    const provider = FakeContractSnapshotProvider.withOne({
      meta,
      openApiDocument: { paths: {} },
      sdkTsSource: "x",
      contractMd: "# x\n",
      blockLibraryTarball: Buffer.from("y"),
    });
    const got = await provider.getSnapshotArtifacts("t1", "snap-1");
    expect(got.meta.id).toBe("snap-1");
  });

  it("throws SnapshotNotFoundError for a wrong id — never silently substitutes another snapshot", async () => {
    const provider = FakeContractSnapshotProvider.withOne({
      meta,
      openApiDocument: { paths: {} },
      sdkTsSource: "x",
      contractMd: "# x\n",
      blockLibraryTarball: Buffer.from("y"),
    });
    await expect(provider.getSnapshotArtifacts("t1", "wrong-id")).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });
});

describe("HubContractSnapshotProvider — the hub-tool adapter (webdev.contracts.get / webdev.contracts.artifact)", () => {
  const b64 = (v: string) => Buffer.from(v).toString("base64");

  function fakeHub(metaOverride: ContractSnapshotMeta = meta) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: ToolCaller = async (name, args) => {
      calls.push({ name, args });
      if (name === "webdev.contracts.get") return JSON.stringify(metaOverride);
      if (name === "webdev.contracts.artifact") {
        const body = (base64: string) => JSON.stringify({ snapshotId: args.snapshotId, artifact: args.artifact, base64 });
        switch (args.artifact) {
          case "openapi": return body(b64(JSON.stringify({ paths: { "/v1/t/acme/x": {} } })));
          case "sdkTs": return body(b64("sdk-bytes"));
          case "contractMd": return body(b64("# content contract\n"));
          case "sdkPhp": return body(b64("<?php // sdk"));
          case "blockLibrary": return body(b64("blocks-bytes"));
        }
      }
      throw new Error(`unexpected tool call: ${name}`);
    };
    return { calls, callTool };
  }

  it("reads meta via webdev.contracts.get, then each artifact via webdev.contracts.artifact by NAME (never a file id), base64-decoded", async () => {
    const { calls, callTool } = fakeHub();
    const provider = new HubContractSnapshotProvider(callTool, envelope);
    const artifacts = await provider.getSnapshotArtifacts("t1", "snap-1");

    expect(calls[0]).toEqual({ name: "webdev.contracts.get", args: { tenantId: "t1", snapshotId: "snap-1" } });
    const artifactCalls = calls.filter((c) => c.name === "webdev.contracts.artifact");
    expect(artifactCalls.map((c) => c.args).sort((x, y) => String(x.artifact).localeCompare(String(y.artifact)))).toEqual([
      { tenantId: "t1", snapshotId: "snap-1", artifact: "blockLibrary" },
      { tenantId: "t1", snapshotId: "snap-1", artifact: "contractMd" },
      { tenantId: "t1", snapshotId: "snap-1", artifact: "openapi" },
      { tenantId: "t1", snapshotId: "snap-1", artifact: "sdkTs" },
    ]);
    for (const c of artifactCalls) expect(c.args).not.toHaveProperty("fileId");
    // The unregistered placeholder tools are gone: the block library is read through webdev.contracts.artifact too (M6-P4b0).
    expect(calls.some((c) => c.name.startsWith("webdev.artifacts."))).toBe(false);

    expect(artifacts.meta.id).toBe("snap-1");
    expect(artifacts.openApiDocument).toEqual({ paths: { "/v1/t/acme/x": {} } });
    expect(artifacts.sdkTsSource).toBe("sdk-bytes"); // plain text, not a tarball
    expect(artifacts.contractMd).toBe("# content contract\n");
    expect(artifacts.blockLibraryTarball!.toString()).toBe("blocks-bytes");
    expect(artifacts.sdkPhpSource).toBeNull();
  });

  it("a 404 artifact_absent from the tool maps to a null block library, not a failure", async () => {
    const { callTool } = fakeHub();
    const absent: ToolCaller = async (name, args, env) => {
      if (name === "webdev.contracts.artifact" && args.artifact === "blockLibrary") {
        throw new Error('platform-nest 404: {"message":"artifact_absent","reason":"artifact_absent"}');
      }
      return callTool(name, args, env);
    };
    const out = await new HubContractSnapshotProvider(absent, envelope).getSnapshotArtifacts("t1", "snap-1");
    expect(out.blockLibraryTarball).toBeNull();
    expect(out.sdkTsSource).toBe("sdk-bytes"); // everything else is unaffected
  });

  it("a snapshot whose pointer has no block library file (older row, or an explicit null) is null without calling the tool", async () => {
    for (const blockLibraryFile of [null, undefined]) {
      const older: ContractSnapshotMeta = { ...meta, artifacts: { ...meta.artifacts, blockLibraryFile } };
      const { calls, callTool } = fakeHub(older);
      const out = await new HubContractSnapshotProvider(callTool, envelope).getSnapshotArtifacts("t1", "snap-1");
      expect(out.blockLibraryTarball).toBeNull();
      expect(calls.some((c) => c.name === "webdev.contracts.artifact" && c.args.artifact === "blockLibrary")).toBe(false);
    }
  });

  it("any other block-library failure (e.g. artifact_hash_mismatch) propagates: a corrupt tarball is never read as absent", async () => {
    const { callTool } = fakeHub();
    const bad: ToolCaller = async (name, args, env) => {
      if (name === "webdev.contracts.artifact" && args.artifact === "blockLibrary") throw new Error("artifact_hash_mismatch");
      return callTool(name, args, env);
    };
    await expect(new HubContractSnapshotProvider(bad, envelope).getSnapshotArtifacts("t1", "snap-1")).rejects.toThrow(/artifact_hash_mismatch/);
  });

  it("skips the sdkPhp read when the snapshot pointer is null", async () => {
    const { calls, callTool } = fakeHub();
    await new HubContractSnapshotProvider(callTool, envelope).getSnapshotArtifacts("t1", "snap-1");
    expect(calls.some((c) => c.name === "webdev.contracts.artifact" && c.args.artifact === "sdkPhp")).toBe(false);
  });

  it("reads sdkPhp when the pointer is set, decoding it as UTF-8 text", async () => {
    const withPhp: ContractSnapshotMeta = { ...meta, artifacts: { ...meta.artifacts, sdkPhp: "file-php" } };
    const { calls, callTool } = fakeHub(withPhp);
    const out = await new HubContractSnapshotProvider(callTool, envelope).getSnapshotArtifacts("t1", "snap-1");
    expect(calls.filter((c) => c.name === "webdev.contracts.artifact" && c.args.artifact === "sdkPhp")).toHaveLength(1);
    expect(out.sdkPhpSource).toBe("<?php // sdk");
  });

  it("refuses an artifact reply with no base64 payload rather than decoding nothing", async () => {
    const callTool: ToolCaller = async (name) => (name === "webdev.contracts.get" ? JSON.stringify(meta) : JSON.stringify({}));
    await expect(new HubContractSnapshotProvider(callTool, envelope).getSnapshotArtifacts("t1", "snap-1")).rejects.toThrow(/no base64/);
  });

  it("propagates a tool-call failure rather than returning a partial/fabricated snapshot", async () => {
    const callTool: ToolCaller = async () => {
      throw new Error("hub 404");
    };
    const provider = new HubContractSnapshotProvider(callTool, envelope);
    await expect(provider.getSnapshotArtifacts("t1", "snap-1")).rejects.toThrow("hub 404");
  });
});

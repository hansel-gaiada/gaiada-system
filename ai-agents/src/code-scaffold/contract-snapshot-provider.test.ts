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
  },
};

describe("FakeContractSnapshotProvider", () => {
  it("returns the fixture for a matching id", async () => {
    const provider = FakeContractSnapshotProvider.withOne({
      meta,
      openApiDocument: { paths: {} },
      sdkTsTarball: Buffer.from("x"),
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
      sdkTsTarball: Buffer.from("x"),
      contractMd: "# x\n",
      blockLibraryTarball: Buffer.from("y"),
    });
    await expect(provider.getSnapshotArtifacts("t1", "wrong-id")).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });
});

describe("HubContractSnapshotProvider — the hub-tool adapter (tools do not exist yet; see hub-client.ts's header)", () => {
  it("calls webdev.contracts.get for metadata, then downloads each artifact by file id, base64-decoded", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: ToolCaller = async (name, args) => {
      calls.push({ name, args });
      if (name === "webdev.contracts.get") return JSON.stringify(meta);
      if (name === "webdev.artifacts.download" && args.fileId === "file-openapi") {
        return Buffer.from(JSON.stringify({ paths: { "/v1/t/acme/x": {} } })).toString("base64");
      }
      if (name === "webdev.artifacts.download" && args.fileId === "file-sdk") {
        return Buffer.from("sdk-bytes").toString("base64");
      }
      if (name === "webdev.artifacts.downloadText" && args.fileId === "file-md") {
        return "# content contract\n";
      }
      if (name === "webdev.artifacts.downloadBlockLibrary") {
        return Buffer.from("blocks-bytes").toString("base64");
      }
      throw new Error(`unexpected tool call: ${name}`);
    };

    const provider = new HubContractSnapshotProvider(callTool, envelope);
    const artifacts = await provider.getSnapshotArtifacts("t1", "snap-1");

    expect(calls[0]).toEqual({ name: "webdev.contracts.get", args: { tenantId: "t1", snapshotId: "snap-1" } });
    expect(artifacts.meta.id).toBe("snap-1");
    expect(artifacts.openApiDocument).toEqual({ paths: { "/v1/t/acme/x": {} } });
    expect(artifacts.sdkTsTarball.toString()).toBe("sdk-bytes");
    expect(artifacts.contractMd).toBe("# content contract\n");
    expect(artifacts.blockLibraryTarball.toString()).toBe("blocks-bytes");
  });

  it("propagates a tool-call failure rather than returning a partial/fabricated snapshot", async () => {
    const callTool: ToolCaller = async () => {
      throw new Error("hub 404");
    };
    const provider = new HubContractSnapshotProvider(callTool, envelope);
    await expect(provider.getSnapshotArtifacts("t1", "snap-1")).rejects.toThrow("hub 404");
  });
});

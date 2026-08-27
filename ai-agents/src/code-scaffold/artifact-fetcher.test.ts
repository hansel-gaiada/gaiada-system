import { describe, it, expect } from "vitest";
import { HubArtifactFetcher, FakeArtifactFetcher } from "./artifact-fetcher";
import type { ToolCaller } from "./hub-client";
import type { Envelope } from "../agent";

const envelope: Envelope = { provider: "test", externalId: "user-1" };

describe("FakeArtifactFetcher", () => {
  it("returns the fixture text for a matching ref", async () => {
    const fetcher = new FakeArtifactFetcher(new Map([["artifact:prd:1", "# PRD\n"]]));
    expect(await fetcher.fetchText("t1", "artifact:prd:1")).toBe("# PRD\n");
  });

  it("throws for an unfixtured ref rather than returning empty text", async () => {
    const fetcher = new FakeArtifactFetcher(new Map());
    await expect(fetcher.fetchText("t1", "artifact:missing")).rejects.toThrow(/no fixture/);
  });
});

describe("HubArtifactFetcher — the hub-tool adapter (pipeline.artifacts.get does not exist yet)", () => {
  it("calls the tool with tenantId + artifactRef and returns its content field", async () => {
    const callTool: ToolCaller = async (name, args) => {
      expect(name).toBe("pipeline.artifacts.get");
      expect(args).toEqual({ tenantId: "t1", artifactRef: "artifact:prd:1" });
      return JSON.stringify({ content: "# PRD\n" });
    };
    const fetcher = new HubArtifactFetcher(callTool, envelope);
    expect(await fetcher.fetchText("t1", "artifact:prd:1")).toBe("# PRD\n");
  });

  it("an absent content field degrades to empty string, never throws on shape alone", async () => {
    const callTool: ToolCaller = async () => JSON.stringify({});
    const fetcher = new HubArtifactFetcher(callTool, envelope);
    expect(await fetcher.fetchText("t1", "ref")).toBe("");
  });
});

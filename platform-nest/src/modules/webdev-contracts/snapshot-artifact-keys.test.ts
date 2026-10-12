// M6-P4b0 — service-free pins for the fifth snapshot artifact. The route's allow-list
// (`SNAPSHOT_ARTIFACT_KEYS`) and the hub tool's input enum are two copies of one list; the scaffolder asks for
// `blockLibrary` through the tool, so a drift between them is a 400 from the route or a refusal at the hub.
// The DB-backed behaviour (bytes, 404 artifact_absent, hash check) is in contract-snapshot-by-id-http.test.ts.
import { describe, it, expect } from "vitest";
import { webdevModule } from "../webdev";
import { SNAPSHOT_ARTIFACT_KEYS, SDK_PHP_CONTENT_TYPE, SDK_PHP_FILENAME, SDK_TS_CONTENT_TYPE, SDK_TS_FILENAME } from "./contract-snapshot.service";

describe("M6-P4b0 · snapshot artifact keys", () => {
  it("the route allow-list has the block library as its fifth artifact", () => {
    expect([...SNAPSHOT_ARTIFACT_KEYS]).toEqual(["openapi", "sdkTs", "sdkPhp", "contractMd", "blockLibrary"]);
  });

  it("webdev.contracts.artifact's enum is exactly the route's allow-list", () => {
    const tool = webdevModule.mcpTools.find((t) => t.name === "webdev.contracts.artifact")!;
    const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.artifact.enum).toEqual([...SNAPSHOT_ARTIFACT_KEYS]);
    expect(tool.write).toBeFalsy();
  });

  it("the SDK files are labelled as what they are (new snapshots), not as gzip tarballs", () => {
    expect([SDK_TS_FILENAME, SDK_TS_CONTENT_TYPE]).toEqual(["sdk.d.ts", "text/plain"]);
    expect([SDK_PHP_FILENAME, SDK_PHP_CONTENT_TYPE]).toEqual(["sdk.php", "text/x-php"]);
  });
});

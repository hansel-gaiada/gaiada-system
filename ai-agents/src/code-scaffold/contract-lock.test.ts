import { describe, it, expect } from "vitest";
import { buildContractLock, contractLockFileContent } from "./contract-lock";

describe("CONTRACT.lock (§06 verbatim shape)", () => {
  const lock = buildContractLock({
    snapshotId: "snap-1",
    contractVersion: "1.4.0",
    vocabularyVersion: "1.2.0",
    contentHash: "sha256:abc123",
    blockLibraryVersion: "1.3.2",
  });

  it("has exactly the five §06 fields, nothing more", () => {
    expect(Object.keys(lock).sort()).toEqual(
      ["snapshotId", "contractVersion", "vocabularyVersion", "contentHash", "blockLibraryVersion"].sort(),
    );
  });

  it("serializes to canonical, sorted-key JSON, parseable back to the same object", () => {
    const text = contractLockFileContent(lock);
    expect(text.endsWith("\n")).toBe(true);
    const keys = Object.keys(JSON.parse(text));
    expect(keys).toEqual([...keys].sort());
    expect(JSON.parse(text)).toEqual(lock);
  });

  it("two builds with the same inputs produce byte-identical file content (determinism)", () => {
    const a = contractLockFileContent(buildContractLock({ snapshotId: "s", contractVersion: "1.0.0", vocabularyVersion: "1.0.0", contentHash: "sha256:x", blockLibraryVersion: "1.0.0" }));
    const b = contractLockFileContent(buildContractLock({ snapshotId: "s", contractVersion: "1.0.0", vocabularyVersion: "1.0.0", contentHash: "sha256:x", blockLibraryVersion: "1.0.0" }));
    expect(a).toBe(b);
  });
});

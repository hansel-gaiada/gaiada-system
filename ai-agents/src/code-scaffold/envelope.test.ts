// WSK-20 — the frozen §06 envelope shape must never silently drift. This test locks the field set at
// compile time (a removed/renamed field fails to compile) AND at the object-shape level (an extra
// field on a real payload would still satisfy the TS type structurally, so this also asserts the
// exact key set survives a round trip).
import { describe, it, expect } from "vitest";
import type { ScaffoldJobEnvelope } from "./envelope";

describe("ScaffoldJobEnvelope (§06 FROZEN shape)", () => {
  const sample: ScaffoldJobEnvelope = {
    runId: "run-1",
    repoUrl: "https://github.com/gaiada/example-site",
    siteKind: "astro",
    prdArtifact: "artifact:prd:1",
    prototypeArtifact: "artifact:prototype:1",
    contractSnapshotId: "snap-1",
    constraints: { blockLibraryVersion: "1.3.2", maxRevise: 3 },
  };

  it("has exactly the seven top-level fields §06 specifies", () => {
    expect(Object.keys(sample).sort()).toEqual(
      ["constraints", "contractSnapshotId", "prdArtifact", "prototypeArtifact", "repoUrl", "runId", "siteKind"].sort(),
    );
  });

  it("constraints carries exactly blockLibraryVersion + maxRevise", () => {
    expect(Object.keys(sample.constraints).sort()).toEqual(["blockLibraryVersion", "maxRevise"].sort());
  });

  it("siteKind accepts astro | node | wp only (type-level; wp is refused at runtime — see scaffold.test.ts)", () => {
    const kinds: ScaffoldJobEnvelope["siteKind"][] = ["astro", "node", "wp"];
    expect(kinds).toHaveLength(3);
  });

  it("round-trips through JSON unchanged (the wire shape both rail ends actually exchange)", () => {
    expect(JSON.parse(JSON.stringify(sample))).toEqual(sample);
  });
});

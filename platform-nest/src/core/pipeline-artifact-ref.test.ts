import { describe, it, expect } from "vitest";
import { classifyArtifactValue, parseStageRef } from "./pipeline-artifact-ref";

const ID = "0f6c1c1e-7a52-4a43-9a5e-1d6a8b0e2f11";

describe("M6-P4e pipeline artifact refs", () => {
  it("parses a stage:<uuid> ref and nothing else", () => {
    expect(parseStageRef(`stage:${ID}`)).toBe(ID);
    expect(parseStageRef(`  stage:${ID.toUpperCase()} `)).toBe(ID);
    expect(parseStageRef(ID)).toBeNull();
    expect(parseStageRef("stage:not-a-uuid")).toBeNull();
    expect(parseStageRef(`stage:${ID} and more text`)).toBeNull();
    expect(parseStageRef("# a design brief\nstage:x")).toBeNull();
  });

  it("classifies what a stage artifact_ref is", () => {
    expect(classifyArtifactValue(ID)).toBe("file");
    expect(classifyArtifactValue("https://example.com/proto")).toBe("external");
    expect(classifyArtifactValue("git@github.com:org/repo.git")).toBe("external");
    expect(classifyArtifactValue("# Design brief\n\nScreens: home, about")).toBe("inline");
    expect(classifyArtifactValue("deployed to staging")).toBe("inline");
    expect(classifyArtifactValue("")).toBe("empty");
    expect(classifyArtifactValue(null)).toBe("empty");
    expect(classifyArtifactValue("   ")).toBe("empty");
  });
});

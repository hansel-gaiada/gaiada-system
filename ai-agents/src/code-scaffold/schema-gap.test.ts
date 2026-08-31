import { describe, it, expect } from "vitest";
import { buildSchemaProposalDraft, schemaProposalFilePath, todoStubFilePathAstro, todoStubFilePathNode } from "./schema-gap";

describe("schema-gap draft", () => {
  it("is explicitly never-auto-applied", () => {
    const draft = buildSchemaProposalDraft({ pageSlug: "team", kind: "unknown-collection", reference: "team-member" });
    expect(draft.note).toMatch(/DRAFT ONLY/);
    expect(draft.note).toMatch(/Never auto-applied/);
  });

  it("an unknown-block-type gap proposes a blocks-only sketch", () => {
    const draft = buildSchemaProposalDraft({ pageSlug: "home", kind: "unknown-block-type", reference: "pricingTable" });
    expect(draft.suggestedComposition).toEqual({ blocks: [] });
  });

  it("file paths are stable, collision-safe, and sanitize the reference", () => {
    expect(schemaProposalFilePath({ kind: "unknown-collection", reference: "team-member" })).toBe(
      "webdesk-schema-proposals/unknown-collection-team-member.json",
    );
    expect(schemaProposalFilePath({ kind: "unknown-block-type", reference: "weird/../path" })).not.toContain("..");
  });

  it("home page (slug \"\") maps to index, not an empty path segment", () => {
    expect(todoStubFilePathAstro("")).toBe("src/pages/index.astro");
    expect(todoStubFilePathNode("")).toBe("src/routes/index.ts");
  });
});

import { describe, it, expect } from "vitest";
import { parseOpenApiCollections } from "./openapi-index";
import { composePages } from "./page-composer";
import type { PrototypeSpec } from "./prototype-spec";

function fixtureIndex(tenantSlug: string, collections: string[]) {
  const paths: Record<string, unknown> = {};
  for (const c of collections) {
    paths[`/v1/t/${tenantSlug}/${c}`] = {};
    paths[`/v1/t/${tenantSlug}/${c}/{slug}`] = {};
  }
  return parseOpenApiCollections({ paths });
}

describe("composePages", () => {
  it("a static page with no collection binding composes without any SDK call or gap", () => {
    const spec: PrototypeSpec = { pages: [{ slug: "", title: "Home" }] };
    const { files, gaps } = composePages(spec, fixtureIndex("acme", []));
    expect(gaps).toHaveLength(0);
    const home = files.find((f) => f.path === "src/pages/index.astro");
    expect(home).toBeDefined();
    expect(String(home!.content)).not.toContain("webdesk-sdk");
    expect(String(home!.content)).toContain("Hero");
  });

  it("an item page bound to a real collection imports ItemRenderer + the SDK, never a hand fetch", () => {
    const spec: PrototypeSpec = { pages: [{ slug: "case-studies", title: "Case Study", collection: "case-study" }] };
    const { files, gaps, referencedCollections } = composePages(spec, fixtureIndex("acme", ["case-study"]));
    expect(gaps).toHaveLength(0);
    expect(referencedCollections).toEqual(["case-study"]);
    const page = files.find((f) => f.path === "src/pages/case-studies/[slug].astro");
    expect(page).toBeDefined();
    const content = String(page!.content);
    expect(content).toContain('import { ItemRenderer');
    expect(content).toContain('from "../lib/webdesk-sdk"');
    expect(content).not.toMatch(/\bfetch\(/); // no hand-rolled fetch in the PAGE itself
  });

  it("a listing page bound to a real collection calls listItems and never invents item data", () => {
    const spec: PrototypeSpec = { pages: [{ slug: "blog", title: "Blog", collection: "blog-post", isListing: true }] };
    const { files, gaps } = composePages(spec, fixtureIndex("acme", ["blog-post"]));
    expect(gaps).toHaveLength(0);
    const page = files.find((f) => f.path === "src/pages/blog.astro");
    expect(String(page!.content)).toContain("listItems");
  });

  it("a collection the pinned contract does not have becomes a TODO + a schema-proposal draft, never a hand fetch", () => {
    const spec: PrototypeSpec = { pages: [{ slug: "team", title: "Team", collection: "team-member" }] };
    const { files, gaps } = composePages(spec, fixtureIndex("acme", [])); // "team-member" not in the pinned contract
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ pageSlug: "team", kind: "unknown-collection", reference: "team-member" });

    const todo = files.find((f) => f.path === gaps[0].todoFilePath);
    expect(todo).toBeDefined();
    expect(String(todo!.content)).toMatch(/TODO/);
    expect(String(todo!.content)).not.toMatch(/\bfetch\(/);
    expect(String(todo!.content)).not.toContain("webdesk-sdk"); // never a real SDK call for an unresolved gap

    const proposal = files.find((f) => f.path === gaps[0].proposalFilePath);
    expect(proposal).toBeDefined();
    const draft = JSON.parse(String(proposal!.content));
    expect(draft).toMatchObject({ kind: "unknown-collection", reference: "team-member", requestedByPage: "team" });
    expect(draft.note).toMatch(/DRAFT ONLY/);
  });

  it("mixed pages: some resolved, one gap — referencedCollections excludes the gap", () => {
    const spec: PrototypeSpec = {
      pages: [
        { slug: "case-studies", title: "Case Study", collection: "case-study" },
        { slug: "team", title: "Team", collection: "team-member" },
      ],
    };
    const { gaps, referencedCollections } = composePages(spec, fixtureIndex("acme", ["case-study"]));
    expect(gaps).toHaveLength(1);
    expect(referencedCollections).toEqual(["case-study"]);
  });
});

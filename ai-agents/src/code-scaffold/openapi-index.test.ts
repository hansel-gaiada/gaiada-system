import { describe, it, expect } from "vitest";
import { parseOpenApiCollections, collectionExists } from "./openapi-index";

function fixtureDoc(tenantSlug: string, collections: string[]): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    [`/v1/t/${tenantSlug}/search`]: { get: { operationId: "search" } },
    [`/v1/t/${tenantSlug}/sitemap.xml`]: { get: { operationId: "sitemap" } },
  };
  for (const c of collections) {
    paths[`/v1/t/${tenantSlug}/${c}`] = { get: { operationId: `list_${c}` } };
    paths[`/v1/t/${tenantSlug}/${c}/{slug}`] = { get: { operationId: `get_${c}` } };
  }
  return { paths };
}

describe("parseOpenApiCollections", () => {
  it("indexes every collection's list + item paths", () => {
    const idx = parseOpenApiCollections(fixtureDoc("acme", ["case-study", "blog-post"]));
    expect(idx.tenantSlug).toBe("acme");
    expect(collectionExists(idx, "case-study")).toBe(true);
    expect(collectionExists(idx, "blog-post")).toBe(true);
    expect(idx.collections.get("case-study")).toEqual({ hasList: true, hasItem: true });
    expect(idx.hasSearch).toBe(true);
    expect(idx.hasSitemap).toBe(true);
  });

  it("a collection the openapi doc never declares does not exist", () => {
    const idx = parseOpenApiCollections(fixtureDoc("acme", ["case-study"]));
    expect(collectionExists(idx, "not-real")).toBe(false);
  });

  it("an empty paths object yields an empty, well-formed index (no throw)", () => {
    const idx = parseOpenApiCollections({});
    expect(idx.collections.size).toBe(0);
    expect(idx.hasSearch).toBe(false);
    expect(idx.hasSitemap).toBe(false);
  });
});

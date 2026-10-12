import { describe, it, expect } from "vitest";
import { composeNextPages, InvalidPageSlugError } from "./next-page-composer";
import { parseOpenApiCollections } from "./openapi-index";

const index = parseOpenApiCollections({
  paths: {
    "/v1/t/acme/article": {},
    "/v1/t/acme/article/{slug}": {},
  },
});

const byPath = (r: ReturnType<typeof composeNextPages>) => new Map(r.files.map((f) => [f.path, String(f.content)]));

describe("composeNextPages", () => {
  it("maps slugs to App Router files under apps/web/src/app", () => {
    const r = composeNextPages(
      {
        pages: [
          { slug: "", title: "Home" },
          { slug: "blog", title: "Blog", collection: "article", isListing: true },
          { slug: "blog", title: "Post", collection: "article" },
          { slug: "a/b", title: "Nested" },
        ],
      },
      index,
    );
    expect([...byPath(r).keys()]).toEqual([
      "apps/web/src/app/page.tsx",
      "apps/web/src/app/blog/page.tsx",
      "apps/web/src/app/blog/[slug]/page.tsx",
      "apps/web/src/app/a/b/page.tsx",
    ]);
    expect(r.referencedCollections).toEqual(["article"]);
  });

  it("imports the lib relative to each file's depth", () => {
    const files = byPath(
      composeNextPages({ pages: [{ slug: "", title: "H" }, { slug: "blog", title: "P", collection: "article" }, { slug: "a/b", title: "N" }] }, index),
    );
    expect(files.get("apps/web/src/app/page.tsx")).toContain('from "../lib/blocks"');
    expect(files.get("apps/web/src/app/a/b/page.tsx")).toContain('from "../../../lib/blocks"');
    expect(files.get("apps/web/src/app/blog/[slug]/page.tsx")).toContain('from "../../../lib/webdesk-sdk"');
  });

  it("item and listing pages render per request, so a build with no WEBDESK_HOST passes", () => {
    const files = byPath(composeNextPages({ pages: [{ slug: "blog", title: "B", collection: "article", isListing: true }, { slug: "blog", title: "P", collection: "article" }] }, index));
    for (const f of files.values()) expect(f).toContain('export const dynamic = "force-dynamic"');
    expect(files.get("apps/web/src/app/blog/[slug]/page.tsx")).toContain("notFound()");
  });

  it("an unknown collection becomes a TODO page and a proposal draft inside apps/web, never a fetch", () => {
    const r = composeNextPages({ pages: [{ slug: "team", title: "Team", collection: "team-member" }] }, index);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].todoFilePath).toBe("apps/web/src/app/team/page.tsx");
    expect(r.gaps[0].proposalFilePath).toBe("apps/web/webdesk-schema-proposals/unknown-collection-team-member.json");
    expect(String(r.files[0].content)).not.toContain("webdesk-sdk");
    expect(r.referencedCollections).toEqual([]);
  });

  it("a title cannot inject code: it reaches the source only as a JSON string literal", () => {
    const evil = 'x"} /> <script>alert(1)</script> {"';
    const r = composeNextPages({ pages: [{ slug: "", title: evil }] }, index);
    const src = String(r.files[0].content);
    const literal = JSON.stringify(evil);
    // every occurrence of the hostile text sits inside a JSON string literal, none is bare markup
    expect(src.split(literal).length - 1).toBe(src.split("<script>alert(1)</script>").length - 1);
    expect(src.split(literal).length - 1).toBeGreaterThan(0);
  });

  it.each(["../x", "a/../b", "/..", "a b", "[slug]", "a\\b", "(group)", "a//b/..", ".hidden"])("refuses the unsafe slug %j", (slug) => {
    expect(() => composeNextPages({ pages: [{ slug, title: "x" }] }, index)).toThrow(InvalidPageSlugError);
  });

  it("treats 'index' as the home page and trims slashes", () => {
    const files = byPath(composeNextPages({ pages: [{ slug: "index", title: "H" }, { slug: "/about/", title: "A" }] }, index));
    expect([...files.keys()]).toEqual(["apps/web/src/app/page.tsx", "apps/web/src/app/about/page.tsx"]);
  });
});

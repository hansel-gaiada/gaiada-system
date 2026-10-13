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

  it("no generated page is force-dynamic: item and listing pages render at build time (static export, M6-P6m)", () => {
    const files = byPath(composeNextPages({ pages: [{ slug: "blog", title: "B", collection: "article", isListing: true }, { slug: "blog", title: "P", collection: "article" }] }, index));
    expect(files.size).toBe(2);
    for (const f of files.values()) {
      expect(f).not.toContain("force-dynamic");
      expect(f).not.toContain("Rendered per request");
    }
    expect(files.get("apps/web/src/app/blog/page.tsx")).toContain('export const dynamic = "force-static"');
    // the listing links only slugs the item page generates (the same rule, which admits WebDesk's dotted slugs)
    expect(files.get("apps/web/src/app/blog/page.tsx")).toContain("list.items.filter((item) => SAFE_SLUG.test(item.slug))");
    expect(files.get("apps/web/src/app/blog/page.tsx")).toContain("const SAFE_SLUG = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;");
    expect(files.get("apps/web/src/app/blog/[slug]/page.tsx")).toContain("notFound()");
  });

  it("the item page lists slugs through the SDK in generateStaticParams, with dynamicParams = false", () => {
    const page = byPath(composeNextPages({ pages: [{ slug: "blog", title: "P", collection: "article" }] }, index)).get("apps/web/src/app/blog/[slug]/page.tsx")!;
    expect(page).toContain("export async function generateStaticParams()");
    expect(page).toContain("export const dynamicParams = false;");
    expect(page).toContain("listItems<ListEnvelope>(COLLECTION");
    expect(page).toContain("SAFE_SLUG.test(item.slug)"); // a slug read from the server is validated before it becomes a path
    // an empty collection must not return [] (Next 15 + output: "export" refuses it): one placeholder that renders the 404
    expect(page).toContain('const EMPTY_SLUG = "_none"');
    expect(page).toContain("slugs.length > 0 ? slugs : [EMPTY_SLUG]");
    expect(page).toContain("if (slug === EMPTY_SLUG) notFound();");
  });

  it("the listing page reads through the SDK too, and pages through every cursor", () => {
    const page = byPath(composeNextPages({ pages: [{ slug: "blog", title: "B", collection: "article", isListing: true }] }, index)).get("apps/web/src/app/blog/page.tsx")!;
    expect(page).toContain("listItems<ListEnvelope>(COLLECTION, { cursor, limit: 100 })");
    expect(page).toContain("list.page?.hasMore");
  });

  it("a page without a collection never gets an SDK call or generateStaticParams", () => {
    const page = String(composeNextPages({ pages: [{ slug: "about", title: "About" }] }, index).files[0].content);
    expect(page).not.toContain("webdesk-sdk");
    expect(page).not.toContain("generateStaticParams");
  });

  it("a title cannot inject code in an item or listing page either", () => {
    const evil = 'x"; process.exit(1); //';
    const r = composeNextPages({ pages: [{ slug: "x", title: evil, collection: "article" }, { slug: "x", title: evil, collection: "article", isListing: true }] }, index);
    expect(r.files).toHaveLength(2);
    for (const f of r.files) {
      const src = String(f.content);
      expect(src).toContain(`= ${JSON.stringify(evil)};`);
      expect(src).not.toContain(evil); // the raw (unescaped) text never reaches the source
    }
  });

  it("the item page awaits params (Next 15: params is a Promise)", () => {
    const files = byPath(composeNextPages({ pages: [{ slug: "blog", title: "B", collection: "article", isListing: true }, { slug: "blog", title: "P", collection: "article" }] }, index));
    const page = files.get("apps/web/src/app/blog/[slug]/page.tsx")!;
    expect(page).toContain("params: Promise<{ slug: string }>");
    expect(page).toContain("await params");
    expect(page).not.toContain("params.slug");
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

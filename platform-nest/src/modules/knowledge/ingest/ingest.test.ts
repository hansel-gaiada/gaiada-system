// Unit tests for the pure halves of knowledge ingestion: chunking, HTML/sitemap parsing, the egress
// allowlist, and JSON flattening. Everything here runs without a DB or network — the DB edge is
// covered by the platform's RLS suites and the store's own D9 tests, and the allowlist is exercised
// against an injected fetch so the SSRF rule is tested rather than assumed.
import { describe, it, expect } from "vitest";
import { chunkText, normalizeText, renderFields } from "./chunk";
import { allowedHosts, canonicalUrl, crawlSite, extractLinks, htmlToText, isAllowed, pagesToDocuments, parseSitemap, stripBoilerplate } from "./web-source";
import { flattenJson } from "./erp-source";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";

describe("chunkText", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  \t ")).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = chunkText("Gaiada is a digital agency based in Jakarta serving regional clients.");
    expect(chunks).toHaveLength(1);
  });

  it("splits long text and overlaps so a boundary-straddling fact survives", () => {
    const para = (n: number) => `Paragraph ${n}. ${"filler sentence here. ".repeat(20)}`;
    const text = [para(1), para(2), para(3), para(4)].join("\n\n");
    const chunks = chunkText(text, { maxChars: 500, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(700); // budget + overlap carry
    // Every chunk after the first begins with text that appeared in its predecessor.
    for (let i = 1; i < chunks.length; i++) {
      const head = chunks[i].slice(0, 30);
      expect(chunks[i - 1].includes(head.trim().slice(0, 15))).toBe(true);
    }
  });

  it("hard-cuts a single unsplittable run rather than emitting one oversized chunk", () => {
    const chunks = chunkText("x".repeat(5000), { maxChars: 500, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });

  it("loses no content: every source paragraph is still findable somewhere", () => {
    const text = ["Alpha distinctive marker one.", "Beta distinctive marker two.", "Gamma distinctive marker three."].join("\n\n");
    const joined = chunkText(text, { maxChars: 60, overlap: 10 }).join(" ");
    for (const marker of ["Alpha", "Beta", "Gamma"]) expect(joined).toContain(marker);
  });

  it("normalizeText collapses the whitespace zoo without eating paragraph breaks", () => {
    expect(normalizeText("a  \t b\r\n\r\n\r\n c ")).toBe("a b\n\nc");
  });

  it("renderFields drops empty values and labels the rest", () => {
    expect(renderFields([["Status", "active"], ["Owner", ""], ["Due", null], ["Priority", "high"]])).toBe("Status: active\nPriority: high");
  });
});

describe("htmlToText", () => {
  it("extracts the title and drops chrome elements", () => {
    const { title, text } = htmlToText(`
      <html><head><title>About — Gaiada</title><style>.a{color:red}</style></head>
      <body><nav>Home Services Contact</nav><script>track()</script>
      <main><h1>About us</h1><p>We build websites and run SEO.</p></main>
      <footer>© 2026 Gaiada</footer></body></html>`);
    expect(title).toBe("About — Gaiada");
    expect(text).toContain("We build websites and run SEO.");
    expect(text).not.toContain("track()");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Home Services Contact");
    expect(text).not.toContain("© 2026 Gaiada");
  });

  it("decodes entities", () => {
    expect(htmlToText("<p>R&amp;D &mdash; caf&#233;</p>").text).toBe("R&D — café");
  });
});

describe("egress allowlist", () => {
  const hosts = allowedHosts(["https://gaiada.com"]);

  it("accepts the configured host and its www twin", () => {
    expect(isAllowed("https://gaiada.com/about", hosts)).toBe(true);
    expect(isAllowed("https://www.gaiada.com/about", hosts)).toBe(true);
  });

  it("refuses other hosts, look-alikes and non-http schemes", () => {
    for (const url of [
      "https://evil.com/",
      "https://gaiada.com.evil.com/",
      "https://notgaiada.com/",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "gopher://gaiada.com/",
    ]) {
      expect(isAllowed(url, hosts)).toBe(false);
    }
  });

  it("canonicalUrl folds fragments and trailing slashes into one source_ref", () => {
    expect(canonicalUrl("https://gaiada.com/about/")).toBe(canonicalUrl("https://gaiada.com/about"));
    expect(canonicalUrl("https://gaiada.com/about#team")).toBe(canonicalUrl("https://gaiada.com/about"));
  });
});

describe("parseSitemap / extractLinks", () => {
  it("distinguishes a sitemap index from a page sitemap", () => {
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://gaiada.com/s1.xml</loc></sitemap></sitemapindex>")).toEqual({
      pages: [],
      sitemaps: ["https://gaiada.com/s1.xml"],
    });
    expect(parseSitemap("<urlset><url><loc>https://gaiada.com/about</loc></url></urlset>")).toEqual({
      pages: ["https://gaiada.com/about"],
      sitemaps: [],
    });
  });

  it("resolves relative hrefs against the page url", () => {
    const links = extractLinks('<a href="/services">s</a><a href="https://x.com/e">e</a>', "https://gaiada.com/about");
    expect(links).toContain("https://gaiada.com/services");
    expect(links).toContain("https://x.com/e"); // extraction is not the filter — isAllowed is
  });
});

describe("crawlSite", () => {
  /** Minimal fake site: a sitemap, two pages, and one off-host link the crawler must never fetch. */
  function fakeFetch(seen: string[]): typeof fetch {
    const pages: Record<string, { type: string; body: string }> = {
      "https://gaiada.com/sitemap.xml": {
        type: "application/xml",
        body: "<urlset><url><loc>https://gaiada.com/about</loc></url><url><loc>https://gaiada.com/services</loc></url></urlset>",
      },
      "https://gaiada.com/about": {
        type: "text/html",
        body: '<title>About</title><p>Gaiada builds websites.</p><a href="https://evil.com/steal">x</a>',
      },
      "https://gaiada.com/services": { type: "text/html", body: "<title>Services</title><p>SEO, SMM and web development.</p>" },
      "https://gaiada.com": { type: "text/html", body: "<title>Home</title><p>Welcome to Gaiada.</p>" },
    };
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push(url);
      const hit = pages[url.replace(/\/$/, "")] ?? pages[url];
      if (!hit) return new Response("", { status: 404 });
      return new Response(hit.body, { status: 200, headers: { "content-type": hit.type } });
    }) as unknown as typeof fetch;
  }

  it("crawls only allowlisted hosts and never follows an off-site link", async () => {
    const seen: string[] = [];
    const pages = await crawlSite({ sites: ["https://gaiada.com"], maxPages: 20, tenantId: TENANT, fetchImpl: fakeFetch(seen) });
    expect(pages.map((p) => p.title).sort()).toContain("About");
    expect(seen.some((u) => u.includes("evil.com"))).toBe(false);
  });

  it("honours maxPages", async () => {
    const seen: string[] = [];
    const pages = await crawlSite({ sites: ["https://gaiada.com"], maxPages: 1, tenantId: TENANT, fetchImpl: fakeFetch(seen) });
    expect(pages).toHaveLength(1);
  });

  it("produces public-tier documents with stable, url-derived source refs", async () => {
    const seen: string[] = [];
    const pages = await crawlSite({ sites: ["https://gaiada.com"], maxPages: 20, tenantId: TENANT, fetchImpl: fakeFetch(seen) });
    const docs = pagesToDocuments(pages, TENANT);
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect(d.audience).toBe("public");
      expect(d.sourceRef.startsWith("web:https://gaiada.com")).toBe(true);
      expect(d.acl).toEqual([]);
      // Each chunk carries its page header so a retrieved chunk is self-describing.
      for (const c of d.chunks) expect(c).toContain(d.sourceRef.slice(4));
    }
    // Re-running produces IDENTICAL refs — this is what makes the scheduled re-ingest idempotent.
    const again = pagesToDocuments(pages, TENANT).map((d) => d.sourceRef);
    expect(again).toEqual(docs.map((d) => d.sourceRef));
  });
});

describe("stripBoilerplate", () => {
  const NAV = ["Service", "Portfolio", "About", "Career", "Blog", "Contact"];
  const site = (n: number, body: string) => ({ url: `https://gaiada.com/p${n}`, title: `Page ${n}`, text: [...NAV, body].join("\n") });

  it("removes the site menu that appears on every page", () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) => site(n, `Unique body paragraph number ${n} about a specific topic.`));
    const cleaned = stripBoilerplate(pages);
    for (const p of cleaned) {
      for (const item of NAV) expect(p.text.split("\n")).not.toContain(item);
      expect(p.text).toContain("Unique body paragraph");
    }
  });

  it("keeps a repeated line that is long enough to be real prose", () => {
    const tagline = "Gaiada is a full-service digital agency in Bali delivering branding, web and performance marketing.";
    const pages = [1, 2, 3, 4, 5, 6].map((n) => ({ url: `https://gaiada.com/p${n}`, title: `P${n}`, text: `${tagline}\nBody ${n}.` }));
    for (const p of stripBoilerplate(pages)) expect(p.text).toContain(tagline);
  });

  it("is a no-op on a corpus too small to judge repetition", () => {
    const pages = [site(1, "Only body."), site(2, "Another body.")];
    expect(stripBoilerplate(pages)).toEqual(pages);
  });

  it("never strips a line that is unique to one page", () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) => site(n, "Shared body text."));
    pages[0].text += "\nOur retainer starts at IDR 25m per month.";
    expect(stripBoilerplate(pages)[0].text).toContain("IDR 25m");
  });
});

describe("flattenJson", () => {
  it("turns nested report/org JSON into labelled lines instead of raw punctuation", () => {
    const out = flattenJson({ summary: { headline: "On track", risks: ["budget", "scope"] }, owner: "Sinta" });
    expect(out).toContain("summary.headline: On track");
    expect(out).toContain("summary.risks[0]: budget");
    expect(out).toContain("owner: Sinta");
    expect(out).not.toContain("{");
  });

  it("terminates on deeply nested / cyclic-shaped input", () => {
    let deep: Record<string, unknown> = { v: "bottom" };
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    expect(() => flattenJson(deep)).not.toThrow();
  });

  it("skips null/undefined without emitting empty labels", () => {
    expect(flattenJson({ a: null, b: undefined, c: "kept" })).toBe("c: kept");
  });
});

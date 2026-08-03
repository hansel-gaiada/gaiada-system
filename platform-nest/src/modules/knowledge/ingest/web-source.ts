// PUBLIC-tier source builder: turns our own marketing site (gaiada.com) into world-readable
// knowledge chunks, so an agent can answer "what does Gaiada do?" for someone with no ERP identity.
//
// ── SCOPE OF EGRESS (read before widening) ───────────────────────────────────────────────────────
// This fetcher is first-party ONLY. Every request — the seed, every sitemap entry, every discovered
// link, and the FINAL url after any redirect chain — must resolve to a host in the configured
// allowlist (`KNOWLEDGE_PUBLIC_SITES`, default gaiada.com). That check is what keeps this from being
// an SSRF primitive: without it, a single attacker-controlled <a href> on the site would let anyone
// aim an authenticated internal service at any URL. It is deliberately a HOST allowlist rather than
// the search module's full IP-level egress guard (search-crawl-go/internal/egress) because that
// guard is a Go package in a separate project and this job only ever needs to reach our own public
// origins; if this is ever pointed at third-party sites, it must move behind that guard first.
//
// robots.txt is not consulted: these are our own origins and this is first-party content ingestion,
// not a crawl of someone else's property. That reasoning stops being true the moment the allowlist
// contains a host we do not own.
import { chunkText, normalizeText } from "./chunk";
import type { IngestDocument } from "./types";

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "GaiadaKnowledgeBot/1.0 (+https://gaiada.com)";
/** Refuse to buffer a response larger than this — a stray media file must not become a 40MB string. */
const MAX_BYTES = 4 * 1024 * 1024;

export interface WebCrawlOpts {
  /** Allowed origins, e.g. ["https://gaiada.com"]. Hosts are matched exactly (plus a `www.` twin). */
  sites: string[];
  maxPages: number;
  tenantId: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

/** Host set for the allowlist, including the www/non-www twin of each configured origin so a
 *  canonical redirect between them is not mistaken for an off-site hop. */
export function allowedHosts(sites: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const s of sites) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      continue;
    }
    const h = u.hostname.toLowerCase();
    hosts.add(h);
    hosts.add(h.startsWith("www.") ? h.slice(4) : `www.${h}`);
  }
  return hosts;
}

export function isAllowed(url: string, hosts: Set<string>): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return hosts.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Strip the fragment and trailing slash so `/about`, `/about/` and `/about#team` are ONE source_ref
 *  rather than three copies of the same page competing in the ranking. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

async function fetchText(url: string, hosts: Set<string>, fetchImpl: typeof fetch): Promise<{ body: string; finalUrl: string } | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml;q=0.9,*/*;q=0.5" } });
    // Re-check AFTER redirects: the allowlist decision must be made about the host we actually read.
    const finalUrl = res.url || url;
    if (!isAllowed(finalUrl, hosts)) return null;
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|xml/i.test(type)) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return null;
    const body = await res.text();
    if (body.length > MAX_BYTES) return null;
    return { body, finalUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Dependency-free HTML → readable text. Drops the elements that are pure chrome (script/style/nav/
 *  header/footer/form/svg) before unwrapping tags, because indexing a site-wide nav menu on every
 *  page produces N identical near-duplicate chunks that crowd out the real answer. */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : "";
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  body = body.replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  body = body.replace(/<(nav|header|footer|form|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Block-level tags become paragraph breaks so the chunker has real seams to split on.
  body = body.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, "\n\n");
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = body.replace(/<[^>]+>/g, " ");
  return { title, text: normalizeText(decodeEntities(body)) };
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  };
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m);
}

/** Pull page URLs out of a sitemap or sitemap-index document. */
export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
  const isIndex = /<sitemapindex/i.test(xml);
  return isIndex ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}

/** Same-origin <a href> extraction for the BFS fallback. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      out.push(canonicalUrl(new URL(decodeEntities(m[1]), baseUrl).toString()));
    } catch {
      // unparseable href — ignore
    }
  }
  return out;
}

/** Discover + fetch pages: sitemap.xml first (authoritative and cheap), BFS from the origin only if
 *  no sitemap yields anything. */
export async function crawlSite(opts: WebCrawlOpts): Promise<CrawledPage[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hosts = allowedHosts(opts.sites);
  const queue: string[] = [];
  const seen = new Set<string>();

  for (const site of opts.sites) {
    for (const candidate of [`${site.replace(/\/$/, "")}/sitemap.xml`, `${site.replace(/\/$/, "")}/sitemap_index.xml`]) {
      const got = await fetchText(candidate, hosts, fetchImpl);
      if (!got) continue;
      const { pages, sitemaps } = parseSitemap(got.body);
      for (const nested of sitemaps.slice(0, 20)) {
        const sub = await fetchText(nested, hosts, fetchImpl);
        if (sub) queue.push(...parseSitemap(sub.body).pages);
      }
      queue.push(...pages);
    }
    queue.push(site); // always include the landing page
  }

  const pages: CrawledPage[] = [];
  // BFS: the queue grows with discovered links only when a sitemap did not already supply enough.
  while (queue.length > 0 && pages.length < opts.maxPages) {
    const raw = queue.shift() as string;
    const url = canonicalUrl(raw);
    if (seen.has(url) || !isAllowed(url, hosts)) continue;
    seen.add(url);

    const got = await fetchText(url, hosts, fetchImpl);
    if (!got) continue;
    if (/^\s*<\?xml|<urlset|<sitemapindex/i.test(got.body)) continue; // a sitemap, not a page

    const { title, text } = htmlToText(got.body);
    if (text.length > 0) pages.push({ url, title, text });
    if (queue.length + pages.length < opts.maxPages) {
      for (const link of extractLinks(got.body, url)) {
        if (!seen.has(link) && isAllowed(link, hosts)) queue.push(link);
      }
    }
  }
  return pages;
}

/** Drop cross-page boilerplate (nav menus, footers, cookie banners) by FREQUENCY rather than by tag
 *  or CSS selector.
 *
 *  Tag-based stripping alone is not enough in practice: real themes build their menu out of plain
 *  <div>/<ul> markup with no <nav> element, so the entire site menu survives htmlToText and lands in
 *  the FIRST chunk of every page — which is the chunk most likely to be retrieved. Fifty pages then
 *  hold fifty near-identical vectors of the word soup "Service Portfolio About Career Blog Contact",
 *  crowding out the page's actual content.
 *
 *  A line that appears on most pages is, by definition, not what any single page is about. So: keep
 *  a line only if it is long enough to be prose, or rare enough to be content. Both escape hatches
 *  matter — the length one stops a genuinely repeated SENTENCE (a boilerplate tagline is fine to
 *  drop, but so is an unlucky common phrase) from being cut out of a page that needs it. */
export function stripBoilerplate(pages: CrawledPage[]): CrawledPage[] {
  // Needs a corpus to compare against; with one or two pages "appears everywhere" is meaningless.
  if (pages.length < 4) return pages;
  const PROSE_CHARS = 80; // long lines are content, never menu items
  const SHARED_RATIO = 0.5;

  const pageCount = new Map<string, number>();
  for (const p of pages) {
    for (const line of new Set(p.text.split("\n").map((l) => l.trim()).filter(Boolean))) {
      if (line.length <= PROSE_CHARS) pageCount.set(line, (pageCount.get(line) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * SHARED_RATIO));
  const boilerplate = new Set([...pageCount].filter(([, n]) => n >= threshold).map(([line]) => line));

  return pages.map((p) => ({
    ...p,
    text: normalizeText(
      p.text
        .split("\n")
        .filter((l) => !boilerplate.has(l.trim()))
        .join("\n"),
    ),
  }));
}

/** Turn crawled pages into public-tier ingest documents. The page title is prepended to every chunk
 *  so a mid-page chunk still carries the context of WHICH page it came from — without it, a chunk
 *  reading "starting from IDR 5m" is retrievable but unusable. */
export function pagesToDocuments(pages: CrawledPage[], tenantId: string): IngestDocument[] {
  const docs: IngestDocument[] = [];
  for (const page of stripBoilerplate(pages)) {
    const header = page.title ? `${page.title} (${page.url})` : page.url;
    const chunks = chunkText(page.text).map((c) => `${header}\n\n${c}`);
    if (chunks.length === 0) continue;
    docs.push({
      tenantId,
      sourceRef: `web:${page.url}`,
      audience: "public",
      acl: [],
      kind: "doc",
      provenance: "human", // published marketing copy authored by the company
      chunks,
      label: page.title || page.url,
    });
  }
  return docs;
}

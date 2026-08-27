// WSK-20 — turns the accepted-prototype artifact into the page list the scaffolder composes.
//
// ── A REAL SPEC GAP (report this) ────────────────────────────────────────────────────────────────
// §06's envelope names `prototypeArtifact` as "artifact_ref of the accepted design stage" but never
// defines its SHAPE. The existing `design.prototype` tool (mcp-hub/src/delivery-tools.ts, v1) is an
// LLM call that returns free-form MARKDOWN prose ("screen inventory, key components, primary user
// flows, and states") — not machine-parseable page/collection bindings. A deterministic scaffolder
// (WSK-D6: no LLM interpretation of untrusted PRD/prototype content driving what gets built — §07's
// prompt-injection posture: "the model can only propose") needs a STRUCTURED shape instead. This file
// defines `PrototypeSpec` as this ticket's own proposal for that structured contract (a page list,
// each optionally bound to one collection) and accepts it when the artifact IS that JSON shape.
//
// For the CURRENT markdown-shaped artifacts (i.e. every one `design.prototype` v1 has ever produced),
// this falls back to a conservative heading-derived page list with NO collection binding — pages that
// are honestly static (hero/richText/cta placeholder blocks only), never a guessed SDK call. This is
// the honest degrade: inventing a collection binding from prose would be exactly the "hand-rolled"
// interpretation §06 forbids. A real fix is an upstream decision (architect-owned): either
// `design.prototype` v2 emits `PrototypeSpec` JSON directly, or a schema is agreed for a WSK-D6-safe
// non-LLM extraction step between design and scaffold. Flagged as a follow-up in this ticket's report.
export interface PrototypePageSpec {
  /** Route slug ("" or "index" = the site's home page). */
  slug: string;
  title: string;
  /** The one collection this page's primary content comes from. Absent = a static page (fixed
   *  hero/cta content only, no SDK-backed data). */
  collection?: string;
  /** true = this page LISTS the collection (list_{key}); false/absent = resolves one item by slug
   *  (get_{key}), using `slug` as the item slug. */
  isListing?: boolean;
}

export interface PrototypeSpec {
  pages: PrototypePageSpec[];
}

export type PrototypeParseMode = "structured" | "markdown-fallback";

export interface ParsedPrototype {
  spec: PrototypeSpec;
  mode: PrototypeParseMode;
}

function isValidPageSpec(v: unknown): v is PrototypePageSpec {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.slug === "string" &&
    typeof p.title === "string" &&
    (p.collection === undefined || typeof p.collection === "string") &&
    (p.isListing === undefined || typeof p.isListing === "boolean")
  );
}

function slugify(heading: string): string {
  const s = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "page";
}

/** Conservative heading extraction: every `#`/`##`/`###` Markdown heading becomes one static page.
 *  The FIRST heading found becomes the home page (slug ""); every subsequent one gets a slugified
 *  route. No collection is ever inferred from prose. */
function markdownHeadingsToPages(md: string): PrototypePageSpec[] {
  const headingRe = /^#{1,3}\s+(.+)$/gm;
  const pages: PrototypePageSpec[] = [];
  let match: RegExpExecArray | null;
  let first = true;
  while ((match = headingRe.exec(md)) !== null) {
    const title = match[1].trim();
    pages.push({ slug: first ? "" : slugify(title), title });
    first = false;
  }
  if (pages.length === 0) pages.push({ slug: "", title: "Home" });
  return pages;
}

export function parsePrototypeSpec(raw: string): ParsedPrototype {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { pages?: unknown };
      if (Array.isArray(parsed.pages) && parsed.pages.every(isValidPageSpec)) {
        return { spec: { pages: parsed.pages }, mode: "structured" };
      }
    } catch {
      // Not valid JSON — fall through to the markdown heuristic below.
    }
  }
  return { spec: { pages: markdownHeadingsToPages(trimmed) }, mode: "markdown-fallback" };
}

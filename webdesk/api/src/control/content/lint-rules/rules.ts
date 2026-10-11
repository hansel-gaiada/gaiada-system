// M5-W3 — the advisory content rules. Each rule is a pure function (view, config) -> findings. A rule
// that cannot run THROWS; the runner (./run.ts) records it as "unavailable" instead of reporting a clean
// list (an empty list is a claim). Messages are plain words for an editor, never a code or a stack.
import { localeFamily, type ContentView } from "./extract";
import type { ContentRulesConfig } from "./config";
import type { MdDoc } from "./markdown";

export type FindingSeverity = "info" | "warn";
export interface ContentFinding {
  /** Stable machine id, e.g. `h1.multiple`. */
  code: string;
  severity: FindingSeverity;
  /** JSON-pointer-ish location in the item (`/blocks/0/props/body`, `/seo/title`) or `/` for the whole item. */
  path: string;
  message: string;
}

export interface ContentRule {
  /** Name shown in `unavailable` when the rule could not run. */
  id: string;
  run(view: ContentView, cfg: ContentRulesConfig): ContentFinding[];
}

const f = (code: string, severity: FindingSeverity, path: string, message: string): ContentFinding => ({ code, severity, path, message });

export const isQuestionHeading = (text: string, cfg: ContentRulesConfig): boolean => {
  const t = text.trim().toLowerCase();
  if (t.endsWith("?")) return true;
  const first = t.split(/\s+/)[0] ?? "";
  return cfg.questionStarters.includes(first);
};

const isInternal = (url: string): boolean => url.startsWith("/") || url.startsWith("#") || (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//"));
const isExternal = (url: string): boolean => /^https?:\/\//i.test(url);

/** Source evidence in a body: an external link, a footnote marker, or a "Sources"/"References" label. */
export function hasSourceEvidence(doc: MdDoc): boolean {
  if (doc.links.some((l) => !l.image && isExternal(l.url))) return true;
  if (doc.headings.some((h) => /\b(sources?|references?|citations?|sumber|referensi)\b/i.test(h.text))) return true;
  return /\[\^[^\]]{1,40}\]|^\s*(sources?|sumber)\s*:/im.test(doc.prose);
}

const STAT = /\d[\d.,]{0,20}\s?%/;

// -- rules ------------------------------------------------------------------------------------------

const h1: ContentRule = {
  id: "h1",
  run(v) {
    const out: ContentFinding[] = [];
    for (const b of v.longForm) {
      const n = b.doc.headings.filter((h) => h.level === 1).length;
      if (n > 1) out.push(f("h1.multiple", "warn", b.path, `This body has ${n} top-level (H1) headings. A long page should have exactly one.`));
      else if (n === 0 && !v.h1Field) out.push(f("h1.missing", "warn", b.path, "This long body has no H1 heading, and no separate H1 field is filled in."));
    }
    return out;
  },
};

const meta: ContentRule = {
  id: "meta",
  run(v, cfg) {
    if (v.bodies.length === 0 && !v.seoTitle && !v.seoDescription) return [];
    const out: ContentFinding[] = [];
    if (!v.seoTitle) out.push(f("meta.title.missing", "warn", "/seo/title", "The page has no meta title."));
    else if (v.seoTitle.length > cfg.metaTitleMax) out.push(f("meta.title.too-long", "warn", "/seo/title", `The meta title is ${v.seoTitle.length} characters; search results cut it off after about ${cfg.metaTitleMax}.`));
    if (!v.seoDescription) out.push(f("meta.description.missing", "warn", "/seo/description", "The page has no meta description."));
    else if (v.seoDescription.length > cfg.metaDescriptionMax) out.push(f("meta.description.too-long", "warn", "/seo/description", `The meta description is ${v.seoDescription.length} characters; keep it to ${cfg.metaDescriptionMax} or fewer.`));
    else if (v.seoDescription.length < cfg.metaDescriptionMin) out.push(f("meta.description.too-short", "info", "/seo/description", `The meta description is ${v.seoDescription.length} characters; ${cfg.metaDescriptionMin} to ${cfg.metaDescriptionMax} works best.`));
    return out;
  },
};

const imageAlt: ContentRule = {
  id: "image-alt",
  run(v) {
    const out: ContentFinding[] = [];
    for (const b of v.bodies) {
      const missing = b.doc.links.filter((l) => l.image && l.text.trim() === "").length;
      if (missing > 0) out.push(f("images.alt.missing", "warn", b.path, `${missing} image${missing === 1 ? " has" : "s have"} no alt text in this body.`));
    }
    if (v.altTexts !== null && v.altTexts.length === 0) {
      out.push(f("images.alt.field-empty", "info", v.altFieldPath ?? "/", "The alt text field is empty. Every image on the page needs a description."));
    }
    return out;
  },
};

const sources: ContentRule = {
  id: "sources",
  run(v) {
    const out: ContentFinding[] = [];
    for (const b of v.longForm) {
      const stats = b.doc.paragraphs.filter((p) => STAT.test(p.text)).length;
      if (stats > 0 && !hasSourceEvidence(b.doc)) {
        out.push(f("sources.missing", "warn", b.path, `${stats} paragraph${stats === 1 ? " quotes a percentage" : "s quote percentages"} but this body cites no source (an external link or a Sources list). Every statistic needs one.`));
      }
    }
    return out;
  },
};

const internalLinks: ContentRule = {
  id: "internal-links",
  run(v, cfg) {
    const out: ContentFinding[] = [];
    for (const b of v.longForm) {
      const n = b.doc.links.filter((l) => !l.image && isInternal(l.url)).length;
      if (n < cfg.minInternalLinks) {
        out.push(f("links.internal.few", "info", b.path, `This body has ${n} internal link${n === 1 ? "" : "s"}; the site aims for ${cfg.minInternalLinks} on a page (counted in this body only, so navigation links are not included).`));
      }
    }
    return out;
  },
};

const twin: ContentRule = {
  id: "id-twin",
  run(v, cfg) {
    if (!v.localized) return [];
    const family = localeFamily(v.locale);
    const wanted = cfg.twin[family];
    if (!wanted || wanted.length === 0) return [];
    if (v.groupLocales === null) throw new Error("the localization group could not be read");
    const have = new Set([family, ...v.groupLocales.map(localeFamily)]);
    const out: ContentFinding[] = [];
    for (const w of wanted) {
      if (!have.has(w)) {
        out.push(f(`twin.missing.${w}`, family === "en" ? "warn" : "info", "/", `No ${w.toUpperCase()} version of this page exists yet. Create one as a twin of this item so both languages stay linked.`));
      }
    }
    return out;
  },
};

const answerFirst: ContentRule = {
  id: "answer-first",
  run(v, cfg) {
    const out: ContentFinding[] = [];
    for (const b of v.longForm) {
      const p = b.doc.paragraphs[b.doc.answerParagraph];
      if (!p) { out.push(f("answer-first.missing", "warn", b.path, "No opening paragraph was found after the heading. Lead with a short, complete answer.")); continue; }
      if (p.words < cfg.answerFirstMinWords || p.words > cfg.answerFirstMaxWords) {
        out.push(f("answer-first.length", "warn", b.path, `The opening paragraph is ${p.words} words; the answer-first rule asks for ${cfg.answerFirstMinWords} to ${cfg.answerFirstMaxWords}.`));
      }
    }
    return out;
  },
};

const questionHeadings: ContentRule = {
  id: "question-headings",
  run(v, cfg) {
    const out: ContentFinding[] = [];
    for (const b of v.longForm) {
      const hs = b.doc.headings.filter((h) => h.level === 2 || h.level === 3);
      if (hs.length === 0) continue;
      const q = hs.filter((h) => isQuestionHeading(h.text, cfg)).length;
      if (q / hs.length < cfg.questionHeadingShare) {
        out.push(f("headings.question-share", "info", b.path, `${q} of ${hs.length} section headings are phrased as questions; aim for at least ${Math.round(cfg.questionHeadingShare * 100)}%.`));
      }
    }
    return out;
  },
};

const keyword: ContentRule = {
  id: "primary-keyword",
  run(v) {
    if (!v.keyword) return [];
    const k = v.keyword.toLowerCase();
    const has = (s: string | null | undefined): boolean => !!s && s.toLowerCase().includes(k);
    const main = v.longForm[0] ?? v.bodies[0];
    const missing: string[] = [];
    if (!has(v.seoTitle)) missing.push("meta title");
    if (!has(v.seoDescription)) missing.push("meta description");
    if (main) {
      const h1 = main.doc.headings.find((h) => h.level === 1)?.text ?? v.h1Field;
      if (!has(h1)) missing.push("H1");
      if (!has(main.doc.paragraphs.slice(0, 6).map((p) => p.text).join(" ").split(/\s+/).slice(0, 100).join(" "))) missing.push("first 100 words");
      if (!main.doc.headings.some((h) => h.level === 2 && has(h.text))) missing.push("an H2");
    }
    const alts = [...(v.altTexts ?? []), ...v.bodies.flatMap((b) => b.doc.links.filter((l) => l.image).map((l) => l.text))];
    if (v.altTexts !== null || alts.length > 0) if (!alts.some((a) => has(a))) missing.push("an image alt text");
    return missing.length === 0 ? [] : [f("keyword.placement", "info", "/", `The primary keyword "${v.keyword}" is missing from: ${missing.join(", ")}.`)];
  },
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const language: ContentRule = {
  id: "banned-language",
  run(v, cfg) {
    const out: ContentFinding[] = [];
    const phrases = cfg.bannedPhrases[localeFamily(v.locale)] ?? [];
    for (const b of v.bodies) {
      const text = b.doc.prose.replace(/!\[/g, "[");
      const hits: string[] = [];
      for (const p of phrases) {
        if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, "iu").test(text)) hits.push(p);
      }
      if (hits.length > 0) out.push(f("language.banned-phrase", "info", b.path, `This body uses words the house style bans: ${hits.join(", ")}.`));
      const bang = (text.match(/!/g) ?? []).length;
      if (bang > 0 && localeFamily(v.locale) === "en") out.push(f("language.exclamation", "info", b.path, `This body has ${bang} exclamation mark${bang === 1 ? "" : "s"}; the house style does not use them.`));
    }
    return out;
  },
};

export const CONTENT_RULES: ContentRule[] = [h1, meta, imageAlt, sources, internalLinks, twin, answerFirst, questionHeadings, keyword, language];

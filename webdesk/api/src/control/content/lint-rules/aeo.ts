// M5-W3 — the AEO extractability score: how easy it is for an answer engine to lift a clean answer
// from the page. A small, fixed, explainable heuristic over the longest long-form body. NOT a ranking
// prediction: it counts six visible structural habits and shows every factor with its points.
//
//   answer-first  25  the first paragraph after the H1 is a complete answer of the configured length
//                     (full points inside the range, half within 50% of it, else 0)
//   questions     25  share of h2/h3 phrased as questions, scaled to the configured target (30% = full)
//   faq           15  an FAQ section (a heading with FAQ / frequently asked / pertanyaan) or an faq block
//   short-paras   15  share of paragraphs within the configured short length
//   structure     10  at least two h2 sections AND a list or a table
//   citations     10  at least one external link or a Sources/References label
//
// Returns null when the item has no long-form body: "no score" is not "score 0".
import type { ContentView } from "./extract";
import type { ContentRulesConfig } from "./config";
import { hasSourceEvidence, isQuestionHeading } from "./rules";

export interface AeoFactor {
  id: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}
export interface AeoScore {
  /** 0-100, the sum of the factor points, rounded. */
  score: number;
  factors: AeoFactor[];
}

export function aeoScore(v: ContentView, cfg: ContentRulesConfig, hasFaqBlock: boolean): AeoScore | null {
  if (v.longForm.length === 0) return null;
  const main = v.longForm.reduce((a, b) => (b.doc.words > a.doc.words ? b : a));
  const d = main.doc;
  const factors: AeoFactor[] = [];

  const lead = d.paragraphs[d.answerParagraph];
  let a = 0;
  if (lead) {
    const lo = cfg.answerFirstMinWords;
    const hi = cfg.answerFirstMaxWords;
    if (lead.words >= lo && lead.words <= hi) a = 25;
    else if (lead.words >= lo * 0.5 && lead.words <= hi * 1.5) a = 12.5;
  }
  factors.push({ id: "answer-first", label: "Opens with a complete answer", points: a, max: 25, detail: lead ? `opening paragraph is ${lead.words} words (target ${cfg.answerFirstMinWords}-${cfg.answerFirstMaxWords})` : "no opening paragraph found" });

  const hs = d.headings.filter((h) => h.level === 2 || h.level === 3);
  const q = hs.filter((h) => isQuestionHeading(h.text, cfg)).length;
  const share = hs.length === 0 ? 0 : q / hs.length;
  const target = cfg.questionHeadingShare > 0 ? cfg.questionHeadingShare : 0.3;
  factors.push({ id: "questions", label: "Headings phrased as questions", points: 25 * Math.min(1, share / target), max: 25, detail: `${q} of ${hs.length} h2/h3 headings are questions (target ${Math.round(target * 100)}%)` });

  const faq = hasFaqBlock || d.headings.some((h) => /\b(faq|frequently asked|pertanyaan)\b/i.test(h.text));
  factors.push({ id: "faq", label: "Has an FAQ section", points: faq ? 15 : 0, max: 15, detail: faq ? "an FAQ section or block is present" : "no FAQ section or block" });

  const shortShare = d.paragraphs.length === 0 ? 0 : d.paragraphs.filter((p) => p.words <= cfg.shortParagraphMaxWords).length / d.paragraphs.length;
  factors.push({ id: "short-paragraphs", label: "Short paragraphs", points: 15 * shortShare, max: 15, detail: `${Math.round(shortShare * 100)}% of paragraphs are ${cfg.shortParagraphMaxWords} words or fewer` });

  const h2 = d.headings.filter((h) => h.level === 2).length;
  const structured = h2 >= 2 && (d.lists > 0 || d.tables > 0);
  factors.push({ id: "structure", label: "Sections with a list or table", points: structured ? 10 : 0, max: 10, detail: `${h2} h2 section${h2 === 1 ? "" : "s"}, ${d.lists} list${d.lists === 1 ? "" : "s"}, ${d.tables} table${d.tables === 1 ? "" : "s"}` });

  const cited = hasSourceEvidence(d);
  factors.push({ id: "citations", label: "Cites sources", points: cited ? 10 : 0, max: 10, detail: cited ? "an external link or sources list is present" : "no external link or sources list" });

  const round = (n: number): number => Math.round(n * 10) / 10;
  for (const x of factors) x.points = round(x.points);
  return { score: Math.round(factors.reduce((s, x) => s + x.points, 0)), factors };
}

// M5-W3 — runs the content rules. NEVER throws: a rule that fails is listed in `unavailable` (so the
// editor can say "this check could not run" rather than show a clean list), and everything else still
// reports. Advisory only, exactly like the placeholder lint: nothing here can block or alter a save.
import { buildView, type ContentLintInput, type ContentView } from "./extract";
import { aeoScore, type AeoScore } from "./aeo";
import { DEFAULT_CONTENT_RULES, type ContentRulesConfig } from "./config";
import { CONTENT_RULES, type ContentFinding, type ContentRule } from "./rules";

export interface ContentLintReport {
  findings: ContentFinding[];
  /** null = no long-form body to score (not a score of 0), or the score itself was unavailable (see `unavailable`). */
  aeo: AeoScore | null;
  /** Rules that could not run; their findings are unknown, not absent. */
  unavailable: Array<{ rule: string; reason: string }>;
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : "unexpected error").slice(0, 200);

export function lintContent(
  input: ContentLintInput,
  cfg: ContentRulesConfig = DEFAULT_CONTENT_RULES,
  rules: ContentRule[] = CONTENT_RULES,
): ContentLintReport {
  let view: ContentView;
  try {
    view = buildView(input, cfg);
  } catch (e) {
    return { findings: [], aeo: null, unavailable: [...rules.map((r) => ({ rule: r.id, reason: reason(e) })), { rule: "aeo", reason: reason(e) }] };
  }
  const findings: ContentFinding[] = [];
  const unavailable: ContentLintReport["unavailable"] = [];
  const off = new Set(cfg.disabledRules);
  for (const rule of rules) {
    if (off.has(rule.id)) continue; // switched off by the site's composition (lint.content.rules.<id>.enabled)
    try {
      findings.push(...rule.run(view, cfg));
    } catch (e) {
      unavailable.push({ rule: rule.id, reason: reason(e) });
    }
  }
  let aeo: AeoScore | null = null;
  if (!off.has("aeo")) try {
    const blocks = Array.isArray(input.blocks) ? input.blocks : [];
    const hasFaqBlock = blocks.some((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "faq");
    aeo = aeoScore(view, cfg, hasFaqBlock);
  } catch (e) {
    unavailable.push({ rule: "aeo", reason: reason(e) });
  }
  return { findings, aeo, unavailable };
}

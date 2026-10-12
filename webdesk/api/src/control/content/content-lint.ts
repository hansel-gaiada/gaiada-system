// WSK-41 — the advisory placeholder lint (write-plane design §2.5 rule 8, §3.3: "Lint is computed and
// returned, never fatal"). A composition declares its placeholder syntaxes in `lint.placeholders`
// (vocabulary 1.1.0): `token` rules (e.g. `{{ }}`, optionally backed by a registry list) and
// `marker` rules (e.g. `[CONFIRM: ]`). Delimiters are literal strings, never regexes, so a
// tenant-declared rule cannot cause ReDoS: scanning is plain indexOf.
//
// Pure. The caller loads the registry (a list field of a singleton collection) and passes it as a
// Map from token key to value; `null` means "no registry available".
import type { PlaceholderRule } from "../../delivery/vocabulary/composition";
import type { PoolClient } from "pg";
import type { CollectionComposition } from "../../delivery/vocabulary/composition";
import { resolveContentRulesFromComposition } from "./lint-rules/config";
import { lintContent, type ContentLintReport } from "./lint-rules/run";

// M5-W3: the editorial content checks (h1, meta, alt, sources, links, ID twin, AEO) live in ./lint-rules
// and are re-exported here so callers have one import. They are advisory exactly like the placeholders.
export { lintContent, type ContentLintReport } from "./lint-rules/run";
export { DEFAULT_CONTENT_RULES, resolveContentRules, resolveContentRulesFromComposition, type ContentRulesConfig } from "./lint-rules/config";
export type { ContentFinding, FindingSeverity } from "./lint-rules/rules";
export type { AeoScore, AeoFactor } from "./lint-rules/aeo";
export type { ContentLintInput } from "./lint-rules/extract";

export interface LintReport {
  placeholders: {
    /** Each distinct unresolved token, delimiters included, in first-occurrence order. */
    unresolvedTokens: string[];
    /** Occurrences per marker label, e.g. { CONFIRM: 3, CLIENT: 1 }. */
    markers: Record<string, number>;
  };
  /** M5-W3, additive: absent when the content checks are switched off. See ContentLintReport. */
  content?: ContentLintReport;
}

function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringLeaves(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) stringLeaves(v, out);
  }
}

/** Every `open…close` occurrence in `text`, as [inner, full]. An unclosed `open` ends the scan. */
function scan(text: string, open: string, close: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  if (open.length === 0 || close.length === 0) return found;
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    const innerStart = start + open.length;
    const end = text.indexOf(close, innerStart);
    if (end < 0) break;
    found.push([text.slice(innerStart, end), text.slice(start, end + close.length)]);
    from = end + close.length;
  }
  return found;
}

function isResolved(registry: Map<string, string | null>, inner: string, full: string): boolean {
  for (const key of [inner.trim(), full]) {
    if (registry.has(key)) {
      const v = registry.get(key);
      return typeof v === "string" && v.length > 0;
    }
  }
  return false;
}

/**
 * `registry` applies to token rules that declare a `registry`; tokens of a rule without one, or with
 * no registry available (`null`), are all unresolved. A token is resolved when the registry has a
 * non-empty value for its trimmed inner text or for the full delimited token.
 */
export function lintPlaceholders(
  rules: PlaceholderRule[],
  blocks: unknown,
  registry: Map<string, string | null> | null,
): LintReport {
  if (!Array.isArray(rules) || rules.length === 0) return { placeholders: { unresolvedTokens: [], markers: {} } };
  const texts: string[] = [];
  stringLeaves(blocks, texts);

  const unresolved: string[] = [];
  const seen = new Set<string>();
  const markers: Record<string, number> = {};

  for (const rule of rules) {
    if (rule.kind === "marker") {
      let n = 0;
      for (const t of texts) n += scan(t, rule.open, rule.close).length;
      markers[rule.label] = (markers[rule.label] ?? 0) + n;
      continue;
    }
    const reg = rule.registry ? registry : null;
    for (const t of texts) {
      for (const [inner, full] of scan(t, rule.open, rule.close)) {
        if (reg && isResolved(reg, inner, full)) continue;
        if (!seen.has(full)) {
          seen.add(full);
          unresolved.push(full);
        }
      }
    }
  }
  return { placeholders: { unresolvedTokens: unresolved, markers } };
}

/**
 * The M5-W3 content checks, shared by the write plane (save) and the read plane (item.get) so an item
 * reads back exactly the `content` member its last save returned. Returns undefined when the rules
 * are disabled. Degrades (to `unavailable`), never throws. The ID-twin rule's group-locale read runs
 * under a savepoint so a failed read cannot abort the caller's transaction.
 */
export async function computeContentLint(
  client: PoolClient,
  siteId: string,
  groupId: string,
  input: { blocks: unknown; seo: unknown; composition: CollectionComposition; locale: string },
): Promise<ContentLintReport | undefined> {
  // M5-W3c: the site's own settings (composition `lint.content`, vocabulary 1.3.0); absent = the defaults.
  // The ONE resolution shared by save, item.get and the sign-off snapshot.
  const cfg = resolveContentRulesFromComposition(input.composition as { lint?: { content?: unknown } });
  if (!cfg.enabled) return undefined;
  try {
    let groupLocales: string[] | null = null;
    await client.query("SAVEPOINT content_lint_twin");
    try {
      const { rows } = await client.query<{ locale: string }>(
        `SELECT locale FROM content_items WHERE site_id = $1 AND localization_group_id = $2 AND deleted_at IS NULL`,
        [siteId, groupId],
      );
      groupLocales = rows.map((r) => r.locale);
      await client.query("RELEASE SAVEPOINT content_lint_twin");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT content_lint_twin").catch(() => undefined);
    }
    return lintContent({ ...input, groupLocales }, cfg);
  } catch (e) {
    return { findings: [], aeo: null, unavailable: [{ rule: "content", reason: e instanceof Error ? e.message.slice(0, 200) : "unexpected error" }] };
  }
}

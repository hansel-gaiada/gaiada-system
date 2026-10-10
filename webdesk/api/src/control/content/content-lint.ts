// WSK-41 — the advisory placeholder lint (write-plane design §2.5 rule 8, §3.3: "Lint is computed and
// returned, never fatal"). A composition declares its placeholder syntaxes in `lint.placeholders`
// (vocabulary 1.1.0): `token` rules (e.g. `{{ }}`, optionally backed by a registry list) and
// `marker` rules (e.g. `[CONFIRM: ]`). Delimiters are literal strings, never regexes, so a
// tenant-declared rule cannot cause ReDoS: scanning is plain indexOf.
//
// Pure. The caller loads the registry (a list field of a singleton collection) and passes it as a
// Map from token key to value; `null` means "no registry available".
import type { PlaceholderRule } from "../../delivery/vocabulary/composition";

export interface LintReport {
  placeholders: {
    /** Each distinct unresolved token, delimiters included, in first-occurrence order. */
    unresolvedTokens: string[];
    /** Occurrences per marker label, e.g. { CONFIRM: 3, CLIENT: 1 }. */
    markers: Record<string, number>;
  };
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

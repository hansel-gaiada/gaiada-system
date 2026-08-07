// Tool-name alias resolution (2026-08-07, follow-up to `agent.ts`'s off-list recoverable-refusal
// loop and the incident documented in `specialists.ts`'s `task-filer` header).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE PROBLEM THIS SOLVES
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// `task-filer`'s allow-list mixes two naming namespaces for one domain: writes live under `pm.*`
// (`pm.createTask`, `pm.createDoc`), reads for the SAME domain live under `tasks.*`/`projects.*`
// (`tasks.list`, `projects.list`). A model that can see `pm.createTask` in its own tool list has every
// reason to guess a sibling `pm.listTasks` "read" by analogy — that guess happened live (2026-08-07).
// `agent.ts`'s off-list recoverable-refusal loop (`MAX_OFF_LIST_ATTEMPTS`) already turns an unknown
// guess into a bounded, recoverable nudge instead of a dead turn, and stays exactly as-is: it is the
// fallback for EVERY name not in the map below, including any future near-miss nobody has justified an
// alias for yet. This module exists only to remove the round-trip for near-misses already observed
// (or identical in cause to one that was), given the naming surface as it exists today.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE SECURITY CONDITION (non-negotiable)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Resolution MUST happen before any authorization decision, so every check downstream — `agent.ts`'s
// own allow-list (`def.tools[tool]`), the D14-12 registry-impact reconciliation (`effectiveImpact`),
// `resolveApproval`, and the eventual hub call — sees ONLY the canonical name, never the raw guess.
// Resolving AFTER any of those would be a bypass: an alias could carry a call past a check that was
// made against a different name (e.g. an allow-list that only lists the canonical name, or a registry
// impact lookup keyed by the canonical name). `runAgent` (`agent.ts`) calls `resolveToolAlias` as the
// FIRST thing it does with the model's `tool` string — before the allow-list lookup, before impact
// reconciliation, before anything else. `tool-alias-resolution-order.test.ts` proves this
// behaviourally against `runAgent` itself (not just this function in isolation): it fails if resolution
// is ever moved to after either gate.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// EXPLICIT MAP ONLY — NO FUZZY MATCHING
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// A near-miss resolver that GUESSES (Levenshtein distance, "did you mean", prefix/suffix heuristics)
// is exactly how a write nobody asked for gets executed against the wrong resource. Every entry below
// is hand-written and carries its own justification. A name absent from this map is returned UNCHANGED
// — it falls through to `agent.ts`'s existing (and already-working) off-list recoverable-refusal loop.
// Do NOT add a generic normalizer, a case-insensitive lookup, or a "starts with" match here.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// READS ONLY — ENFORCED AT MODULE LOAD, NOT JUST BY CONVENTION
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// An alias may only resolve to a tool this file asserts is `impact: "read"` (the loop below throws at
// import time otherwise). This means NO write can ever be reached by a name the model merely guessed:
// the model must still name a write tool verbatim, and that write still goes through every impact/
// approval gate exactly as if it had named it correctly the first time — aliasing never touches D14.
// If a future near-miss involves a write tool, that is a materially different risk (a wrong guess could
// resolve to a DIFFERENT mutating action than the one the model thought it was calling) and needs its
// own explicit owner decision; it does not belong in this map. See the 2026-08-07 tool-alias-map report
// (`docs/superpowers/plans/2026-08-07-tool-alias-map-report.md`) for the full reasoning.

interface AliasEntry {
  /** The canonical hub tool name this alias resolves to. */
  to: string;
  /** MUST be "read". Not load-bearing on its own (this file doesn't know the hub's live registry) —
   *  paired with the module-load assertion below AND `tool-aliases.test.ts`'s hand-mirrored list of
   *  every hub `write: true` tool name, so an alias accidentally pointed at a write tool fails loudly
   *  in at least two independent places rather than silently shipping. */
  impact: "read";
  /** One line: which real incident, or which identical documented naming asymmetry, justifies this
   *  entry. Required so the map can't silently grow speculative aliases — a near-miss with no
   *  justification here should stay unaliased and fall through to the refusal loop instead. */
  justification: string;
}

const TOOL_ALIASES: Readonly<Record<string, AliasEntry>> = {
  "pm.listTasks": {
    to: "tasks.list",
    impact: "read",
    justification:
      "OBSERVED LIVE (2026-08-07, task-filer): the model guessed this name by analogy from " +
      "pm.createTask. See specialists.ts's task-filer header for the full incident.",
  },
  "pm.getTask": {
    to: "tasks.get",
    impact: "read",
    justification:
      "Same root cause as pm.listTasks, pre-emptive (not yet separately observed live): " +
      "pm.createTask invites the identical analogy for a single-resource read, and tasks.get is a " +
      "real hub tool (mcp-hub/src/platform-tools.ts) — this is the same documented asymmetry, not a " +
      "speculative guess.",
  },
};

for (const [from, entry] of Object.entries(TOOL_ALIASES)) {
  if (entry.impact !== "read") {
    throw new Error(
      `tool-aliases: "${from}" -> "${entry.to}" is not impact:"read" — aliases may only target read ` +
        "tools (see this file's header: no write may ever be reached by a name the model guessed)",
    );
  }
}

/**
 * Resolve a model-supplied tool name to its canonical registry name via the explicit map above.
 *
 * MUST be called before any authorization decision sees the name — see this file's header. A name
 * absent from the map is returned UNCHANGED (no fuzzy matching, ever), so it falls through to
 * `agent.ts`'s existing off-list recoverable-refusal loop exactly as it did before this module existed.
 *
 * Observability: every resolution is logged via `console.warn` (visible in the runner's stdout, and
 * OTel-trace-correlated when `OTEL_ENABLED` — see `telemetry.ts`'s `fastifyLoggerOption`), so a
 * repeatedly-hit alias stays visible as the naming wart it papers over instead of quietly hiding the
 * root cause forever. A silent alias would be worse than no alias at all — see the ticket's framing.
 */
export function resolveToolAlias(name: string): string {
  const entry = TOOL_ALIASES[name];
  if (!entry) return name;
  // eslint-disable-next-line no-console
  console.warn(`[tool-alias] resolved "${name}" -> "${entry.to}"`);
  return entry.to;
}

/** Read-only view of the map for tests / future admin-console visibility. Never consulted by
 *  `resolveToolAlias` itself (which reads `TOOL_ALIASES` directly) — this exists so nothing outside
 *  this file needs its own copy of the alias list to assert against. */
export function toolAliasEntries(): ReadonlyArray<{ from: string; to: string }> {
  return Object.entries(TOOL_ALIASES).map(([from, e]) => ({ from, to: e.to }));
}

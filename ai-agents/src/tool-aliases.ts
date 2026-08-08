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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// RETIRED 2026-08-08 (P4-J5) — pm.listTasks / pm.getTask are no longer near-misses, they are REAL
// canonical tools now.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The two entries this map used to carry (`pm.listTasks -> tasks.list`, `pm.getTask -> tasks.get`)
// were correct on 2026-08-07: at that time neither name existed anywhere in the hub registry, so
// silently redirecting a guess to the real, analogous tool was a safe, reads-only convenience.
//
// `mcp-hub/src/pm-tools.ts` (P4-J1, landed on top of this map) registered `pm.listTasks` and
// `pm.getTask` as genuine, DIFFERENT tools — tenant-wide, facet-rich (status/tag/priority/ball/
// responsible/dueSoon/cursor pagination), Cerbos-gated on the caller's own identity, not the
// project-scoped `tasks.list`/single-resource `tasks.get` these aliases used to redirect to. Leaving
// the alias in place after that would have been actively WRONG, not merely stale: any agent that
// correctly named the real `pm.listTasks` tool (e.g. a PM specialist that declares it on its OWN
// allow-list, per `specialists.ts`'s `pm-reporter`/`pm-task-manager`) would have had that call
// silently rewritten to a DIFFERENT, less capable tool before the allow-list even saw the real name —
// and since `tasks.list` requires a `projectId` a tenant-wide PM query never has, the rewritten call
// would then either 400 at the platform or (worse) run against the wrong resource shape. A resolver
// that turns a correct call into a wrong one is a bug, not a convenience; the fix is to retire the
// entry, not to widen it.
//
// `task-filer` (the one specialist this alias used to help) loses nothing behaviourally: it never
// declared `pm.listTasks` on its own allow-list, and never will (its job is narrowly "read via
// projects.list/tasks.list, write via pm.createTask/createDoc" — see its own header). A stray guess of
// `pm.listTasks` there still gets `agent.ts`'s bounded off-list recoverable-refusal loop, exactly like
// any other unlisted name; it costs one extra round-trip instead of a silent (and now WRONG) same-turn
// resolution. See specialists.ts's task-filer header for the corrected wording.
const TOOL_ALIASES: Readonly<Record<string, AliasEntry>> = {};

// Test-only overlay, checked FIRST by `resolveToolAlias` below. `TOOL_ALIASES` above is intentionally
// empty right now (see the retirement note) — the alias-vs-authorization ORDERING property
// (`tool-alias-resolution-order.test.ts`) is a property of `runAgent`'s call order, not of which real
// aliases happen to exist today, and pinning that test to a real name is exactly what broke when
// `pm.listTasks` stopped being a near-miss. Tests inject a synthetic, obviously-fake name via
// `__setTestAlias`/`__clearTestAliases`; no production code path ever calls either.
const testOverrideAliases = new Map<string, AliasEntry>();

/** Test-only. Registers a synthetic alias for exercising resolution ORDER, independent of whatever is
 *  (or isn't) in the real `TOOL_ALIASES` map. Never call this outside a test. */
export function __setTestAlias(from: string, to: string): void {
  testOverrideAliases.set(from, { to, impact: "read", justification: "test-only override" });
}

/** Test-only. Clears every synthetic alias registered via `__setTestAlias` — call in `afterEach`. */
export function __clearTestAliases(): void {
  testOverrideAliases.clear();
}

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
  const entry = testOverrideAliases.get(name) ?? TOOL_ALIASES[name];
  if (!entry) return name;
  // eslint-disable-next-line no-console
  console.warn(`[tool-alias] resolved "${name}" -> "${entry.to}"`);
  return entry.to;
}

/** Read-only view of the PRODUCTION map only (never the test overlay) — for tests / future
 *  admin-console visibility, so nothing outside this file needs its own copy of the alias list to
 *  assert against. */
export function toolAliasEntries(): ReadonlyArray<{ from: string; to: string }> {
  return Object.entries(TOOL_ALIASES).map(([from, e]) => ({ from, to: e.to }));
}

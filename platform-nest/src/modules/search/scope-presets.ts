// SM-02 — per-engagement tool-scope presets (design §04/§05, owner decision D-11).
//
// `search_engagements.scope_preset` is LABEL ONLY (design §04: "presets SEED tool_scope;
// enforcement never reads it") — every scheduled flow and the SM-04 dispatch choke-point consult
// `tool_scope` directly, never `scope_preset`. This module owns the ONE seeding table so "what a
// preset means" can never drift between the engagement-create path and the scope PUT path.
//
// Shapes below extend the illustrative example in seo-sem-design.md §04 verbatim for 'standard'
// (the doc's own worked example), then scale it down for 'light' (crawler/AI-only, $0 paid pulls —
// P1 value per §01) and up for 'heavy' (adds backlinks + daily rank + higher keyword caps). No
// `provider` override ships in any preset: provider selection cascades per §05 (engagement override
// -> tenant default -> platform default) and Semrush is still decision-gated (OQ-3) — a preset must
// never silently imply a premium provider is live.
export type ScopePreset = "light" | "standard" | "heavy" | "custom";

export const SCOPE_PRESET_VALUES: readonly ScopePreset[] = ["light", "standard", "heavy", "custom"];

/** The tool keys a preset may seed (design §04's illustrative shape). Loosely typed as jsonb on
 *  the DB side — this is the seeding contract, not a runtime validation schema. */
export type ToolScopeShape = Record<string, unknown>;

const SEEDED_PRESETS: Record<Exclude<ScopePreset, "custom">, ToolScopeShape> = {
  light: {
    rank: { enabled: false },
    volume: { enabled: false },
    backlinks: { enabled: false },
    ai_visibility: { enabled: false },
    audit_technical: { enabled: true, cadence: "monthly" },
    audit_cwv: { enabled: true, cadence: "monthly" },
    sem_sync: { enabled: false, mode: "manual" },
  },
  standard: {
    rank: { enabled: true, cadence: "weekly", maxKeywords: 50 },
    // SM-61 (tracker §6au Ruling 1 clause 2, binding): `volume` used to ship cadence-LESS —
    // `enabled: true` with no `cadence` key — which the pull scheduler (SM-54) was defaulting to
    // weekly-conservative while the cost projection had ALWAYS priced it as one on-demand
    // refresh/month. That is the SM-61 defect itself: a cadence-less enabled tool was scheduled ~4x
    // more often than the panel showed. `cadence: "monthly"` fixes this by SCHEDULING it at exactly
    // the rate it was already being priced at (`runsPerMonth("monthly") === 1`, identical to the old
    // absent-default) — zero change to the number any human has ever seen, and it matches the
    // vendor's own monthly volume-data update cycle (a weekly pull would re-buy unchanged data).
    volume: { enabled: true, cadence: "monthly" },
    backlinks: { enabled: false },
    ai_visibility: { enabled: true, cadence: "weekly" },
    audit_technical: { enabled: true, cadence: "weekly" },
    audit_cwv: { enabled: true },
    sem_sync: { enabled: false, mode: "manual" },
  },
  heavy: {
    rank: { enabled: true, cadence: "daily", maxKeywords: 200 },
    // Same SM-61 fix as 'standard' above, same price-identity proof.
    volume: { enabled: true, cadence: "monthly" },
    backlinks: { enabled: true, cadence: "monthly" },
    ai_visibility: { enabled: true, cadence: "weekly" },
    audit_technical: { enabled: true, cadence: "weekly" },
    audit_cwv: { enabled: true, cadence: "weekly" },
    sem_sync: { enabled: true, mode: "manual" },
  },
};

export function isScopePreset(v: unknown): v is ScopePreset {
  return typeof v === "string" && (SCOPE_PRESET_VALUES as readonly string[]).includes(v);
}

/** Returns the seeded `tool_scope` shape for light/standard/heavy, or `undefined` for 'custom'
 *  (or an unrecognized value) — the caller's own `tool_scope` is left as-is (design §04). */
export function seedToolScope(preset: ScopePreset | undefined): ToolScopeShape | undefined {
  if (preset === "light" || preset === "standard" || preset === "heavy") {
    // Deep-clone: callers may go on to JSON.stringify + mutate at the call site's discretion;
    // never hand out the shared literal.
    return JSON.parse(JSON.stringify(SEEDED_PRESETS[preset])) as ToolScopeShape;
  }
  return undefined;
}

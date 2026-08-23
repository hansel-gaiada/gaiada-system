// The risk ladder (P0). Design: docs/superpowers/plans/2026-08-22-hermes-moe-personas-training.md §4.
// Schema: platform-nest/migrations/202608221746_risk_policy_and_host_risk.sql
//
// Four tiers:
//   R0 auto     — reversible, scoped, cheap to undo. The agent executes unattended.
//   R1 gated    — real effect, recoverable with effort. Agent proposes, human confirms.
//   R2 approved — customer-facing or not trivially reversible. NAMED human approves out of band.
//   R3 escort   — the agent must NOT hold the capability at all. The human acts; the agent guides,
//                 verifies each step and records evidence.
//
// ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────────────────────
// Risk is a property of the ACTION IN CONTEXT, not of the tool. `delivery-tools.ts` already knows
// this — it ships deployStaging (impact "low": "staging is isolated + reversible") and deployProd
// (impact "high": "customer-facing + not trivially reversible") as TWO SEPARATE TOOLS. That instinct
// is right and does not scale: every tool that can touch more than one environment, tenant or data
// class would need one variant per combination. Here the environment is an INPUT instead.
//
// ── THE TWO INVARIANTS. Both are pinned by tests; neither may be "simplified" away ────────────────
//  1. THE TOOL'S DECLARED IMPACT IS A FLOOR. Computation may RAISE a call's tier and may NEVER lower
//     it. A tool that declares itself dangerous stays dangerous even where policy is silent.
//  2. FAIL CLOSED. An unmatched lookup resolves to R2, never R0. This is the property a refactor is
//     most likely to invert, because "no rule matched" intuitively reads as "nothing to worry about".
//     `policy.ts:73` already gets this right today (`tool.impact ?? "unclassified"` suspends); this
//     module must not regress it.
import type { Impact } from "./registry";

export type Tier = "R0" | "R1" | "R2" | "R3";

const ORDER: Record<Tier, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };

/** The fail-closed tier. Everything that cannot be resolved lands here, deliberately not R0. */
export const UNRESOLVED_TIER: Tier = "R2";

/** Strongest-wins. Used for BOTH the floor-vs-computed comparison and for combining policy matches. */
export function strongest(...tiers: Tier[]): Tier {
  return tiers.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a), "R0" as Tier);
}

/**
 * The FLOOR contributed by the tool's own declaration.
 *
 * The mapping preserves `policy.ts`'s existing gate exactly: today an unattended write suspends
 * unless `impact === "low"`. Under this mapping "low" is the only impact that reaches R0, so
 * "R0 runs unattended, R1+ suspends" is the same rule expressed on the ladder — not a new one.
 *
 * `undefined` (an unclassified write) maps to the fail-closed tier, matching today's
 * `tool.impact ?? "unclassified"` suspend branch.
 */
export function tierFromImpact(impact: Impact | undefined, isWrite: boolean): Tier {
  if (!isWrite) return "R0"; // reads are gated by SCOPE (Cerbos + RLS), not by tier
  switch (impact) {
    case "low":
      return "R0";
    case "medium":
      return "R1";
    case "high":
      return "R2";
    default:
      return UNRESOLVED_TIER; // unclassified write — never assume safe
  }
}

/** A host's contribution, derived from `infra_hosts.env` unless an explicit weight overrides it. */
export type HostEnv = "production" | "staging" | "ops" | "dev";

export function tierFromHost(env: HostEnv | undefined, riskWeight?: Tier | null): Tier {
  // An explicit override always wins — that is the column's whole purpose (e.g. shared WP hosting is
  // nominally production but has weaker rollback, so its env label understates it).
  if (riskWeight) return riskWeight;
  switch (env) {
    case "staging":
    case "dev":
      return "R0"; // isolated + reversible — the deliberate agent playground
    case "production":
    case "ops":
      return "R2";
    default:
      return UNRESOLVED_TIER; // an unknown host is not a safe host
  }
}

/** One row of `risk_policy`. `"*"` is a wildcard on any dimension. */
export interface RiskRule {
  action: string;
  env: string;
  dataClass: string;
  minTier: Tier;
  rationale?: string;
}

export interface RiskInput {
  action: string;
  /** Resolved from `infra_hosts` for the call's target host, when it has one. */
  env?: HostEnv;
  hostRiskWeight?: Tier | null;
  dataClass?: string;
  /** The tool's own declaration — the FLOOR (invariant 1). */
  impact?: Impact;
  isWrite: boolean;
}

export interface RiskDecision {
  tier: Tier;
  /** Every rule that contributed, so a decision can be explained rather than merely asserted. */
  matched: RiskRule[];
  floor: Tier;
  /** True when nothing but the fail-closed default applied — worth surfacing, not hiding. */
  unresolved: boolean;
}

function matches(rule: RiskRule, input: RiskInput): boolean {
  const actionOk = rule.action === "*" || rule.action === input.action;
  const envOk = rule.env === "*" || rule.env === input.env;
  const dataOk = rule.dataClass === "*" || rule.dataClass === (input.dataClass ?? "internal");
  return actionOk && envOk && dataOk;
}

/**
 * Compute a call's tier.
 *
 * Matching is deliberately NON-EXCLUSIVE: every matching rule contributes and the strongest wins.
 * The tempting alternative — "most specific rule wins" — needs a total ordering over specificity
 * that nobody can keep correct as dimensions are added, and its failure mode is a SILENT DOWNGRADE
 * (a narrow R0 rule quietly overriding a broad R2 one). Strongest-wins has no such failure mode: a
 * mistake makes something too strict, which is loud and gets reported.
 */
export function computeRisk(input: RiskInput, rules: RiskRule[]): RiskDecision {
  const floor = tierFromImpact(input.impact, input.isWrite);
  const host = input.env !== undefined || input.hostRiskWeight ? tierFromHost(input.env, input.hostRiskWeight) : "R0";

  const matched = rules.filter((r) => matches(r, input));
  const fromRules = matched.length ? strongest(...matched.map((r) => r.minTier)) : undefined;

  // A WRITE with no matching rule must not fall through to R0 on the rules' account alone — the
  // floor already covers the classified case, and `tierFromImpact` returns R2 for the unclassified.
  const contributions: Tier[] = [floor, host];
  if (fromRules) contributions.push(fromRules);

  return {
    tier: strongest(...contributions),
    matched,
    floor,
    unresolved: input.isWrite && fromRules === undefined && input.impact === undefined,
  };
}

/**
 * Does this tier run unattended?
 *
 * ONLY R0. This is the single predicate `policy.ts`'s automation gate needs, and keeping it here
 * means the ladder has exactly one place where "may an agent just do this?" is answered.
 */
export function runsUnattended(tier: Tier): boolean {
  return tier === "R0";
}

/**
 * R3 is enforced by the ABSENCE of the tool from the seat's view — never by an instruction.
 *
 * This helper exists so the hub's tool-view builder can drop R3 tools rather than advertise them
 * with a warning. A persona that says "never call this" is a suggestion to a stochastic system;
 * a tool that is not in the view cannot be called at all. If this function's callers ever shrink to
 * zero, R3 has quietly become a prompt convention again.
 */
export function mustBeHiddenFromSeat(tier: Tier): boolean {
  return tier === "R3";
}

// SCP-1b — the UI's mirror of the Social Media stage machine (FRONTEND-BFF-CONTRACT §63.3). Pure and client-safe: no
// I/O, no `server-only`, so the post page's stepper and the DEMO_MODE store (SCP-1o) can both import it.
//
// It reads ONLY `scpStageMachine.json`, a byte-identical copy of the backend's
// `platform-nest/src/modules/social/scp-stage-machine.json` (`scpStageMachine.test.ts` compares the bytes, the
// clientHealthGolden.json pattern). Neither side hard-codes a status list, a phase rule, a holder, an engine status or a
// transition: change the backend fixture first, copy it here, and both suites run against the new rows.
//
// The server decides every write. This file answers what the page draws: the phase, who holds the post, its engine
// status, the primary action, and which actions exist from its status. The few fixture values that are prose are read
// here exactly as the backend's `pipeline/machine.ts` reads them (`PROSE` below); the test pins each string.
import fixture from "./scpStageMachine.json";

interface ChangeCase { key: string; changeBy: string; changeKind: string; returnTo: string; phase: string; holder: string }
interface FromEntry { status: string; changeCase?: string[] }
interface Action { action: string; kind?: string; from: FromEntry[] }
interface Override { when: Record<string, string | boolean>; engineStatus: string }

const F = fixture as unknown as {
  statuses: string[];
  phases: Array<{ key: string; label: string }>;
  phaseOf: Record<string, string>;
  changeCases: ChangeCase[];
  holders: Record<string, string | null>;
  primaryAction: Record<string, string | Record<string, string>>;
  engineStatus: { byPipelineStatus: Record<string, string>; overrides: Override[] };
  actions: Action[];
};

/** The fixture prose this mirror interprets, verbatim (the backend's `PROSE`). */
export const PROSE = {
  phaseOfChanges: "from the change case: see changeCases[].phase",
  holderChanges: "from the change case: see changeCases[].holder",
  holderScheduled: "officer when scheduleVia is 'manual'; publisher when 'publisher'",
  holderBlocked: "from blockWaitingOn",
  primaryDesign: "start_design while creativeState is 'not_started', else submit_design",
} as const;

export const SCP_STATUSES: readonly string[] = F.statuses;
export const SCP_PHASES: ReadonlyArray<{ key: string; label: string }> = F.phases;

/** A post as the page knows it: `pipelineStatus`, and `changeCase` (the read's `change.case`) when it has one. */
export interface ScpPostView {
  pipelineStatus: string | null;
  changeCase?: string | null;
  scheduleVia?: string | null;
  blockWaitingOn?: string | null;
  creativeState?: string | null;
}

function caseOf(post: ScpPostView): ChangeCase {
  const c = F.changeCases.find((x) => x.key === post.changeCase);
  if (!c) throw new Error(`scpStageMachine: status '${post.pipelineStatus}' needs a known change case, got '${String(post.changeCase)}'`);
  return c;
}

/** The phase people see. */
export function scpPhaseOf(post: ScpPostView): string | null {
  const s = post.pipelineStatus;
  if (s === null) return null;
  const v = F.phaseOf[s];
  if (v === undefined) throw new Error(`scpStageMachine: unknown status '${s}'`);
  return v === PROSE.phaseOfChanges ? caseOf(post).phase : v;
}

/** The phase's label, for the stepper. */
export function scpPhaseLabel(phase: string): string {
  return F.phases.find((p) => p.key === phase)?.label ?? phase;
}

/** Who holds the post: an actor role, or null when nobody does. */
export function scpHolderOf(post: ScpPostView): string | null {
  const s = post.pipelineStatus;
  if (s === null) return null;
  if (!(s in F.holders)) throw new Error(`scpStageMachine: unknown status '${s}'`);
  const v = F.holders[s];
  if (v === null) return null;
  if (v === PROSE.holderChanges) return caseOf(post).holder;
  if (v === PROSE.holderScheduled) return post.scheduleVia === "publisher" ? "publisher" : "officer";
  if (v === PROSE.holderBlocked) return post.blockWaitingOn ?? null;
  return v;
}

/** `social_posts.status` of a pipeline post: byPipelineStatus, then the first matching override. */
export function scpEngineStatusOf(post: ScpPostView, variantStatuses: string[] = [], archived = false): string | null {
  const s = post.pipelineStatus;
  if (s === null) return null;
  let status = F.engineStatus.byPipelineStatus[s];
  for (const o of F.engineStatus.overrides) {
    const hit = Object.entries(o.when).every(([k, v]) =>
      k === "archived" ? archived === v : k === "pipelineStatus" ? s === v : k === "anyVariantStatus" ? variantStatuses.includes(String(v)) : false,
    );
    if (hit) {
      status = o.engineStatus;
      break;
    }
  }
  return status ?? null;
}

/** The stepper's main button for the post's status. */
export function scpPrimaryActionOf(post: ScpPostView): string | null {
  const s = post.pipelineStatus;
  if (s === null) return null;
  const v = F.primaryAction[s];
  if (v === undefined) return null;
  if (typeof v === "string") return v === PROSE.primaryDesign ? (post.creativeState === "not_started" ? "start_design" : "submit_design") : v;
  return v[caseOf(post).key] ?? null;
}

/** The fixture actions possible from the post's status (and change case). The server's `actions[]` says which of them
 *  this person may take now; this list only says which exist. */
export function scpActionsFromStatus(post: ScpPostView): string[] {
  const s = post.pipelineStatus;
  if (s === null) return [];
  return F.actions
    .filter((a) => a.from.some((f) => f.status === s && (f.changeCase === undefined || (post.changeCase != null && f.changeCase.includes(post.changeCase)))))
    .map((a) => a.action);
}

// ── SCP-4b: the boost and boost-budget machines (BFF §63.11), read from the fixture's `boosts` and `boostBudgets` keys ──────────────────────────────────────────
interface BoostAction { action: string; cerbosAction: string; actors: string[]; from: string[]; params?: Record<string, string>; guards: Array<{ guard: string; refusal: string }>; approvedVia?: string }
interface BoostFixture {
  statuses: string[]; approvedVia: string[]; committedBy: Record<string, string>;
  actions: Array<BoostAction & { to: unknown }>;
}
interface BudgetFixture { statuses: string[]; agreedVia: string[]; actions: Array<{ action: string; cerbosAction: string; actors: string[]; params?: Record<string, string>; guards: Array<{ guard: string; refusal: string }> }> }
const FB = (fixture as unknown as { boosts: BoostFixture; boostBudgets: BudgetFixture });

/** The boost statuses, in the fixture's order. */
export const scpBoostStatuses = (): string[] => [...FB.boosts.statuses];
/** What each status commits of the monthly budget (`committedBy`): "total budget", "actual spend" or "nothing". */
export const scpBoostCommittedBy = (status: string): string | null => FB.boosts.committedBy[status] ?? null;
/** The boost actions that exist from `status` (the fixture's `from` lists), in the fixture's order, with the Cerbos action and the actors each needs. */
export function scpBoostActionsFrom(status: string): Array<{ action: string; cerbosAction: string; actors: string[] }> {
  return FB.boosts.actions.filter((a) => a.from.includes(status)).map((a) => ({ action: a.action, cerbosAction: a.cerbosAction, actors: [...a.actors] }));
}
/** One boost action of the fixture, or undefined. */
export const scpBoostAction = (action: string) => FB.boosts.actions.find((a) => a.action === action);
/** One boost-budget action of the fixture, or undefined. */
export const scpBudgetAction = (action: string) => FB.boostBudgets.actions.find((a) => a.action === action);

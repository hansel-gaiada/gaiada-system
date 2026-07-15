// WS8 Step D — the trainer + eval-gated improvement loop (spec §8.5, D13).
//
// The trainer PROPOSES improvements from episodes + evals + human feedback; it NEVER applies anything
// autonomously. Two locked gates stand between a proposal and production (D13):
//   1. It must BEAT THE EVAL BASELINE — a proposal whose candidate suite REGRESSES any case is
//      auto-rejected (a green scalar is not enough; the diff is the artifact).
//   2. It must get HUMAN APPROVAL on the failure diff — even a no-regression proposal only reaches
//      "eval_passed"; a human must call `approve` to make it "approved". There is no proposed→approved
//      path without both. (Mirrors the WS7 security learning loop.)
//
// Proposal GENERATION here is a deterministic heuristic over episode signals (testable, no model).
// It can later be LLM-assisted — but the GATES stay deterministic and in code, which is the invariant.
import type { Episode, HumanFeedback } from "../memory/episodic";
import { diffBaseline, type SuiteReport } from "../evals/harness";

export type ProposalKind = "prompt" | "routing" | "fewshot" | "toolfix" | "lora";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  target: string; // the agent this concerns
  rationale: string; // cites the signal (counts) that motivated it
  status: "proposed" | "eval_passed" | "rejected" | "approved";
  /** The regression/fix diff vs the baseline, once the gate has run. */
  evalDelta?: { regressed: string[]; fixed: string[]; stillFailing: string[] };
  /** Opaque change payload (a prompt string, a provider list, few-shot examples, a LoRA ref, …). */
  change: Record<string, unknown>;
}

export interface AnalyzeThresholds {
  minEpisodes: number; // don't propose from too little evidence
  protocolErrorRate: number; // 0..1 — propose a prompt fix above this
  toolFailures: number; // absolute count of failures for one tool → propose a tool-use fix
  downVotes: number; // trusted down-votes → propose a prompt/few-shot fix
}

export const DEFAULT_THRESHOLDS: AnalyzeThresholds = {
  minEpisodes: 3,
  protocolErrorRate: 0.3,
  toolFailures: 2,
  downVotes: 2,
};

/**
 * Mine episodes (per agent) for improvement signals and emit candidate proposals. Deterministic:
 * ids are derived from (agent, kind) so re-analysis is stable (no clock/random). Only TRUSTED
 * feedback counts (D9.3). Every proposal starts `proposed` — gates below decide its fate.
 */
export function analyze(episodes: Episode[], thresholds: AnalyzeThresholds = DEFAULT_THRESHOLDS): Proposal[] {
  const byAgent = new Map<string, Episode[]>();
  for (const e of episodes) (byAgent.get(e.agent) ?? byAgent.set(e.agent, []).get(e.agent)!).push(e);

  const proposals: Proposal[] = [];
  for (const [agent, eps] of byAgent) {
    if (eps.length < thresholds.minEpisodes) continue;

    // Signal 1: protocol errors (the model isn't emitting valid actions) → clarify the prompt.
    const protoErrors = eps.filter((e) => e.status === "protocol_error").length;
    if (protoErrors / eps.length >= thresholds.protocolErrorRate) {
      proposals.push({
        id: `${agent}:prompt`,
        kind: "prompt",
        target: agent,
        rationale: `${protoErrors}/${eps.length} runs ended in a protocol error — reinforce the strict single-JSON-action format`,
        status: "proposed",
        change: { addToSystemPrompt: "Always reply with exactly one JSON object and nothing else." },
      });
    }

    // Signal 2: a specific tool keeps failing → propose a tool-use fix.
    const toolFail = new Map<string, number>();
    for (const e of eps) for (const t of e.failedTools) toolFail.set(t, (toolFail.get(t) ?? 0) + 1);
    for (const [tool, count] of toolFail) {
      if (count >= thresholds.toolFailures) {
        proposals.push({
          id: `${agent}:toolfix:${tool}`,
          kind: "toolfix",
          target: agent,
          rationale: `${tool} failed ${count} times across runs — check argument shape / preconditions`,
          status: "proposed",
          change: { tool },
        });
      }
    }

    // Signal 3: trusted human down-votes → propose a prompt/few-shot refinement.
    const downs = eps.reduce((n, e) => n + e.feedback.filter((f: HumanFeedback) => f.trust === "trusted" && f.rating === "down").length, 0);
    if (downs >= thresholds.downVotes) {
      proposals.push({
        id: `${agent}:fewshot`,
        kind: "fewshot",
        target: agent,
        rationale: `${downs} trusted down-votes — add corrective few-shot examples from the flagged runs`,
        status: "proposed",
        change: { source: "downvoted-episodes" },
      });
    }
  }
  return proposals;
}

/**
 * Gate 1 (evals). Compare the candidate suite (proposal applied) to the baseline. ANY regression
 * auto-rejects (D13: a change must beat the baseline). No regression ⇒ `eval_passed` — eligible, but
 * NOT yet live: it still needs the human gate below.
 */
export function evalGate(proposal: Proposal, baseline: SuiteReport, candidate: SuiteReport): Proposal {
  const delta = diffBaseline(baseline, candidate);
  if (delta.regressed.length > 0) return { ...proposal, status: "rejected", evalDelta: delta };
  return { ...proposal, status: "eval_passed", evalDelta: delta };
}

/**
 * Gate 2 (human). Only an `eval_passed` proposal can be approved, and only by an explicit human call
 * that attests they reviewed the failure diff. There is NO autonomous production update.
 */
export function approve(proposal: Proposal, humanReviewedDiff: boolean): Proposal {
  if (proposal.status !== "eval_passed")
    throw new Error(`cannot approve a "${proposal.status}" proposal — it must pass the eval gate first`);
  if (!humanReviewedDiff) throw new Error("approval requires a human review of the failure diff (D13)");
  return { ...proposal, status: "approved" };
}

export function reject(proposal: Proposal): Proposal {
  return { ...proposal, status: "rejected" };
}

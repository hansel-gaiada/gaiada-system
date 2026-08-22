// WS8 Step B — running a WRITE-CAPABLE specialist safely (D13 + D14 together).
//
// D14 (already in the runner): a high_write throws ApprovalRequiredError and commits nothing. This
// wrapper turns that suspension into a DURABLE, human-decidable record by filing it through the
// mcp-hub `approvals.request` tool (origin="agent") — the SAME platform automation_approvals inbox
// WS4 automation uses (generalized, not duplicated). The agent still commits nothing; a human
// approves/rejects in platform-ui.
//
// D14-10 UPDATE — the resume path is no longer deferred to Temporal. Under the owner's locked D14-b
// decision a suspended goal is resumed by RE-RUNNING IT FROM THE TOP, and `agent.ts` now consults the
// platform (`AgentDeps.resolveApproval`) before throwing. Consequences for THIS file:
//
//   * `ApprovalRequiredError` is now raised ONLY when no decided row binds the exact call, so
//     `fileApproval` below can no longer file a duplicate for a call a human already decided. The
//     re-file that made re-run useless is gone by construction, not by a check added here.
//   * A resumed run reaches `status: "completed"` with `run.approvals` populated, surfaced as
//     `resumed` on the result so a caller can distinguish "completed having performed a human-approved
//     write" (and whether its result was freshly executed or reused) from "completed doing reads".
//   * `ApprovalNotResumableError` (approved-but-stuck: executing / failed / no registry entry)
//     deliberately PROPAGATES. It must not be caught and turned into a filing: there is already a row
//     for this call, and a human — not this wrapper — is the one who unsticks it (D14-07 retry).
//
// D13 failover safety: a write-capable agent may run with its write tools ONLY on a provider that
// passed its eval suite + tool-calling contract (def.evaledProviders). On any other (un-evaled)
// provider it is forced READ-ONLY — its write tools are stripped from the allow-list, so an attempted
// write is contained as a typed refusal rather than executed by an unproven model.
//
// D13 is enforced against the provider that ACTUALLY SERVED (`deps.lastProvider()`), not against the
// caller's declaration — the declaration is only the cold-start seed. See the D13 block inside
// `runWriteAgent` for the live misconfiguration that distinction was hiding, and why "prefer observed"
// rather than "replace declared" is the right shape.
import {
  runAgent,
  ApprovalRequiredError,
  type AgentDef,
  type AgentDeps,
  type AgentRun,
  type ApprovalConsumption,
  type Envelope,
  type Impact,
  type EmitStep,
} from "./agent";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T1 — the agent-side impact label is NOT the wire impact label. Translate at the filing boundary.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// THE BUG THIS CLOSES: `fileApproval` used to forward `err.impact` to the hub's `approvals.request`
// tool verbatim. For a suspended `high_write` that value is the literal string `"high_write"` (see
// `agent.ts`'s write gate: `if (impact === "high_write") throw new ApprovalRequiredError(tool, impact,
// ...)`), but BOTH downstream consumers only ever accepted `medium | high | unclassified`:
//   - the hub tool's own JSON-schema enum for `approvals.request` (`mcp-hub/src/platform-write-tools.ts`)
//   - the platform controller (`platform-nest/src/core/automation-approvals.controller.ts`'s `IMPACTS`
//     set) and migration 0014's CHECK constraint on `automation_approvals.impact`
// So the FIRST genuine `high_write` filing in the platform's history would 400 at the hub and the
// agent goal would fail with no proposal ever appearing — never caught because every agent-side test
// scripted `callTool` (the real schema was never exercised) and the D14-17 tests inserted approval
// rows via raw SQL with `impact='high'` directly. See
// docs/superpowers/plans/2026-08-06-t1-impact-vocabulary-report.md for the full writeup.
//
// THE WIRE VOCABULARY IS CORRECT AND SHARED WITH n8n — it is not widened here. The agent-side `Impact`
// union (`agent.ts`) is the internal label; this is the one place it gets translated before it leaves
// `ai-agents` on the wire.
//
// `ai-agents` and `platform-nest` are separate standalone projects, not a monorepo (see CLAUDE.md), so
// the accepted wire set below is RESTATED rather than imported — the source of truth is
// `platform-nest/src/core/automation-approvals.controller.ts`'s `IMPACTS = new Set(["medium", "high",
// "unclassified"])` (mirrored by `mcp-hub/src/platform-write-tools.ts`'s `approvals.request` schema
// enum). `write-agent.test.ts` pins this restated copy against that exact list so a future divergence
// on either side fails a test here instead of a live 400.
export type WireImpact = "medium" | "high" | "unclassified";

/** The full accepted wire set, restated from `platform-nest`'s `IMPACTS` (see the header above) —
 *  exported so a test can assert `toWireImpact`'s range never leaves this set. */
export const WIRE_IMPACTS: readonly WireImpact[] = ["medium", "high", "unclassified"];

/**
 * Map `agent.ts`'s `Impact` label (as carried by `ApprovalRequiredError.impact`, typed `Impact |
 * "unclassified"`) onto the wire vocabulary above. EXHAUSTIVE over every value the type permits, so a
 * future variant added to `Impact` is a compile error here (`_exhaustive: never`) rather than a
 * runtime 400 at the hub.
 *
 * Mapping, and why:
 *
 *  - "high_write" -> "high". The strictest agent-side write tier onto the wire's strictest tier.
 *    `agent.ts`'s own D14-12 header already establishes that the hub treats "medium" | "high" |
 *    undefined (unclassified-but-write) as equally confirm-required, stricter-wins in both directions
 *    — "high" is the one wire label that keeps a `high_write` at least as strict as that equivalence
 *    on the way out, and it is the exact severity `approvals.resolveExecute` (the D14-14 rerun-capable
 *    transport) is itself registered at in `mcp-hub/src/platform-write-tools.ts` (impact:"high") — so a
 *    rerun-capable high_write carries the same tier end to end, filing through to execution.
 *
 *  - "unclassified" -> "unclassified". Identical spelling on both sides; a straight pass-through kept
 *    explicit (rather than folded into a default) so it is visibly covered by this exhaustiveness check.
 *
 *  - "low_write" and "read" -> THROW. Neither should ever reach here: `agent.ts`'s write gate only
 *    throws `ApprovalRequiredError` when the EFFECTIVE impact is exactly `"high_write"` (see the `if
 *    (impact === "high_write")` branch there) — a `low_write` runs unattended by design (that is what
 *    makes it low), and a `read` tool has no write-impact opinion at all. There is also no wire tier
 *    for "safe to auto-execute": the wire only has medium|high|unclassified, because a filed suspension
 *    is by definition at least medium-severity. Mapping either onto "medium" would fabricate a severity
 *    nobody assessed; a loud throw at the filing boundary is more honest than silently inventing one, or
 *    than letting the hub reject a nonsensical filing with a 400 downstream.
 */
export function toWireImpact(impact: Impact | "unclassified"): WireImpact {
  switch (impact) {
    case "high_write":
      return "high";
    case "unclassified":
      return "unclassified";
    case "low_write":
    case "read":
      throw new Error(
        `fileApproval: impact "${impact}" has no wire representation — an ApprovalRequiredError should ` +
          `only ever carry "high_write" (agent.ts's write gate) or "unclassified"; this means something ` +
          `constructed it outside that contract`,
      );
    default: {
      const _exhaustive: never = impact;
      throw new Error(`fileApproval: unmapped agent-side impact "${String(_exhaustive)}"`);
    }
  }
}

export function isWriteCapable(def: AgentDef): boolean {
  return Object.values(def.tools).some((impact) => impact !== "read");
}

/** A read-only projection of an agent: keep only its `read` tools (D13 forced-read-only). */
export function readOnlyProjection(def: AgentDef): AgentDef {
  const tools: AgentDef["tools"] = {};
  for (const [name, impact] of Object.entries(def.tools)) if (impact === "read") tools[name] = impact;
  return { ...def, name: `${def.name}(read-only)`, tools };
}

export interface FiledApproval {
  approvalId: string | null;
  tool: string;
  impact: string;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T2b — deferred filing (§7.2.5 of the 2026-08-06 ASST-23 unblock design's DELTA). The owner overrode
// OQ-2: an in-thread confirm chip ships before a proposal is filed. `runWriteAgent` gains a per-call
// `fileOnSuspend` option (default TRUE — see the function's own doc); when it is explicitly `false`,
// a suspended `high_write` is captured as a `SuspendedIntent` INSTEAD of being filed through
// `fileApproval`. Nothing here calls `approvals.request` on that path — no decider bell/mail exists
// until something downstream (the confirm endpoint, out of THIS repo's scope) files it for real.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** T2b — a suspended `high_write` that was NOT filed (`fileOnSuspend:false`). `impact` is already the
 *  WIRE label (`toWireImpact(err.impact)` — the SAME exported helper `fileApproval` uses below, reused
 *  rather than duplicated), because this crosses a process boundary too: `runner/service.ts` hands it
 *  back on `GET /goals/:id` as `suspendedIntent`, and a future confirm-time filer must receive the
 *  exact same wire-legal value `fileApproval` would have sent — never the raw agent-side `"high_write"`
 *  label. `args` are the model-composed tool args VERBATIM — this is the one place `ai-agents` returns
 *  them to a caller instead of filing them; the caller (the runner service, then platform-nest) is
 *  responsible for their custody from here (see the design's §7.2.4 custody chain) — `ai-agents` itself
 *  never persists them (no agents-DB migration in this ticket; the runner keeps them in-memory only). */
export interface SuspendedIntent {
  tool: string;
  impact: WireImpact;
  args: Record<string, unknown>;
}

export type WriteAgentResult =
  /** D14-10: `resumed` is present ONLY when this run turned one or more decided approvals into
   *  progress — the consumed-result path made visible at the result level instead of buried in
   *  `run.steps`. Optional (never a new variant) on purpose: `runner/service.ts`'s `mapWriteResult`
   *  exhausts this union with an `else`, so a fourth variant would silently be treated as
   *  `suspended` and dereference a `filed` that isn't there. Additive field, no consumer breaks. */
  | { status: "completed"; run: AgentRun; resumed?: ApprovalConsumption[] }
  /** The pre-T2b shape: filed immediately (the `fileOnSuspend` default, or an explicit `true`). */
  | { status: "suspended"; filed: FiledApproval }
  /** T2b (`fileOnSuspend:false` only): suspended WITHOUT filing. `filed: null` is the discriminant a
   *  consumer switches on within the shared `"suspended"` status — see `runner/service.ts`'s
   *  `mapWriteResult`, which now handles BOTH `suspended` shapes explicitly rather than assuming
   *  `filed` is always present (the exact hazard the comment above used to warn about; it is now
   *  handled, not just documented). */
  | { status: "suspended"; filed: null; intent: SuspendedIntent }
  | { status: "forced_read_only"; run: AgentRun; reason: string };

/** File a pending approval for a suspended high_write, via the hub tool, under the caller's OBO. */
export async function fileApproval(
  deps: AgentDeps,
  envelope: Envelope,
  tenantId: string,
  agentName: string,
  err: ApprovalRequiredError,
): Promise<FiledApproval> {
  // T1 fix: translate the agent-side label to the wire vocabulary BEFORE it leaves this process — see
  // `toWireImpact`'s header for the mapping and why. `err.impact` (e.g. "high_write") is never sent
  // over the wire directly.
  const wireImpact = toWireImpact(err.impact);
  const raw = await deps.callTool(
    "approvals.request",
    {
      tenantId,
      workflowId: agentName, // the principal-side identifier of who was suspended
      toolName: err.tool,
      toolArgs: err.args,
      impact: wireImpact,
      reason: err.message,
      origin: "agent",
      agentName,
    },
    envelope,
  );
  let approvalId: string | null = null;
  try {
    approvalId = (JSON.parse(raw) as { id?: string }).id ?? null;
  } catch {
    /* hub returned a non-JSON body; leave id null — the approval may still have been recorded */
  }
  return { approvalId, tool: err.tool, impact: wireImpact };
}

/** T2b — per-goal options for {@link runWriteAgent}. */
export interface WriteAgentOptions {
  /**
   * Whether a suspended `high_write` is filed through the hub immediately (the historical, and
   * default, behaviour) or merely captured as a {@link SuspendedIntent} for a caller to file later
   * (the confirm-chip flow, §7.2.5). Defaults to `true` so every pre-T2b caller — the CLI, the
   * orchestrator's delegated writes, every existing test — stays BYTE-IDENTICAL: an omitted 7th
   * argument, an omitted `fileOnSuspend` key, and an explicit `fileOnSuspend: true` all take the exact
   * same branch below.
   */
  fileOnSuspend?: boolean;
  /** S0 — optional in-flight event observer, forwarded to BOTH `runAgent` calls below (the D13
   *  forced-read-only projection and the normal path) unchanged. See agent.ts's `EmitStep` doc. */
  emit?: EmitStep;
}

/**
 * Run a specialist that may hold write capability. `servingProvider` is the provider the caller
 * DECLARES the Gateway will use; since 2026-08-07 it is only the cold-start seed — once the Gateway has
 * reported one, `deps.lastProvider()` (what actually served) is what D13 enforces against. That closes
 * the "one remaining runtime wire" this docstring used to describe as outstanding; see the D13 block in
 * the body for the live misconfiguration it was hiding. Enforces D13 (provider gate) then D14 (filing).
 *
 * T2b: `opts.fileOnSuspend` (default `true`) controls what happens when a `high_write` suspends with
 * no decided approval bound to it (`ApprovalRequiredError`). `false` skips `fileApproval` entirely and
 * returns the intent instead — see `SuspendedIntent`'s doc for why nothing here persists it.
 */
export async function runWriteAgent(
  def: AgentDef,
  goal: string,
  envelope: Envelope,
  deps: AgentDeps,
  tenantId: string,
  servingProvider: string,
  opts: WriteAgentOptions = {},
): Promise<WriteAgentResult> {
  const fileOnSuspend = opts.fileOnSuspend ?? true;
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // D13 — OBSERVE the serving provider; do not merely trust the declaration.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // This closes the wire this function's own docstring named as outstanding ("auto-detecting it from
  // the Gateway response is the one remaining runtime wire"). It is a real gap, not a tidy-up:
  //
  // `servingProvider` is DECLARED by the caller — on the runner service it is
  // `AGENT_SERVING_PROVIDER`, whose compose default is `openai`. Nothing forced that declaration to
  // resemble reality, so on `gda-aicenter` (2026-08-07) the gate was passing on a provider that
  // CANNOT serve there at all: `OPENAI_BASE_URL`/`OPENAI_API_KEY` unset (⇒ `Available()=false`),
  // `openai` absent from `LLM_CHAIN`, and site topology strips gemini/claude anyway — so the
  // effective chain is `[hermes, central-forward, echo]` and **Hermes** authored every agent write
  // while this gate believed the eval-cleared `openai` had. D13's whole promise is "only a provider
  // that passed its eval suite may author a write", and a control an env var can satisfy on its own
  // is not that promise.
  //
  // WHY PREFER-OBSERVED RATHER THAN REPLACE: an UNSET declaration was itself a real failure mode
  // (79051ff — writes go silently inert), and `lastProvider()` is `undefined` until the Gateway has
  // served at least one completion, i.e. on a cold runner's very first turn. So the declaration is
  // kept as the COLD-START seed and the observation wins the moment there is one. Test deps that omit
  // `lastProvider` (most of them) therefore behave exactly as before — this is not a behaviour change
  // for anything that was already honest.
  //
  // Not silent when they disagree: a mismatch means someone's configuration is lying, and the operator
  // has to be able to see which way round. It is logged AND named in the refusal reason.
  const observed = deps.lastProvider?.();
  const effectiveProvider = observed ?? servingProvider;
  const mismatch = observed !== undefined && observed !== servingProvider;
  if (mismatch) {
    console.warn(
      `[d13] serving-provider mismatch for ${def.name}: declared "${servingProvider}", Gateway served ` +
        `"${observed}" — enforcing against the SERVED provider. Fix the declaration ` +
        "(AGENT_SERVING_PROVIDER) or the Gateway chain; one of them is wrong.",
    );
  }
  if (isWriteCapable(def) && !(def.evaledProviders ?? []).includes(effectiveProvider)) {
    // D13: this provider has not been evaled for this write-capable agent — force read-only.
    const because = mismatch ? ` (declared "${servingProvider}", Gateway served "${observed}")` : "";
    const run = await runAgent(readOnlyProjection(def), goal, envelope, deps, opts.emit);
    return {
      status: "forced_read_only",
      run,
      reason: `provider "${effectiveProvider}" is not eval-cleared for ${def.name}; writes disabled (D13)${because}`,
    };
  }
  try {
    const run = await runAgent(def, goal, envelope, deps, opts.emit);
    // D14-10: surface the consumed/executed approvals when there were any. `run.approvals` is absent
    // on every run that resolved nothing, so this stays undefined for all pre-existing behaviour.
    return run.approvals?.length ? { status: "completed", run, resumed: run.approvals } : { status: "completed", run };
  } catch (err) {
    // ApprovalRequiredError now means "NO decided row binds this exact call" (agent.ts consults
    // first), so this filing can no longer duplicate a decision a human already made.
    // ApprovalNotResumableError is deliberately NOT caught here — see this file's header.
    if (err instanceof ApprovalRequiredError) {
      if (!fileOnSuspend) {
        // T2b: capture, don't file. Same wire-impact mapping `fileApproval` uses — ONE helper, reused,
        // not duplicated — so a later filer (outside this repo) receives the exact value `fileApproval`
        // would have sent for the identical error.
        return { status: "suspended", filed: null, intent: { tool: err.tool, impact: toWireImpact(err.impact), args: err.args } };
      }
      const filed = await fileApproval(deps, envelope, tenantId, def.name, err);
      return { status: "suspended", filed };
    }
    throw err;
  }
}

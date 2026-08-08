// D14-11 — the write-capability guard. This is a CI GUARD, not a behavioural test: it asserts
// something about the SHAPE of every AgentDef in the repo, so a future edit to specialists.ts cannot
// silently arm a latent defect.
//
// WHY THIS EXISTS (the latent defect it guards)
// The owner's locked D14-b decision is: a suspended agent goal is resumed by RE-RUNNING IT FROM THE
// TOP. Two facts make that unsafe if an AgentDef changes without care:
//
//  1. `agent.ts` throws ApprovalRequiredError on a `high_write` UNCONDITIONALLY — it has no knowledge
//     of an already-decided `automation_approvals` row. So a re-run replays steps 1..N-1, re-suspends
//     at N, and files a SECOND approval (and a second notification email). It cannot make forward
//     progress; it is a duplicate generator.
//  2. A re-run redoes every write the goal already committed. That is safe only for writes that are
//     idempotent (or dedupe on a stable key).
//
// Today neither bites: no AgentDef declares a `high_write`, and the single write any agent holds
// (`tasks.update`) was verified idempotent by the 2026-08-05 re-run idempotency audit. This guard
// keeps that true by construction instead of by luck.
//
// TWO HALVES, DIFFERENT LIFETIMES — do not delete them together:
//  * The `high_write` ban is TEMPORARY. D14-10 (approval-aware agent runner) makes a re-run consult
//    the decided approval row and proceed once; when it lands, this half is liftable.
//  * The `low_write` allowlist is PERMANENT until a per-tool dedupe mechanism exists. Extending it
//    requires a per-tool idempotency proof in the PR — deliberately per-tool, because the broad
//    "audit every low-impact write" prerequisite was found to be overstated (the reachable agent
//    write set is tiny; a blanket audit is theatre where a per-tool proof is evidence).
//
// ── D14-10 LANDED (2026-08-05) AND THE `high_write` BAN STAYS — WHY, EXPLICITLY ────────────────────
// D14-10 shipped: `agent.ts` now consults `AgentDeps.resolveApproval` before throwing, and
// `platform-nest`'s `POST :tenantId/automation-approvals/resolve-and-execute` matches a decided
// `origin='agent'` row on the canonical `argsSha256` and drives D14-03's single-use claim. Both claim
// orders are proven to execute exactly once. So the mechanism this ban was waiting for EXISTS.
//
// It is still not liftable, because the ban's premise — "a re-run cannot make forward progress" —
// remains TRUE end to end for two reasons OUTSIDE D14-10's file scope:
//
//  1. NO LIVE TRANSPORT. `resolveApproval` is optional and NOTHING wires it: `deps.ts` has no
//     implementation, and there is no hub tool for the endpoint (`approvals.request` exists;
//     a resolve-and-execute counterpart does not). ai-agents holds no platform credential and reaches
//     the platform only through the MCP hub, so the wiring is a hub-tool ticket — including the
//     contract decision of what impact tier a tool that TRIGGERS an approved execution carries.
//     Until then every runner takes the documented fallback: `{ match: "none" }` ⇒ throw + file ⇒
//     the duplicate generator, unchanged.
//  2. NO REGISTRY ENTRY EITHER WAY. Even with the transport, the platform can only execute a tool that
//     has an entry in `platform-nest/src/core/approval-executables.ts` (today: `deploy.staging`,
//     `deploy.production`). `decide()` leaves anything else `execution_status='not_applicable'`, which
//     resolves to `not_executable` — a loud stop, still no forward progress. That registry is
//     deliberately one-tool-per-ticket-with-its-own-precondition, and money-spending tools are
//     permanently barred, so this is a real gate rather than paperwork.
//
// LIFTING THIS HALF therefore requires, per tool: (a) the live resolver wired end to end, and (b) an
// executable-registry entry with a server-side precondition. When both hold, replace this blanket ban
// with a per-tool allowlist of high writes that satisfy them — do not simply delete the assertion, or
// the next AgentDef edit re-arms the defect silently. The `low_write` half above is untouched by all
// of this and stays as-is.
//
// ── D14-14 LANDED (2026-08-05) — THE BLANKET BAN BECOMES A PER-TOOL ALLOWLIST ───────────────────────
// Prerequisite (1) above is now satisfied END TO END: `mcp-hub/src/platform-write-tools.ts` registers
// `approvals.resolveExecute` (write:true, impact:"high", minAssurance:"verified" — never scoped into
// any workflow allow-list, never listed in any AgentDef), and `ai-agents/src/deps.ts`'s `liveDeps`
// binds a real `resolveApproval` that calls it. The transport half of the ban is gone.
//
// Prerequisite (2) is STILL per-tool: at D14-14 landing, `approval-executables.ts` registered only
// `deploy.staging` and `deploy.production` — neither is, or is meant to be, an AgentDef tool. So
// `RERUN_CAPABLE_HIGH_WRITES` below is the allowlist the blanket ban becomes, and it was EMPTY at
// landing: no tool yet satisfied BOTH halves for an agent-callable write. The three AgentDefs that
// existed then were therefore unaffected — that change was a MECHANISM swap (blanket ban → per-tool
// allowlist + structural absence check), not a behavior change.
//
// TO ADD A TOOL to `RERUN_CAPABLE_HIGH_WRITES`, its PR must show BOTH, by name:
//   (a) the live resolver is wired (true globally as of D14-14 — cite this file's date/ticket), AND
//   (b) `platform-nest/src/core/approval-executables.ts` has an entry for that exact tool name with a
//       server-side `precondition` (not the `NO_PRECONDITION_REASON` fail-closed default).
// Do not delete this assertion when adding an entry — extend the allowlist and keep the check.
//
// ── T2 (ASST-23, 2026-08-06) — FIRST TWO ENTRIES LAND: `pm.createTask`, `pm.createDoc` ──────────────
// See `RERUN_CAPABLE_HIGH_WRITES`'s own doc, immediately below, for the full per-tool (a)/(b) citation.
// `ai-agents/src/specialists.ts`'s new `task-filer` AgentDef (`writeSpecialists`) is the first, and
// only, AgentDef that declares either — the allowlist stays a per-tool ledger, not a blanket grant.
import { describe, it, expect } from "vitest";
import * as specialistsModule from "./specialists";
import type { AgentDef, Impact } from "./agent";

/**
 * Low-impact write tools an agent may hold, each with a verified idempotency proof.
 *
 * `tasks.update` — verified 2026-08-05 (re-run idempotency audit): a bounded field update on an
 * existing row, so re-applying identical args converges rather than accumulating. No INSERT, no
 * append, no external effect.
 *
 * TO ADD A TOOL HERE you must state, in the PR, why re-executing it with identical arguments cannot
 * produce a second effect. Beware two traps that have already caused wrong idempotency conclusions in
 * this repo: `UNIQUE (a, b)` does NOT constrain rows where either column is NULL (SQL NULLs are
 * distinct) and that same rule silently disables `ON CONFLICT`; and a column a SELECT omits looks
 * exactly like a NULL value. "It has a unique index" is not a proof until you have checked the
 * columns' nullability in the migration.
 *
 * ── P4-J5 (2026-08-08) — THREE OF FOUR PM writes ADDED; ONE EXCLUDED ON PURPOSE ─────────────────────
 * `pm-task-manager` (specialists.ts) wanted all four P4-J2 writes. Per-tool proof against
 * `platform-nest/src/modules/pm/pm.controller.ts`'s actual handlers (not the hub's impact label,
 * which answers a different question — blast radius, not re-run safety):
 *
 *  - `pm.setStatus` -> `patchTask`'s status/progress coupling. On a re-run, the SECOND identical
 *    `{status: X}` call arrives when the row is ALREADY at X (the first run committed it — low writes
 *    never wait for approval). `status !== task.status` is false, so: `statusChanged` is false (no
 *    duplicate follower notify, patchTask's own gate at the "if (statusChanged)" branch below the
 *    transaction); `wasDone === isDoneNow` (both computed off the SAME status), so `completingNow` is
 *    false and the not-done→done recurrence-spawn edge does NOT fire twice (patchTask's own comment:
 *    "re-PATCHing an already-done task ... never spawns a second child — the edge is false the second
 *    time", plus a second, independent existing-child guard); `blockReason`'s three branches
 *    (cleared / system-forced-null / human-reason) are pure functions of `(status, openDeps,
 *    b.blockReason)`, all identical on both calls, so it converges to the same value. The bounded
 *    `UPDATE ... SET status = $5` is a plain overwrite with the value it already holds. The one thing
 *    that DOES re-fire is `emitEvent`'s `pm.task.updated` — a second audit/outbox row, not a second
 *    business-data effect — the same category of harmless bookkeeping `tasks.update`'s own proof
 *    above tolerates; it is not what this guard exists to prevent.
 *  - `pm.passBall` -> `patchTask`'s `writesAssignee` branch, specifically `syncTaskAssignees`
 *    (`pm.controller.ts`): it calls `applyRoleTransition` for both the owner (Ball) and responsible
 *    roles, and that function's OWN documented invariant is "a true no-op (... the incoming target is
 *    identical to what's already open) must NOT append — see pm_task_assignment_events' own header: it
 *    is a log of WRITES, not a heartbeat" (`sameValue` check, returns `false`). `syncTaskAssignees`
 *    then appends to the ledger `ONLY when something actually changed` (`ownerChanged ||
 *    responsibleChanged`). So a re-run's identical pass — same refId, same responsibleId (the tool
 *    itself reads-before-write and carries the existing responsibleId forward unchanged) — appends
 *    NOTHING to `pm_task_assignment_events` the second time. `notifyResponsible` is gated on
 *    `assignee.responsibleId !== task.assignee.responsibleId`, already false post-first-run. The blob
 *    UPDATE (`pm_tasks.assignee = $9`) overwrites with the value it already holds.
 *  - `pm.setDueDate` -> `patchTask`'s `due_date = CASE WHEN $14 THEN $15::date ELSE due_date END` — a
 *    single bounded scalar column set on an existing row, gated by nothing else in the coupling logic
 *    (dueDate does not participate in the done/recurrence/dependency branches above). Structurally the
 *    SAME shape as `tasks.update`'s own already-verified proof, just a different column.
 *
 *  - `pm.comment` is DELIBERATELY NOT HERE and NOT on `pm-task-manager`'s allow-list.
 *    `core/collab.controller.ts`'s `createComment` mints a fresh `id = newId()` and unconditionally
 *    `INSERT`s — no `ON CONFLICT`, no content-based or client-supplied dedup key (contrast
 *    `addReaction` two functions above it in the SAME file, whose own comment states the exact
 *    property this needs: "Idempotent: re-adding the same (comment, user, emoji) is a no-op ... the PK
 *    IS the idempotency key" — `comments` has no equivalent). Two identical re-runs create TWO comment
 *    rows. This is a real gap, not an oversight papered over: an agent that needs to comment on PM work
 *    is a legitimate follow-up, gated on either (a) the platform adding a client-supplied idempotency
 *    key to `POST :t/comments` (same shape `addReaction`'s composite PK already gives reactions), or
 *    (b) declaring it `high_write` and adding a real `approval-executables.ts` entry — NOT on loosening
 *    this guard.
 */
export const VERIFIED_IDEMPOTENT_LOW_WRITES: readonly string[] = ["tasks.update", "pm.setStatus", "pm.passBall", "pm.setDueDate"];

/**
 * D14-14 — high-write tools an AgentDef MAY declare, because BOTH prerequisites the header above
 * requires are satisfied for that exact tool name:
 *   (a) the live `resolveApproval` transport is wired (globally true since D14-14 — see this file's
 *       header for the mechanism), AND
 *   (b) `platform-nest/src/core/approval-executables.ts` registers that tool with a real server-side
 *       precondition (not the fail-closed `NO_PRECONDITION_REASON` default).
 *
 * ── T2 (ASST-23, 2026-08-06) — FIRST TWO ENTRIES: `pm.createTask`, `pm.createDoc` ───────────────────
 * Both prerequisites verified, by name, for BOTH tools (not asserted — read from the code):
 *   (a) TRUE GLOBALLY as of D14-14, same mechanism as every other tool: `ai-agents/src/deps.ts`'s
 *       `liveDeps.resolveApproval` calls the hub's `approvals.resolveExecute`
 *       (`mcp-hub/src/platform-write-tools.ts:345`). Nothing tool-specific to verify here — this half
 *       does not vary by tool name.
 *   (b) `platform-nest/src/core/approval-executables.ts`'s `registerPmExecutableApprovals()` registers
 *       BOTH: `pm.createTask` with `pmCreateTaskPrecondition` (project exists ∧ not archived ∧, when an
 *       assignee is named, that assignee is still an active member — typed reasons
 *       `project_not_found` / `project_archived` / `assignee_gone`), and `pm.createDoc` with the shared
 *       `pmProjectPrecondition` (project exists ∧ not archived — no assignee branch because the tool
 *       has no assignee field, a documented scope call, not a gap). Neither is the fail-closed
 *       `NO_PRECONDITION_REASON` default.
 *
 * Consumer: `ai-agents/src/specialists.ts`'s `task-filer` (the assistant's first proposable write,
 * `writeSpecialists`) declares both `high_write`. `d14-17-assistant-write-registry.test.ts`
 * (platform-nest) proves the `origin='agent'` execution path end to end for `pm.createTask` (test C)
 * and, per the design's §7.1 caveat, gained a matching `pm.createDoc` executes-once case + an
 * archived-project refusal case so "both covered" is demonstrated, not merely asserted from the
 * `createTask` proof's mechanism.
 *
 * PREVIOUSLY EMPTY (through 2026-08-05): `approval-executables.ts` registered only
 * `deploy.staging`/`deploy.production` (D14-05, neither agent-callable) plus, since D14-15, the PM
 * pair above with NO AgentDef yet declaring either `high_write` — this file's own guard forbade it
 * while the allowlist was `[]`. Extending this list FURTHER requires citing BOTH (a) and (b) by name in
 * the PR for the specific tool being added; a per-tool proof, never a blanket audit (the same
 * discipline `VERIFIED_IDEMPOTENT_LOW_WRITES` above already uses). Do not delete this assertion when
 * extending the allowlist further — extend it and keep the check.
 */
export const RERUN_CAPABLE_HIGH_WRITES: readonly string[] = ["pm.createTask", "pm.createDoc"];

/** D14-14 — the runner-only re-run transport tool. NEVER model-selectable: the write gate in
 *  `agent.ts` calls `AgentDeps.resolveApproval` directly, never via a tool a model chose from an
 *  `AgentDef.tools` map. This name must therefore appear in NO AgentDef, ever — see the guard test
 *  below. (Kept as a literal rather than imported: ai-agents cannot import mcp-hub's registry —
 *  separate standalone projects, not a monorepo — so this is the one place the name is pinned on the
 *  ai-agents side, mirroring how `mcp-hub/src/platform-write-tools.ts` pins it on the other.) */
export const RESOLVE_EXECUTE_TOOL_NAME = "approvals.resolveExecute";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T2 (ASST-23) — the ai-agents half of a TWO-SIDED handshake: no assistant-facing AgentDef may declare
// ANY `low_write`, not even one on `VERIFIED_IDEMPOTENT_LOW_WRITES` above.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS IS A SEPARATE, STRICTER RULE FROM THE `low_write` GUARD ABOVE: that guard asks "is this
// write idempotent enough to survive agent.ts's re-run-from-the-top resume?" — a runner-safety
// question. It says nothing about WHO may trigger the write. The owner's locked design decision D-A
// (docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md) is that EVERY assistant-triggered write
// becomes a proposal a human decides — never a silent, unattended commit, no matter how idempotent. A
// `low_write` executes immediately by construction (`agent.ts`'s write gate only suspends on
// `high_write`), so an assistant-facing AgentDef holding one — even `tasks.update`, verified idempotent
// for `task-triager`'s own re-run safety — would let a chat turn commit a write with nobody in the
// loop. That is a DIFFERENT failure mode than the re-run duplication problem `VERIFIED_IDEMPOTENT_LOW_WRITES`
// guards against, so it needs its own list and its own check rather than being folded into that one.
//
// "ASSISTANT-FACING" is read off `platform-nest/src/modules/assistant/broker.ts`'s `ASSISTANT_AGENT_TOOLS`
// map — the broker's entire tool universe for a chat turn (that file's own header: `runToolTurn` refuses
// any agent not present as a key before it ever contacts the runner). `ai-agents` cannot import that
// map (separate standalone projects, not a monorepo — see CLAUDE.md), so this is the ai-agents-side half
// of the same handshake `broker.ts` restates from its side: keep the two lists in sync by hand, same
// discipline as `RERUN_CAPABLE_HIGH_WRITES`'s own restated-not-imported wire vocabulary in
// `write-agent.ts`. `task-triager` is deliberately NOT here — it is a write-capable specialist, but the
// broker cannot drive it (D14-17's own finding, still true: it lives in `writeSpecialists` under a name
// `ASSISTANT_AGENT_TOOLS` never mentions), so its `low_write` stays exactly as governed by
// `VERIFIED_IDEMPOTENT_LOW_WRITES` above and is out of THIS guard's scope.
export const ASSISTANT_FACING_AGENTS: readonly string[] = ["status-reporter", "approvals-chaser", "task-filer"];

/** Structural AgentDef check — deliberately duck-typed rather than instanceof/type-only. */
function isAgentDef(value: unknown): value is AgentDef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.systemPrompt === "string" &&
    typeof v.tools === "object" &&
    v.tools !== null &&
    typeof v.maxSteps === "number"
  );
}

/**
 * Every AgentDef reachable from specialists.ts, however it is exported.
 *
 * This walks the module's exports and recurses one level into exported records, rather than reading
 * the two known maps. That matters: `taskTriager` — the ONLY write-capable specialist — is absent
 * from `specialists` and lives in `writeSpecialists`, so a guard that iterated `specialists` alone
 * would inspect exactly the two read-only defs and pass while ignoring the one def that can write.
 * A future def added as a bare named export, or in a third map, is caught here for the same reason.
 */
function collectAgentDefs(): Array<{ exportPath: string; def: AgentDef }> {
  const found: Array<{ exportPath: string; def: AgentDef }> = [];
  const seen = new Set<AgentDef>();
  for (const [exportName, exported] of Object.entries(specialistsModule as Record<string, unknown>)) {
    if (isAgentDef(exported)) {
      if (!seen.has(exported)) { seen.add(exported); found.push({ exportPath: exportName, def: exported }); }
      continue;
    }
    if (typeof exported === "object" && exported !== null) {
      for (const [key, nested] of Object.entries(exported as Record<string, unknown>)) {
        if (isAgentDef(nested) && !seen.has(nested)) {
          seen.add(nested);
          found.push({ exportPath: `${exportName}.${key}`, def: nested });
        }
      }
    }
  }
  return found;
}

describe("D14-11 — AgentDef write-capability guard", () => {
  const defs = collectAgentDefs();

  it("finds the AgentDefs, including write-capable ones outside the `specialists` map", () => {
    // Falsifiability anchor: if this ever collects only the read-only defs, the guard below is
    // vacuous and would pass no matter what task-triager (or task-filer) declared.
    expect(defs.length).toBeGreaterThanOrEqual(4);
    expect(defs.map((d) => d.def.name)).toContain("task-triager");
    expect(defs.map((d) => d.def.name)).toContain("task-filer");
  });

  it("declares `high_write` only for tools on RERUN_CAPABLE_HIGH_WRITES (D14-14: per-tool allowlist, not a blanket ban)", () => {
    const offenders = defs.flatMap(({ exportPath, def }) =>
      Object.entries(def.tools)
        .filter(([tool, impact]) => impact === "high_write" && !RERUN_CAPABLE_HIGH_WRITES.includes(tool))
        .map(([tool]) => `${def.name} (${exportPath}) declares high_write "${tool}"`),
    );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : [
            "A `high_write` AgentDef tool must be on RERUN_CAPABLE_HIGH_WRITES before an AgentDef may",
            `declare it. Current allowlist: [${RERUN_CAPABLE_HIGH_WRITES.join(", ")}] (see this file's header).`,
            "",
            "Two prerequisites gate that allowlist, and a PR extending it must show BOTH, by name, for",
            "the specific tool:",
            "",
            "  (a) The live `AgentDeps.resolveApproval` transport is wired — TRUE globally since D14-14",
            "      (mcp-hub/src/platform-write-tools.ts registers approvals.resolveExecute;",
            "      ai-agents/src/deps.ts's liveDeps binds a real resolveApproval that calls it).",
            "",
            "  (b) platform-nest/src/core/approval-executables.ts registers THIS tool with a real",
            "      server-side precondition (not the fail-closed NO_PRECONDITION_REASON default) — the",
            "      platform can only auto-execute a registered tool; anything else stays",
            "      execution_status='not_applicable' and resolves to `not_executable`, a loud stop with",
            "      no forward progress. Entries are one-per-ticket with their own precondition;",
            "      money-spending tools are permanently barred from that registry.",
            "",
            "Add the tool name to RERUN_CAPABLE_HIGH_WRITES only once both hold — do not just delete or",
            "widen this assertion.",
            "",
            ...offenders.map((o) => `  - ${o}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("D14-14: approvals.resolveExecute — the runner-only re-run transport — appears in NO AgentDef.tools map", () => {
    // Structural proof, not a convention: the write gate in agent.ts calls AgentDeps.resolveApproval
    // DIRECTLY (runner infrastructure), never via a tool a model selects from an AgentDef.tools map.
    // If this name ever appeared in a map, a model could choose to call it directly — defeating the
    // single-use claim and the requested_by binding that make it safe (§1's authority rule) — so its
    // absence is exactly what the architect's Ruling 1 (2026-08-05 SET C §C.0) requires.
    const offenders = defs
      .filter(({ def }) => RESOLVE_EXECUTE_TOOL_NAME in def.tools)
      .map(({ def, exportPath }) => `${def.name} (${exportPath}) lists ${RESOLVE_EXECUTE_TOOL_NAME}`);
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : [
            `"${RESOLVE_EXECUTE_TOOL_NAME}" must never appear in any AgentDef.tools map — it is a`,
            "runner-only transport (agent.ts's write gate calls AgentDeps.resolveApproval directly),",
            "never a model-selectable tool. See D14-14 / architect Ruling 1 (2026-08-05 SET C §C.0).",
            "",
            ...offenders.map((o) => `  - ${o}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("declares no `low_write` outside VERIFIED_IDEMPOTENT_LOW_WRITES (needs a per-tool proof)", () => {
    const offenders = defs.flatMap(({ exportPath, def }) =>
      Object.entries(def.tools)
        .filter(([tool, impact]) => impact === "low_write" && !VERIFIED_IDEMPOTENT_LOW_WRITES.includes(tool))
        .map(([tool]) => `${def.name} (${exportPath}) declares unverified low_write "${tool}"`),
    );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : [
            "A `low_write` tool must be on VERIFIED_IDEMPOTENT_LOW_WRITES before an AgentDef may hold it.",
            `Current allowlist: [${VERIFIED_IDEMPOTENT_LOW_WRITES.join(", ")}] (see this file's header).`,
            "",
            "Why: the owner's D14-b decision re-runs a suspended goal FROM THE TOP, which redoes every",
            "write the goal already committed. A non-idempotent write therefore duplicates its effect",
            "on every re-run — the same defect class WD-29 fixed for pipeline stages.",
            "",
            "To extend the allowlist, state in the PR why re-executing the tool with identical arguments",
            "cannot produce a second effect. A unique index is NOT a proof until you have checked the",
            "columns' nullability (SQL NULLs are distinct, which also silently disables ON CONFLICT).",
            "",
            ...offenders.map((o) => `  - ${o}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("no assistant-facing AgentDef declares a `low_write` — the ai-agents half of the two-sided no-immediate-writes handshake (D-A)", () => {
    // Falsifiability anchor: if ASSISTANT_FACING_AGENTS ever names a def that doesn't exist (a typo, or
    // one renamed on the broker side without a matching rename here), the filter below silently checks
    // nothing for it. Every name on the list must resolve to a real, found AgentDef.
    const foundNames = new Set(defs.map((d) => d.def.name));
    const unresolved = ASSISTANT_FACING_AGENTS.filter((name) => !foundNames.has(name));
    expect(unresolved, `ASSISTANT_FACING_AGENTS names an AgentDef this guard never found: [${unresolved.join(", ")}]`).toEqual([]);

    const offenders = defs
      .filter(({ def }) => ASSISTANT_FACING_AGENTS.includes(def.name))
      .flatMap(({ exportPath, def }) =>
        Object.entries(def.tools)
          .filter(([, impact]) => impact === "low_write")
          .map(([tool]) => `${def.name} (${exportPath}) is assistant-facing and declares low_write "${tool}"`),
      );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : [
            "An assistant-facing AgentDef (one the platform-nest assistant broker can drive — see",
            `ASSISTANT_FACING_AGENTS's header) may declare NO low_write at all, even one on`,
            "VERIFIED_IDEMPOTENT_LOW_WRITES: the owner's D-A decision is that every assistant-triggered",
            "write is a PROPOSAL a human decides, never an unattended commit. A low_write executes",
            "immediately by construction (agent.ts's write gate only suspends on high_write), so holding",
            "one here would let a chat turn commit a write with nobody in the loop — a different failure",
            "mode than the re-run-duplication problem VERIFIED_IDEMPOTENT_LOW_WRITES guards against.",
            "",
            "If this agent genuinely needs to write, declare the tool high_write and add it to",
            "RERUN_CAPABLE_HIGH_WRITES (with both prerequisites) instead — that is the proposal path.",
            "",
            ...offenders.map((o) => `  - ${o}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("uses only known Impact values (an unknown label would bypass both checks above)", () => {
    const known: Impact[] = ["read", "low_write", "high_write"];
    const offenders = defs.flatMap(({ exportPath, def }) =>
      Object.entries(def.tools)
        .filter(([, impact]) => !known.includes(impact as Impact))
        .map(([tool, impact]) => `${def.name} (${exportPath}): tool "${tool}" has impact "${String(impact)}"`),
    );
    // This is the guard's own guard: a typo'd impact (e.g. "write") is neither high_write nor an
    // unlisted low_write, so both assertions above would pass it silently while agent.ts treats it as
    // an allow-listed non-high write and executes it unattended.
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

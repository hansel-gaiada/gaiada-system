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
 */
export const VERIFIED_IDEMPOTENT_LOW_WRITES: readonly string[] = ["tasks.update"];

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
    // vacuous and would pass no matter what task-triager declared.
    expect(defs.length).toBeGreaterThanOrEqual(3);
    expect(defs.map((d) => d.def.name)).toContain("task-triager");
  });

  it("declares no `high_write` tool on any AgentDef (D14-10 landed; see the header for what still gates the lift)", () => {
    const offenders = defs.flatMap(({ exportPath, def }) =>
      Object.entries(def.tools)
        .filter(([, impact]) => impact === "high_write")
        .map(([tool]) => `${def.name} (${exportPath}) declares high_write "${tool}"`),
    );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : [
            "A `high_write` AgentDef tool is still banned. D14-10 landed, but two prerequisites OUTSIDE",
            "its scope are not met, so a re-run STILL cannot make forward progress with this tool:",
            "",
            "  1. No live `AgentDeps.resolveApproval` transport. agent.ts consults it before throwing,",
            "     but nothing implements it (deps.ts has no binding, and the MCP hub exposes no",
            "     resolve-and-execute tool — only approvals.request). With no resolver the gate takes its",
            "     documented fallback — throw + file — i.e. the duplicate-approval generator, unchanged:",
            "     a re-run replays steps 1..N-1, re-suspends here, and files a SECOND approval.",
            "",
            "  2. No executable-registry entry for the tool. Even with the transport, the platform can",
            "     only execute a tool registered in platform-nest/src/core/approval-executables.ts",
            "     (today: deploy.staging, deploy.production). Anything else stays",
            "     execution_status='not_applicable' and resolves to `not_executable` — a loud stop, no",
            "     progress. Entries are one-per-ticket with their own server-side precondition; money-",
            "     spending tools are permanently barred.",
            "",
            "To hold a high_write, satisfy BOTH for that tool, then replace this blanket ban with a",
            "per-tool allowlist naming it — do not just delete the assertion.",
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

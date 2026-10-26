// PGL-05 (owner ruling PV-D46 (1), revisiting PV-D27 (1)) — NOBODY APPROVES THEIR OWN AGENT'S HIGH-IMPACT REQUEST.
//
// Contract: docs/PERMISSION-CONTRACT.md §52. Plan: docs/plans/2026-10-15-portal-go-live-tickets.md (PGL-05).
//
// ── THE RULE ──────────────────────────────────────────────────────────────────────────────────────
// An `approved` decision on an `automation_approvals` row is refused with the typed reason `self_approval` when ALL hold:
//   1. the row's origin is `agent` or `automation` (the D14 rows: a machine filed it, a human lifts the gate);
//   2. the row's tool is HIGH impact (see "WHERE IMPACT COMES FROM" below);
//   3. the decider is the row's filer (`requested_by`), or the decide call acts FOR the filer (`x-act-for`).
// Nobody is exempt: this runs after Cerbos and is not a Cerbos rule, so `platform_admin`'s wildcard cannot reach past it.
// Rejecting is always allowed (it executes nothing). Medium, low and unclassified rows are untouched (the lead's call in
// the plan: PV-D46 (1) applies to the high tier PV-D27 (1) named).
//
// It is ONE generic rule, not a per-entry `approverCheck`: a high-impact tool added next month is covered the day it is
// declared high, with no new code. Two walls use the same function:
//   - `AutomationApprovalsController.decide()` (the one decide surface for these rows; the `/approvals/:id/decide`
//     façade delegates to it), BEFORE the decide UPDATE, so a refusal is a 403 and the row stays `pending`;
//   - the executor's claim transaction (`approval-execute.ts`), against the STORED `decided_by`, so a row that reached
//     `approved` by any other path (a hand edit, a future surface, a row decided before this rule) lands `failed` with
//     `approver_refused: self_approval` and the hub is never called.
//
// ── WHO "THE HUMAN THE REQUEST ACTS FOR" IS ───────────────────────────────────────────────────────
// `automation_approvals` has no act-for column. It does not need one, because of how rows are filed:
//   - origin `agent`: the agent runner files under the TRIGGERING HUMAN'S OWN OBO envelope (ai-agents sends the
//     human's envelope verbatim; the agent is recorded as `agent_name` and `via.agent`, never as the principal), so
//     `requested_by` IS the human the agent acts for. The confirm machinery (assistant write intents) files as the
//     chatting user, the same human.
//   - origin `automation`: `requested_by` is the n8n workflow's own service account. It acts for no human.
//   - a filing that carries `x-act-for` naming someone else would lose that human (only `requested_by` is stored), so
//     `create()` REFUSES it (`act_for_filing_unsupported`, see `actForFilingRefusal` below). No channel sends
//     one today (the hub mints no act-for; only the simulation harness can), so nothing live is refused, and the rule
//     stays complete by construction: every row's acting-for human is its `requested_by`.
// So the excluded set is `{ requested_by }`, compared with BOTH the decider and the human the decide call acts for.
//
// ── WHERE IMPACT COMES FROM (and why the stored column alone is not enough) ───────────────────────
// `automation_approvals.impact` is stored on the row, but the FILER supplies it (`approvals.request`'s `impact` arg), and
// the filer is exactly the party this rule constrains: labelling a high tool `medium` would dodge the rule. So the
// effective impact is the HIGHEST of every server-side source that knows the tool, and the stored value can only
// ever raise it:
//   1. the platform's own tool definition (`McpToolDef.impact` in `core/core-tools.ts` or a module's `mcpTools`),
//      the same union `GET /mcp/tool-defs` hands the hub, which is where the hub's D14 gate reads the tier from;
//   2. the executable registry entry's declared `impact`, which exists ONLY for the hub-local tools the platform does
//      not define (`deploy.*`, `pm.*`, restated from `mcp-hub/src/delivery-tools.ts` and `pm-tools.ts`);
//   3. the stored row `impact`.
// `approval-self-approval.test.ts` pins that every executable registry entry resolves to a server-side tier (1 or 2),
// so a tool that can EXECUTE always has an impact the filer cannot lower. A tool with no server-side tier cannot execute
// (no registry entry means `not_applicable`), so for it the stored value is the only fact and is used as is.
import { allCoreTools } from "./core-tools";
import { allModules } from "../modules/registry";
import { getExecutable, type PreconditionVerdict } from "./approval-executables";

/** The typed refusal reason (403 body `reason`, and the executor's `approver_refused: self_approval`). */
export const SELF_APPROVAL = "self_approval";

/** The typed reason `create()` refuses a filing whose acting-for human would not be recorded. */
export const ACT_FOR_FILING_UNSUPPORTED = "act_for_filing_unsupported";

/** The origins the rule covers: the D14 rows, where a machine files and a human lifts the gate. */
export const SELF_APPROVAL_ORIGINS: ReadonlySet<string> = new Set(["automation", "agent"]);

export type ApprovalImpact = "low" | "medium" | "high" | "unclassified";

const RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

/** The impact tier the PLATFORM declares for a tool (its `McpToolDef`), or undefined when it defines none. */
export function platformToolImpact(toolName: string): "low" | "medium" | "high" | undefined {
  const def =
    allCoreTools().find((d) => d.name === toolName) ??
    allModules().flatMap((m) => m.mcpTools ?? []).find((d) => d.name === toolName);
  return def?.impact;
}

/** The tier known SERVER-SIDE for a tool (platform def, else the executable entry's declared tier), or undefined. */
export function serverSideToolImpact(toolName: string): "low" | "medium" | "high" | undefined {
  const fromDef = platformToolImpact(toolName);
  const fromEntry = getExecutable(toolName)?.impact;
  if (fromDef && fromEntry) return RANK[fromDef] >= RANK[fromEntry] ? fromDef : fromEntry;
  return fromDef ?? fromEntry;
}

/** The effective impact of an approval row: the highest of the server-side tier and the stored value. */
export function effectiveApprovalImpact(toolName: string, storedImpact: string | null | undefined): ApprovalImpact {
  const known = [serverSideToolImpact(toolName), storedImpact].filter((v): v is "low" | "medium" | "high" => !!v && v in RANK);
  if (!known.length) return "unclassified";
  return known.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

export interface SelfApprovalRow {
  origin: string;
  toolName: string;
  impact: string | null | undefined;
  requestedBy: string | null | undefined;
}

export interface SelfApprovalDecider {
  /** The deciding principal's `users.id` (at execution: the stored `decided_by`). */
  userId: string | null | undefined;
  /** The human the decide call acts for (`x-act-for`), when it does. */
  actForUserId?: string | null;
}

/**
 * THE rule, pure. `{ ok: true }` when the rule does not apply or is satisfied. A high-impact D14 row with no decider id
 * refuses as `approver_unknown` (the same token `approverCheck` uses): an id-less principal cannot be told apart from
 * the filer. A row with no `requested_by` has no filer to exclude, so only that half is skipped.
 */
export function selfApprovalVerdict(row: SelfApprovalRow, decider: SelfApprovalDecider): PreconditionVerdict {
  if (!SELF_APPROVAL_ORIGINS.has(row.origin)) return { ok: true };
  if (effectiveApprovalImpact(row.toolName, row.impact) !== "high") return { ok: true };
  if (!decider.userId) return { ok: false, reason: "approver_unknown" };
  const excluded = row.requestedBy ? [row.requestedBy] : [];
  const deciders = [decider.userId, decider.actForUserId].filter((v): v is string => !!v);
  if (deciders.some((d) => excluded.includes(d))) return { ok: false, reason: SELF_APPROVAL };
  return { ok: true };
}

/**
 * The filing half of the act-for reasoning in this file's header: a filing whose principal acts for SOMEONE ELSE
 * would store only the acting principal as `requested_by` and lose the human, so the rule could not see them. Refused
 * rather than silently filed. Returns the refusal reason, or null when the filing is fine (no act-for, or act-for
 * naming the principal itself).
 */
export function actForFilingRefusal(principal: { userId?: string | null; actFor?: { userId: string } }): string | null {
  if (principal.actFor && principal.actFor.userId && principal.actFor.userId !== principal.userId) {
    return ACT_FOR_FILING_UNSUPPORTED;
  }
  return null;
}

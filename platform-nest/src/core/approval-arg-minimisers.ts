// M5-G5b — per-tool APPROVAL ARGS POLICIES: a tool whose arguments are personal data declares how its args are
// reduced BEFORE an approval for it is persisted or emitted. Applied by core/approval-filing.ts (the INSERT
// chokepoint) and by the two controller paths that read or re-emit stored args. A tool with no policy is
// untouched: its `tool_args` are stored exactly as before (regression-tested), so adopting this is opt-in.
//
// ── WHY A SEPARATE REGISTRY, AND WHY IT IS STATIC ───────────────────────────────────────────────────
// core/approval-executables.ts is the D14 registry ("may this auto-execute"), and `resetExecutableApprovals()`
// clears it for tests; a minimiser parked there would be cleared with it and a later test (or a real process that
// never re-registered) would store raw args. This registry is separate, never reset, and its built-in entries are
// imported statically below, so no boot order can leave a privacy tool without its policy. The only mutable part
// is `registerApprovalArgsPolicy`, for the next tool that opts in.
//
// ── THE CONTRACT OF A POLICY ────────────────────────────────────────────────────────────────────────
//   minimise(args)        PURE and IDEMPOTENT. Returns the args to store and the reason text to file with (the
//                         caller's own free-text `reason` is replaced, so it cannot carry the data either). May
//                         throw a 400 for args the tool would refuse anyway (nothing is stored then).
//   eventArgs(stored)     what of the STORED args may ride the `automation_approval.decided` outbox event.
//   authorizeFiling(...)  extra authority required to FILE an approval for this tool through the generic create.
//   onFiled(c, ...)       a same-transaction side write (the privacy ledger's `filed` row).
import type { PoolClient } from "pg";
import type { Principal } from "../rbac/principal";
import {
  AGENCY_PRIVACY_TOOL_NAMES, agencyPrivacyEventArgs, authorizeAgencyPrivacyFiling, minimiseAgencyPrivacyArgs,
  onAgencyPrivacyFiled,
} from "./agency-privacy.filing";

export interface ApprovalArgsPolicy {
  toolName: string;
  minimise(args: Record<string, unknown>): { toolArgs: Record<string, unknown>; reason: string };
  eventArgs?(stored: Record<string, unknown>): Record<string, unknown>;
  authorizeFiling?(principal: Principal, tenantId: string): Promise<void>;
  onFiled?(
    c: PoolClient,
    f: { approvalId: string; tenantId: string; toolName: string; requestedBy: string; toolArgs: Record<string, unknown> },
  ): Promise<void>;
}

const policies = new Map<string, ApprovalArgsPolicy>();
const builtIn = new Set<string>();

for (const toolName of AGENCY_PRIVACY_TOOL_NAMES) {
  policies.set(toolName, {
    toolName,
    minimise: (args) => minimiseAgencyPrivacyArgs(toolName, args),
    eventArgs: agencyPrivacyEventArgs,
    authorizeFiling: authorizeAgencyPrivacyFiling,
    onFiled: onAgencyPrivacyFiled,
  });
  builtIn.add(toolName);
}

/** Opt another tool in. Throws on a duplicate name (a policy is a decision, not a default to overwrite). */
export function registerApprovalArgsPolicy(policy: ApprovalArgsPolicy): void {
  if (policies.has(policy.toolName)) throw new Error(`approval args policy already registered: ${policy.toolName}`);
  policies.set(policy.toolName, policy);
}

/** Test seam for a fixture policy. Built-in policies cannot be removed. */
export function unregisterApprovalArgsPolicy(toolName: string): void {
  if (builtIn.has(toolName)) throw new Error(`cannot unregister the built-in args policy for '${toolName}'`);
  policies.delete(toolName);
}

export function getApprovalArgsPolicy(toolName: string): ApprovalArgsPolicy | undefined {
  return policies.get(toolName);
}

export function listApprovalArgsPolicyTools(): string[] {
  return [...policies.keys()];
}

/**
 * The filing input with its args (and reason) reduced by the tool's policy. No policy: the SAME object back,
 * untouched. Idempotent, so every layer may call it.
 */
export function minimiseFilingInput<T extends { toolName: string; toolArgs: Record<string, unknown>; reason?: string | null }>(input: T): T {
  const policy = policies.get(input.toolName);
  if (!policy) return input;
  const m = policy.minimise(input.toolArgs ?? {});
  return { ...input, toolArgs: m.toolArgs, reason: m.reason };
}

/** Just the args, for a digest comparison against a STORED (already minimised) row. */
export function minimiseToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const policy = policies.get(toolName);
  return policy ? policy.minimise(args).toolArgs : args;
}

/** The stored args as they may appear in an outbox event. No policy: unchanged. */
export function eventSafeToolArgs(toolName: string, stored: unknown): unknown {
  const policy = policies.get(toolName);
  if (!policy?.eventArgs) return stored;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return stored;
  return policy.eventArgs(stored as Record<string, unknown>);
}

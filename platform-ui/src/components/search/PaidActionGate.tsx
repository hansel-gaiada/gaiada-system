"use client";
// SM-19 — the pre-commit disclosure for a METERED PROVIDER PULL (design §12 SM-19's "dual-mode
// picker" half that covers §05/§08's paid-pull actions; addendum §A2/§A3/§A4 supply the honesty
// rules this component exists to enforce). NOT the SEM change-proposal execution picker — see
// `ApplyProposalTwins.tsx` for that (design §04/§07's manual/api twins).
//
// Ticket's four honesty rules, each with a concrete line below:
//   1. Real vs simulated must be UNMISSABLE and come from the backend, never inferred client-side.
//      `tool.simulated` is `providers/dispatch.ts`'s own `projectMonthlyCost` output — the SAME
//      field SM-38's `SimulatedBadge` already renders elsewhere. This component never guesses mode
//      from a config assumption.
//   2. A projection is not a charge. Every dollar figure here is captioned "estimate", never
//      "actual"/"charge"/"spend" (addendum §A3's forbidden-word rule, already binding on the
//      ledger surface — extended here to the pre-commit disclosure).
//   3. Which provider, and why. `SINGLE_PROVIDER_TOOLS` (searchMarketingShared.ts) is a literal
//      transcription of `config.ts`'s hardcoded `serp`/`ai_visibility` preference lists — a
//      disabled, reasoned single-choice display, never a dropdown of alternatives this module was
//      never told about (this file does NOT expose an override control: no endpoint serializes the
//      candidate provider list for any capability, so offering a picker of vendors would be
//      inventing data — see searchMarketingShared.ts's header note on this component).
//   4. Unavailable != free. `tool.provider === null` (the projector's own `note` fires when
//      `resolveProvider` throws) renders "Unavailable", never "$0.00" — the exact failure mode a
//      disabled toggle's legitimate $0 must not be confused with.
import { useState } from "react";
import { Button } from "@/components/ui";
import { ProviderLabel, SimulatedBadge } from "@/components/search/SimulatedBadge";
import { SINGLE_PROVIDER_TOOLS, singleProviderReason, formatUsd, type CostProjectionTool, type ProviderMode } from "@/lib/searchMarketingShared";

const DANGER = "var(--erp-danger, #B5622F)";
const WARN = "var(--erp-warn, #9c6f1f)";
const MUTED = "var(--erp-ink-60)";

export function PaidActionGate({
  tool, // toolScope key, e.g. "rank" — used ONLY to look up SINGLE_PROVIDER_TOOLS, never re-derived
  projection, // the matching CostProjectionTool row from GET .../cost-projection, or undefined if it never answered
  providerMode,
  overBudget,
  triggerLabel,
  confirmLabel,
  helpText,
  disabled,
  onConfirm,
}: {
  tool: string;
  projection: CostProjectionTool | null | undefined;
  providerMode: ProviderMode | null;
  overBudget: boolean;
  triggerLabel: string;
  confirmLabel: string;
  helpText?: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const singleProvider = SINGLE_PROVIDER_TOOLS.has(tool);

  function confirm() {
    setReviewing(false);
    onConfirm();
  }

  if (!reviewing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Button variant="solid" size="sm" disabled={disabled} onClick={() => setReviewing(true)}>
          {triggerLabel}
        </Button>
        {helpText && <span style={{ font: "400 12px var(--font-body)", color: MUTED }}>{helpText}</span>}
      </div>
    );
  }

  // Unknown: the cost-projection endpoint never answered for this engagement (404/403, degraded per
  // `skipUnavailable`) — an honest "we don't know" state, never defaulted to looking free or real.
  if (!projection) {
    return (
      <div role="group" aria-label="Confirm paid action" style={{ border: `0.5px solid ${WARN}`, borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
        <p style={{ margin: 0, font: "600 12px var(--font-body)", color: WARN }}>
          Cost, provider, and mode are UNKNOWN for this action — the cost-projection endpoint didn&apos;t
          answer. Proceeding runs the platform&apos;s own live check at dispatch time; nothing here
          confirms it will succeed or what it will cost.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="solid" size="sm" onClick={confirm}>{confirmLabel} anyway</Button>
          <Button variant="ghost" size="sm" onClick={() => setReviewing(false)}>Cancel</Button>
        </div>
      </div>
    );
  }

  const unavailable = projection.enabled && projection.provider === null;

  return (
    <div role="group" aria-label="Confirm paid action" style={{ border: "0.5px solid var(--erp-hairline)", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, font: "400 13px var(--font-body)" }}>
        <strong style={{ color: "var(--text-primary)" }}>Provider:</strong>
        {unavailable ? (
          <span style={{ color: DANGER, fontWeight: 600 }}>Unavailable{projection.note ? ` — ${projection.note}` : ""}</span>
        ) : projection.provider ? (
          <ProviderLabel provider={projection.provider} />
        ) : (
          <span style={{ color: MUTED }}>— (disabled toggle)</span>
        )}
      </div>

      {singleProvider && (
        <p style={{ margin: 0, font: "400 11px/1.5 var(--font-body)", color: MUTED }}>
          {singleProviderReason(unavailable ? null : projection.provider)}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, font: "400 13px var(--font-body)" }}>
        <strong style={{ color: "var(--text-primary)" }}>Estimated cost for this run:</strong>
        {unavailable ? (
          <span style={{ color: DANGER }}>unavailable — not $0.00</span>
        ) : (
          <span>{formatUsd(projection.costPerRunUsd)} <em style={{ fontStyle: "italic", color: MUTED }}>(an estimate — not a charge)</em></span>
        )}
        {projection.simulated && <SimulatedBadge />}
      </div>

      <p style={{ margin: 0, font: "400 12px var(--font-body)", color: projection.simulated ? WARN : "var(--erp-ok, #3a7a54)" }}>
        {providerMode === "simulate" || projection.simulated
          ? "This platform is in SIMULATE mode — this run will NOT place a real vendor call or spend real money."
          : "This platform is in LIVE mode — this run will place a real, billable request to the provider above."}
      </p>

      {overBudget && (
        <p role="alert" style={{ margin: 0, font: "600 12px var(--font-body)", color: DANGER }}>
          This engagement&apos;s projected monthly cost already exceeds its budget cap — further paid
          pulls this month may be refused. (Tenant, provider, and global caps aren&apos;t visible from
          this screen — a refusal for one of those reasons, or the operator kill switch, would only
          appear as an error after you click.)
        </p>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="solid" size="sm" onClick={confirm} disabled={unavailable}>{confirmLabel}</Button>
        <Button variant="ghost" size="sm" onClick={() => setReviewing(false)}>Cancel</Button>
      </div>
    </div>
  );
}

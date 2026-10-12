"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { Card, StatusBadge, Button } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import {
  CANONICAL_DELEGATION_ROLES,
  DELEGATION_SOURCE_LABEL,
  QUESTIONNAIRE_SECTIONS,
  SCHEMA_VERSION,
  PIPELINE_REFUSAL_TEXT,
  STATUS_LABEL,
  allowedMoves,
  buildInviteLink,
  checkDealInput,
  dealInputValue,
  formatAnswerValue,
  formatDeal,
  historyNewestFirst,
  isClosedStage,
  pipelineRefusalMessage,
  precisionHint,
  sectionEntries,
  sourceLabel,
  stageLabel,
  type DelegationInput,
  type LeadDetail,
  type LeadStatus,
  type LeadSubmission,
  type PipelineCurrency,
  type PipelineReference,
  type PipelineStage,
  type StageEvent,
} from "@/lib/agencyLeads";
import type { ReadResult } from "@/lib/readResult";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import type {
  ConvertResult, InviteResult, MoveStageResult, RevokeResult, SetDealResult, TriageResult,
} from "@/app/(app)/agency/leads/actions";
import "./agencyLeads.css";

export type Actions = {
  moveStage: (prev: MoveStageResult | null, formData: FormData) => Promise<MoveStageResult>;
  setDeal: (prev: SetDealResult | null, formData: FormData) => Promise<SetDealResult>;
  invite: (prev: InviteResult | null, formData: FormData) => Promise<InviteResult>;
  revoke: (prev: RevokeResult | null, formData: FormData) => Promise<RevokeResult>;
  open: (prev: TriageResult | null, formData: FormData) => Promise<TriageResult>;
  decline: (prev: TriageResult | null, formData: FormData) => Promise<TriageResult>;
  nurture: (prev: TriageResult | null, formData: FormData) => Promise<TriageResult>;
  convert: (prev: ConvertResult | null, formData: FormData) => Promise<ConvertResult>;
};

const CONVERT_ELIGIBLE: LeadStatus[] = ["submitted", "in_review", "nurturing"];
const INVITE_ELIGIBLE: LeadStatus[] = ["new", "invited", "submitted", "in_review", "nurturing"];
/** Every status a lead can still be declined from (AD-5 amendment, M5-P1): a web lead is often lost before
 *  the discovery form is ever sent. */
const DECLINE_ELIGIBLE: LeadStatus[] = INVITE_ELIGIBLE;

export function AgencyLeadDetail({
  lead,
  submissionsResult,
  members,
  canWrite,
  canTriage,
  canConvert,
  reference,
  history,
  recentCurrency = null,
  actions,
}: {
  lead: LeadDetail;
  submissionsResult: ReadResult<LeadSubmission[] | null>;
  members: { id: string; name: string }[];
  canWrite: boolean;
  canTriage: boolean;
  canConvert: boolean;
  /** M5-P1: the stage list and the active currencies, and this lead's stage history. Each carries its own
   *  refusal, rendered inline by the Pipeline card. */
  reference: ReadResult<PipelineReference>;
  history: ReadResult<StageEvent[]>;
  /** The currency most recently used on this tenant's leads (pre-select only; there is no default). */
  recentCurrency?: string | null;
  actions: Actions;
}) {
  const stages = reference.kind === "ok" ? reference.data.stages : null;
  const currencies = reference.kind === "ok" ? reference.data.currencies : null;
  // The convert report lives HERE, not in ConvertCard: the convert action revalidates this page and (Next 16.3)
  // the refreshed lead is `converted`, so ConvertCard unmounts together with the "what was delegated" report it
  // held. This component stays mounted through the refresh, so the Converted card can show what just happened.
  // A later visit has no report (it is not stored); the tasks themselves are on the project.
  const [justConverted, setJustConverted] = useState<ConvertOk | null>(null);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <LeadSummaryCard lead={lead} stages={stages} />

      <PipelineCard
        lead={lead}
        reference={reference}
        history={history}
        recentCurrency={recentCurrency}
        canWrite={canWrite}
        canTriage={canTriage}
        moveAction={actions.moveStage}
        dealAction={actions.setDeal}
      />

      {canWrite && INVITE_ELIGIBLE.includes(lead.status) && (
        <InviteCard leadId={lead.id} status={lead.status} action={actions.invite} revokeAction={actions.revoke} />
      )}

      {canTriage && (lead.status === "submitted" || lead.status === "in_review") && (
        <TriageCard leadId={lead.id} status={lead.status} openAction={actions.open} nurtureAction={actions.nurture} />
      )}

      {canTriage && DECLINE_ELIGIBLE.includes(lead.status) && <DeclineCard leadId={lead.id} action={actions.decline} />}

      {canConvert && CONVERT_ELIGIBLE.includes(lead.status) && (
        <ConvertCard
          leadId={lead.id}
          members={members}
          action={actions.convert}
          currencies={canWrite ? currencies : null}
          recentCurrency={recentCurrency}
          onConverted={setJustConverted}
        />
      )}
      {lead.status === "converted" && (
        <Card title="Converted">
          {justConverted ? (
            <div className="adl-callout" role="status">
              <p style={{ margin: 0, font: "500 13px var(--font-body)", color: "var(--ink)" }}>
                Converted. <Link href={`/pipeline/${justConverted.runId}`}>Open the delivery run →</Link>
              </p>
              <DelegationReport delegations={justConverted.delegations} members={members} />
            </div>
          ) : (
            <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink)" }}>
              This lead is already converted.{" "}
              {lead.pipelineRunId && <Link href={`/pipeline/${lead.pipelineRunId}`}>Open the delivery run →</Link>}
            </p>
          )}
          {lead.dealValue !== null && lead.dealCurrency !== null && (
            <p className="adl-note">Won at {formatDeal(lead.dealValue, lead.dealCurrency, currencies)}.</p>
          )}
        </Card>
      )}

      <SubmissionCard lead={lead} submissionsResult={submissionsResult} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── summary
function LeadSummaryCard({ lead, stages }: { lead: LeadDetail; stages: PipelineStage[] | null }) {
  return (
    <Card
      title={lead.orgName}
      headerRight={
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <StatusBadge label={STATUS_LABEL[lead.status] ?? lead.status} />
          <StatusBadge label={stageLabel(stages, lead.stage)} />
        </span>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <Meta label="Contact" value={lead.contactName ?? "—"} />
        <Meta label="Email" value={lead.contactEmail ?? "—"} />
        <Meta label="Phone / WhatsApp" value={lead.contactPhone ?? "—"} />
        <Meta label="Owner" value={lead.ownerName ?? "Unassigned"} />
        <Meta label="Source" value={sourceLabel(lead.source)} />
        <Meta label="Created" value={formatDateTime(lead.createdAt)} />
        <Meta label="Last updated" value={formatDateTime(lead.updatedAt)} />
        {lead.triagedAt && <Meta label="Triaged" value={`${formatDateTime(lead.triagedAt)} by ${lead.triagedByName ?? "—"}`} />}
        {lead.status === "declined" && <Meta label="Decline reason" value={lead.declinedReason ?? "—"} />}
      </div>
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ font: "500 11px var(--font-body)", color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ font: "400 13px var(--font-body)", color: "var(--ink)" }}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── invite
function InviteCard({
  leadId, status, action, revokeAction,
}: {
  leadId: string;
  status: LeadStatus;
  action: Actions["invite"];
  revokeAction: Actions["revoke"];
}) {
  const [invite, inviteAction, invitePending] = useActionState<InviteResult | null, FormData>(action, null);
  const [revoke, doRevoke, revokePending] = useActionState<RevokeResult | null, FormData>(revokeAction, null);
  const [copied, setCopied] = useState(false);

  return (
    <Card title="Invite">
      <div id="invite" style={{ display: "grid", gap: 10 }}>
        <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
          {status === "new"
            ? "This lead has never been sent the discovery form. Mint a link below and send it to the contact."
            : "Mint a fresh link — re-minting is safe and does not disturb the lead's history. It will not move a lead that has already submitted backwards."}
        </p>

        <form action={inviteAction}>
          <input type="hidden" name="leadId" value={leadId} />
          <Button type="submit" size="md" disabled={invitePending}>
            {invitePending ? "Minting…" : "Send invite"}
          </Button>
        </form>

        {invite && !invite.ok && <p className="adl-error">{invite.error}</p>}

        {invite?.ok && (
          <div className="adl-callout">
            <p style={{ margin: 0, font: "500 13px var(--font-body)", color: "var(--ink)" }}>
              Invite link ready — <strong>shown only once</strong>.
            </p>
            <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
              Only a hash of this token is stored — if you navigate away without copying it, it is gone for good and
              you will need to send a new link. It expires {new Date(invite.expiresAt as string).toLocaleString()}.
            </p>
            <code className="adl-token">{invite.link ?? invite.token}</code>
            {!invite.link && (
              <p className="adl-error" style={{ color: "var(--ink-subtle)", fontStyle: "italic" }}>
                No discovery-form URL is configured (AGENCY_DISCOVERY_FORM_URL) — this is the raw token. Build the
                link yourself as <code>&lt;form host&gt;/discovery#t=&lt;token&gt;</code> — the token in the URL
                fragment, never a query parameter.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                variant="ghost"
                onClick={() => {
                  const text = invite.link ?? invite.token ?? "";
                  void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <form action={doRevoke}>
                <input type="hidden" name="leadId" value={leadId} />
                <input type="hidden" name="tokenId" value={invite.tokenId} />
                <Button type="submit" variant="ghost" disabled={revokePending}>
                  {revokePending ? "Revoking…" : "Revoke this link"}
                </Button>
              </form>
            </div>
          </div>
        )}
        {revoke?.ok && (
          <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
            {revoke.revoked ? "Revoked." : "Already used or already revoked — no change made (this is idempotent, not an error)."}
          </p>
        )}
        {revoke && !revoke.ok && <p className="adl-error">{revoke.error}</p>}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────── pipeline (M5-P1)
/** The Pipeline card (design §6). It is rendered for every lead and never unmounts on a server action, so
 *  what it shows after a move or a value edit is the re-rendered server state (the stage, the saved value,
 *  the new history row), not a message held in this component. Only a refusal, or the "already at that
 *  stage" no-op, is component state. Won and Lost are not offered here: Convert and Decline own them. */
export function PipelineCard({
  lead, reference, history, recentCurrency, canWrite, canTriage, moveAction, dealAction,
}: {
  lead: LeadDetail;
  reference: ReadResult<PipelineReference>;
  history: ReadResult<StageEvent[]>;
  recentCurrency: string | null;
  canWrite: boolean;
  canTriage: boolean;
  moveAction: Actions["moveStage"];
  dealAction: Actions["setDeal"];
}) {
  const ref = reference.kind === "ok" ? reference.data : null;
  const stages = ref?.stages ?? null;
  const closed = isClosedStage(stages, lead.stage);
  const moves = ref ? allowedMoves(ref.stages, lead.stage, lead.status) : [];
  const openStages = ref ? ref.stages.filter((s) => s.kind === "open").sort((a, b) => a.position - b.position) : [];
  const [moveState, doMove, movePending] = useActionState<MoveStageResult | null, FormData>(moveAction, null);

  return (
    <Card title="Pipeline" headerRight={<StatusBadge label={stageLabel(stages, lead.stage)} />}>
      <div style={{ display: "grid", gap: 14 }}>
        {reference.kind === "forbidden" && <ReadRefusal subject="the pipeline stages and currencies" kind="forbidden" inline />}
        {reference.kind === "unavailable" && <ReadRefusal subject="The pipeline stages and currencies" kind="unavailable" reason={reference.reason} inline />}

        {ref && (
          <ol className="adl-stepper" aria-label="Pipeline stage">
            {openStages.map((s) => (
              <li key={s.key} className={`adl-step${s.key === lead.stage ? " adl-step--current" : ""}`} aria-current={s.key === lead.stage ? "step" : undefined}>
                {s.label}
              </li>
            ))}
            {closed && <li className="adl-step adl-step--current" aria-current="step">{stageLabel(stages, lead.stage)}</li>}
          </ol>
        )}
        <p className="adl-note">
          In this stage since {formatDateTime(lead.stageEnteredAt)}. Won happens only through <strong>Convert</strong>, and Lost only through <strong>Decline</strong>.
        </p>

        {canTriage && moves.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="adl-note">Move to</span>
            {moves.map((s) => (
              <form key={s.key} action={doMove}>
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="stage" value={s.key} />
                <Button type="submit" variant="ghost" disabled={movePending}>{s.label}</Button>
              </form>
            ))}
          </div>
        )}
        {moveState && !moveState.ok && (
          <p className="adl-error" role="alert">{pipelineRefusalMessage(moveState.reason, moveState.httpStatus, moveState.error ?? "Could not move the lead.")}</p>
        )}
        {moveState?.ok && moveState.changed === false && (
          <p className="adl-note" role="status">Already at {stageLabel(stages, moveState.stage ?? lead.stage)}. Nothing changed.</p>
        )}

        <DealValueForm
          key={`${lead.dealValue ?? ""}|${lead.dealCurrency ?? ""}`}
          lead={lead}
          currencies={ref?.currencies ?? null}
          recentCurrency={recentCurrency}
          canWrite={canWrite}
          action={dealAction}
        />

        <StageHistory result={history} stages={stages} currencies={ref?.currencies ?? null} />
        {/* Slot for P2: "Ad platform uploads" (conversion-upload status) renders here. */}
      </div>
    </Card>
  );
}

function DealValueForm({
  lead, currencies, recentCurrency, canWrite, action,
}: {
  lead: LeadDetail;
  currencies: PipelineCurrency[] | null;
  recentCurrency: string | null;
  canWrite: boolean;
  action: Actions["setDeal"];
}) {
  const [state, doSet, pending] = useActionState<SetDealResult | null, FormData>(action, null);
  const [value, setValue] = useState(dealInputValue(lead.dealValue));
  const [currency, setCurrency] = useState(lead.dealCurrency ?? recentCurrency ?? "");
  const picked = currencies?.find((c) => c.code === currency) ?? null;
  const typed = value.trim();
  const localProblem = typed ? checkDealInput(typed, picked ? picked.minorUnit : null) : null;
  const hasValue = lead.dealValue !== null && lead.dealCurrency !== null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="adl-note">
        <strong>Deal value:</strong> {hasValue ? formatDeal(lead.dealValue, lead.dealCurrency, currencies) : "not set"}
      </div>
      {canWrite && currencies && (
        <>
          <form action={doSet} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
            <input type="hidden" name="leadId" value={lead.id} />
            <label className="lux-field" style={{ minWidth: 100 }}>
              <span className="lux-field__label">Currency</span>
              <select name="currency" className="lux-field__control" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="">Choose…</option>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>
                ))}
              </select>
            </label>
            <label className="lux-field" style={{ minWidth: 160 }}>
              <span className="lux-field__label">Value</span>
              <input
                name="value"
                className="lux-field__control"
                inputMode="decimal"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-invalid={localProblem ? true : undefined}
              />
            </label>
            <Button type="submit" size="md" disabled={pending || !typed || !currency || localProblem !== null}>
              {pending ? "Saving…" : hasValue ? "Update value" : "Set value"}
            </Button>
          </form>
          <p className="adl-note">{precisionHint(picked)}</p>
          {localProblem && <p className="adl-error" role="alert">{PIPELINE_REFUSAL_TEXT[localProblem]}</p>}
          {hasValue && (
            <form action={doSet}>
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="intent" value="clear" />
              <Button type="submit" variant="ghost" disabled={pending}>Clear value</Button>
            </form>
          )}
        </>
      )}
      {state && !state.ok && (
        <p className="adl-error" role="alert">{pipelineRefusalMessage(state.reason, state.httpStatus, state.error ?? "Could not save the value.")}</p>
      )}
    </div>
  );
}

function StageHistory({
  result, stages, currencies,
}: {
  result: ReadResult<StageEvent[]>;
  stages: PipelineStage[] | null;
  currencies: PipelineCurrency[] | null;
}) {
  if (result.kind === "forbidden") return <ReadRefusal subject="this lead's stage history" kind="forbidden" inline />;
  if (result.kind === "unavailable") return <ReadRefusal subject="Stage history" kind="unavailable" reason={result.reason} inline />;
  const events = historyNewestFirst(result.data);
  return (
    <div>
      <p style={{ margin: "0 0 4px", font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>Stage history (newest first)</p>
      {events.length === 0 ? (
        <p className="adl-note">No stage changes yet. History starts at the first move.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }} aria-label="Stage history">
          {events.map((e) => (
            <li key={e.id} className="adl-delegation-row">
              <span>
                {stageLabel(stages, e.fromStage)} → {stageLabel(stages, e.toStage)}
                {e.dealValue !== null && e.dealCurrency !== null && <span className="adl-subtle"> · {formatDeal(e.dealValue, e.dealCurrency, currencies)}</span>}
              </span>
              <span className="adl-subtle">
                {e.actorName ?? "System"}
                {e.viaAgent ? ` via agent ${e.viaAgent}` : ""}
                {" · "}
                {formatDateTime(e.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── decline (every open status)
function DeclineCard({ leadId, action }: { leadId: string; action: Actions["decline"] }) {
  const [state, doDecline, pending] = useActionState<TriageResult | null, FormData>(action, null);
  const [reason, setReason] = useState("");
  return (
    <Card title="Decline">
      <form action={doDecline} style={{ display: "grid", gap: 8 }}>
        <input type="hidden" name="leadId" value={leadId} />
        <p className="adl-note">Declining marks the lead Lost and revokes any unused invite link. It can be done from any open status.</p>
        <label className="lux-field">
          <span className="lux-field__label lux-field__label--req">Decline reason</span>
          <textarea
            name="reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="lux-field__control lux-field__control--textarea"
            placeholder="Why this lead is being declined."
          />
        </label>
        <div>
          <Button type="submit" variant="ghost" disabled={pending || !reason.trim()}>{pending ? "Declining…" : "Decline"}</Button>
        </div>
      </form>
      {state && !state.ok && <p className="adl-error" role="alert">{pipelineRefusalMessage(state.reason, state.httpStatus, state.error ?? "Could not decline the lead.")}</p>}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────── triage
function TriageCard({
  leadId, status, openAction, nurtureAction,
}: {
  leadId: string;
  status: LeadStatus;
  openAction: Actions["open"];
  nurtureAction: Actions["nurture"];
}) {
  const [openState, doOpen, openPending] = useActionState<TriageResult | null, FormData>(openAction, null);
  const [nurtureState, doNurture, nurturePending] = useActionState<TriageResult | null, FormData>(nurtureAction, null);

  return (
    <Card title="Triage">
      {status === "submitted" && (
        <form action={doOpen} style={{ display: "grid", gap: 8 }}>
          <input type="hidden" name="leadId" value={leadId} />
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
            They answered. Open it for review before deciding.
          </p>
          <div>
            <Button type="submit" size="md" disabled={openPending}>{openPending ? "Opening…" : "Open for review"}</Button>
          </div>
        </form>
      )}

      {status === "in_review" && (
        <form action={doNurture}>
          <input type="hidden" name="leadId" value={leadId} />
          <Button type="submit" size="md" disabled={nurturePending}>{nurturePending ? "…" : "Nurture (not ready — revisit later)"}</Button>
        </form>
      )}

      {openState && !openState.ok && <p className="adl-error">{openState.error}</p>}
      {nurtureState && !nurtureState.ok && <p className="adl-error">{nurtureState.error}</p>}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────── convert
function ConvertCard({
  leadId, members, action, currencies, recentCurrency, onConverted,
}: {
  leadId: string;
  members: { id: string; name: string }[];
  action: Actions["convert"];
  /** Non-null only when the viewer may set a value (`update`) and the reference loaded: the optional deal
   *  input is then offered. A caller without `update` gets a 403 for the deal part, so it is not shown. */
  currencies: PipelineCurrency[] | null;
  recentCurrency: string | null;
  /** Hands a success to the parent, which outlives this card (see AgencyLeadDetail). */
  onConverted: (result: ConvertOk) => void;
}) {
  const [state, doConvert, pending] = useActionState<ConvertResult | null, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result.ok) onConverted(result as ConvertOk);
    return result;
  }, null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [dealValue, setDealValue] = useState("");
  const [dealCurrency, setDealCurrency] = useState(recentCurrency ?? "");
  const pickedCurrency = currencies?.find((c) => c.code === dealCurrency) ?? null;
  const dealProblem = dealValue.trim() ? checkDealInput(dealValue, pickedCurrency ? pickedCurrency.minorUnit : null) : null;

  const delegationsPayload: DelegationInput[] = Object.entries(overrides)
    .filter(([, assigneeId]) => assigneeId)
    .map(([role, assigneeId]) => ({ role, assigneeId }));

  return (
    <Card title="Convert">
      <div style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
          Mints a client, a project and a delivery run seeded from this lead&rsquo;s own answers, then opens the
          client&rsquo;s PRD sign-off gate. This cannot be undone from here. Delegated tasks below resolve
          automatically (a tenant seat holder, or the lead owner) — override an assignee only if you want it to go
          to someone specific.
        </p>

        <div style={{ display: "grid", gap: 8 }}>
          {CANONICAL_DELEGATION_ROLES.map((r) => (
            <label key={r.role} className="lux-field">
              <span className="lux-field__label">
                {r.title} <span className="adl-subtle">({r.resolution === "owner" ? "defaults to lead owner" : "defaults to seat holder, falls back to owner"})</span>
              </span>
              <select
                className="lux-field__control"
                value={overrides[r.role] ?? ""}
                onChange={(e) => setOverrides((prev) => ({ ...prev, [r.role]: e.target.value }))}
              >
                <option value="">Auto (recommended)</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
          ))}
        </div>

        {currencies && (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
              <label className="lux-field" style={{ minWidth: 100 }}>
                <span className="lux-field__label">Deal currency</span>
                <select className="lux-field__control" value={dealCurrency} onChange={(e) => setDealCurrency(e.target.value)} aria-label="Deal currency">
                  <option value="">Choose…</option>
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>
                  ))}
                </select>
              </label>
              <label className="lux-field" style={{ minWidth: 160 }}>
                <span className="lux-field__label">Deal value (optional)</span>
                <input
                  className="lux-field__control"
                  inputMode="decimal"
                  autoComplete="off"
                  value={dealValue}
                  onChange={(e) => setDealValue(e.target.value)}
                  aria-label="Deal value"
                  aria-invalid={dealProblem ? true : undefined}
                />
              </label>
            </div>
            <p className="adl-note">{precisionHint(pickedCurrency)} Leave the value empty to convert without one.</p>
            {dealProblem && <p className="adl-error" role="alert">{PIPELINE_REFUSAL_TEXT[dealProblem]}</p>}
          </div>
        )}

        <form
          action={doConvert}
          onSubmit={(e) => {
            if (!window.confirm("Convert this lead into a client, project and delivery run? This cannot be undone.")) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="delegations" value={JSON.stringify(delegationsPayload)} />
          {currencies && <input type="hidden" name="dealValue" value={dealValue.trim()} />}
          {currencies && <input type="hidden" name="dealCurrency" value={dealCurrency} />}
          <Button type="submit" size="md" disabled={pending || dealProblem !== null}>{pending ? "Converting…" : "Convert lead"}</Button>
        </form>

        {state && !state.ok && (
          <div>
            <p className="adl-error" role="alert">{pipelineRefusalMessage(state.reason, state.httpStatus, state.error ?? "Could not convert the lead.")}</p>
            {state.existing && (
              <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
                {state.existing.runId && <>Open the existing <Link href={`/pipeline/${state.existing.runId}`}>delivery run →</Link></>}
              </p>
            )}
          </div>
        )}

        {state?.ok && (
          <div className="adl-callout">
            <p style={{ margin: 0, font: "500 13px var(--font-body)", color: "var(--ink)" }}>
              Converted. <Link href={`/pipeline/${state.runId}`}>Open the delivery run →</Link>
            </p>
            <DelegationReport delegations={state.delegations} members={members} />
          </div>
        )}
      </div>
    </Card>
  );
}

/** A convert answer that succeeded (`ConvertResult` is one interface with `ok: boolean`, not a union). */
type ConvertOk = ConvertResult & { ok: true };

/** What the conversion delegated, as the convert answer reported it. */
function DelegationReport({ delegations, members }: { delegations: ConvertOk["delegations"]; members: { id: string; name: string }[] }) {
  return delegations && delegations.length > 0 ? (
    <div>
      <p style={{ margin: "0 0 4px", font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>What was delegated</p>
      {delegations.map((d, i) => (
        <div key={`${d.role}-${i}`} className="adl-delegation-row">
          <span>{d.title}</span>
          <span className="adl-subtle">
            {d.source === "unresolved"
              ? (d.reason ?? "unresolved")
              : `${members.find((m) => m.id === d.assigneeId)?.name ?? d.assigneeId} — ${DELEGATION_SOURCE_LABEL[d.source]}`}
          </span>
        </div>
      ))}
    </div>
  ) : (
    <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
      This backend response did not include a delegation report — tasks may still have been created; check
      the project&rsquo;s task list directly.
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────── the questionnaire (contract rule 4)
function SubmissionCard({
  lead, submissionsResult,
}: {
  lead: LeadDetail;
  submissionsResult: ReadResult<LeadSubmission[] | null>;
}) {
  if (!lead.latestSubmissionId) {
    return (
      <Card title="Discovery submission">
        <div className="dash-empty">
          <div style={{ fontFamily: "var(--font-display)", fontSize: 16 }}>No submission yet</div>
          <p>This lead has not answered the discovery form.</p>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card title="Discovery submission">
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
            <span>Submitted {formatDateTime(lead.latestSubmittedAt)}</span>
            <span>{lead.latestRequiredAnswered} / {lead.latestRequiredTotal} required answered</span>
            <span>{lead.latestAnsweredCount} total answered</span>
            <span>{lead.latestRedactions ?? 0} value{(lead.latestRedactions ?? 0) === 1 ? "" : "s"} redacted for PII</span>
          </div>
          {lead.latestSchemaVersion && lead.latestSchemaVersion !== SCHEMA_VERSION && (
            <p className="adl-hint">
              Captured under questionnaire version <code>{lead.latestSchemaVersion}</code>, not the current{" "}
              <code>{SCHEMA_VERSION}</code> this page groups by — some stored answers may not line up perfectly with
              the sections below.
            </p>
          )}

          {QUESTIONNAIRE_SECTIONS.map((section) => (
            <div key={section.id} className="adl-section">
              <h4 className="adl-section__title">{section.title}</h4>
              {sectionEntries(section, lead.latestAnswers).map((entry, i) => {
                if (entry.kind === "heading") return <p key={i} className="adl-heading">{entry.label}</p>;
                const { field, answered, value } = entry;
                return (
                  <div key={field.id} className="adl-qa">
                    <span className="adl-qa__label">
                      {field.label}
                      {field.required && <span className="adl-subtle"> *</span>}
                    </span>
                    {answered ? (
                      <AnswerValue field={field} value={value} />
                    ) : (
                      <span className={`adl-qa__value ${field.required ? "adl-qa__value--missing" : "adl-qa__value--skipped"}`}>
                        {field.required ? "Not answered (required)" : "Skipped"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Card>

      <SubmissionHistoryCard result={submissionsResult} currentId={lead.latestSubmissionId} />
    </>
  );
}

function AnswerValue({ field, value }: { field: Parameters<typeof formatAnswerValue>[0]; value: unknown }) {
  const rendered = formatAnswerValue(field, value);
  if (typeof rendered === "string") return <span className="adl-qa__value">{rendered}</span>;
  return (
    <div className="adl-grid">
      {rendered.map((r) => (
        <div key={r.row} className="adl-grid__row">
          <span>{r.row}</span>
          <span className="adl-subtle">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function SubmissionHistoryCard({ result, currentId }: { result: ReadResult<LeadSubmission[] | null>; currentId: string }) {
  if (result.kind === "forbidden") return <ReadRefusal subject="this lead's submission history" kind="forbidden" inline />;
  if (result.kind === "unavailable") return <ReadRefusal subject="Submission history" kind="unavailable" reason={result.reason} inline />;
  const rows = result.data;
  if (!rows || rows.length <= 1) return null; // nothing to chain — the single/latest submission is already shown above

  return (
    <Card title="Submission history">
      <div style={{ display: "grid", gap: 6 }}>
        {rows.map((s) => (
          <div key={s.id} className="adl-delegation-row">
            <span>
              {formatDateTime(s.createdAt)} {s.id === currentId && <strong>(current)</strong>}
              {s.supersedesId && <span className="adl-subtle"> — supersedes an earlier submission</span>}
            </span>
            <span className="adl-subtle">{s.answeredCount} answered, {s.redactions} redacted</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

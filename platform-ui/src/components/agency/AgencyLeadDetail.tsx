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
  STATUS_LABEL,
  buildInviteLink,
  formatAnswerValue,
  sectionEntries,
  type DelegationInput,
  type LeadDetail,
  type LeadStatus,
  type LeadSubmission,
} from "@/lib/agencyLeads";
import type { ReadResult } from "@/lib/readResult";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import type { ConvertResult, InviteResult, RevokeResult, TriageResult } from "@/app/(app)/agency/leads/actions";
import "./agencyLeads.css";

type Actions = {
  invite: (prev: InviteResult | null, formData: FormData) => Promise<InviteResult>;
  revoke: (prev: RevokeResult | null, formData: FormData) => Promise<RevokeResult>;
  open: (prev: TriageResult | null, formData: FormData) => Promise<TriageResult>;
  decline: (prev: TriageResult | null, formData: FormData) => Promise<TriageResult>;
  nurture: (prev: TriageResult | null, formData: FormData) => Promise<TriageResult>;
  convert: (prev: ConvertResult | null, formData: FormData) => Promise<ConvertResult>;
};

const CONVERT_ELIGIBLE: LeadStatus[] = ["submitted", "in_review", "nurturing"];
const INVITE_ELIGIBLE: LeadStatus[] = ["new", "invited", "submitted", "in_review", "nurturing"];

export function AgencyLeadDetail({
  lead,
  submissionsResult,
  members,
  canWrite,
  canTriage,
  canConvert,
  actions,
}: {
  lead: LeadDetail;
  submissionsResult: ReadResult<LeadSubmission[] | null>;
  members: { id: string; name: string }[];
  canWrite: boolean;
  canTriage: boolean;
  canConvert: boolean;
  actions: Actions;
}) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <LeadSummaryCard lead={lead} />

      {canWrite && INVITE_ELIGIBLE.includes(lead.status) && (
        <InviteCard leadId={lead.id} status={lead.status} action={actions.invite} revokeAction={actions.revoke} />
      )}

      {canTriage && (lead.status === "submitted" || lead.status === "in_review") && (
        <TriageCard leadId={lead.id} status={lead.status} openAction={actions.open} declineAction={actions.decline} nurtureAction={actions.nurture} />
      )}

      {canConvert && CONVERT_ELIGIBLE.includes(lead.status) && (
        <ConvertCard leadId={lead.id} members={members} action={actions.convert} />
      )}
      {lead.status === "converted" && (
        <Card title="Converted">
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink)" }}>
            This lead is already converted.{" "}
            {lead.pipelineRunId && <Link href={`/pipeline/${lead.pipelineRunId}`}>Open the delivery run →</Link>}
          </p>
        </Card>
      )}

      <SubmissionCard lead={lead} submissionsResult={submissionsResult} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── summary
function LeadSummaryCard({ lead }: { lead: LeadDetail }) {
  return (
    <Card
      title={lead.orgName}
      headerRight={<StatusBadge label={STATUS_LABEL[lead.status] ?? lead.status} />}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <Meta label="Contact" value={lead.contactName ?? "—"} />
        <Meta label="Email" value={lead.contactEmail ?? "—"} />
        <Meta label="Phone / WhatsApp" value={lead.contactPhone ?? "—"} />
        <Meta label="Owner" value={lead.ownerName ?? "Unassigned"} />
        <Meta label="Source" value={lead.source} />
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

// ─────────────────────────────────────────────────────────────────── triage
function TriageCard({
  leadId, status, openAction, declineAction, nurtureAction,
}: {
  leadId: string;
  status: LeadStatus;
  openAction: Actions["open"];
  declineAction: Actions["decline"];
  nurtureAction: Actions["nurture"];
}) {
  const [openState, doOpen, openPending] = useActionState<TriageResult | null, FormData>(openAction, null);
  const [declineState, doDecline, declinePending] = useActionState<TriageResult | null, FormData>(declineAction, null);
  const [nurtureState, doNurture, nurturePending] = useActionState<TriageResult | null, FormData>(nurtureAction, null);
  const [reason, setReason] = useState("");

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
        <div style={{ display: "grid", gap: 14 }}>
          <form action={doNurture}>
            <input type="hidden" name="leadId" value={leadId} />
            <Button type="submit" size="md" disabled={nurturePending}>{nurturePending ? "…" : "Nurture (not ready — revisit later)"}</Button>
          </form>

          <form
            action={doDecline}
            style={{ display: "grid", gap: 8, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}
          >
            <input type="hidden" name="leadId" value={leadId} />
            <label className="lux-field">
              <span className="lux-field__label lux-field__label--req">Decline reason</span>
              <textarea
                name="reason"
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="lux-field__control lux-field__control--textarea"
                placeholder="Why this lead is being declined — the requester sees this."
              />
            </label>
            <div>
              <Button type="submit" variant="ghost" disabled={declinePending || !reason.trim()}>
                {declinePending ? "Declining…" : "Decline"}
              </Button>
            </div>
          </form>
        </div>
      )}

      {openState && !openState.ok && <p className="adl-error">{openState.error}</p>}
      {declineState && !declineState.ok && <p className="adl-error">{declineState.error}</p>}
      {nurtureState && !nurtureState.ok && <p className="adl-error">{nurtureState.error}</p>}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────── convert
function ConvertCard({
  leadId, members, action,
}: {
  leadId: string;
  members: { id: string; name: string }[];
  action: Actions["convert"];
}) {
  const [state, doConvert, pending] = useActionState<ConvertResult | null, FormData>(action, null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

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
          <Button type="submit" size="md" disabled={pending}>{pending ? "Converting…" : "Convert lead"}</Button>
        </form>

        {state && !state.ok && (
          <div>
            <p className="adl-error">{state.error}</p>
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
            {state.delegations && state.delegations.length > 0 ? (
              <div>
                <p style={{ margin: "0 0 4px", font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>What was delegated</p>
                {state.delegations.map((d, i) => (
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
            )}
          </div>
        )}
      </div>
    </Card>
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

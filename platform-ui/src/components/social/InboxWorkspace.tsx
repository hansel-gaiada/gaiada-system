"use client";
// SMM-18 — the inbox tab: triage queue + thread view + reply-approval states. Server-fetched data
// (`departments/[deptId]/inbox/page.tsx`) is handed down as plain props; selecting a thread is a
// real navigation (`<Link href="?thread=...">`), so the server re-fetches that thread's messages
// fresh rather than this component owning a second copy of the read path — same division of labour
// `CalendarGrid.tsx`/`VariantCard.tsx` already use elsewhere in this module.
//
// No "Send" button anywhere here — see `lib/socialActions.ts`'s header on why the dispatch endpoint
// is executor-only, never human-clicked directly in this codebase's own established convention.
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, HairlineTable, StatusBadge } from "@/components/ui";
import { InboxTriageChip } from "./InboxTriageChip";
import { InboxSlaTimer } from "./InboxSlaTimer";
import {
  describeRefusal, type InboxThread, type InboxMessage, type ReplySendPreconditionResult,
} from "@/lib/socialShared";
import {
  createReplyDraft, updateReplyDraft, approveReplyDraft, checkReplySendPreconditions,
} from "@/lib/socialActions";

export interface InboxAccountInfo {
  handle: string;
  displayName: string | null;
  network: string;
}

const STATUS_FILTERS = ["open", "escalated", "replied", "all"] as const;

export function InboxWorkspace({
  tenantId, deptId, threads, accountsById, selectedThreadId, messages, messagesForbidden,
  canReply, canAssign, canEscalate,
}: {
  tenantId: string;
  deptId: string;
  threads: InboxThread[];
  accountsById: Record<string, InboxAccountInfo>;
  selectedThreadId: string | null;
  messages: InboxMessage[];
  messagesForbidden: boolean;
  canReply: boolean;
  canAssign: boolean;
  canEscalate: boolean;
}) {
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const visible = statusFilter === "all" ? threads : threads.filter((t) => t.status === statusFilter);
  const selected = threads.find((t) => t.id === selectedThreadId) ?? null;
  const threadHref = (id: string) => `/departments/${deptId}/inbox?thread=${id}`;

  return (
    <div style={{ display: "grid", gridTemplateColumns: selected ? "1.1fr 1.4fr" : "1fr", gap: 16, alignItems: "start" }}>
      <div>
        <div role="tablist" aria-label="Queue filter" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s} type="button" role="tab" aria-selected={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              className={`lux-btn lux-btn--sm ${statusFilter === s ? "lux-btn--solid" : "lux-btn--ghost"}`}
            >
              {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
            Nothing in this queue right now.
          </p>
        ) : (
          <HairlineTable
            tcols="2.2fr 0.9fr 1.3fr 1.1fr 0.9fr"
            columns={[
              { label: "Thread" }, { label: "Kind" }, { label: "Triage" }, { label: "SLA" }, { label: "Status" },
            ]}
            rows={visible.map((t) => {
              const acct = accountsById[t.accountId];
              return [
                <Link key={`${t.id}-thread`} href={threadHref(t.id)} style={{ color: "var(--text-primary)", textDecoration: selected?.id === t.id ? "underline" : "none" }}>
                  <span style={{ fontWeight: 700 }}>{t.authorName ?? t.authorHandle ?? "Unknown"}</span>
                  {" · "}
                  <span style={{ color: "var(--erp-ink-50)" }}>{t.excerpt ?? "(content purged)"}</span>
                </Link>,
                <span key={`${t.id}-kind`} style={{ font: "400 12px var(--font-body)" }}>
                  {acct ? `${acct.network} · ${t.kind}` : t.kind}
                </span>,
                <InboxTriageChip key={`${t.id}-triage`} thread={t} />,
                <InboxSlaTimer key={`${t.id}-sla`} slaDueAt={t.slaDueAt} />,
                <StatusBadge key={`${t.id}-status`} label={t.status} />,
              ];
            })}
          />
        )}
      </div>

      {selected && (
        <InboxThreadPanel
          key={selected.id}
          tenantId={tenantId}
          thread={selected}
          accountInfo={accountsById[selected.accountId]}
          messages={messages}
          messagesForbidden={messagesForbidden}
          canReply={canReply}
          canAssign={canAssign}
          canEscalate={canEscalate}
        />
      )}
    </div>
  );
}

function InboxThreadPanel({
  tenantId, thread, accountInfo, messages, messagesForbidden, canReply, canAssign, canEscalate,
}: {
  tenantId: string;
  thread: InboxThread;
  accountInfo?: InboxAccountInfo;
  messages: InboxMessage[];
  messagesForbidden: boolean;
  canReply: boolean;
  canAssign: boolean;
  canEscalate: boolean;
}) {
  const router = useRouter();
  const draft = messages.find((m) => m.direction === "out" && m.status !== "sent") ?? null;
  const [draftBody, setDraftBody] = useState(draft?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<ReplySendPreconditionResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPending, startPreviewTransition] = useTransition();

  function saveDraft() {
    setError(null);
    const text = draftBody.trim();
    if (!text) { setError(describeRefusal("empty_body")); return; }
    startTransition(async () => {
      const res = draft
        ? await updateReplyDraft(tenantId, thread.id, draft.id, text)
        : await createReplyDraft(tenantId, thread.id, text);
      if (!res.ok) { setError(describeRefusal(res.error)); return; }
      router.refresh();
    });
  }

  function approve(messageId: string) {
    setError(null);
    startTransition(async () => {
      const res = await approveReplyDraft(tenantId, thread.id, messageId);
      if (!res.ok) { setError(describeRefusal(res.error)); return; }
      router.refresh();
    });
  }

  function runPreview(messageId: string) {
    setPreviewError(null);
    startPreviewTransition(async () => {
      const res = await checkReplySendPreconditions(tenantId, thread.id, messageId);
      if (!res.ok) { setPreviewError(res.error); setPreview(null); return; }
      setPreview(res.verdict);
    });
  }

  return (
    <div style={{ border: "0.5px solid var(--erp-hairline)", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <div style={{ font: "700 14px var(--font-body)", color: "var(--text-primary)" }}>
            {thread.authorName ?? thread.authorHandle ?? "Unknown author"}
            {accountInfo && <span style={{ fontWeight: 400, color: "var(--erp-ink-50)" }}> → @{accountInfo.handle}</span>}
          </div>
          <div style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 2 }}>
            {thread.network} · {thread.kind}
          </div>
        </div>
        <StatusBadge label={thread.status} />
      </div>

      <InboxTriageChip thread={thread} />

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div>
          <span style={{ font: "600 11px var(--font-body)", color: "var(--erp-ink-60)" }}>SLA: </span>
          <InboxSlaTimer slaDueAt={thread.slaDueAt} />
        </div>
        <div>
          <span style={{ font: "600 11px var(--font-body)", color: "var(--erp-ink-60)" }}>Assigned: </span>
          <span style={{ font: "400 12px var(--font-body)" }}>{thread.assignedTo ?? "Unassigned"}</span>
        </div>
      </div>

      {(canAssign || canEscalate) && (
        <p style={{ margin: 0, font: "400 11px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
          Assignment and escalation are read-only here — Cerbos already grants you {canAssign && "assign"}
          {canAssign && canEscalate && " and "}{canEscalate && "escalate"} on this thread, but the backend has
          no write endpoint for them yet (a follow-up gap, not a permissions problem).
        </p>
      )}

      <div style={{ borderTop: "0.5px solid var(--erp-hairline-soft)", paddingTop: 10 }}>
        <span style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>Messages</span>
        {messagesForbidden ? (
          <p style={{ margin: "6px 0 0", font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>
            Access denied reading this thread's messages (403) — not the same as an empty thread.
          </p>
        ) : messages.length === 0 ? (
          <p style={{ margin: "6px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>No messages recorded.</p>
        ) : (
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {messages.map((m) => (
              <li key={m.id} style={{
                alignSelf: m.direction === "out" ? "flex-end" : "flex-start", maxWidth: "85%",
                border: "0.5px solid var(--erp-hairline-soft)", padding: "6px 10px",
                background: m.direction === "out" ? "var(--tint-hover)" : "transparent",
              }}>
                <div style={{ font: "400 13px/1.4 var(--font-body)" }}>{m.body}</div>
                <div style={{ font: "400 10px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 3, display: "flex", gap: 6 }}>
                  <span>{m.direction === "out" ? "Staff reply" : "Inbound"}</span>
                  <StatusBadge label={m.status} />
                  {m.status !== "draft" && m.status !== "sent" && (
                    <Button variant="ghost" size="sm" onClick={() => runPreview(m.id)} disabled={previewPending}>
                      {previewPending ? "Checking…" : "Check send readiness"}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canReply && (
        <div style={{ borderTop: "0.5px solid var(--erp-hairline-soft)", paddingTop: 10 }}>
          <span style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
            {draft ? "Draft reply" : "Draft a reply"}
          </span>
          <textarea
            value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={3} disabled={pending || draft?.status === "sent"}
            style={{ display: "block", marginTop: 6, width: "100%", font: "400 13px var(--font-body)", padding: "6px 8px" }}
          />
          <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="solid" size="sm" onClick={saveDraft} disabled={pending}>
              {pending ? "Saving…" : draft ? "Save edit" : "Save draft"}
            </Button>
            {draft && draft.status !== "approved" && draft.status !== "sent" && (
              <Button variant="ghost" size="sm" onClick={() => approve(draft.id)} disabled={pending}>
                {pending ? "Approving…" : "Approve reply"}
              </Button>
            )}
            {draft && (
              <Button variant="ghost" size="sm" onClick={() => runPreview(draft.id)} disabled={previewPending}>
                {previewPending ? "Checking…" : "Check send readiness"}
              </Button>
            )}
            {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{error}</span>}
          </div>
          <p style={{ margin: "8px 0 0", font: "400 11px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
            Sending a reply happens through the automation-approval workflow, not a button here — an
            approved reply is dispatched only once it reaches WS4 and a human decides it on the
            approvals inbox, mirroring how this console never publishes a post directly either.
          </p>
        </div>
      )}

      {(previewError || preview) && (
        <div style={{ marginTop: 4 }}>
          {previewError && (
            <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{previewError}</p>
          )}
          {!previewError && preview?.ok && (
            <p style={{ margin: 0, font: "600 12px var(--font-body)", color: "var(--status-positive-fg, #1a7f37)" }}>
              This reply would send right now — every gate (scope, hash, single-use, retention) passes.
            </p>
          )}
          {!previewError && preview && !preview.ok && (
            <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>
              <code style={{ font: "700 10px var(--font-mono, monospace)", background: "var(--tint-hover)", border: "0.5px solid var(--status-critical-fg, #b3261e)", padding: "1px 5px", marginRight: 6 }}>
                {preview.stage}
              </code>
              {describeRefusal(preview.reason ?? "")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDateTime } from "@/lib/format";
import { getEntityMailThread, getPortalRunMailThread, type ThreadMessageView } from "@/lib/mail";
import { QuotedMessageBody } from "@/components/mail/QuotedMessageBody";

// MAIL-15 — the self-contained entity thread panel (design §8A). Consumed by the approval detail
// surface, the run workspace (`/pipeline/[runId]`), and the portal run view
// (`/portal/approvals/[runId]`) — same component, two BFF reads, picked by `portal`. The panel
// fetches its own data so every call site is a one-line drop-in; it absence-degrades to an empty
// state on its own (see `lib/mail.ts`'s `degradeThread`) rather than pushing that concern onto
// every page that embeds it.
//
// Load-bearing security UI (ticket brief): every message here came in over SMTP from an
// unauthenticated sender — routing is by VERP `reply_token` only, `from_email` is display metadata
// and forgeable (design §7.6). `senderVerified` is always `false` on every row the BFF serves
// (`ThreadMessageView`), so the banner below is driven by that field, never a hardcoded assumption
// this component could silently drift from.
export async function MailThreadPanel({
  userId,
  tenantId,
  entityType,
  entityId,
  portal = false,
  title = "Email thread",
}: {
  userId: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  portal?: boolean;
  title?: string;
}) {
  const result = portal
    ? await getPortalRunMailThread(userId, tenantId, entityId)
    : await getEntityMailThread(userId, tenantId, entityType, entityId);

  return (
    <Card title={title}>
      {result.messages.length === 0 ? (
        <EmptyNote>No email replies on this thread yet.</EmptyNote>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {result.messages.map((msg) => (
            <ThreadMessage key={msg.id} message={msg} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ThreadMessage({ message }: { message: ThreadMessageView }) {
  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        padding: "12px 14px",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span style={{ font: "500 13px var(--font-body)" }}>{message.subject ?? "(no subject)"}</span>
        <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
          {formatDateTime(message.receivedAt)}
        </span>
      </div>

      {/* The one non-negotiable line of this whole component (ticket brief): the from-address must
          never lend authority to the content below it. */}
      {!message.senderVerified && (
        <div
          role="note"
          style={{
            font: "500 12px/1.4 var(--font-body)",
            color: "var(--status-critical-fg)",
            background: "color-mix(in srgb, var(--status-critical) 12%, transparent)",
            borderRadius: 6,
            padding: "6px 10px",
          }}
        >
          Email reply — sender unverified ({message.fromEmail})
        </div>
      )}

      <div
        style={{
          font: "400 13px/1.5 var(--font-body)",
          color: "var(--ink)",
          maxHeight: 280,
          overflow: "auto",
          border: "1px solid var(--hairline)",
          borderRadius: 8,
          padding: "8px 10px",
          background: "var(--wash)",
        }}
      >
        {/* Already through the intake allowlist sanitizer server-side (design §7.6) — the raw MIME
            was never stored. Still rendered in a constrained, scrollable container per that section,
            never inline with the rest of the page's markup. MAIL-20: quote-collapsed at render, see
            `QuotedMessageBody` for the boundary detection + anti-chrome-spoofing reasoning. */}
        <QuotedMessageBody bodyText={message.bodyText} bodyHtmlSanitized={message.bodyHtmlSanitized} />
      </div>

      {message.attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {message.attachments.map((att) => (
            <span
              key={att.index}
              title={att.blockedReason ? `Not downloadable: ${att.blockedReason}` : undefined}
              style={{
                font: "400 11px var(--font-body)",
                color: att.downloadable ? "var(--ink-muted)" : "var(--ink-subtle)",
                border: "1px solid var(--hairline)",
                borderRadius: 999,
                padding: "3px 10px",
              }}
            >
              {att.name} {att.downloadable ? "" : `(${att.blockedReason ?? "unavailable"})`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

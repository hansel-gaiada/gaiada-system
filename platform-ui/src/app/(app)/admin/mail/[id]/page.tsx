import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getMailLogDetail, getMailLogThread, entityHref, type MailLogRow } from "@/lib/mail";
import { MailStatusChip } from "@/components/mail/MailStatusChip";
import { QuotedMessageBody } from "@/components/mail/QuotedMessageBody";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { formatDateTime } from "@/lib/format";

// MAIL-15 — the admin mail log detail pane (design §8A): the event timeline built from `mail_log`'s
// own lifecycle timestamps (no separate events table exists — MAIL-04's row IS the timeline), plus
// the inbound thread via `GET /api/admin/mail/log/:id/thread` (MAIL-13, absence-degrades to empty
// per `lib/mail.ts`), plus the triggering entity as a working deep link.
function limitedState() {
  return (
    <>
      <PageHeader eyebrow="Settings" title="Mail" subtitle="" />
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
          This page is limited to administrators.
        </p>
      </Card>
    </>
  );
}

function timelineEvents(row: MailLogRow): { label: string; at: string | null; tone: "neutral" | "danger" }[] {
  const events: { label: string; at: string | null; tone: "neutral" | "danger" }[] = [
    { label: "Queued", at: row.queued_at, tone: "neutral" },
  ];
  if (row.provider_accepted_at) {
    // Deliberately worded "accepted", never "sent successfully" or "delivered" — this is the SMTP
    // 250 response time, not a delivery confirmation (design §7.7/§13).
    events.push({ label: `Accepted by ${row.provider ?? "provider"}`, at: row.provider_accepted_at, tone: "neutral" });
  }
  if (row.delivered_at) {
    events.push({ label: "Delivered (provider event)", at: row.delivered_at, tone: "neutral" });
  }
  if (row.status === "bounced") events.push({ label: "Bounced", at: row.updated_at, tone: "danger" });
  if (row.status === "failed") events.push({ label: `Failed after ${row.attempts} attempt(s)`, at: row.updated_at, tone: "danger" });
  if (row.status === "suppressed") events.push({ label: "Suppressed at enqueue — never sent", at: row.created_at, tone: "danger" });
  return events;
}

export default async function AdminMailDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  await getMe(userId);

  let row: MailLogRow | null;
  try {
    row = await getMailLogDetail(userId, id);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return limitedState();
    throw e;
  }
  if (!row) notFound();

  const thread = await getMailLogThread(userId, id);
  const href = entityHref(row.entity_type, row.entity_id);

  return (
    <>
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Mail", href: "/admin/mail" }, { label: row.subject || row.id }]} />
      <PageHeader
        eyebrow="Settings"
        title={row.subject || "(no subject)"}
        subtitle={`${row.stream} stream · to ${row.to_email}`}
      />

      <div style={{ display: "grid", gap: 20 }}>
        <Card title="Overview">
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <Field label="Status"><MailStatusChip status={row.status} /></Field>
            <Field label="Template">{row.template_key}</Field>
            <Field label="Attempts">{row.attempts}</Field>
            <Field label="Provider">{row.provider ?? "—"}</Field>
            <Field label="Tenant id">{row.tenant_id ?? "— (auth stream)"}</Field>
            <Field label="Triggering entity">
              {href ? (
                <Link href={href}>{row.entity_type} →</Link>
              ) : (
                row.entity_type ?? "—"
              )}
            </Field>
          </div>
          {row.last_error && (
            <p style={{ marginTop: 12, font: "400 13px var(--font-body)", color: "var(--status-critical-fg)" }}>
              Last error: {row.last_error}
            </p>
          )}
        </Card>

        <Card title="Event timeline">
          <div style={{ display: "grid", gap: 8 }}>
            {timelineEvents(row).map((ev, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <span style={{ font: "500 13px var(--font-body)", color: ev.tone === "danger" ? "var(--status-critical-fg)" : "var(--ink)" }}>
                  {ev.label}
                </span>
                <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
                  {ev.at ? formatDateTime(ev.at) : "—"}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Thread">
          {thread.messages.length === 0 ? (
            <EmptyNote>No inbound replies on this mail yet.</EmptyNote>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {thread.messages.map((msg) => (
                <div key={msg.id} style={{ border: "1px solid var(--hairline)", borderRadius: 8, padding: "10px 12px" }}>
                  <div
                    role="note"
                    style={{
                      font: "500 12px/1.4 var(--font-body)",
                      color: "var(--status-critical-fg)",
                      marginBottom: 8,
                    }}
                  >
                    Email reply — sender unverified ({msg.fromEmail})
                  </div>
                  <div style={{ font: "400 13px/1.5 var(--font-body)" }}>
                    {/* MAIL-20: quote-collapsed at render — see `QuotedMessageBody` for the boundary
                        detection + the anti-chrome-spoofing reasoning (no structured intake field
                        exists to do better; see the MAIL-20 report). */}
                    <QuotedMessageBody bodyText={msg.bodyText} bodyHtmlSanitized={msg.bodyHtmlSanitized} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ font: "500 11px var(--font-body)", color: "var(--ink-subtle)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ font: "400 14px var(--font-body)", marginTop: 2 }}>{children}</div>
    </div>
  );
}

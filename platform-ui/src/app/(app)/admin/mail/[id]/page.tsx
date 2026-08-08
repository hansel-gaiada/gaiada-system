import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getMailLogDetail, getMailLogThread, getMailPreview, entityHref, type MailLogRow } from "@/lib/mail";
import { isUuidShaped } from "@/lib/mailFilters";
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

// MAIL-34 defect 1 (detail page's equivalent gap) — `admin-mail.controller.ts`'s `detail()` has
// no id-shape check, unlike its sibling `thread()` on the same controller: a malformed id reaches
// a raw `uuid` column comparison and the platform's last-resort exception filter turns that into
// an uncaught 500, which this page didn't catch either (it only caught 403) — the same crash
// symptom as the list page's defect, one step removed. Fixing the backend validation is out of
// scope here (platform-ui only); checked here instead, BEFORE the request is ever sent, so no id
// shape this page can produce ever reaches that code path. A malformed id can never be a real
// `mail_log.id` (a `uuid` column), so this is not a weaker refusal than a real 404 — just an
// earlier, cheaper one that also says what's wrong instead of leaving the user to guess.
function invalidIdState(id: string) {
  return (
    <>
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Mail", href: "/admin/mail" }, { label: "Invalid id" }]} />
      <PageHeader eyebrow="Settings" title="Mail" subtitle="" />
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--status-critical-fg)" }}>
          &quot;{id}&quot; isn&apos;t a valid mail log id. Check the link and try again.
        </p>
      </Card>
    </>
  );
}

function filterErrorState(message: string) {
  return (
    <>
      <PageHeader eyebrow="Settings" title="Mail" subtitle="" />
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--status-critical-fg)" }}>
          {message}.
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

  // MAIL-34 defect 1 — see invalidIdState()'s comment: a malformed id must never reach the
  // backend at all, since the detail endpoint has no shape check of its own.
  if (!isUuidShaped(id)) return invalidIdState(id);

  let row: MailLogRow | null;
  try {
    row = await getMailLogDetail(userId, id);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return limitedState();
    // Defensive, symmetric with the list page: this endpoint has no other validated input today,
    // so the backend has no live 400 path here, but this keeps the two pages' error handling
    // identical rather than leaving one asymmetric should that ever change.
    if (e instanceof PlatformError && e.status === 400) return filterErrorState(e.message);
    throw e;
  }
  if (!row) notFound();

  const thread = await getMailLogThread(userId, id);
  // MAIL-38. Absence-degrades to null (see getMailPreview) so a UI deployed ahead of its backend
  // still renders the log and timeline instead of erroring the whole page.
  const preview = await getMailPreview(userId, id);
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

        {/* MAIL-38 — the rendered message. `mail_log` stores `subject` + `payload` and never the
            composed body, so this is recomposed server-side on demand from the same
            `renderTemplate()` the sender uses; nothing is cached (design §11).

            The iframe is `sandbox=""` — the maximally restrictive value, which withholds scripts,
            forms, popups AND same-origin. That is defence in depth rather than the primary control:
            the templates already `escapeHtml()` every payload value, but `payload` can carry
            inbound-derived text, and MAIL-18 only proved those bytes inert AS STORED — a guarantee
            that does not survive composition into HTML on an elevated-only page. If the escaping
            ever regresses, the sandbox keeps it from becoming script execution in an admin session.
            `srcDoc` (not `src`) so nothing is fetched over the network to render it. */}
        {preview ? (
          <Card title="Rendered message">
            <p style={{ margin: "0 0 10px", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
              Subject: {preview.subject || "(no subject)"}
              {preview.renderedFromCurrentTemplate && (
                <>
                  {" · "}
                  <span title="mail_log stores the template key and payload, not the sent body. This is re-rendered from today's template, so a template changed since this mail was sent will render differently from what the recipient received.">
                    re-rendered from the current template
                  </span>
                </>
              )}
            </p>
            {preview.linkOmitted && (
              <p style={{ margin: "0 0 10px", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
                The link in this message is blank on purpose. It carries a one-time sign-in token,
                which is never stored — so it exists only in the delivered email and cannot be
                reproduced here. The empty link is the protection working, not a broken template.
              </p>
            )}
            <iframe
              title="Rendered email body"
              sandbox=""
              srcDoc={preview.html}
              style={{
                width: "100%",
                height: 420,
                border: "1px solid var(--hairline)",
                background: "var(--surface-card)",
              }}
            />
            <details style={{ marginTop: 10 }}>
              <summary style={{ font: "500 12px var(--font-body)", color: "var(--ink-muted)", cursor: "pointer" }}>
                Plain-text alternative
              </summary>
              <pre style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", font: "400 12px/1.6 var(--font-body)", color: "var(--ink-muted)" }}>
                {preview.text}
              </pre>
            </details>
          </Card>
        ) : (
          <Card title="Rendered message">
            <EmptyNote>
              Preview unavailable — the backend has no renderer for template{" "}
              <code>{row.template_key}</code>, or this build of the platform predates MAIL-38&apos;s
              preview endpoint. The log and timeline below are unaffected.
            </EmptyNote>
          </Card>
        )}

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
                        detection + the anti-chrome-spoofing reasoning. MAIL-25: the truncation notice
                        it renders is driven by the structured `bodyTruncated`/`bodyTruncatedChars`
                        fields only, never by matching the marker string in `bodyText`. */}
                    <QuotedMessageBody
                      bodyText={msg.bodyText}
                      bodyHtmlSanitized={msg.bodyHtmlSanitized}
                      bodyTruncated={msg.bodyTruncated}
                      bodyTruncatedChars={msg.bodyTruncatedChars}
                    />
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

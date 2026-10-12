// M5-L5 / M5-L5b — staff alert when a gaiada.com WEB lead is created (source = 'web').
//
// ── CHANNELS ────────────────────────────────────────────────────────────────────────────────────────
// 1. The bell (M5-L5): the ERP's one staff notification path, `notify()` (core/http.ts), an in-app
//    notification to `AGENCY_WEB_LEAD_ALERT_USER_IDS`. Always on when that list is set.
// 2. Chat (M5-L5b), IN ADDITION to the bell and independent of it: a POST to wa-chat-bot's
//    `/admin/alerts/web-lead` (wa-chat-bot/src/web-lead-alert.ts). This file still contains no WhatsApp or
//    Telegram client (only ai-gateway-go holds provider keys); the bot owns the transport, the message
//    TEMPLATE and the DESTINATION chat. We send four fields and nothing else; the bot validates them,
//    composes the text, de-duplicates on the lead id and refuses any destination it ingests.
//    ENABLED BY `AGENCY_WEB_LEAD_ALERT_CHAT=1` (exactly "1"; empty/anything else = off = bell only) AND the
//    bot being configured (BOT_URL + the admin token, the same seam the Admin console proxy uses).
//    An explicit flag, not "the bot URL is present": BOT_URL is always set on a deployment that runs the bot
//    for the admin console, so presence alone would switch lead alerts to chat the moment the bot was deployed.
//    The bot must have WEB_LEAD_ALERT_CHAT_ID set (else it answers 503 `alert-destination-unset`, which is
//    logged here and changes nothing) and WEB_LEAD_ALERT_LINK_BASE equal to MAIL_LINK_BASE_URL.
//
// ── DESTINATION (operator config) ───────────────────────────────────────────────────────────────────
// Bell: `AGENCY_WEB_LEAD_ALERT_USER_IDS` = comma-separated ERP user ids (uuid) of the staff who get the alert.
// Each must be an active member of the tenant (notify() skips anyone who is not). Unset or empty = no bell
// (fail-closed). Read at call time, like AGENCY_WEB_LEADS_ENABLED.
// Chat: the destination lives ONLY on the bot (WEB_LEAD_ALERT_CHAT_ID); it is never sent in the request.
//
// !! The chat destination must NEVER be a chat that the work-summary bot ingests (wa-chat-bot's `groups.yaml`
// !! registry, or any group not on its ignored list). Alert text in chat history is kept for 90 days and may
// !! go to an AI processor (legal/website-visitor-addendum.md R-V13). The bot enforces this and refuses to
// !! send; prefer a DM or a Telegram private chat.
//
// ── PAYLOAD (R-V13: minimal) ────────────────────────────────────────────────────────────────────────
// ONLY: the lead id, the contact's FIRST name (first token of contact_name, letters only, else "someone"),
// the form key and a link to /agency/leads/:id. Never email, phone, message body, org name or attribution.
// Both channels are built from ONE pure allow-list, `webLeadAlertFields`, so a new field cannot slip into
// one channel and not the other. The chat body is exactly `{leadId, firstName, form, link}`.
//
// ── IDEMPOTENCY + FAIL-SOFT ─────────────────────────────────────────────────────────────────────────
// Called only when the INSERT actually created the row (the unique (tenant_id, submission_ref) makes a replay
// return the existing lead, which does not alert); the bot also de-duplicates on the lead id. Never throws:
// each channel is tried independently (a chat failure never affects the bell or the lead, nor the reverse); a
// failure is logged (lead id + error name only) and the lead creation is unaffected. The chat call has a
// short timeout (5 s) and is awaited, so it adds at most that to the event handler, never to the visitor.
import { Logger } from "@nestjs/common";
import { config } from "../config";
import { notifyBestEffort } from "./client-notify";
import type { NotificationPayload } from "./http";

const logger = new Logger("AgencyWebLeadAlert");

export const WEB_LEAD_ALERT_TYPE = "agency.lead.web_created";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRST_NAME_CAP = 40;
const FORM_CAP = 64;
/** Mirrors the bot's validation (wa-chat-bot/src/web-lead-alert.ts), so a value we emit is never refused by it. */
const FIRST_NAME_RE = /^[\p{L}][\p{L}\p{M}'’-]{0,39}$/u;
const FORM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const WEB_LEAD_CHAT_TIMEOUT_MS = 5000;

export type WebLeadAlertSender = (
  tenantId: string, recipientIds: string[], type: string, payload: NotificationPayload,
) => Promise<void>;

/** The exact body of POST <bot>/admin/alerts/web-lead. Four fields; the bot rejects any other key. */
export interface WebLeadChatBody { leadId: string; firstName: string; form: string; link: string }
export type WebLeadChatSender = (body: WebLeadChatBody) => Promise<void>;

export const defaultAlertSender: WebLeadAlertSender = (tenantId, recipientIds, type, payload) =>
  notifyBestEffort(tenantId, null, recipientIds, type, payload);

export function webLeadAlertRecipients(): string[] {
  const raw = process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS ?? "";
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)))];
}

/** On only when the flag is exactly "1" AND the bot URL + token are configured. Read at call time. */
export function webLeadChatEnabled(): boolean {
  return process.env.AGENCY_WEB_LEAD_ALERT_CHAT === "1" && !!config.services.bot.url && !!config.services.bot.token;
}

/** First token of the contact's name if it is a plain name (letters, with ' ’ - inside), else "someone". Pure.
 *  A token that is a URL, an e-mail, a phone number or anything else non-name-like is replaced, not cleaned,
 *  so no fragment of it reaches a channel. */
export function firstNameOf(contactName: string | null | undefined): string {
  const tok = (contactName ?? "").trim().split(/\s+/)[0] ?? "";
  const name = tok.slice(0, FIRST_NAME_CAP).replace(/^[^\p{L}]+/u, "").replace(/[^\p{L}\p{M}]+$/u, "");
  return FIRST_NAME_RE.test(name) ? name : "someone";
}

/** Pure. THE allow-list both channels are built from: nothing outside these arguments can reach either. */
export function webLeadAlertFields(a: { leadId: string; contactName: string | null; originForm: string | null }): {
  leadId: string; firstName: string; form: string; href: string; link: string;
} {
  const href = `/agency/leads/${a.leadId}`;
  const form = a.originForm && FORM_RE.test(a.originForm.slice(0, FORM_CAP)) ? a.originForm.slice(0, FORM_CAP) : "web-form";
  return { leadId: a.leadId, firstName: firstNameOf(a.contactName), form, href, link: `${config.mail.linkBaseUrl}${href}` };
}

/** Pure. The bell notification. */
export function buildWebLeadAlert(a: { leadId: string; contactName: string | null; originForm: string | null }): NotificationPayload {
  const f = webLeadAlertFields(a);
  return {
    title: "New web lead",
    body: `New web lead ${f.leadId}: ${f.firstName} via the ${f.form} form. ${f.link}`,
    href: f.href,
    entityType: "agency_lead",
    entityId: f.leadId,
    severity: "info",
  };
}

/** Pure. The chat relay body: exactly four fields. */
export function buildWebLeadChatBody(a: { leadId: string; contactName: string | null; originForm: string | null }): WebLeadChatBody {
  const f = webLeadAlertFields(a);
  return { leadId: f.leadId, firstName: f.firstName, form: f.form, link: f.link };
}

/** A non-2xx from the bot. The status rides in the NAME so a log line that prints only the error name still
 *  says why (e.g. BotHttp503 = destination unset or refused); the bot's response body is never read. */
class BotHttpError extends Error {
  constructor(status: number) {
    super(`bot answered ${status}`);
    this.name = `BotHttp${status}`;
  }
}

/** POST to the bot with a short timeout. 200 (sent or replayed) resolves; anything else throws. */
export const defaultChatSender: WebLeadChatSender = async (body) => {
  const svc = config.services.bot;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEB_LEAD_CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${svc.url.replace(/\/$/, "")}/admin/alerts/web-lead`, {
      method: "POST",
      signal: ac.signal,
      headers: { authorization: `Bearer ${svc.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new BotHttpError(res.status);
  } finally {
    clearTimeout(timer);
  }
};

export async function alertStaffOfWebLead(
  tenantId: string,
  lead: { leadId: string; contactName: string | null; originForm: string | null },
  send: WebLeadAlertSender = defaultAlertSender,
  chat: WebLeadChatSender = defaultChatSender,
): Promise<void> {
  try {
    const recipients = webLeadAlertRecipients();
    if (recipients.length > 0) await send(tenantId, recipients, WEB_LEAD_ALERT_TYPE, buildWebLeadAlert(lead));
  } catch (err) {
    logger.warn(`lead ${lead.leadId}: staff alert failed (${(err as Error)?.name ?? "error"})`);
  }
  try {
    if (webLeadChatEnabled()) await chat(buildWebLeadChatBody(lead));
  } catch (err) {
    logger.warn(`lead ${lead.leadId}: chat alert failed (${(err as Error)?.name ?? "error"})`);
  }
}

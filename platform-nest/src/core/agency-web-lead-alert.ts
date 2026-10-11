// M5-L5 — staff alert when a gaiada.com WEB lead is created (source = 'web').
//
// ── CHANNEL ─────────────────────────────────────────────────────────────────────────────────────────
// The ERP's one staff notification path is `notify()` (core/http.ts): an in-app notification (the bell).
// This file uses exactly that. It does NOT contain a WhatsApp or Telegram client: only ai-gateway-go holds
// provider keys, and wa-chat-bot exposes no generic "send this text" route on purpose (its only notify
// route composes a check-in reminder). Chat delivery of this alert therefore needs a bot route that does
// not exist yet; see the M5-L5 report. Until then the alert is a bell notification.
//
// ── DESTINATION (operator config) ───────────────────────────────────────────────────────────────────
// `AGENCY_WEB_LEAD_ALERT_USER_IDS` = comma-separated ERP user ids (uuid) of the staff who get the alert.
// Each must be an active member of the tenant (notify() skips anyone who is not). Unset or empty = no alert
// (fail-closed: nothing is sent to anybody by default). Read at call time, like AGENCY_WEB_LEADS_ENABLED.
//
// !! The destination must NEVER be a chat group that the work-summary bot ingests (wa-chat-bot's
// !! `groups.yaml` registry). Alert text lands in chat history, and the bot stores history for 90 days and
// !! may send it to an AI processor (legal/website-visitor-addendum.md R-V13). If a chat relay is added
// !! later, point it at a DM or a group that is NOT in `groups.yaml` / is on the ignored list.
//
// ── PAYLOAD (R-V13: minimal) ────────────────────────────────────────────────────────────────────────
// ONLY: the lead id, the contact's FIRST name (first token of contact_name, else "someone"), the form key
// and a link to /agency/leads/:id. Never email, phone, message body, org name or attribution. The shape is
// built by `buildWebLeadAlert` from an explicit allow-list so a new field cannot slip in by accident.
//
// ── IDEMPOTENCY + FAIL-SOFT ─────────────────────────────────────────────────────────────────────────
// Called only when the INSERT actually created the row (the unique (tenant_id, submission_ref) makes a replay
// return the existing lead, which does not alert). Never throws: a failure is logged (lead id + error name
// only) and the lead creation is unaffected.
import { Logger } from "@nestjs/common";
import { config } from "../config";
import { notifyBestEffort } from "./client-notify";
import type { NotificationPayload } from "./http";

const logger = new Logger("AgencyWebLeadAlert");

export const WEB_LEAD_ALERT_TYPE = "agency.lead.web_created";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRST_NAME_CAP = 40;
const FORM_CAP = 64;

export type WebLeadAlertSender = (
  tenantId: string, recipientIds: string[], type: string, payload: NotificationPayload,
) => Promise<void>;

export const defaultAlertSender: WebLeadAlertSender = (tenantId, recipientIds, type, payload) =>
  notifyBestEffort(tenantId, null, recipientIds, type, payload);

export function webLeadAlertRecipients(): string[] {
  const raw = process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS ?? "";
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)))];
}

/** First token of the contact's name, or "someone". Pure. */
export function firstNameOf(contactName: string | null | undefined): string {
  const tok = (contactName ?? "").trim().split(/\s+/)[0] ?? "";
  return tok ? tok.slice(0, FIRST_NAME_CAP) : "someone";
}

/** Pure. The whole alert; nothing outside these arguments can reach it. */
export function buildWebLeadAlert(a: { leadId: string; contactName: string | null; originForm: string | null }): NotificationPayload {
  const href = `/agency/leads/${a.leadId}`;
  const form = a.originForm ? a.originForm.slice(0, FORM_CAP) : "web form";
  return {
    title: "New web lead",
    body: `New web lead ${a.leadId}: ${firstNameOf(a.contactName)} via the ${form} form. ${config.mail.linkBaseUrl}${href}`,
    href,
    entityType: "agency_lead",
    entityId: a.leadId,
    severity: "info",
  };
}

export async function alertStaffOfWebLead(
  tenantId: string,
  lead: { leadId: string; contactName: string | null; originForm: string | null },
  send: WebLeadAlertSender = defaultAlertSender,
): Promise<void> {
  try {
    const recipients = webLeadAlertRecipients();
    if (recipients.length === 0) return;
    await send(tenantId, recipients, WEB_LEAD_ALERT_TYPE, buildWebLeadAlert(lead));
  } catch (err) {
    logger.warn(`lead ${lead.leadId}: staff alert failed (${(err as Error)?.name ?? "error"})`);
  }
}

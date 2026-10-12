// M5-L5b — the web-lead alert relay: `POST /admin/alerts/web-lead` (route lives in server.ts; the
// rules live here so they can be unit-tested without Fastify).
//
// WHAT THIS IS NOT: a generic "send this text" route. The caller (platform-nest) supplies four
// validated fields; THE BOT composes the message from a fixed template. Nothing free-form from the
// caller can reach a chat. The destination chat comes ONLY from bot-side config
// (WEB_LEAD_ALERT_CHAT_ID), never from the request.
//
// PRIVACY (legal/website-visitor-addendum.md R-V13): the payload is minimal by law — lead id, the
// contact's FIRST name, the form key and a link. Never email, phone, message body, org name or
// attribution. Unknown body keys are a 400, so a future caller cannot start sending more by accident.
//
// NEVER AN INGESTED CHAT: the work-summary bot stores chat history for 90 days and may send it to an
// AI processor. An alert posted into an ingested group would put web-lead data into that history.
// `destinationRefusal` therefore refuses (and the route answers 503 `alert-destination-refused`,
// logging a config error with NO personal data) when the destination:
//   1. is not a valid chat id, or
//   2. is a MONITORED registry group (`isMonitored`: a non-management row of groups.yaml), or
//   3. is a group (`...@g.us`, or a Telegram group `tg:-...`) that is NOT on the ignored list.
// Why rule 3 and not "unlisted is fine": in registry mode an unlisted group is dropped today, but in
// trial mode (no groups.yaml, or the file is ever removed) EVERY group is ingested. The ignore list is
// the one mechanism that drops a group "in BOTH modes, ahead of the registry gate" (bot.ts), so a group
// destination is only safe when it is explicitly ignored. A DM is not subject to group ingestion (the
// alert is an outbound bot message, which is never stored: bot.ts drops `fromMe`), so a DM or a
// Telegram private chat is the recommended destination. Evaluated per request, so a registry or
// ignore-list edit takes effect immediately.
//
// NOT HISTORY: this module never touches the message store. The send goes through the SurfaceRouter
// (so the halt switch and the global outbound ceiling apply); that router's only side effect besides
// the transport is the in-memory echo-loop guard, which keeps the text for ~2 minutes.
//
// IDEMPOTENCY: one alert per lead id. The sent set is persisted next to the groups file (lead ids
// only, no names) so a bot restart cannot re-alert; a replay answers 200 `replayed`. An id is marked
// only AFTER a successful send, so a failed send can be retried; a concurrent duplicate gets 409.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config";
import { isValidChatId } from "./chat-admin";
import { isIgnored, isMonitored } from "./groups";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Letters (any script) with optional ' ’ - inside. No digits, dots, spaces, "@", ":" or "/", so a first
 *  name can never carry a phone number, an e-mail or an auto-linkable URL; no control or format
 *  characters (newline, bidi overrides) either, since those are not letters or marks. */
const FIRST_NAME_RE = /^[\p{L}][\p{L}\p{M}'’-]{0,39}$/u;
const FORM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ALLOWED_KEYS = new Set(["leadId", "firstName", "form", "link"]);
const MAX_REMEMBERED = 5000;

export interface WebLeadAlert {
  leadId: string;
  firstName: string;
  form: string;
  link: string;
}

export type Validation = { ok: true; value: WebLeadAlert } | { ok: false; error: string };

/** Strict allow-list validation. `linkBase` is the bot-side ERP base URL (no trailing slash). */
export function validateWebLeadAlert(body: unknown, linkBase: string): Validation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const rec = body as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, error: `unknown field "${k.slice(0, 40)}"` };
  }
  const { leadId, firstName, form, link } = rec;
  if (typeof leadId !== "string" || !UUID_RE.test(leadId)) return { ok: false, error: "leadId must be a uuid" };
  if (typeof firstName !== "string" || !FIRST_NAME_RE.test(firstName)) {
    return { ok: false, error: "firstName must be 1-40 letters (no digits, spaces, punctuation or links)" };
  }
  if (typeof form !== "string" || !FORM_RE.test(form)) return { ok: false, error: "form must be 1-64 of [A-Za-z0-9_.:-]" };
  if (typeof link !== "string" || link !== `${linkBase}/agency/leads/${leadId}`) {
    return { ok: false, error: "link must be <ERP base URL>/agency/leads/<leadId>" };
  }
  return { ok: true, value: { leadId, firstName, form, link } };
}

/** The ONLY message this route can ever send. Fixed template; every substituted value was validated. */
export function composeWebLeadAlertText(a: WebLeadAlert): string {
  return `New web lead from ${a.firstName} via the ${a.form} form.\n${a.link}`;
}

function isGroupChat(chatId: string): boolean {
  return chatId.endsWith("@g.us") || chatId.startsWith("tg:-");
}

/** Why this chat must not receive the alert, or null when it is safe. See the header for the rule. */
export function destinationRefusal(chatId: string): string | null {
  if (!isValidChatId(chatId)) return "destination is not a valid chat id";
  if (isMonitored(chatId)) return "destination is an ingested group (listed in the group registry)";
  if (isGroupChat(chatId) && !isIgnored(chatId)) return "destination is a group that is not on the ignored list";
  return null;
}

/** Bot-side config as read per request. Empty/whitespace means UNSET (never 0, never ""). */
export function webLeadAlertSettings(): { chatId: string; linkBase: string } {
  return {
    chatId: (config.webLeadAlertChatId ?? "").trim(),
    linkBase: (config.webLeadAlertLinkBase ?? "").trim().replace(/\/+$/, ""),
  };
}

// ── de-duplication (one alert per lead id) ──────────────────────────────────────────────────────────
interface Remembered { id: string; at: number }
let loadedPath = "";
let sent = new Map<string, number>();
const inFlight = new Set<string>();

function stateFile(): string {
  return config.webLeadAlertStateFile || join(dirname(config.groupsFile), "web-lead-alerts.json");
}

function load(): void {
  const path = stateFile();
  if (loadedPath === path) return;
  loadedPath = path;
  sent = new Map();
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { ids?: Remembered[] };
    for (const e of raw.ids ?? []) if (typeof e?.id === "string") sent.set(e.id, Number(e.at) || 0);
  } catch {
    /* a corrupt state file degrades to "nothing remembered", never to a failure */
  }
}

function persist(): void {
  const path = stateFile();
  try {
    if (sent.size > MAX_REMEMBERED) {
      const oldest = [...sent.entries()].sort((a, b) => a[1] - b[1]).slice(0, sent.size - MAX_REMEMBERED);
      for (const [id] of oldest) sent.delete(id);
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ ids: [...sent.entries()].map(([id, at]) => ({ id, at })) })}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[web-lead-alert] could not persist the sent-lead set: ${(err as Error).name}`);
  }
}

export function alreadyAlerted(leadId: string): boolean {
  load();
  return sent.has(leadId.toLowerCase());
}
/** Claim the lead for sending. False when a send for it is already in flight. */
export function beginAlert(leadId: string): boolean {
  const k = leadId.toLowerCase();
  if (inFlight.has(k)) return false;
  inFlight.add(k);
  return true;
}
export function endAlert(leadId: string, delivered: boolean): void {
  const k = leadId.toLowerCase();
  inFlight.delete(k);
  if (!delivered) return;
  load();
  sent.set(k, Date.now());
  persist();
}
export function resetWebLeadAlertState(): void {
  loadedPath = "";
  sent = new Map();
  inFlight.clear();
}

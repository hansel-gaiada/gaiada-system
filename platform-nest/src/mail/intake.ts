// MAIL-05 — the approval/risk email tap (design §7.2/§7.4, plan row MAIL-05; binding: M9-M12).
// `notify()` (core/http.ts) calls this exactly once, AFTER its own `notifications` INSERT commits,
// for EVERY notification it creates — per design A5 this is the entire mail-triggering surface:
// you are only ever emailed about something that is in a bell (yours, or for a client, their
// portal bell).
//
// FAIL-SOFT IS ENFORCED BY THE CALLER, NOT HERE. `notify()` wraps its call to `mailIntake` in a
// try/catch and only logs on failure (test-pinned in `src/mail/tap.test.ts`'s "fail-soft" group) —
// a mail failure must never fail the write path that is announcing itself via the bell. This
// function is therefore a plain function that is allowed to throw on a real bug (e.g. a typo'd
// template key surfacing as `UnknownMailTemplateError`) — swallowing errors HERE too would hide
// exactly the kind of mistake the caller's single log line exists to surface.
//
// ALLOWLIST is {approval.requested, pipeline.gate.opened} (design §7.2) plus, since PV4-06,
// `conversation.message.staff` — nothing else in the bell produces mail. `mention`, `comment`,
// `approval_decided`, and every other notification type return immediately without a query, let alone
// a mail_log row (probed in tap.test.ts). The conversation type is the one entry that mails people
// OUTSIDE the company, so it sits behind its OWN flag (`config.mail.conversationClientMailEnabled`,
// env `CONVERSATION_CLIENT_MAIL_ENABLED`, default OFF) on top of the master gate, and it is throttled:
// at most one mail per contact per thread until that contact has read the thread.
import { config } from "../config";
import { withGlobal, withMailContext, withTenants } from "../db";
import { enqueueMail } from "./queue";
import { MAIL_THREAD_ENTITY_KINDS } from "./thread-authz";

/** PV4-06 — staff wrote to a client contact in Conversation. */
export const CONVERSATION_STAFF_MAIL_TYPE = "conversation.message.staff";

const MAIL_NOTIFICATION_TYPES = new Set(["approval.requested", "pipeline.gate.opened", CONVERSATION_STAFF_MAIL_TYPE]);

/** M12/§7.4 — origins whose DECIDE today re-drives NOTHING (the D14 gap) get the purely
 *  informational `approval.warning` template; everything else (pipeline/hr/agency — deciding
 *  today actually executes the effect) gets `approval.actionable`. `pipeline.gate.opened` never
 *  carries an `origin` in its payload — the notification TYPE itself already answers the question
 *  (a gate is always the `pipeline` origin) — so only `approval.requested` needs to inspect
 *  `payload.origin` (set by MAIL-06's callers: automation/agent/hr/agency). An `approval.requested`
 *  row with a missing/unrecognized origin defaults to `approval.actionable` — the SAFER default
 *  when unsure, because the warning template's entire reason to exist is a proven D14 gap on a
 *  KNOWN automation/agent origin, never a guess. */
const WARNING_ORIGINS = new Set(["automation", "agent"]);

export type MailTemplateKey = "approval.warning" | "approval.actionable" | "conversation.message.staff";

export function wordingClassFor(type: string, payload: Record<string, unknown>): MailTemplateKey {
  if (type === CONVERSATION_STAFF_MAIL_TYPE) return "conversation.message.staff";
  if (type === "pipeline.gate.opened") return "approval.actionable";
  const origin = typeof payload.origin === "string" ? payload.origin : "";
  return WARNING_ORIGINS.has(origin) ? "approval.warning" : "approval.actionable";
}

/** §7.5/M11 — the mail body's ONLY link: a PLAIN entity deep link, no token/session/capability.
 *  The notification `payload.href` is already the correct staff-vs-portal ROUTE for both
 *  allowlisted types (every existing `notify()` call site for `pipeline.gate.opened` already sets
 *  it to `/portal/approvals/:runId` for a client recipient — design §7.2's table; MAIL-06 will do
 *  the same for `approval.requested`'s staff `/approvals` href). This function's only job is to
 *  turn that relative route into an absolute URL using the CONFIGURED link base (A12:
 *  `MAIL_LINK_BASE_URL`, reserved-TLD default) — it never constructs a route itself, so it can
 *  never invent an action-shaped URL, and it never sees a literal domain. */
export function absoluteEntityHref(routeOrUrl: string | undefined): string {
  const path = routeOrUrl && routeOrUrl.trim() ? routeOrUrl.trim() : "/";
  if (/^https?:\/\//i.test(path)) return path; // already absolute (defensive; every real caller hands in a relative route)
  return `${config.mail.linkBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function resolveRecipientEmail(userId: string): Promise<string | null> {
  // users.email is NOT NULL UNIQUE since migration 0001 (design §7.2) — client-contact users are
  // `users` rows too (0072), so this ONE query resolves an email for staff AND client recipients
  // alike (M10). `users` is a GLOBAL table (identity_links' sibling) — read via withGlobal, not a
  // tenant-scoped connection, same convention `admin-mail.controller.ts` and `queue.ts` follow.
  const { rows } = await withGlobal((c) =>
    c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]),
  );
  return rows[0]?.email ?? null;
}

/** PV4-06 throttle: has this contact ALREADY been mailed about this thread since they last read it?
 *
 *  "Since they last read it" is the contact's `conversation_reads.last_read_at` for the thread; with no read marker at all
 *  (they have never opened it) ANY earlier conversation mail for the thread counts, so a thread they ignore mails them once,
 *  not once per staff message. Every status counts (queued, sent, suppressed, failed): the question is whether we already
 *  tried, and a suppressed or failing address would otherwise be retried on every message. The mail row records the thread in
 *  its `payload.threadId` (the row's `entity_*` columns are reserved for the thread-authz kinds). Two reads, because the two
 *  tables sit behind different RLS contexts: the read marker is tenant-scoped, `mail_log` is global (`mail_context`). */
async function alreadyMailedSinceRead(tenantId: string, userId: string, threadId: string): Promise<boolean> {
  const marker = await withTenants([tenantId], (c) =>
    c.query<{ last_read_at: string | Date }>(
      `SELECT last_read_at FROM conversation_reads WHERE thread_id = $1 AND user_id = $2`,
      [threadId, userId],
    ),
  );
  const lastReadAt = marker.rows[0]?.last_read_at ?? null;
  const prior = await withMailContext((c) =>
    c.query(
      `SELECT 1 FROM mail_log
        WHERE user_id = $1 AND tenant_id = $2 AND template_key = $3 AND payload->>'threadId' = $4
          AND ($5::timestamptz IS NULL OR created_at > $5::timestamptz)
        LIMIT 1`,
      [userId, tenantId, CONVERSATION_STAFF_MAIL_TYPE, threadId, lastReadAt],
    ),
  );
  return prior.rows.length > 0;
}

export interface MailIntakeInput {
  notificationId: string;
  tenantId: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
}

/** The tap itself. Returns without enqueuing anything for every notification NOT on the allowlist
 *  — the fast, common case costs one Set lookup and nothing else (no query, no config read beyond
 *  the master gate). */
export async function mailIntake(input: MailIntakeInput): Promise<void> {
  if (!config.mail.enabled) return;
  if (!MAIL_NOTIFICATION_TYPES.has(input.type)) return;

  // PV4-06 — the conversation type: its own flag first (OFF = no query, no address lookup, no row), then the throttle.
  const isConversation = input.type === CONVERSATION_STAFF_MAIL_TYPE;
  const conversationThreadId = isConversation && typeof input.payload.entityId === "string" ? input.payload.entityId : null;
  if (isConversation) {
    if (!config.mail.conversationClientMailEnabled) return;
    // No thread id means no way to throttle, so no mail: never an unthrottled path.
    if (!conversationThreadId) return;
    if (await alreadyMailedSinceRead(input.tenantId, input.userId, conversationThreadId)) return;
  }

  const email = await resolveRecipientEmail(input.userId);
  // Defensive only — users.email is NOT NULL, so a live miss here would mean the row vanished
  // between notify()'s member-check and this read. Never a reason to throw: "no address to mail"
  // is a legitimate, silent no-op for this tap, same as "recipient is suppressed" downstream.
  if (!email) return;

  const templateKey = wordingClassFor(input.type, input.payload);
  const href = absoluteEntityHref(typeof input.payload.href === "string" ? input.payload.href : undefined);

  // MAIL-33 — the entity ref this row is allowed to carry is gated by the SAME set thread-authz
  // authorizes reads against (`MAIL_THREAD_ENTITY_KINDS`, imported above, not a second copy of the
  // list). Stamping a kind here that thread reads don't recognize is exactly the drift class this
  // ticket found: `pipeline_gate` had a passing write-side test and a passing read-side test, and
  // nothing enforced they agreed. Falling back to "no entity" (both fields null) rather than storing
  // a half-known ref matches the already-established "entity-less mail" posture (NDR messages,
  // auth-stream mail) — `admin-mail.controller.ts`'s thread read skips the parent-entity check
  // entirely when either field is null, so this degrades to elevation-only rather than an unreadable
  // 403 for everyone. An entityId with no recognized entityType is treated the same as neither being
  // present — a stray id next to a null type authorizes against nothing.
  const entityType = typeof input.payload.entityType === "string" && MAIL_THREAD_ENTITY_KINDS.has(input.payload.entityType)
    ? input.payload.entityType
    : null;
  const entityId = entityType && typeof input.payload.entityId === "string" ? input.payload.entityId : null;

  await enqueueMail({
    stream: "notify",
    templateKey,
    toEmail: email,
    tenantId: input.tenantId,
    userId: input.userId,
    notificationIds: [input.notificationId],
    entityType,
    entityId,
    // §7.6 — every threads-eligible outbound mail mints a fresh VERP reply token. The two approval
    // types hang off a real ERP entity a reply should thread onto, so they always request one.
    // PV4-06: a conversation mail is a pointer to the portal, not a thread to reply into by email.
    withReplyToken: !isConversation,
    payload: {
      ...(conversationThreadId ? { threadId: conversationThreadId } : {}),
      href,
      subjectTitle: typeof input.payload.title === "string" ? input.payload.title : undefined,
      companyName: typeof input.payload.companyName === "string" ? input.payload.companyName : undefined,
      tool: typeof input.payload.tool === "string" ? input.payload.tool : undefined,
      impact: typeof input.payload.impact === "string" ? input.payload.impact : undefined,
    },
  });
}

/** Exposed for tests/other mail tickets that need to assert the allowlist without duplicating the
 *  literal set. */
export function mailAllowlistedNotificationTypes(): string[] {
  return [...MAIL_NOTIFICATION_TYPES];
}

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
// ALLOWLIST is EXACTLY {approval.requested, pipeline.gate.opened} (design §7.2) — nothing else in
// the bell produces mail. `mention`, `comment`, `approval_decided`, and every other notification
// type return immediately without a query, let alone a mail_log row (probed in tap.test.ts).
import { config } from "../config";
import { withGlobal } from "../db";
import { enqueueMail } from "./queue";

const MAIL_NOTIFICATION_TYPES = new Set(["approval.requested", "pipeline.gate.opened"]);

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

export type MailTemplateKey = "approval.warning" | "approval.actionable";

export function wordingClassFor(type: string, payload: Record<string, unknown>): MailTemplateKey {
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

  const email = await resolveRecipientEmail(input.userId);
  // Defensive only — users.email is NOT NULL, so a live miss here would mean the row vanished
  // between notify()'s member-check and this read. Never a reason to throw: "no address to mail"
  // is a legitimate, silent no-op for this tap, same as "recipient is suppressed" downstream.
  if (!email) return;

  const templateKey = wordingClassFor(input.type, input.payload);
  const href = absoluteEntityHref(typeof input.payload.href === "string" ? input.payload.href : undefined);

  await enqueueMail({
    stream: "notify",
    templateKey,
    toEmail: email,
    tenantId: input.tenantId,
    userId: input.userId,
    notificationIds: [input.notificationId],
    entityType: typeof input.payload.entityType === "string" ? input.payload.entityType : null,
    entityId: typeof input.payload.entityId === "string" ? input.payload.entityId : null,
    // §7.6 — every threads-eligible outbound mail mints a fresh VERP reply token. Both allowlisted
    // types hang off a real ERP entity a reply should thread onto, so both always request one;
    // there is no allowlisted case that should NOT get a reply_token.
    withReplyToken: true,
    payload: {
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

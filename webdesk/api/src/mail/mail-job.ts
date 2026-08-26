// WSK-11 — the BullMQ job payload. mail_log carries NO body/variables columns (0004_mail.sql only
// stores to_address/subject/status/error) — the rendered content is transient, living only in
// this Redis-backed job data until the worker consumes it, exactly like the migration's own
// comment implies (mail_log is the audit/status shadow, not the spool).
//
// Deliberately absent: a `from` field. See identity.ts's header — the processor NEVER takes a
// From: address from job data; it calls resolveFromIdentity() itself, fresh, on every send. That
// is what makes "Zone B is structurally incapable of referencing a Zone A stream" true even if a
// Redis job payload were somehow tampered with.
export type MailJobData = {
  mailLogId: string;
  tenantId: string;
  toEmail: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: { email: string; name?: string };
};

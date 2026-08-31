// WSK-11 — Zone B mail config. THE IDENTITY RULE (design D14 + this ticket's hard security
// boundary): Zone B owns exactly ONE sending identity, the forms stream. There is no per-stream
// selector anywhere in this file — unlike Zone A's mail module (`MailStream = "notify" | "auth"`,
// docs/superpowers/specs/2026-08-04-zone-a-mail-design.md §4.1), this config surface is
// structurally a single identity with no "which stream" parameter for anything to supply.
//
// Every value is a live GETTER, never snapshotted at module-load time — same reason ../config.ts
// documents: ESM import hoisting evaluates this module's transitive graph before a test's own
// top-level `process.env.X = ...` assignments run, so a snapshotted `const` would freeze in
// whatever was in `process.env` a moment too early.
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export type MailProviderName = "mailpit" | "smtp" | "dev-log";

export const mailConfig = {
  // Master kill switch, mirroring Zone A's own MAIL_ENABLED convention (A-parity, not shared
  // code). When false, MailService still writes mail_log rows and runs suppression checks — it
  // just never enqueues a BullMQ job, so nothing is even attempted.
  get enabled(): boolean {
    return bool("MAIL_ENABLED", true);
  },

  get provider(): MailProviderName {
    const v = (process.env.MAIL_PROVIDER || "dev-log").toLowerCase();
    return v === "mailpit" || v === "smtp" ? v : "dev-log";
  },

  // A12-style reserved-TLD default (Zone A mail doctrine's own pattern, §4.1/§4.2 of the Zone A
  // mail design): a missed env var can never resolve or deliver, and can never collide with a
  // real gaiada.com/.online host. Staging sets this to the real forms.gaiada.online identity —
  // env only, never a code change (identity.ts's own denylist still applies regardless).
  get fromAddress(): string {
    return process.env.MAIL_FROM_ADDRESS || "no-reply@forms.gaiada.invalid";
  },
  get fromName(): string {
    return process.env.MAIL_FROM_NAME || "Gaiada WebDesk Forms";
  },

  get smtpHost(): string {
    return process.env.MAIL_SMTP_HOST || "mailpit";
  },
  get smtpPort(): number {
    return Number(process.env.MAIL_SMTP_PORT ?? 1025);
  },
  get smtpUser(): string {
    return process.env.MAIL_SMTP_USER || "";
  },
  get smtpPassword(): string {
    return process.env.MAIL_SMTP_PASSWORD || "";
  },

  get queueName(): string {
    return process.env.MAIL_QUEUE_NAME || "webdesk-mail";
  },
  get maxAttempts(): number {
    return Number(process.env.MAIL_QUEUE_MAX_ATTEMPTS ?? 5);
  },
  get backoffDelayMs(): number {
    return Number(process.env.MAIL_QUEUE_BACKOFF_DELAY_MS ?? 5000);
  },
};

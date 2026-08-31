// WSK-11 — SMTP transport (nodemailer). Serves BOTH the dev sink (Mailpit, authless, no TLS —
// Zone A mail doctrine v3 A11) and a real relay/Brevo leg later (staging reopen register; not
// activated by this ticket) through the SAME code path — only mail.config.ts's env values differ.
import nodemailer, { type Transporter } from "nodemailer";
import { mailConfig } from "../mail.config";
import type { MailProviderAdapter, OutboundMail, SendResult } from "./mail-provider";

export class SmtpMailProvider implements MailProviderAdapter {
  readonly name = "smtp";
  private readonly transporter: Transporter;

  constructor() {
    const hasAuth = Boolean(mailConfig.smtpUser);
    this.transporter = nodemailer.createTransport({
      host: mailConfig.smtpHost,
      port: mailConfig.smtpPort,
      secure: false,
      auth: hasAuth ? { user: mailConfig.smtpUser, pass: mailConfig.smtpPassword } : undefined,
      // Transport-TLS rule mirrored from the Zone A mail doctrine (§4.1's own rule): credentials
      // only ever go over TLS. An authless dev sink (Mailpit, no USER/PASSWORD) is exempt by
      // construction — that is what makes the dev hop legal without making leaked-creds-over-
      // plaintext representable once real credentials are configured.
      requireTLS: hasAuth,
    });
  }

  async send(mail: OutboundMail): Promise<SendResult> {
    // Header-injection guard: strip CR/LF from anything that becomes a header value. Subject is
    // the one field here that is regularly influenced by rendered template variables.
    const subject = mail.subject.replace(/[\r\n]/g, " ");
    const info = await this.transporter.sendMail({
      from: { address: mail.from.address, name: mail.from.name },
      to: { address: mail.to.email, name: mail.to.name ?? "" },
      replyTo: mail.replyTo ? { address: mail.replyTo.email, name: mail.replyTo.name ?? "" } : undefined,
      subject,
      html: mail.html,
      text: mail.text,
      headers: mail.headers,
    });
    return { ok: true, providerMessageId: info.messageId };
  }
}

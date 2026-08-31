// WSK-11 — default when MAIL_PROVIDER is unset/unrecognized. Logs and "succeeds" without sending
// anything — mirrors Zone A's own dev-log adapter (A3 in the Zone A mail doctrine): the module is
// dark without explicit config, so a missing env var fails LOUD (nothing ever leaves the box)
// rather than silently misrouting.
import type { MailProviderAdapter, OutboundMail, SendResult } from "./mail-provider";

export class DevLogMailProvider implements MailProviderAdapter {
  readonly name = "dev-log";

  async send(mail: OutboundMail): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log("[webdesk:mail:dev-log] would send (no provider configured)", {
      from: mail.from.address,
      to: mail.to.email,
      subject: mail.subject,
    });
    return { ok: true };
  }
}

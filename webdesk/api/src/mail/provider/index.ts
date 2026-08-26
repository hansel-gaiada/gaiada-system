// WSK-11 — provider selection. The ONLY place mailConfig.provider is read to decide which
// adapter class to instantiate; every caller (mail-sender.processor.ts) goes through this
// factory rather than importing a concrete provider class directly.
import { mailConfig } from "../mail.config";
import { DevLogMailProvider } from "./dev-log-mail-provider";
import { SmtpMailProvider } from "./smtp-mail-provider";
import type { MailProviderAdapter } from "./mail-provider";

export function createMailProvider(): MailProviderAdapter {
  switch (mailConfig.provider) {
    case "mailpit":
    case "smtp":
      return new SmtpMailProvider();
    default:
      return new DevLogMailProvider();
  }
}

export * from "./mail-provider";

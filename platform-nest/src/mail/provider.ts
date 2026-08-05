// MAIL-04 — the two v1 provider adapters (design §4.1). `smtp` (nodemailer; per-stream transports
// from env — relay or Brevo per A8) and `dev-log` (default when unconfigured — the whole module
// is dark without config; also the deliberate fallback when MAIL_ENABLED=0, so a boot-time mistake
// can never leak a real send even if some other guard is missed).
import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config";
import { stripHeaderInjection, isPlausibleEmail } from "./sanitize";
import type { MailProviderAdapter, MailStream, OutboundMail, SendResult } from "./types";

/** Fail-soft, no-network adapter. Logs what WOULD have been sent and returns success — the module
 *  stays entirely dark (design §7.8: "MAIL_ENABLED=0 (default) | Module dark ... dev-log adapter",
 *  and §4.1: "the whole module is dark without config"). */
export const devLogAdapter: MailProviderAdapter = {
  name: "dev-log",
  async send(mail: OutboundMail): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log(
      `[mail:dev-log] would send stream=${mail.stream} to=${mail.to.email} subject=${JSON.stringify(mail.subject)}`,
    );
    return { ok: true };
  },
  async verify() {
    /* nothing to verify — there is no transport */
  },
};

interface SmtpTransportFacts {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Transport TLS rule (design §4.1, v3-binding): credentials only ever travel over TLS. When
 *  `user`/`password` are BOTH set, `requireTLS` is forced on — a leaked-creds-over-plaintext send
 *  is unrepresentable. When both are empty (the dev sink — Mailpit is authless), plaintext is
 *  allowed so the sink hop stays legal. Anything else (mixed - only one of the two set) is treated
 *  as configured-with-creds for the TLS decision, since a stray password with no username (or vice
 *  versa) is still "there are credentials in play". Exported so a unit test can pin this exact
 *  decision without spinning up a real transporter. */
export function smtpTransportOptions(facts: SmtpTransportFacts) {
  const hasCreds = !!(facts.user || facts.password);
  return {
    host: facts.host,
    port: facts.port,
    secure: false, // never implicit TLS (:465) in v1 — relay/Brevo both speak STARTTLS on 587
    requireTLS: hasCreds, // forces STARTTLS before AUTH; plaintext AUTH is refused by nodemailer
    auth: hasCreds ? { user: facts.user, pass: facts.password } : undefined,
  };
}

function transportFactsFor(stream: MailStream): SmtpTransportFacts {
  const streamConfig = config.mail.streams[stream];
  return streamConfig.transport === "brevo" ? streamConfig.brevo : streamConfig.relay;
}

function fromFor(stream: MailStream): string {
  return config.mail.streams[stream].from;
}

/** The `smtp` adapter — one nodemailer transporter per (stream, transport-choice) pair, created
 *  lazily and cached, so an operator's A8 failover flip (`MAIL_STREAM_*_TRANSPORT`) takes effect on
 *  the NEXT config read (config.ts is read once per process — a flip needs a restart, same as every
 *  other env-driven switch in this codebase) without this module needing its own reload logic. */
const transporterCache = new Map<string, Transporter>();

function transporterFor(stream: MailStream): Transporter {
  const facts = transportFactsFor(stream);
  const cacheKey = `${stream}:${config.mail.streams[stream].transport}:${facts.host}:${facts.port}`;
  let t = transporterCache.get(cacheKey);
  if (!t) {
    t = nodemailer.createTransport(smtpTransportOptions(facts));
    transporterCache.set(cacheKey, t);
  }
  return t;
}

/** For tests: drop cached transporters so a test that mutates `config.mail` gets a fresh one. */
export function resetSmtpTransporterCacheForTest(): void {
  transporterCache.clear();
}

export const smtpAdapter: MailProviderAdapter = {
  name: "smtp",
  async send(mail: OutboundMail): Promise<SendResult> {
    const subject = stripHeaderInjection(mail.subject);
    if (!isPlausibleEmail(mail.to.email)) {
      throw new Error(`refusing to send: implausible recipient address ${JSON.stringify(mail.to.email)}`);
    }
    const transporter = transporterFor(mail.stream);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(mail.headers ?? {})) headers[k] = stripHeaderInjection(v);
    const info = await transporter.sendMail({
      from: fromFor(mail.stream),
      to: mail.to.name ? `${stripHeaderInjection(mail.to.name)} <${mail.to.email}>` : mail.to.email,
      replyTo: mail.replyTo
        ? mail.replyTo.name
          ? `${stripHeaderInjection(mail.replyTo.name)} <${mail.replyTo.email}>`
          : mail.replyTo.email
        : undefined,
      subject,
      html: mail.html,
      text: mail.text,
      headers,
    });
    return { ok: true, providerMessageId: info.messageId };
  },
  async verify(): Promise<void> {
    // Fail-soft (design §4.1: "boot-time config sanity (fail-soft, logged)") — callers are expected
    // to catch, never let a provider misconfiguration take the app down.
    await transporterFor("notify").verify();
    await transporterFor("auth").verify();
  },
};

/** Picks the adapter a `mail_log` row of the given stream should send through RIGHT NOW.
 *
 *  `MAIL_ENABLED=0` is the master gate (design §4.1/§7.8): dev-log unconditionally, so a boot-time
 *  mistake elsewhere (e.g. the sender loop starting despite the flag) still cannot leak a real
 *  send — belt and suspenders alongside main.ts only starting the loop when enabled.
 *
 *  When enabled, an UNCONFIGURED stream (empty host for whichever transport is selected) also
 *  falls back to dev-log rather than half-attempting a connection to `''`  — same fail-soft
 *  convention as every other optional downstream in `config.ts`. */
export function resolveAdapter(stream: MailStream): MailProviderAdapter {
  if (!config.mail.enabled) return devLogAdapter;
  const facts = transportFactsFor(stream);
  if (!facts.host) return devLogAdapter;
  return smtpAdapter;
}

// WSK-11 — THE IDENTITY RULE. webdesk-design.md D14 + §03 (the egress allowlist — this is the
// security core of this ticket): Zone B owns EXACTLY ONE sending identity, the forms stream
// (`forms.gaiada.online` in real DNS; a reserved-TLD placeholder in dev, mail.config.ts's own
// default). `From:` is always ours; `Reply-To:`, when set at all, is the human submitter — never
// a Zone A identity. Locked decision, restated verbatim in the design's §14 decision log: "Zone A
// mail never routes through C-03."
//
// STRUCTURAL incapacity, not a policy note. Two things make that true, both load-bearing:
//
//   1. There is no "stream" or "domain" parameter ANYWHERE in this module's public surface.
//      Contrast Zone A's own `MailStream = "notify" | "auth"` selector
//      (docs/superpowers/specs/2026-08-04-zone-a-mail-design.md §4.1) — this file deliberately
//      does NOT mirror that shape. `resolveFromIdentity()` below takes ZERO arguments. Nothing
//      calling into this module — not MailService, not the queue job payload, not the provider
//      adapters — ever carries a `from`/domain value chosen by a caller. Grep-tested in
//      test/mail-zone-a-isolation.spec.ts: no other file under src/mail/** or src/queue/**
//      constructs a `from` value from anything but this function's return value.
//
//   2. The one remaining variable input — MAIL_FROM_ADDRESS, an OPERATOR env var, never a caller
//      or tenant input — is checked against a hard denylist below before it can ever reach an
//      OutboundMail. This is defence in depth for that one variable (belt AND suspenders, per the
//      D14 two-place-gate lesson applied here at module scope), not the primary control — the
//      primary control is (1): there is nothing else for the denylist to have to catch.
import { mailConfig } from "./mail.config";

export type MailIdentity = { fromAddress: string; fromName: string };

// Zone A's real mail root (design §04.2 of the Zone A mail doctrine: ALL employee/system mail —
// auth.gaiada.com, notify.gaiada.com — lives on the gaiada.com Workspace). Matched on the DOMAIN
// portion of an address only, so `forms.gaiada.online` legitimately passes while
// `anything@notify.gaiada.com` / `anything@auth.gaiada.com` / `anything@gaiada.com` do not.
// Deliberately blocks the WHOLE gaiada.com apex and every subdomain of it, not just the two named
// streams — Zone B has no legitimate reason to send from any part of that domain, named or not.
const ZONE_A_DOMAIN_PATTERNS = [/(^|\.)gaiada\.com$/i];

export class ZoneAIdentityViolation extends Error {
  constructor(domain: string) {
    super(
      `[webdesk:mail] refused to send from domain "${domain}" — Zone B may never reference a ` +
        `Zone A mail identity (design D14: "Zone A mail never routes through C-03"). This is a ` +
        `hard containment rule, not a config mistake to silently work around.`,
    );
    this.name = "ZoneAIdentityViolation";
  }
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/** Throws ZoneAIdentityViolation if `address` resolves to a Zone A domain. Used on BOTH the
 * From: identity (below) and any Reply-To address a caller supplies (mail.service.ts) — the
 * human being replied-to must never itself be spoofed as a Zone A identity either. */
export function assertNotZoneADomain(address: string): void {
  const domain = domainOf(address);
  if (ZONE_A_DOMAIN_PATTERNS.some((re) => re.test(domain))) {
    throw new ZoneAIdentityViolation(domain);
  }
}

/**
 * The ONE identity Zone B ever sends as. Takes no arguments — there is nothing for a caller to
 * pass that would change which domain a mail sends from; every field comes from mail.config.ts's
 * own env-only surface. Called independently by BOTH mail.service.ts (fail fast at enqueue time
 * on bad config) AND mail-sender.processor.ts (the actual send — never trusts a `from` carried
 * through the Redis job payload, because no such field exists on MailJobData in the first place).
 *
 * A future per-tenant own-domain upgrade (design §03 egress table: "per-tenant send-as-own-domain
 * opt-in") is EXPLICITLY NOT built here: it needs a new, senior-db-owned schema column (e.g. a
 * DNS-verified `tenants.custom_mail_domain`) that does not exist in 0001_platform_core.sql today,
 * and this ticket is not authorized to add migrations (reported as a gap in the ticket report).
 * When that column lands, it plugs in HERE and ONLY here — this function's signature is the seam
 * — and it still passes through assertNotZoneADomain() before anything else changes.
 */
export function resolveFromIdentity(): MailIdentity {
  const fromAddress = mailConfig.fromAddress;
  assertNotZoneADomain(fromAddress);
  return { fromAddress, fromName: mailConfig.fromName };
}

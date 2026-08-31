// WSK-11 — THE IDENTITY RULE, tested. This file is the one the ticket brief explicitly demands:
// "Write a test that FAILS if a Zone A stream can be configured or referenced." Three
// independent layers, because a single check can be worked around by whatever it didn't think of:
//
//   1. Runtime denylist — resolveFromIdentity()/assertNotZoneADomain() actually refuse a Zone A
//      domain, for every shape of Zone A address (notify./auth./bare gaiada.com), and correctly
//      ALLOW the real forms identity so the check isn't just "reject everything".
//   2. Source-literal sweep — no file under src/mail/** or src/queue/** OTHER than identity.ts
//      itself (which must document what it blocks) mentions a Zone A stream hostname anywhere,
//      code or comment. identity.ts is the ONE place allowed to know these strings exist.
//   3. Structural incapacity, proven behaviorally — even a caller that bypasses TypeScript (an
//      `as any` cast smuggling a `from`/`replyTo` override) cannot make a real, end-to-end send
//      carry a Zone A header, because nothing in the send path ever reads such a field from
//      caller/job data in the first place.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { assertNotZoneADomain, resolveFromIdentity, ZoneAIdentityViolation } from "../src/mail/identity";

const SRC_MAIL_DIR = join(__dirname, "..", "src", "mail");
const SRC_QUEUE_DIR = join(__dirname, "..", "src", "queue");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("WSK-11 identity rule — layer 1: runtime denylist", () => {
  const savedEnv = process.env.MAIL_FROM_ADDRESS;
  afterAll(() => {
    process.env.MAIL_FROM_ADDRESS = savedEnv;
  });

  it.each([
    ["no-reply@notify.gaiada.com", "the Zone A approval/warning stream"],
    ["no-reply@auth.gaiada.com", "the Zone A magic-link/auth stream"],
    ["someone@gaiada.com", "the bare Zone A apex — no employee mail identity either"],
    ["sneaky@sub.gaiada.com", "ANY subdomain of gaiada.com, not just the two named streams"],
  ])("refuses MAIL_FROM_ADDRESS=%s (%s)", (address) => {
    process.env.MAIL_FROM_ADDRESS = address;
    expect(() => resolveFromIdentity()).toThrow(ZoneAIdentityViolation);
  });

  it("allows the real forms identity (proves the denylist isn't just rejecting everything)", () => {
    process.env.MAIL_FROM_ADDRESS = "no-reply@forms.gaiada.online";
    expect(() => resolveFromIdentity()).not.toThrow();
    const identity = resolveFromIdentity();
    expect(identity.fromAddress).toBe("no-reply@forms.gaiada.online");
  });

  it("allows the dev reserved-TLD default when unset", () => {
    delete process.env.MAIL_FROM_ADDRESS;
    const identity = resolveFromIdentity();
    expect(identity.fromAddress).toMatch(/@forms\.gaiada\.invalid$/);
  });

  it("assertNotZoneADomain (the replyTo gate) refuses the same set of Zone A domains", () => {
    expect(() => assertNotZoneADomain("someone@notify.gaiada.com")).toThrow(ZoneAIdentityViolation);
    expect(() => assertNotZoneADomain("someone@auth.gaiada.com")).toThrow(ZoneAIdentityViolation);
    expect(() => assertNotZoneADomain("a.human@theirclient.com")).not.toThrow();
  });
});

describe("WSK-11 identity rule — layer 2: source-literal sweep", () => {
  const ZONE_A_HOSTS = ["notify.gaiada", "auth.gaiada"];

  it("no file under src/mail/** or src/queue/** other than identity.ts mentions a Zone A stream host", () => {
    const files = [...walkTsFiles(SRC_MAIL_DIR), ...walkTsFiles(SRC_QUEUE_DIR)].filter(
      (f) => !f.endsWith(`${sep}identity.ts`),
    );
    expect(files.length).toBeGreaterThan(5); // sanity: the sweep is actually looking at real files

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      for (const host of ZONE_A_HOSTS) {
        if (contents.includes(host)) offenders.push(`${file} contains "${host}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("mail-job.ts (the queue payload) declares no from/domain/stream field at all", () => {
    const contents = readFileSync(join(SRC_MAIL_DIR, "mail-job.ts"), "utf8");
    // The type block itself — a `from`/`domain`/`stream` field here would be the ONE place a
    // caller could smuggle an identity override through Redis into the worker.
    expect(contents).not.toMatch(/\bfrom\s*:/);
    expect(contents).not.toMatch(/\bdomain\s*:/i);
    expect(contents).not.toMatch(/\bstream\s*:/i);
  });

  it("mail.service.ts's SendTemplateInput type declares no from/domain override either", () => {
    const contents = readFileSync(join(SRC_MAIL_DIR, "mail.service.ts"), "utf8");
    const typeBlockMatch = contents.match(/export type SendTemplateInput = \{[^}]*\}/);
    expect(typeBlockMatch).not.toBeNull();
    const typeBlock = typeBlockMatch![0];
    expect(typeBlock).not.toMatch(/\bfrom\s*:/);
    expect(typeBlock).not.toMatch(/\breplyTo\s*:/); // replyTo is derived, not caller-settable —
    // see sendNotification's own comment: "submitter" is named for what it is, not a free field.
  });
});

describe("WSK-11 identity rule — layer 3: structural incapacity, proven end-to-end", () => {
  let app: NestFastifyApplication;
  let MailService: typeof import("../src/mail/mail.service").MailService;
  let tenant: import("./helpers/fixtures").FixtureTenant;

  beforeAll(async () => {
    process.env.MAIL_PROVIDER = "smtp";
    process.env.MAIL_SMTP_HOST = process.env.MAIL_SMTP_HOST || "localhost";
    process.env.MAIL_SMTP_PORT = process.env.MAIL_SMTP_PORT || "55452";
    process.env.MAIL_FROM_ADDRESS = "no-reply@forms.gaiada.invalid";
    process.env.MAIL_FROM_NAME = "Gaiada WebDesk Forms (test)";
    process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55451";
    process.env.MAIL_QUEUE_NAME = `mail-isolation-${Date.now()}`;
    process.env.MAIL_QUEUE_MAX_ATTEMPTS = "1";
    process.env.MAIL_QUEUE_BACKOFF_DELAY_MS = "100";
    process.env.NODE_ENV = process.env.NODE_ENV || "test";
    process.env.APP_DATABASE_URL =
      process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

    const { startMailTestApp } = await import("./helpers/mail-app");
    const { createFixtureTenant } = await import("./helpers/fixtures");
    const { createMailTemplate } = await import("./helpers/mail-fixtures");
    ({ MailService } = await import("../src/mail/mail.service"));

    app = await startMailTestApp();
    tenant = await createFixtureTenant("isolation");
    await createMailTemplate(tenant, {
      key: "identity-probe",
      subject: "hello {{name}}",
      bodyHtml: "<p>hi {{name}}</p>",
    });
  });

  afterAll(async () => {
    const { stopMailTestApp } = await import("./helpers/mail-app");
    await stopMailTestApp(app);
  });

  it("a smuggled replyTo pointed at a Zone A domain is REJECTED, not silently sent", async () => {
    const mailService = app.get(MailService);
    const to = `victim-a-${Date.now()}@example.invalid`;

    // A hostile/buggy caller trying to inject a Zone A identity through a field that does not
    // exist on sendAutoresponder's real type — `as never` is the ONLY way to even attempt this,
    // which is itself part of the proof (no legitimate TS caller can do it without deliberately
    // defeating the type system). Even so, the SAME assertNotZoneADomain() gate that guards a
    // legitimate submitter address (mail.service.ts's enqueueRendered) catches this one too —
    // there is no second, weaker path into the queue.
    const spoofed = {
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "identity-probe",
      to: { email: to, name: "Victim" },
      variables: { name: "Victim" },
      replyTo: { email: "spoofed@auth.gaiada.com" },
    };

    await expect(mailService.sendAutoresponder(spoofed as never)).rejects.toThrow(/refused to send/);
  });

  it("a smuggled from override is simply never read — the real identity ships regardless", async () => {
    const { mailpitReset, waitForMailpitMessage, mailpitGetMessage } = await import("./helpers/mailpit-client");
    await mailpitReset();

    const mailService = app.get(MailService);
    const to = `victim-b-${Date.now()}@example.invalid`;

    // No Zone A replyTo this time (that path is proven above) — just a `from` override, which
    // MailJobData has no field for at all (layer 2's own source-sweep test proves that
    // structurally). This proves it BEHAVIORALLY: the override has zero effect on the header
    // that actually ships.
    const spoofed = {
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "identity-probe",
      to: { email: to, name: "Victim" },
      variables: { name: "Victim" },
      from: { address: "attacker@notify.gaiada.com", name: "Fake Zone A" },
    };

    await mailService.sendAutoresponder(spoofed as never);

    const summary = await waitForMailpitMessage(`to:${to}`);
    const detail = await mailpitGetMessage(summary.ID);

    expect(detail.From.Address).toBe("no-reply@forms.gaiada.invalid");
  });
});

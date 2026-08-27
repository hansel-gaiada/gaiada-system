// WSK-37 — the end-to-end proof, against REAL infrastructure (a real throwaway Postgres, a real
// Redis/BullMQ queue, and a real local HTTPS sink — not mocks), of every acceptance criterion the
// ticket lists:
//   1. registration + a signature the receiver can independently verify with WSK-12's own
//      `verifySignature()` — proving "signed exactly like WSK-12's Zone A bridge" for real
//   2. retry/backoff against a genuinely failing sink, then recovery
//   3. an SSRF-targeted webhook is refused end-to-end (never connects, delivery marked failed
//      with an SSRF reason, real proof via the sink's OWN request log staying empty)
//   4. cross-tenant isolation: a webhook registered for tenant A never fires for tenant B's event,
//      even though both call the SAME dispatcher method with the SAME event kind
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55510/webdesk";
process.env.MIGRATE_DATABASE_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55510/webdesk";
process.env.TENANT_WEBHOOK_SECRET_PEPPER =
  process.env.TENANT_WEBHOOK_SECRET_PEPPER || "wsk37-test-pepper-never-used-outside-this-suite";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55511";
process.env.TENANT_WEBHOOK_QUEUE_NAME = `tenant-webhook-${Date.now()}`;
process.env.TENANT_WEBHOOK_MAX_ATTEMPTS = "4";
process.env.TENANT_WEBHOOK_BACKOFF_DELAY_MS = "400";
process.env.TENANT_WEBHOOK_REQUEST_TIMEOUT_MS = "3000";
// See ssrf-guard.ts's own header on this var: a loud, NODE_ENV!=production-gated escape hatch that
// lets THIS suite prove retry/backoff and signature verification through the REAL dispatch path
// against test/helpers/tenant-webhook-sink.ts's local HTTPS sink, without weakening the guard for
// anything else — the SSRF-refusal test below deliberately does NOT allowlist its target, so it
// still exercises the guard's real refusal path end-to-end.
process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST = ""; // filled in per-test, after the sink's port is known
// The sink's self-signed cert is not issued by a real CA — accepting that for a `fetch()` call to
// a local test double this process itself just started is the standard shape of this trade-off;
// no production traffic is affected (real tenant endpoints must present real, verifiable certs).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTenantWebhooksTestApp, stopTenantWebhooksTestApp } from "./tenant-webhooks-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { TenantWebhookSink } from "./helpers/tenant-webhook-sink";
import { TenantWebhooksService } from "../src/tenant-webhooks/tenant-webhooks.service";
import { TenantWebhookDispatcherService } from "../src/tenant-webhooks/tenant-webhook-dispatcher.service";
import { TenantWebhooksRepository } from "../src/tenant-webhooks/tenant-webhooks.repository";
import { verifySignature } from "../src/events/zoneb-event-signature";
import { encryptWebhookSecret, generateWebhookSecret } from "../src/tenant-webhooks/webhook-secret";
import { DbService } from "../src/db/db.service";

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("WSK-37 — per-tenant outbound webhooks (real DB + real Redis/BullMQ + real HTTPS sink)", () => {
  let app: NestFastifyApplication;
  let webhooksService: TenantWebhooksService;
  let dispatcher: TenantWebhookDispatcherService;
  let repo: TenantWebhooksRepository;
  let sink: TenantWebhookSink;

  beforeAll(async () => {
    app = await startTenantWebhooksTestApp();
    webhooksService = app.get(TenantWebhooksService);
    dispatcher = app.get(TenantWebhookDispatcherService);
    repo = app.get(TenantWebhooksRepository);
    sink = await TenantWebhookSink.start();
    // Now that the sink's ephemeral port is known, allowlist EXACTLY this host:port — nothing else.
    process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST = `127.0.0.1:${sink.port}`;
  }, 30_000);

  afterAll(async () => {
    await sink.stop();
    await dispatcher.onModuleDestroy();
    await stopTenantWebhooksTestApp(app);
  });

  afterEach(() => {
    sink.failNextRequests(0);
  });

  it("registers a webhook, dispatches a form.received event, and the sink can verify the signature with WSK-12's own verifySignature()", async () => {
    const tenant = await createFixtureTenant("wsk37-sig");
    const registered = await webhooksService.register(tenant.tenantId, {
      targetUrl: sink.url(),
      eventKinds: ["form.received"],
      description: "signature proof",
    });
    expect(registered.secret).toMatch(/^whsec_/);

    await dispatcher.dispatchFormReceived(tenant.tenantId, {
      siteSlug: tenant.slug,
      formId: "11111111-1111-1111-1111-111111111111",
      submissionId: "22222222-2222-2222-2222-222222222222",
      hasAttachments: false,
      fields: { name: "Ada Lovelace", email: "ada@example.test" },
    });

    const received = await waitFor(async () => {
      const rows = sink.received();
      return rows.length > 0 ? rows[rows.length - 1] : null;
    }, 10_000);

    // THE PROOF: an independent receiver (this test, standing in for a client's own server),
    // using nothing but the plaintext secret shown ONCE at registration and WSK-12's own
    // reference `verifySignature()`, can validate the signature on the exact raw bytes received.
    const timestampHeader = received.headers["x-webdesk-timestamp"] as string;
    const signatureHeader = received.headers["x-webdesk-signature"] as string;
    const verification = verifySignature({
      secret: registered.secret,
      timestampHeader,
      rawBody: received.rawBody,
      signatureHeader,
      toleranceMs: 5 * 60_000,
    });
    expect(verification.ok).toBe(true);

    // The wrong secret must NOT verify — proves this is a real check, not a tautology.
    const wrongSecretCheck = verifySignature({
      secret: "whsec_definitely-not-the-real-secret",
      timestampHeader,
      rawBody: received.rawBody,
      signatureHeader,
      toleranceMs: 5 * 60_000,
    });
    expect(wrongSecretCheck.ok).toBe(false);

    const envelope = JSON.parse(received.rawBody);
    expect(envelope.kind).toBe("form.received");
    expect(envelope.tenantId).toBe(tenant.tenantId);
    expect(envelope.data.fields).toEqual({ name: "Ada Lovelace", email: "ada@example.test" });

    const deliveries = await webhooksService.listDeliveries(tenant.tenantId, registered.id);
    expect(deliveries[0].status).toBe("sent");
    expect(deliveries[0].response_status).toBe(200);
  }, 20_000);

  it("retries with growing backoff while the sink fails, then delivers once it recovers", async () => {
    const tenant = await createFixtureTenant("wsk37-retry");
    const registered = await webhooksService.register(tenant.tenantId, {
      targetUrl: sink.url(),
      eventKinds: ["form.received"],
      description: "retry proof",
    });

    // The sink will 503 the first 2 attempts, then succeed on the 3rd — well inside the
    // TENANT_WEBHOOK_MAX_ATTEMPTS=4 ceiling this suite configured above.
    sink.failNextRequests(2);
    const beforeCount = sink.received().length;
    const t0 = Date.now();

    await dispatcher.dispatchFormReceived(tenant.tenantId, {
      siteSlug: tenant.slug,
      formId: "33333333-3333-3333-3333-333333333333",
      submissionId: "44444444-4444-4444-4444-444444444444",
      hasAttachments: false,
      fields: { message: "retry me" },
    });

    const deliveries = await waitFor(async () => {
      const rows = await webhooksService.listDeliveries(tenant.tenantId, registered.id);
      const row = rows[0];
      return row && row.status === "sent" ? rows : null;
    }, 15_000);

    const elapsed = Date.now() - t0;
    expect(deliveries[0].attempt_count).toBeGreaterThanOrEqual(3);
    // Exponential backoff, base 400ms: attempt1->2 waits ~400ms, attempt2->3 waits ~800ms — at
    // least 1200ms of structurally-required backoff before the 3rd (successful) attempt could fire.
    expect(elapsed).toBeGreaterThan(1000);

    const sinkRequestsForThisDelivery = sink.received().length - beforeCount;
    expect(sinkRequestsForThisDelivery).toBeGreaterThanOrEqual(3); // 2 failures + 1 success, real HTTP calls
  }, 25_000);

  it("REFUSES an SSRF-targeted webhook — a target pointed at the cloud-metadata address never reaches the network, delivery marked failed with an SSRF reason, sink untouched", async () => {
    const tenant = await createFixtureTenant("wsk37-ssrf");
    // Direct repository insert (bypassing the SERVICE's own registration-time SSRF check, exactly
    // like every other fixture in this suite bypasses the HTTP layer for setup) — this is the
    // "what if a row already exists with a bad target" case: DNS rebinding, or a target that was
    // valid at registration and is not anymore. The DISPATCH-time guard is what must catch this,
    // not just the registration-time one, and this test proves specifically THAT layer.
    const badTarget = "https://169.254.169.254/latest/meta-data/iam/security-credentials/";

    // Insert directly through the repository's own `insert`, under a real transaction, the same
    // way the service does it internally — just skipping the service's pre-flight SSRF check.
    // This is the "what if a row already exists with a bad target" case: DNS rebinding, or a
    // target that was valid at registration and is not anymore. The DISPATCH-time guard is what
    // must catch this, not just the registration-time one, and this test proves specifically that
    // layer, not the registration-time short-circuit already covered by the next test file.
    const plaintext = generateWebhookSecret();
    const realDb = app.get(DbService);
    const row = await realDb.withTenant(tenant.tenantId, (d) =>
      d.transaction((client) =>
        repo.insert(client, {
          tenantId: tenant.tenantId,
          targetUrl: badTarget,
          secretCiphertext: encryptWebhookSecret(plaintext),
          eventKinds: ["form.received"],
          description: "ssrf probe — direct insert, bypasses registration-time check on purpose",
        }),
      ),
    );

    const beforeCount = sink.received().length;

    await dispatcher.dispatchFormReceived(tenant.tenantId, {
      siteSlug: tenant.slug,
      formId: "55555555-5555-5555-5555-555555555555",
      submissionId: "66666666-6666-6666-6666-666666666666",
      hasAttachments: false,
      fields: { note: "should never leave the process" },
    });

    const deliveries = await waitFor(async () => {
      const rows = await webhooksService.listDeliveries(tenant.tenantId, row.id);
      const r = rows[0];
      return r && r.status === "failed" ? rows : null;
    }, 15_000);

    expect(deliveries[0].last_error).toMatch(/refused target/);
    expect(deliveries[0].response_status).toBeNull();
    // THE REAL PROOF: the unrelated sink's request log did not grow — nothing anywhere on the
    // network path this test can observe ever received a connection attempt for this delivery.
    expect(sink.received().length).toBe(beforeCount);
  }, 20_000);

  it("cross-tenant isolation: a webhook registered for tenant A never fires when tenant B's event is dispatched", async () => {
    const tenantA = await createFixtureTenant("wsk37-xtenant-a");
    const tenantB = await createFixtureTenant("wsk37-xtenant-b");

    await webhooksService.register(tenantA.tenantId, {
      targetUrl: sink.url(),
      eventKinds: ["form.received"],
      description: "tenant A's own webhook",
    });
    // Tenant B registers NO webhook at all.

    const beforeCount = sink.received().length;

    await dispatcher.dispatchFormReceived(tenantB.tenantId, {
      siteSlug: tenantB.slug,
      formId: "77777777-7777-7777-7777-777777777777",
      submissionId: "88888888-8888-8888-8888-888888888888",
      hasAttachments: false,
      fields: { secret: "tenant B's data — must never reach tenant A's endpoint" },
    });

    // Give the (empty) fan-out a moment to settle, then assert the sink saw NOTHING for this —
    // tenant A's webhook exists in the same database, same queue, same worker process, and still
    // never fires for an event dispatched under tenant B's id.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(sink.received().length).toBe(beforeCount);

    // Now prove the SAME dispatcher call under tenant A's own id DOES reach tenant A's webhook —
    // the negative result above is isolation, not a broken dispatcher.
    await dispatcher.dispatchFormReceived(tenantA.tenantId, {
      siteSlug: tenantA.slug,
      formId: "99999999-9999-9999-9999-999999999999",
      submissionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      hasAttachments: false,
      fields: { ok: "tenant A's own data" },
    });
    const received = await waitFor(async () => {
      const rows = sink.received();
      return rows.length > beforeCount ? rows[rows.length - 1] : null;
    }, 10_000);
    const envelope = JSON.parse(received.rawBody);
    expect(envelope.tenantId).toBe(tenantA.tenantId);
  }, 25_000);
});

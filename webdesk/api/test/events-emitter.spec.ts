// WSK-12 — the emitter's own contract: it signs correctly against a REAL HTTP receiver (a plain
// node:http server, not a mock of fetch — this proves the exact bytes that hit the wire verify
// correctly with the SAME `verifySignature()` the bridge-side test suite (events-hmac.spec.ts)
// already proves refuses forgery/replay/mutation), AND it is fail-soft in every documented
// failure mode: unreachable bridge, disabled, unconfigured secret/url. No Postgres/Redis needed —
// this module talks to nothing but the bridge URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { ZoneBEventEmitterService } from "../src/events/zoneb-event-emitter.service";
import { verifySignature } from "../src/events/zoneb-event-signature";

const SECRET = "wsk12-emitter-test-secret";

type CapturedRequest = { headers: IncomingMessage["headers"]; rawBody: string };

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let nextStatus = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(nextStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: nextStatus < 300 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}/webhook/wd-zoneb-intake`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  nextStatus = 200;
  process.env.WEBDESK_ZONEB_EVENTS_ENABLED = "true";
  process.env.WEBDESK_ZONEB_BRIDGE_URL = baseUrl;
  process.env.WEBDESK_EVENT_SECRET = SECRET;
  process.env.WEBDESK_ZONEB_ORIGIN_SITE = "wsk12-test-site";
  process.env.WEBDESK_ZONEB_EVENT_TIMEOUT_MS = "2000";
});

describe("WSK-12 · ZoneBEventEmitterService — delivers a genuinely verifiable signature", () => {
  it("emitFormReceived() POSTs a request the reference verifier ACCEPTS", async () => {
    const emitter = new ZoneBEventEmitterService();
    await emitter.emitFormReceived("tenant-abc", {
      siteSlug: "acme-rebrand", formId: "contact-form", submissionId: "sub-123", hasAttachments: false,
    });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    const timestampHeader = req.headers["x-webdesk-timestamp"] as string | undefined;
    const signatureHeader = req.headers["x-webdesk-signature"] as string | undefined;
    expect(timestampHeader).toBeTruthy();
    expect(signatureHeader).toBeTruthy();

    // The exact same reference implementation the "forged/mutated/stale" refusal suite exercises —
    // here run in the ACCEPT direction, against bytes that actually crossed a real socket.
    const result = verifySignature({
      secret: SECRET, timestampHeader, rawBody: req.rawBody, signatureHeader, toleranceMs: 5 * 60_000,
    });
    expect(result.ok).toBe(true);

    const envelope = JSON.parse(req.rawBody);
    expect(envelope.kind).toBe("form.received");
    expect(envelope.tenantId).toBe("tenant-abc");
    expect(envelope.originSite).toBe("wsk12-test-site");
    expect(envelope.data).toEqual({
      siteSlug: "acme-rebrand", formId: "contact-form", submissionId: "sub-123", hasAttachments: false,
    });
    expect(typeof envelope.eventId).toBe("string");
    expect(envelope.eventId.length).toBeGreaterThan(0);
  });

  it("mints a DIFFERENT eventId on every call — the idempotency key must never collide by construction", async () => {
    const emitter = new ZoneBEventEmitterService();
    await emitter.emitFormReceived("tenant-abc", { siteSlug: "a", formId: "f", submissionId: "s1", hasAttachments: false });
    await emitter.emitFormReceived("tenant-abc", { siteSlug: "a", formId: "f", submissionId: "s2", hasAttachments: false });

    expect(captured).toHaveLength(2);
    const idA = JSON.parse(captured[0].rawBody).eventId;
    const idB = JSON.parse(captured[1].rawBody).eventId;
    expect(idA).not.toBe(idB);
  });
});

describe("WSK-12 · ZoneBEventEmitterService — FAIL-SOFT (§03: 'a bridge outage must never break a form submission')", () => {
  it("never throws when the bridge is unreachable (connection refused)", async () => {
    process.env.WEBDESK_ZONEB_BRIDGE_URL = "http://127.0.0.1:1/unreachable"; // port 1: nothing listens there
    const emitter = new ZoneBEventEmitterService();
    await expect(
      emitter.emitFormReceived("tenant-x", { siteSlug: "a", formId: "f", submissionId: "s", hasAttachments: false }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the bridge responds with a server error", async () => {
    nextStatus = 502;
    const emitter = new ZoneBEventEmitterService();
    await expect(
      emitter.emitFormReceived("tenant-x", { siteSlug: "a", formId: "f", submissionId: "s", hasAttachments: false }),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(1); // the call WAS attempted — this proves the failure is post-delivery, not a skip
  });

  it("never throws and never attempts delivery when WEBDESK_ZONEB_EVENTS_ENABLED=false", async () => {
    process.env.WEBDESK_ZONEB_EVENTS_ENABLED = "false";
    const emitter = new ZoneBEventEmitterService();
    await expect(
      emitter.emitFormReceived("tenant-x", { siteSlug: "a", formId: "f", submissionId: "s", hasAttachments: false }),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(0);
  });

  it("never throws and never attempts delivery when the bridge URL is unset", async () => {
    process.env.WEBDESK_ZONEB_BRIDGE_URL = "";
    const emitter = new ZoneBEventEmitterService();
    await expect(
      emitter.emitFormReceived("tenant-x", { siteSlug: "a", formId: "f", submissionId: "s", hasAttachments: false }),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(0);
  });

  it("never throws and never attempts delivery when the secret is unset (never send an unsigned/wrongly-signed fact)", async () => {
    process.env.WEBDESK_EVENT_SECRET = "";
    const emitter = new ZoneBEventEmitterService();
    await expect(
      emitter.emitFormReceived("tenant-x", { siteSlug: "a", formId: "f", submissionId: "s", hasAttachments: false }),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(0);
  });
});

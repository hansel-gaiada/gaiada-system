// M4 telemetry — the security spec: NO bearer token, header, query string or body reaches a span.
//
// Two layers. (1) The pure rules (redact.ts), including shapes no route produces today. (2) The real
// pipeline: the SDK with its instrumentations is started, real requests hit each token route over a real
// socket, and every span that reaches the exporter is serialised and searched for the token. The
// NEGATIVE CONTROL lives in telemetry-redaction-control.spec.ts: the same drive with redaction off must
// find the token, which proves this search can see a token and that the spans really carried one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { redactAttributes, redactName, redactPath, redactText, redactUrl } from "../src/telemetry/redact";
import { sanitizeSpan } from "../src/telemetry/sanitizing-exporter";
import { startTelemetry, type TelemetryHandle } from "../src/telemetry/sdk";
import { CaptureExporter, driveRoutes, newToken, serializeSpans, tokenOf, tokenRoutes } from "./telemetry-capture";

const T = "A".repeat(43); // shaped like a real token, easy to spot

describe("redact.ts — pure rules", () => {
  it("redacts the credential segment of both token routes, keeps the rest of the path", () => {
    expect(redactPath(`/v1/t/acme/preview/${T}`)).toBe("/v1/t/acme/preview/[redacted]");
    expect(redactPath(`/v1/t/acme/media/upload/${T}`)).toBe("/v1/t/acme/media/upload/[redacted]");
    expect(redactPath(`/v1/t/acme/preview/${T}/extra`)).toBe("/v1/t/acme/preview/[redacted]/extra");
  });

  it("survives the spellings the router accepts: encoded route word, doubled slashes, upper case", () => {
    expect(redactPath(`/v1/t/acme/%70review/${T}`)).not.toContain(T);
    expect(redactPath(`/v1/t/acme//preview/${T}`)).not.toContain(T);
    expect(redactPath(`/v1/t/acme/PREVIEW/${T}`)).not.toContain(T);
    expect(redactPath(`/v1/t/acme/media/%75pload/${T}`)).not.toContain(T);
  });

  it("backstop: any token-shaped segment is redacted even on a route nobody listed", () => {
    expect(redactPath(`/v1/t/acme/some-future-route/${T}`)).toBe("/v1/t/acme/some-future-route/[redacted]");
  });

  it("returns a path with no credential byte for byte", () => {
    for (const p of ["/v1/t/acme/pages", "/v1/t/acme/pages/home", "/control/v1/tenants/acme/sites/0b9f/content/items/0b9f", "//x//y"]) expect(redactPath(p)).toBe(p);
  });

  it("urls: query, fragment and userinfo are dropped; outbound calls lose their whole path", () => {
    expect(redactUrl(`http://h:3000/v1/t/acme/preview/${T}?api_key=S#frag`, "token-routes")).toBe("http://h:3000/v1/t/acme/preview/[redacted]");
    expect(redactUrl("https://user:pw@hooks.example.com/services/T0/B0/XYZ?x=1", "drop")).toBe("https://hooks.example.com/[redacted]");
  });

  it("text: a token route inside a span name or message is redacted", () => {
    expect(redactName(`GET /v1/t/acme/preview/${T}`)).toBe("GET /v1/t/acme/preview/[redacted]");
    expect(redactText(`failed on /v1/t/acme/media/upload/${T} twice`)).toBe("failed on /v1/t/acme/media/upload/[redacted] twice");
    expect(redactText("nothing to see")).toBe("nothing to see");
  });

  it("attributes: URL fields rewritten, query/header/body/caller/exception attributes dropped, server peer address dropped", () => {
    const out = redactAttributes(
      {
        "url.full": `http://h/v1/t/acme/preview/${T}?k=1`,
        "http.url": `http://h/v1/t/acme/preview/${T}?k=1`,
        "http.target": `/v1/t/acme/preview/${T}?k=1`,
        "url.path": `/v1/t/acme/preview/${T}`,
        "url.query": "api_key=S",
        "http.request.header.authorization": "Bearer S",
        "http.response.header.set-cookie": "sid=S",
        "http.request.body.size": 5,
        "client.address": "203.0.113.9",
        "http.user_agent": "curl",
        "network.peer.address": "203.0.113.9",
        "exception.message": `duplicate key value (token_hash)=(${T})`,
        "http.method": "GET",
        "http.status_code": 404,
        "some.note": `see /v1/t/acme/preview/${T}`,
      },
      1,
    );
    expect(Object.keys(out).sort()).toEqual(["http.method", "http.status_code", "http.target", "http.url", "some.note", "url.full", "url.path"]);
    expect(JSON.stringify(out)).not.toContain(T);
    expect(out["http.target"]).toBe("/v1/t/acme/preview/[redacted]");
  });

  it("a peer address on a CLIENT span is the upstream, not a person: kept", () => {
    expect(redactAttributes({ "network.peer.address": "10.0.0.5" }, 2)).toEqual({ "network.peer.address": "10.0.0.5" });
  });

  it("sanitizeSpan clears event text, links and the status message and does not mutate its input", () => {
    const span = {
      name: `GET /v1/t/acme/preview/${T}`,
      kind: 1,
      spanContext: () => ({ traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 }),
      parentSpanContext: undefined,
      startTime: [1, 0],
      endTime: [2, 0],
      status: { code: 2, message: `boom ${T}` },
      attributes: { "http.target": `/v1/t/acme/preview/${T}?x=1` },
      links: [{ context: { traceId: "1".repeat(32), spanId: "3".repeat(16), traceFlags: 1 }, attributes: { u: `/v1/t/acme/media/upload/${T}` } }],
      events: [{ name: "exception", time: [1, 5], attributes: { "exception.type": "Error", "exception.message": `bad ${T}`, "exception.stacktrace": `at /v1/t/acme/preview/${T}` } }],
      duration: [1, 0],
      ended: true,
      resource: { attributes: {} },
      instrumentationScope: { name: "x" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as never;
    const clean = sanitizeSpan(span);
    expect(JSON.stringify({ n: clean.name, s: clean.status, a: clean.attributes, l: clean.links, e: clean.events })).not.toContain(T);
    expect(clean.status).toEqual({ code: 2 });
    expect(clean.events[0].attributes).toEqual({ "exception.type": "Error" });
    expect((span as { name: string }).name).toContain(T); // input untouched
  });
});

describe("real pipeline — every token route, spans serialised and searched", () => {
  const capture = new CaptureExporter();
  let handle: TelemetryHandle;
  let app: NestFastifyApplication;
  let base: string;

  beforeAll(async () => {
    // The SDK first (it patches node:http and fastify as they are first required), the app after.
    handle = startTelemetry({
      gate: { enabled: true, tracesUrl: "http://127.0.0.1:9/v1/traces", headers: {} },
      exporter: capture,
      scheduledDelayMillis: 50,
      warn: () => undefined,
    });
    const kit = await import("./telemetry-kit");
    app = await kit.buildTelemetryApp();
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.shutdown();
  });

  it("no token, header value, query value or body byte is in any exported span; the redacted shape is", async () => {
    const previewToken = newToken();
    const uploadToken = newToken();
    const routes = tokenRoutes(previewToken, uploadToken);
    const statuses = await driveRoutes(base, routes);
    expect(statuses.length).toBe(routes.length); // every request got an answer (404 is these routes' real invalid-token answer)
    await handle.forceFlush();

    expect(capture.spans.length, "the SDK produced no spans at all: the search below would pass vacuously").toBeGreaterThan(0);
    const dump = serializeSpans(capture.spans);

    for (const secret of [previewToken, uploadToken, "QUERYSECRET", "HEADERSECRET", "BODYSECRET", "a.png"]) {
      expect(dump, `span data contains ${secret}`).not.toContain(secret);
    }
    expect(dump).toContain("[redacted]");
    expect(dump).toContain("webdesk-api");
    // the other direction, so the assertion above is not satisfied by dropping every URL: the route is still there
    expect(dump).toContain("/v1/t/acme/preview/[redacted]");
    expect(dump).toContain("/v1/t/acme/media/upload/[redacted]");
  });

  it("each route on its own: a span exists for it and none leaks", async () => {
    for (const r of tokenRoutes(newToken(), newToken())) {
      const before = capture.spans.length;
      await driveRoutes(base, [r]);
      await handle.forceFlush();
      const mine = capture.spans.slice(before);
      expect(mine.length, `${r.label}: no span`).toBeGreaterThan(0);
      expect(serializeSpans(mine), r.label).not.toContain(tokenOf(r));
    }
  });
});

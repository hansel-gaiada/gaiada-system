// M4 telemetry — the real exporter against a local sink: the SDK is started from env exactly as main.ts does
// (gate -> startTelemetry), real requests are served, and the sink sees what a collector would.
//
// Proves: OTLP/HTTP protobuf POSTs to /v1/traces and ONLY there (no logs, no metrics), carrying the configured
// bearer verbatim; the resource identity; and, on the WIRE bytes rather than the in-process spans, that none of
// the secrets (path tokens, query values, header values, body) left the process.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { evaluateTelemetryGate } from "../src/telemetry/gate";
import { startTelemetry, type TelemetryHandle } from "../src/telemetry/sdk";
import { driveRoutes, newToken, tokenRoutes } from "./telemetry-capture";
import { startSink, type Sink } from "./telemetry-sink";

const BEARER = "wdotlp_" + "f".repeat(48);

describe("OTLP exporter -> local sink", () => {
  let sink: Sink;
  let handle: TelemetryHandle;
  let app: NestFastifyApplication;
  let base: string;
  const previewToken = newToken();
  const uploadToken = newToken();

  beforeAll(async () => {
    sink = await startSink();
    const gate = evaluateTelemetryGate({
      OTEL_ENABLED: "true",
      WEBDESK_OTEL_ZONEA_PUSH_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${sink.port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${BEARER}`,
    });
    if (!gate.enabled) throw new Error("test setup: the gate should be on");
    handle = startTelemetry({ gate, scheduledDelayMillis: 100, warn: () => undefined });
    const kit = await import("./telemetry-kit");
    app = await kit.buildTelemetryApp();
    base = await app.getUrl();
    await driveRoutes(base, tokenRoutes(previewToken, uploadToken));
    await handle.forceFlush();
    await sink.waitForTracePosts(1);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.shutdown();
    await sink?.close();
  });

  it("POSTs OTLP/HTTP protobuf to /v1/traces, and to nothing else", () => {
    expect(sink.posts.length).toBeGreaterThan(0);
    for (const p of sink.posts) {
      expect(p.method).toBe("POST");
      expect(p.url).toBe("/v1/traces"); // no /v1/logs, no /v1/metrics: the receiver has no such pipelines
      expect(String(p.headers["content-type"])).toContain("application/x-protobuf");
      expect(p.body.length).toBeGreaterThan(0);
    }
  });

  it("every POST carries exactly the configured bearer, nothing else secret", () => {
    for (const p of sink.posts) {
      expect(p.headers.authorization).toBe(`Bearer ${BEARER}`);
      expect(p.headers.cookie).toBeUndefined();
    }
  });

  it("spans are batched, not sent one POST per span", () => {
    // 7 requests x 2 spans = 14 spans, batch size 128: a handful of POSTs at most
    expect(sink.posts.length).toBeLessThanOrEqual(7);
  });

  it("the resource says webdesk-api / webdesk and names a version; the spans name the route", () => {
    const wire = Buffer.concat(sink.posts.map((p) => p.body)).toString("latin1");
    expect(wire).toContain("service.name");
    expect(wire).toContain("webdesk-api");
    expect(wire).toContain("service.namespace");
    expect(wire).toContain("service.version");
    expect(wire).toContain("GET /v1/*");
  });

  it("WIRE CHECK: no path token, query value, header value or request body byte left the process", () => {
    const wire = Buffer.concat(sink.posts.map((p) => p.body)).toString("latin1");
    for (const secret of [previewToken, uploadToken, "QUERYSECRET", "HEADERSECRET", "BODYSECRET", "a.png", BEARER]) {
      expect(wire.includes(secret), `the exported bytes contain ${secret.slice(0, 12)}...`).toBe(false);
    }
    expect(wire).toContain("/v1/t/acme/preview/[redacted]");
    expect(wire).toContain("/v1/t/acme/media/upload/[redacted]");
  });
});

// M4 telemetry — NEGATIVE CONTROL for telemetry-redaction.spec.ts. Same app, same requests, same search,
// but the sanitizer is switched OFF (the `redact: false` seam that exists for this file only). The search MUST
// find the tokens. If it does not, the redaction spec proves nothing: either the spans never carried the
// token in the first place or the search cannot see one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTelemetry, type TelemetryHandle } from "../src/telemetry/sdk";
import { CaptureExporter, driveRoutes, newToken, serializeSpans, tokenOf, tokenRoutes } from "./telemetry-capture";

describe("negative control: with redaction OFF the same requests leak the token into spans", () => {
  const capture = new CaptureExporter();
  let handle: TelemetryHandle;
  let app: NestFastifyApplication;
  let base: string;

  beforeAll(async () => {
    handle = startTelemetry({
      gate: { enabled: true, tracesUrl: "http://127.0.0.1:9/v1/traces", headers: {} },
      exporter: capture,
      redact: false,
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

  it("the token, the query secret and a request header value are all findable in the raw spans", async () => {
    const previewToken = newToken();
    const uploadToken = newToken();
    await driveRoutes(base, tokenRoutes(previewToken, uploadToken));
    await handle.forceFlush();
    const dump = serializeSpans(capture.spans);
    expect(dump).toContain(previewToken);
    expect(dump).toContain(uploadToken);
    expect(dump).toContain("QUERYSECRET"); // the query string is recorded by the instrumentations (url.full / http.target)
    expect(dump).not.toContain("[redacted]");
  });

  it("every individual route leaks on its own when unredacted (so each per-route assertion in the redaction spec has teeth)", async () => {
    for (const r of tokenRoutes(newToken(), newToken())) {
      const before = capture.spans.length;
      await driveRoutes(base, [r]);
      await handle.forceFlush();
      expect(serializeSpans(capture.spans.slice(before)), r.label).toContain(tokenOf(r));
    }
  });
});

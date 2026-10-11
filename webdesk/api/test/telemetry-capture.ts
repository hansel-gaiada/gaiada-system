// M4 telemetry — Nest-free helpers for test/telemetry-*.spec.ts: the token routes to drive, the request driver,
// and an exporter that captures spans. Imports only TYPES from OpenTelemetry on purpose, so a spec can import
// this BEFORE it starts the SDK without loading anything the instrumentations must patch.
import { randomBytes } from "node:crypto";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

export const newToken = (): string => randomBytes(32).toString("base64url");

export type Route = { label: string; method: string; path: string };

/** Every token route of the api (and the spellings the router also accepts), for the given tokens. */
export function tokenRoutes(previewToken: string, uploadToken: string, slug = "acme"): Route[] {
  return [
    { label: "preview GET", method: "GET", path: `/v1/t/${slug}/preview/${previewToken}` },
    { label: "preview OPTIONS", method: "OPTIONS", path: `/v1/t/${slug}/preview/${previewToken}` },
    { label: "preview with query", method: "GET", path: `/v1/t/${slug}/preview/${previewToken}?api_key=QUERYSECRET` },
    { label: "preview, encoded route word", method: "GET", path: `/v1/t/${slug}/%70review/${previewToken}` },
    { label: "preview, doubled slash", method: "GET", path: `/v1/t/${slug}//preview/${previewToken}` },
    { label: "media upload POST", method: "POST", path: `/v1/t/${slug}/media/upload/${uploadToken}?filename=a.png` },
    { label: "media upload OPTIONS", method: "OPTIONS", path: `/v1/t/${slug}/media/upload/${uploadToken}` },
  ];
}

export const SECRET_HEADERS = {
  authorization: "Bearer HEADERSECRET-authorization",
  cookie: "sid=HEADERSECRET-cookie",
  "x-api-key": "HEADERSECRET-apikey",
  "x-webdesk-control-gate": "HEADERSECRET-gate",
};

/** Drives each route over a real socket; returns the HTTP status of each. */
export async function driveRoutes(base: string, routes: Route[]): Promise<number[]> {
  const out: number[] = [];
  for (const r of routes) {
    const res = await fetch(`${base}${r.path}`, { method: r.method, headers: SECRET_HEADERS, body: r.method === "POST" ? "BODYSECRET-payload" : undefined });
    await res.arrayBuffer();
    out.push(res.status);
  }
  return out;
}

/** The token inside a route path (the one 43-character segment, possibly behind an encoded or doubled-slash spelling). */
export function tokenOf(route: Route): string {
  return route.path.split("?")[0].split("/").find((s) => s.length === 43)!;
}

/** Collects exactly what reaches the exporter (after the sanitizer, when it is on). */
export class CaptureExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.spans.push(...spans);
    cb({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

/** Everything a span can hold, as one string, for "is this secret anywhere in it" searches. */
export function serializeSpans(spans: ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((s) => ({
      name: s.name,
      kind: s.kind,
      context: s.spanContext(),
      parent: s.parentSpanContext,
      status: s.status,
      attributes: s.attributes,
      events: s.events,
      links: s.links,
      resource: s.resource.attributes,
      scope: s.instrumentationScope,
    })),
  );
}

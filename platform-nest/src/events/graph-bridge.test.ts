// Pure forwarding logic of the event→knowledge-graph bridge (no Redis). Covers the /graph/ingest
// target + body shape and the ack/retry decision per HTTP outcome (mirrors the n8n-bridge test).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { forwardToGraph } from "./graph-bridge";
import type { OutboxEvent } from "./types";

const ev: OutboxEvent = {
  id: "evt-1",
  tenantId: "co-1",
  entityType: "project",
  entityId: "p1",
  eventType: "project.created",
  payload: { title: "Website", clientId: "acme" },
  originSite: "main",
  schemaVersion: 1,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function mockFetch(status: number) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;
}

describe("event→knowledge-graph bridge forwarding (WS8 Step E)", () => {
  beforeEach(() => {
    config.services.knowledge = { url: "http://knowledge:3005", token: "know-token" };
    config.graphBridge = { entityTypes: ["project", "client"], timeoutMs: 1000 };
  });
  afterEach(() => vi.restoreAllMocks());

  it("POSTs a PlatformEvent to /graph/ingest with the service token", async () => {
    const spy = mockFetch(200);
    vi.stubGlobal("fetch", spy);
    expect(await forwardToGraph(ev)).toBe("delivered");
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toBe("http://knowledge:3005/graph/ingest");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer know-token");
    expect(JSON.parse(init.body)).toMatchObject({ eventType: "project.created", tenantId: "co-1", entityType: "project", entityId: "p1", payload: { clientId: "acme" } });
  });

  it("acks on 2xx and 4xx (delivered), retries on 5xx / network error", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    expect(await forwardToGraph(ev)).toBe("delivered");
    vi.stubGlobal("fetch", mockFetch(404));
    expect(await forwardToGraph(ev)).toBe("delivered"); // client error → ack, don't loop
    vi.stubGlobal("fetch", mockFetch(503));
    expect(await forwardToGraph(ev)).toBe("retry");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch);
    expect(await forwardToGraph(ev)).toBe("retry");
  });
});

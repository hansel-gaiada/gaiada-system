// Pure forwarding logic of the event→n8n bridge (no Redis needed). The Redis loop mirrors the
// consumer's tested pattern; here we cover allow-list gating, the v1 envelope + secret header,
// and the ack/retry decision per HTTP outcome.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { buildEnvelope, forwardEvent } from "./n8n-bridge";
import type { OutboxEvent } from "./types";

const ev: OutboxEvent = {
  id: "evt-1",
  tenantId: "co-1",
  entityType: "org_structure",
  entityId: "co-1",
  eventType: "org_structure.updated",
  payload: { updatedBy: "u-9" },
  originSite: "main",
  schemaVersion: 1,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function mockFetch(status: number) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;
}

describe("event→n8n bridge forwarding (WS4 §4)", () => {
  beforeEach(() => {
    config.n8nBridge = {
      webhookBaseUrl: "http://n8n:5678/",
      secret: "bridge-secret",
      events: ["org_structure.updated", "client.created"],
      entityTypes: ["org_structure", "client"],
      timeoutMs: 1000,
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it("builds a stable v1 envelope from real fields (no fabricated timestamps)", () => {
    expect(buildEnvelope(ev)).toEqual({
      v: 1,
      id: "evt-1",
      eventType: "org_structure.updated",
      entityType: "org_structure",
      tenantId: "co-1",
      entityId: "co-1",
      originSite: "main",
      createdAt: "2026-07-15T00:00:00.000Z",
      payload: { updatedBy: "u-9" },
    });
  });

  it("skips an event not on the allow-list without calling n8n", async () => {
    const spy = mockFetch(200);
    vi.stubGlobal("fetch", spy);
    expect(await forwardEvent({ ...ev, eventType: "deliverable.updated" })).toBe("skipped");
    expect((spy as any).mock.calls).toHaveLength(0);
  });

  it("POSTs the envelope to /webhook/ev/<eventType> with the shared secret and reports delivered on 2xx", async () => {
    const spy = mockFetch(200);
    vi.stubGlobal("fetch", spy);
    expect(await forwardEvent(ev)).toBe("delivered");
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toBe("http://n8n:5678/webhook/ev/org_structure.updated");
    expect((init.headers as Record<string, string>)["x-gaiada-bridge-secret"]).toBe("bridge-secret");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).id).toBe("evt-1");
  });

  it("acks (delivered) on a 4xx to avoid a poison-redelivery loop", async () => {
    vi.stubGlobal("fetch", mockFetch(404)); // no/inactive webhook
    expect(await forwardEvent(ev)).toBe("delivered");
  });

  it("retries on a 5xx (n8n up but erroring)", async () => {
    vi.stubGlobal("fetch", mockFetch(503));
    expect(await forwardEvent(ev)).toBe("retry");
  });

  it("retries on a network/timeout error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    expect(await forwardEvent(ev)).toBe("retry");
  });
});

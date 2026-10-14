import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./platform", async () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string) { super(message); }
  }
  return { platformFetch: vi.fn(), PlatformError };
});

import { platformFetch, PlatformError } from "./platform";
import { searchKnowledge } from "./admin";

const body = { query: "kickoff", results: [{ sourceRef: "client:1", family: "client", title: "Acme", snippet: "s", href: "/clients/1", score: 0.9 }], indexedAt: null };

beforeEach(() => { vi.mocked(platformFetch).mockReset(); });

describe("searchKnowledge (DW-8i)", () => {
  it("ok: returns the body and calls the encoded route", async () => {
    vi.mocked(platformFetch).mockResolvedValue(body);
    const r = await searchKnowledge("u1", "t1", "a & b", 5);
    expect(r).toEqual({ kind: "ok", data: body });
    expect(vi.mocked(platformFetch).mock.calls[0][0]).toBe("/api/t1/knowledge/search?q=a%20%26%20b&limit=5");
  });
  it("403 is forbidden, never an empty result", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "denied"));
    expect(await searchKnowledge("u1", "t1", "kickoff")).toEqual({ kind: "forbidden" });
  });
  it("503 is unavailable", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(503, "knowledge_unavailable"));
    expect(await searchKnowledge("u1", "t1", "kickoff")).toEqual({ kind: "unavailable", reason: "knowledge_unavailable" });
  });
  it("an unreachable platform is unavailable", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new Error("socket hang up"));
    expect(await searchKnowledge("u1", "t1", "kickoff")).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });
  it("400 maps to the query_invalid reason", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(400, "query_invalid"));
    expect(await searchKnowledge("u1", "t1", "x")).toEqual({ kind: "unavailable", reason: "query_invalid" });
  });
});

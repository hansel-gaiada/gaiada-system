import { describe, it, expect, vi, afterEach } from "vitest";
import { CLIENT_IDLE_TIMEOUT_MS, type ClientStreamEvent } from "@/lib/assistant";
import { openAssistantStream } from "./useAssistantStream";

// ASST-07 — proves the transport half of the streaming pipeline: real incremental decoding off a
// controllable fake `fetch`/`ReadableStream` reader (jsdom has no real network), the "stream end
// without done/error is an error" mandate, and — the ticket's own explicit ask, "test this
// deliberately; it is the failure users actually hit" — the 120s client idle timeout tearing the
// connection down via `AbortController` rather than hanging forever. Fake timers make this
// deterministic and fast instead of an actual 2-minute wait.

/** A reader whose `read()` calls are driven by the test, not by a real stream. `push`/`read` can be
 *  called in either order — chunks queue if no read is waiting yet, and vice versa — so tests don't
 *  have to reason about microtask timing to get the ordering right. */
function makeControllableReader() {
  const queue: (Uint8Array | null)[] = [];
  const waiters: { resolve: (v: { done: boolean; value?: Uint8Array }) => void; reject: (e: unknown) => void }[] = [];
  function deliver() {
    while (queue.length && waiters.length) {
      const chunk = queue.shift()!;
      const w = waiters.shift()!;
      if (chunk === null) w.resolve({ done: true });
      else w.resolve({ done: false, value: chunk });
    }
  }
  return {
    push(chunk: Uint8Array | null) {
      queue.push(chunk);
      deliver();
    },
    read(): Promise<{ done: boolean; value?: Uint8Array }> {
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        deliver();
      });
    },
    rejectPending(err: unknown) {
      while (waiters.length) waiters.shift()!.reject(err);
    },
    releaseLock() {},
  };
}

function installFetchMock(reader: ReturnType<typeof makeControllableReader>, opts: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      const err = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      reader.rejectPending(err);
    });
    return Promise.resolve({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      body: { getReader: () => reader },
      json: async () => ({}),
    } as unknown as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function drain(events: AsyncGenerator<ClientStreamEvent>): Promise<ClientStreamEvent[]> {
  const out: ClientStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("openAssistantStream — real incremental decoding", () => {
  it("yields a token event per SSE block as it arrives, in order, then done", async () => {
    const reader = makeControllableReader();
    installFetchMock(reader);
    const enc = new TextEncoder();
    // Three SEPARATE pushes — the point being proven is that each arrives as its own event rather
    // than everything being buffered until the connection closes.
    reader.push(enc.encode('event: token\ndata: {"text":"Hel"}\n\n'));
    reader.push(enc.encode('event: token\ndata: {"text":"lo"}\n\n'));
    reader.push(enc.encode('event: usage\ndata: {"tokens":2,"latencyMs":40}\n\n'));
    reader.push(enc.encode("event: done\ndata: {}\n\n"));
    reader.push(null);

    const events = await drain(openAssistantStream("t1", "m1").events);
    expect(events).toEqual([
      { type: "token", text: "Hel" },
      { type: "token", text: "lo" },
      { type: "usage", tokens: 2, latencyMs: 40, source: "estimate", promptTokens: undefined, completionTokens: undefined },
      { type: "done" },
    ]);
  });

  it("decodes a meta event and a real (provider-sourced) usage event", async () => {
    const reader = makeControllableReader();
    installFetchMock(reader);
    const enc = new TextEncoder();
    reader.push(enc.encode('event: meta\ndata: {"provider":"ollama","model":"llama3.2"}\n\n'));
    reader.push(enc.encode('event: token\ndata: {"text":"hi"}\n\n'));
    reader.push(enc.encode('event: usage\ndata: {"tokens":15,"latencyMs":300,"source":"provider","promptTokens":10,"completionTokens":5}\n\n'));
    reader.push(enc.encode("event: done\ndata: {}\n\n"));
    reader.push(null);

    const events = await drain(openAssistantStream("t1", "m1").events);
    expect(events).toEqual([
      { type: "meta", provider: "ollama", model: "llama3.2" },
      { type: "token", text: "hi" },
      { type: "usage", tokens: 15, latencyMs: 300, source: "provider", promptTokens: 10, completionTokens: 5 },
      { type: "done" },
    ]);
  });

  it("a block split across two chunk boundaries still decodes once the rest arrives", async () => {
    const reader = makeControllableReader();
    installFetchMock(reader);
    const enc = new TextEncoder();
    reader.push(enc.encode('event: token\ndata: {"te'));
    reader.push(enc.encode('xt":"hi"}\n\n'));
    reader.push(enc.encode("event: done\ndata: {}\n\n"));
    reader.push(null);
    const events = await drain(openAssistantStream("t1", "m1").events);
    expect(events).toEqual([{ type: "token", text: "hi" }, { type: "done" }]);
  });

  it("an error event ends the stream immediately — nothing after it is emitted, even if more bytes were queued", async () => {
    const reader = makeControllableReader();
    installFetchMock(reader);
    const enc = new TextEncoder();
    reader.push(enc.encode('event: token\ndata: {"text":"hi"}\n\n'));
    reader.push(enc.encode('event: error\ndata: {"error":"boom","errorKind":"upstream_error"}\n\n'));
    reader.push(enc.encode("event: done\ndata: {}\n\n")); // must never be reached
    const events = await drain(openAssistantStream("t1", "m1").events);
    expect(events).toEqual([
      { type: "token", text: "hi" },
      { type: "error", error: "boom", errorKind: "upstream_error" },
    ]);
  });

  it("a clean stream end with NEITHER done NOR error is reported as a failure, never a silent success (ASST-10's mandate, client side)", async () => {
    const reader = makeControllableReader();
    installFetchMock(reader);
    const enc = new TextEncoder();
    reader.push(enc.encode('event: token\ndata: {"text":"partial"}\n\n'));
    reader.push(null); // the connection just closes, no terminal event
    const events = await drain(openAssistantStream("t1", "m1").events);
    expect(events).toEqual([
      { type: "token", text: "partial" },
      { type: "error", error: "The connection ended before the reply finished.", errorKind: "client_abnormal_drop" },
    ]);
  });

  it("a non-2xx response (e.g. our proxy's 404/502) surfaces as an immediate error, not a hang", async () => {
    const reader = makeControllableReader();
    installFetchMock(reader, { ok: false, status: 502 });
    const events = await drain(openAssistantStream("t1", "m1").events);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });
});

describe("openAssistantStream — the 120s client idle timeout (this ticket's own explicit test-it-deliberately case)", () => {
  it("aborts via AbortController and yields a visible client_idle_timeout error after 120s of total silence — never a forever-spinner", async () => {
    vi.useFakeTimers();
    const reader = makeControllableReader(); // never pushes anything: a fully stalled upstream
    installFetchMock(reader);

    const events: ClientStreamEvent[] = [];
    const consuming = (async () => {
      for await (const e of openAssistantStream("t1", "m1").events) events.push(e);
    })();

    // Just under the timeout: still silent, nothing has fired yet.
    await vi.advanceTimersByTimeAsync(CLIENT_IDLE_TIMEOUT_MS - 1000);
    expect(events).toEqual([]);

    // Crossing the 120s mark: the armed idle timer fires, aborts the controller, which rejects the
    // pending `reader.read()` with AbortError — this is the exact mechanism, not a stand-in for it.
    await vi.advanceTimersByTimeAsync(1000);
    await consuming;

    expect(events).toEqual([
      { type: "error", error: "No response for 2 minutes — the connection was closed.", errorKind: "client_idle_timeout" },
    ]);
  });

  it("any activity at all resets the idle timer — a stream that keeps sending tokens never times out", async () => {
    vi.useFakeTimers();
    const reader = makeControllableReader();
    installFetchMock(reader);
    const enc = new TextEncoder();

    const events: ClientStreamEvent[] = [];
    const handle = openAssistantStream("t1", "m1");
    const consuming = (async () => {
      for await (const e of handle.events) events.push(e);
    })();

    // Three rounds of "almost timed out, but a token arrives just in time" — each push happens
    // before the FULL 120s elapses since the last one, so the timer keeps getting re-armed.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(CLIENT_IDLE_TIMEOUT_MS - 5000);
      reader.push(enc.encode(`event: token\ndata: {"text":"t${i}"}\n\n`));
      await vi.advanceTimersByTimeAsync(0); // let the microtask deliver before the next round
    }
    reader.push(enc.encode("event: done\ndata: {}\n\n"));
    reader.push(null);
    await consuming;

    expect(events).toEqual([
      { type: "token", text: "t0" }, { type: "token", text: "t1" }, { type: "token", text: "t2" }, { type: "done" },
    ]);
  });
});

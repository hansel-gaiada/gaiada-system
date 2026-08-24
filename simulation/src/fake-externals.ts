// The fake external boundary.
//
// WHAT PROBLEM THIS SOLVES
// -----------------------
// The estate's edges are real: `gaiada-waha-1` is a live WhatsApp gateway on the box, and the
// gateway holds real provider keys. Driving those for a simulation is not an option — a mis-wired
// outbound call messages a stranger's handset, and provider quota is real money. But leaving the
// edges out entirely means the simulation never exercises the code that HANDLES an edge: the retry,
// the 429 back-off, the timeout, the malformed response. That code is exactly where estates break.
//
// So: impersonate the edge, faithfully, and make it misbehave on purpose.
//
// TWO DIRECTIONS, AND THE INBOUND ONE MATTERS MORE
// ------------------------------------------------
//  * OUTBOUND (the estate calls out): WAHA-shaped send endpoints that answer like WAHA, with
//    injectable latency and failures. Nothing leaves the box.
//  * INBOUND (the world calls in): posts a REAL-SHAPED WAHA webhook at the bot, which is how an
//    actual customer message arrives. This is the more valuable direction, because inbound is where
//    the estate does its own parsing, persistence and dispatch.
//
// EVERY PAYLOAD SHAPE HERE WAS READ OFF THE CONSUMER, NEVER INVENTED. The field names below come
// from `wa-chat-bot/src/waha.ts::normalize()` and `src/gateway/events.ts::normalizeWahaEvent()` —
// `payload.from`, `payload.participant`, `payload.notifyName`, `payload.timestamp` in SECONDS, and
// the `event` discriminator. Guessing them would produce the program's own recurring bug class:
// a confident payload the receiver silently drops, and a simulation that reports success while the
// bot ignored every message.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/** How the boundary should behave for a given call. Failure is INJECTED rather than random, so a
 *  run is reproducible: the same tick produces the same failure. */
export type FaultMode = "ok" | "rate_limited" | "server_error" | "timeout" | "malformed" | "unauthorized";

/** The rotation the outbound endpoints walk through. Roughly one in five calls misbehaves, which is
 *  pessimistic for a real provider and deliberately so: the point is to reach the handling code, and
 *  a 1-in-1000 fault rate would need a thousand ticks to test the retry once. */
const FAULT_CYCLE: FaultMode[] = ["ok", "ok", "ok", "ok", "rate_limited", "ok", "ok", "ok", "server_error", "ok", "ok", "timeout", "ok", "ok", "malformed"];

let callSeq = 0;
function nextFault(forced?: string | null): FaultMode {
  if (forced && (FAULT_CYCLE as string[]).includes(forced)) return forced as FaultMode;
  if (forced === "ok") return "ok";
  return FAULT_CYCLE[callSeq++ % FAULT_CYCLE.length]!;
}

const journalDir = join(config.logDir, config.runId);
const journalFile = join(journalDir, "externals.jsonl");

/** Everything the estate TRIED to send leaves a record. This is the half a real provider would
 *  never give back: proof of what the system attempted, including the attempts that "failed". */
function journal(entry: Record<string, unknown>): void {
  try {
    mkdirSync(journalDir, { recursive: true });
    appendFileSync(journalFile, JSON.stringify({ ts: new Date().toISOString(), runId: config.runId, ...entry }) + "\n", "utf8");
  } catch {
    // A journal that cannot be written must not take the boundary down — the estate under test is
    // more important than the harness's own bookkeeping.
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return { _unparsed: raw.slice(0, 500) };
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
  res.end(text);
}

/** Apply the injected fault. Returns true when it already answered and the caller must stop. */
async function applyFault(res: ServerResponse, fault: FaultMode, path: string): Promise<boolean> {
  switch (fault) {
    case "rate_limited":
      // Real providers send Retry-After. Omitting it is how a client ends up hammering.
      res.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
      res.end(JSON.stringify({ error: "rate limit exceeded", retryAfter: 2 }));
      journal({ direction: "outbound", path, fault, status: 429 });
      return true;
    case "server_error":
      send(res, 502, { error: "upstream unavailable" });
      journal({ direction: "outbound", path, fault, status: 502 });
      return true;
    case "unauthorized":
      send(res, 401, { error: "invalid api key" });
      journal({ direction: "outbound", path, fault, status: 401 });
      return true;
    case "malformed":
      // A 200 with a body the client cannot parse. This is the nastiest real-world case and the one
      // most likely to be mishandled, because the status says everything is fine.
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id": "truncated-json"');
      journal({ direction: "outbound", path, fault, status: 200, note: "malformed body" });
      return true;
    case "timeout":
      // Hold the socket open past any sane client timeout, then hang up without answering. Real
      // timeouts do not send a status, and a stub that returns 504 tests a different code path.
      journal({ direction: "outbound", path, fault, status: 0, note: "held open then destroyed" });
      await new Promise((r) => setTimeout(r, 35_000));
      res.destroy();
      return true;
    case "ok":
      return false;
  }
}

/** Build a WAHA `message` webhook envelope that `normalizeWahaEvent` + `normalize` accept.
 *
 *  `timestamp` is in SECONDS — normalize() multiplies by 1000. Sending milliseconds here would date
 *  every simulated message to the year 57000 and is the kind of thing that looks fine until a report
 *  is grouped by day. */
export function wahaInboundMessage(opts: {
  fromPhone: string;
  senderName: string;
  text: string;
  isGroup?: boolean;
  messageId?: string;
}): Record<string, unknown> {
  const chatId = opts.isGroup ? `${opts.fromPhone.replace(/\D/g, "")}-group@g.us` : `${opts.fromPhone.replace(/\D/g, "")}@c.us`;
  return {
    event: "message",
    session: "default",
    payload: {
      id: opts.messageId ?? `sim_${Date.now().toString(36)}_${Math.floor(callSeq++ % 100000)}`,
      timestamp: Math.floor(Date.now() / 1000),
      from: chatId,
      participant: opts.isGroup ? `${opts.fromPhone.replace(/\D/g, "")}@c.us` : undefined,
      notifyName: opts.senderName,
      body: opts.text,
      fromMe: false,
      hasMedia: false,
    },
  };
}

/** A WAHA `session.status` event — the lifecycle signal the bot subscribes to and, until recently,
 *  silently dropped. Worth simulating precisely because a disconnect is the failure operators care
 *  about most. */
export function wahaSessionStatus(status: "WORKING" | "FAILED" | "STOPPED" | "SCAN_QR_CODE"): Record<string, unknown> {
  return { event: "session.status", payload: { name: "default", status, timestamp: Math.floor(Date.now() / 1000) } };
}

export interface FakeExternalsHandle {
  port: number;
  close: () => Promise<void>;
}

/** Start the boundary. Returns immediately once listening. */
export function startFakeExternals(port = 4599): Promise<FakeExternalsHandle> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const forced = url.searchParams.get("fault");
      const body = await readBody(req);

      // ── Control surface ────────────────────────────────────────────────────────────────────────
      if (path === "/health") return send(res, 200, { ok: true, role: "fake-externals", runId: config.runId, calls: callSeq });

      // ── WAHA outbound: the endpoints wa-chat-bot's WahaGateway calls ───────────────────────────
      // Path prefix and body keys mirror WAHA's own API (`/api/sendText` with { session, chatId,
      // text }) so the bot needs no change to point at this instead.
      if (path.startsWith("/api/send")) {
        const fault = nextFault(forced);
        if (await applyFault(res, fault, path)) return;
        // Realistic latency. A stub that answers in 0ms hides every ordering bug that only appears
        // when a send is slower than the next event.
        await new Promise((r) => setTimeout(r, 120 + (callSeq % 7) * 45));
        const b = (body ?? {}) as Record<string, unknown>;
        journal({ direction: "outbound", path, fault: "ok", status: 201, chatId: b.chatId, textLen: String(b.text ?? "").length });
        return send(res, 201, {
          id: `false_${String(b.chatId ?? "unknown")}_${Date.now().toString(36)}`,
          timestamp: Math.floor(Date.now() / 1000),
          from: "sim@c.us",
          to: b.chatId ?? null,
          _sim: "This message was NOT delivered. It was absorbed by the simulation's fake boundary.",
        });
      }

      // WAHA session admin, so the bot's admin console reads a plausible session rather than erroring.
      if (path.startsWith("/api/sessions")) {
        journal({ direction: "outbound", path, fault: "ok", status: 200 });
        return send(res, 200, [{ name: "default", status: "WORKING", config: { proxy: null } }]);
      }

      // ── Generic paid-provider surface ──────────────────────────────────────────────────────────
      // Anything under /provider/* answers a small, well-formed, obviously-fake result. Shape is
      // deliberately generic: the point is the failure behaviour, not pretending to be one vendor.
      if (path.startsWith("/provider/")) {
        const fault = nextFault(forced);
        if (await applyFault(res, fault, path)) return;
        await new Promise((r) => setTimeout(r, 200 + (callSeq % 5) * 120));
        journal({ direction: "outbound", path, fault: "ok", status: 200 });
        return send(res, 200, {
          provider: path.split("/")[2] ?? "unknown",
          simulated: true,
          note: "Fake provider response from the simulation boundary. No external call was made and no quota was spent.",
          results: [
            { rank: 1, value: "simulated-result-a", score: 0.91 },
            { rank: 2, value: "simulated-result-b", score: 0.74 },
          ],
        });
      }

      journal({ direction: "outbound", path, fault: "ok", status: 404, note: "unhandled path" });
      return send(res, 404, { error: "no fake for this path", path });
    })().catch(() => {
      try {
        send(res, 500, { error: "fake boundary failed" });
      } catch {
        /* socket already gone */
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

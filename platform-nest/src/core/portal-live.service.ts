// CP-5 — the portal's realtime bus. Turns the existing event backbone into per-connection "something
// you can see has changed" hints for the client portal.
//
// ══ THE ONE DESIGN DECISION THAT MATTERS: THIS STREAM CARRIES NO BUSINESS DATA ═══════════════════
// An SSE fan-out to EXTERNAL parties is, by default, the worst possible place to enforce row-level
// authorization: the filter runs per event rather than per request, there is no `withTenants`
// transaction around it, and a mistake leaks continuously and silently rather than failing a test.
//
// So this bus deliberately cannot leak: a frame is `{topic, at}` — a topic name and a timestamp. No
// ids, no titles, no amounts, no payload. The browser's reaction is to re-render, which re-runs the
// ordinary server-side reads through the ownership-enforcing BFF. Authorization therefore still
// happens exactly once, in the place it already worked, on every refresh. The stream's only power is
// to say "ask again now" instead of "ask again in 30 seconds".
//
// That inversion is what makes realtime cheap to reason about here. If a filtering bug below let one
// tenant's hint reach another tenant's connection, the consequence is a wasted refetch — not a
// disclosure. Nothing about the client's data depends on this code being correct.
//
// ══ WHY A TAIL READER AND NOT A CONSUMER GROUP ═══════════════════════════════════════════════════
// `consumer.service.ts` reads each `events:<entityType>` stream through the `in-process-platform`
// consumer GROUP, where every entry must be ACKed and an un-ACKed entry is redelivered. Joining that
// group would mean this bus could stall module dispatch (an un-ACKed entry blocks nothing else, but a
// second consumer in the same group STEALS entries from it — the module handlers would silently stop
// seeing events). Creating a second group would be correct but would make the portal's liveness a
// durable, at-least-once obligation with its own pending-entry list and dead-letter accounting, for
// data we explicitly do not care about losing.
//
// A plain `XREAD BLOCK` from `$` (the tail) is the honest match for the semantics: at-most-once,
// no ACKs, no group state, and a dropped hint costs one late refresh. A missed frame is covered by
// the client's polling fallback, which is always on.
import Redis from "ioredis";
import { config } from "../config";

/** A portal topic is a page-sized bucket of interest. Coarse ON PURPOSE — finer topics would push us
 *  toward putting ids in the frame to disambiguate, which is exactly what this file refuses to do. */
export type PortalTopic =
  | "approvals"    // a client-side gate opened/decided; scope sign-off progress
  | "projects"     // project/task/milestone movement -> progress + timeline
  | "deliverables"
  | "invoices"     // invoice issued/updated, payment confirmed
  | "contracts"
  | "profile"      // contact added/revoked, capability changed
  | "requests";    // MI-02/MI-03: a webdev change request submitted/triaged/converted

/** event_type -> topic. An event type absent from this map produces NO frame: the portal's realtime
 *  surface is an allowlist, same principle as the timeline query (see portal-workspace.controller.ts).
 *  Adding an internal event to the backbone must never, by default, wake a client's browser. */
const TOPIC_BY_EVENT: Record<string, PortalTopic> = {
  "pipeline.gate.opened": "approvals",
  "pipeline.gate.decided": "approvals",
  "scope.signed": "approvals",
  "pipeline.run.created": "projects",
  "pipeline.run.updated": "projects",
  "pipeline.stage.completed": "projects",
  "pm.task.updated": "projects",
  "pm.task.created": "projects",
  "pm.milestone.updated": "projects",
  "pm.project.updated": "projects",
  "deliverable.created": "deliverables",
  "deliverable.updated": "deliverables",
  "invoice.created": "invoices",
  "invoice.updated": "invoices",
  "invoice.payment.recorded": "invoices",
  "invoice.payment.confirmed": "invoices",
  "contract.sent": "contracts",
  "contract.client_signed": "contracts",
  "contract.signed": "contracts",
  "client_contact.created": "profile",
  "client_contact.updated": "profile",
  // MI-02/MI-03 (webdev maintenance intake, D-7): submit (portal) and triage/convert (staff) both
  // land here — one topic covers the CR's whole lifecycle so the portal page refetches on either.
  "webdev.change_request.created": "requests",
  "webdev.change_request.updated": "requests",
};

/** The `events:<entityType>` streams worth tailing — derived from the map above rather than listed
 *  twice. Every entity type whose events can produce a portal topic, and no others: tailing a stream
 *  nobody maps costs a blocking read slot for frames that would all be dropped. */
const TAILED_ENTITY_TYPES = [
  "pipeline_gate", "pipeline_run", "pipeline_stage", "scope",
  "pm_task", "pm_project", "pm_milestone",
  "deliverable", "invoice", "invoice_payment", "contract", "client_contact",
  "webdev_change_request",
] as const;

export interface PortalFrame {
  topic: PortalTopic;
  /** ISO timestamp of the originating outbox row, not of delivery — so a client that reconnects can
   *  tell an old replayed hint from a new one without us numbering them. */
  at: string;
}

interface Subscriber {
  tenantId: string;
  /** Resolved ONCE at connect. A client whose access is revoked mid-connection keeps receiving
   *  content-free hints until they reconnect; every refetch those hints trigger re-resolves the scope
   *  server-side and returns nothing. That is why resolving once is safe here and would not be if the
   *  frames carried data. */
  clientIds: Set<string>;
  send: (frame: PortalFrame) => void;
}

const subscribers = new Set<Subscriber>();
let reader: Redis | null = null;
let stopped = false;

/** True when the backbone is actually available. With no Redis the portal still works — the client
 *  falls back to polling — and the stream endpoint says so in its `hello` frame rather than pretending
 *  to be live. A silent degrade here would look exactly like "realtime is broken", which is the
 *  failure mode the `mode` field exists to make visible. */
export function portalLiveAvailable(): boolean {
  return Boolean(config.redisUrl);
}

export function subscribePortal(sub: Subscriber): () => void {
  subscribers.add(sub);
  startTailIfNeeded();
  return () => {
    subscribers.delete(sub);
    // The blocking reader is torn down when the last client leaves so an idle deployment holds no
    // extra Redis connection. It is recreated on the next subscriber.
    if (subscribers.size === 0) stopTail();
  };
}

/** Testing seam: drive the fan-out without Redis. Mirrors how the event tests exercise the relay. */
export function dispatchPortalFrame(tenantId: string, eventType: string, payload: Record<string, unknown>, at: string): void {
  const topic = TOPIC_BY_EVENT[eventType];
  if (!topic) return;
  // `clientId` is only present on events whose producers know it (the portal's own writes, and the
  // client-scoped staff writes). When it IS present the frame is narrowed to that client's
  // connections; when it is NOT, the frame goes to every connection in the tenant. That fallback is a
  // deliberate over-delivery: the cost is a redundant refetch that returns the same data, and the
  // alternative — resolving each event's owning client with a DB query on the hot path — would put a
  // per-event query behind an endpoint held open by external parties.
  const clientId = typeof payload.clientId === "string" ? payload.clientId : null;
  for (const sub of subscribers) {
    if (sub.tenantId !== tenantId) continue;
    if (clientId && !sub.clientIds.has(clientId)) continue;
    try {
      sub.send({ topic, at });
    } catch {
      // A dead socket must not break the loop for the other subscribers. The endpoint's own `close`
      // handler is what unsubscribes; this catch only stops one bad write from starving the rest.
    }
  }
}

function startTailIfNeeded(): void {
  if (reader || !portalLiveAvailable()) return;
  stopped = false;
  // A DEDICATED connection, built here rather than `getRedis().duplicate()`, for two reasons:
  //   * XREAD BLOCK monopolises its connection for the whole block window, so it must never share with
  //     the relay's XADDs or the consumer's XREADGROUPs — those would queue behind a 20s block.
  //   * `.duplicate()` would first CONSTRUCT the shared client (getRedis() is lazy) purely to clone its
  //     options, and the shared client has no 'error' listener of its own. On a machine where REDIS_URL
  //     points at a Redis that is not running — every dev box, and the unit-test environment — that
  //     produced an "[ioredis] Unhandled error event" traceable to a client this feature never uses.
  //     Owning the connection means owning its error handling.
  reader = new Redis(config.redisUrl as string, {
    // Bounded, growing backoff. ioredis's default retries roughly every 50ms×n with no ceiling on
    // attempts; against a Redis that is down for an hour that is a lot of log noise for a feature whose
    // absence is already handled by the client's polling fallback.
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    maxRetriesPerRequest: 2,
  });
  // An 'error' listener is MANDATORY, not tidiness. ioredis emits connection failures as client-level
  // 'error' events, which tailLoop's try/catch (it only wraps the COMMAND) cannot see — and an
  // unhandled 'error' on an EventEmitter is a process-level crash risk.
  reader.on("error", (err: Error) => {
    // Logged once per event and otherwise ignored: ioredis reconnects on its own, and tailLoop's own
    // backoff covers the command side. Nothing here should escalate — a client portal with no live
    // stream is a portal that polls, not a broken platform.
    // eslint-disable-next-line no-console
    console.error("[portal-live] redis connection error (portal falls back to polling):", err.message);
  });
  void tailLoop(reader);
}

function stopTail(): void {
  stopped = true;
  const r = reader;
  reader = null;
  // `disconnect()`, not `quit()`: quit() waits for the in-flight BLOCK to return, which can be the
  // full block timeout away.
  r?.disconnect();
}

async function tailLoop(r: Redis): Promise<void> {
  // Start at "$" = only entries added after we attached. Historical entries are the consumer group's
  // business; replaying them here would fire a burst of refreshes for work the client already saw.
  const cursors = new Map<string, string>(TAILED_ENTITY_TYPES.map((t) => [`events:${t}`, "$"]));
  while (!stopped) {
    try {
      const streams = [...cursors.keys()];
      const ids = streams.map((s) => cursors.get(s) as string);
      // 20s block: long enough that an idle portal costs no polling, short enough that `stopped` is
      // noticed promptly on the last unsubscribe.
      // COUNT before BLOCK: that is the order Redis's own XREAD grammar specifies
      // (`XREAD [COUNT n] [BLOCK ms] STREAMS ...`), and ioredis's overloads enforce it.
      const res = (await r.xread("COUNT", 100, "BLOCK", 20_000, "STREAMS", ...streams, ...ids)) as
        | Array<[string, Array<[string, string[]]>]>
        | null;
      if (!res) continue; // block timeout: no new entries, cursors unchanged
      for (const [stream, entries] of res) {
        for (const [entryId, fields] of entries) {
          cursors.set(stream, entryId);
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(obj.payload || "{}");
          } catch {
            // A malformed payload still tells us SOMETHING changed, and the frame carries no payload
            // anyway — so fall through with an empty object rather than dropping the hint.
          }
          dispatchPortalFrame(obj.tenantId, obj.eventType, payload, obj.createdAt || new Date().toISOString());
        }
      }
    } catch (err) {
      if (stopped) return;
      // eslint-disable-next-line no-console
      console.error("[portal-live] tail read failed:", (err as Error)?.message ?? err);
      // Back off before retrying so a Redis outage does not become a tight reconnect loop. Clients
      // keep working throughout — their polling fallback is what covers this window.
      await new Promise((res2) => setTimeout(res2, 2_000));
    }
  }
}

/** Test/shutdown hook. */
export function resetPortalLive(): void {
  subscribers.clear();
  stopTail();
}

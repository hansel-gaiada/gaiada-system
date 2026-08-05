// MAIL-13 — raw-body capture for `POST /api/mail/inbound/*`.
//
// TWO problems this solves, both structural:
//
//  1. HMAC verification needs the EXACT BYTES that crossed the wire (auth.ts). Nest hands controllers
//     a parsed object, and `JSON.stringify` of that object is not the original — key order and
//     whitespace differ — so any signature computed over a re-serialization would fail against every
//     real payload.
//  2. Fastify's global `bodyLimit` is 1 MiB by default and this app never raises it, while
//     `MAIL_INBOUND_MAX_BYTES` is 5 MiB by design (§4.1). Left alone, Fastify would 413 a legitimate
//     4 MiB inbound mail before any of this ticket's caps or counters ever ran, and the endpoint's
//     documented cap would be fiction.
//
// HOW: a `preParsing` hook, SCOPED BY URL so nothing else in the app changes, drains the request
// stream itself (bounded — see below), stashes the bytes, and hands the JSON parser a tiny `{}` in
// their place. Consequences, on purpose:
//   * the inbound controller ignores `@Body()` entirely and parses `raw` itself, which is also where
//     malformed JSON becomes a counted 400 instead of a Fastify error shape;
//   * Fastify's body limit is measured against the 2-byte `{}`, so it can never pre-empt our cap;
//   * NOTHING outside `/api/mail/inbound/` is affected — the global JSON parser is untouched, which
//     matters in a repo where several agents share the tree and a global parser swap would be a
//     silent regression surface for every other route.
//
// MEMORY IS BOUNDED at `MAIL_INBOUND_MAX_BYTES + 1`: bytes past the cap are counted and DISCARDED
// rather than buffered, so a hostile 500 MB post costs one cap-sized buffer and the socket read, then
// a 413. It is deliberately drained rather than destroyed mid-stream: aborting the request has to be
// done through Fastify's own error path to produce a clean response, and at a documented handful of
// mails/day the read cost of a flood is the rate limiter's problem, not this hook's.
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config";

export const INBOUND_ROUTE_PREFIX = "/api/mail/inbound/";

/** The stand-in body handed to Fastify's JSON parser in place of the real one. Valid JSON so the
 *  parser succeeds; ignored by the controller, which reads the captured raw bytes.
 *
 *  MUST be a Buffer, not the string "{}". A `Readable.from(["{}"])` yields STRING chunks, and the
 *  body-collecting code downstream does `Buffer.concat(chunks)` — which throws
 *  `ERR_INVALID_ARG_TYPE: The "list[0]" argument must be an instance of Buffer` from inside a stream
 *  callback. A throw there is not an error response, it is an UNHANDLED rejection: the reply is never
 *  sent and the request hangs until the client gives up. That is exactly how it presented — every
 *  inbound test timing out at 20s with no error attributed to it — so this is deliberately pinned by
 *  raw-body.test.ts rather than left to a comment. */
const REPLACEMENT_BODY = Buffer.from("{}", "utf8");

export interface CapturedRawBody {
  /** The captured bytes, truncated at the cap when `overCap` is true. */
  raw: Buffer;
  /** Total bytes actually received, including anything discarded past the cap. */
  receivedBytes: number;
  overCap: boolean;
}

/** A WeakMap rather than a `declare module "fastify"` augmentation: `src/fastify.d.ts` is shared
 *  global surface, and this is one route's private plumbing. Entries die with the request object. */
const captured = new WeakMap<object, CapturedRawBody>();

export function takeCapturedRawBody(req: FastifyRequest): CapturedRawBody | undefined {
  return captured.get(req as unknown as object);
}

/** Registered from `buildApp()`. Idempotent per Fastify instance in practice (Nest builds one app
 *  per process; the test harness builds one per suite). */
export function registerInboundRawBodyCapture(instance: FastifyInstance): void {
  instance.addHook("preParsing", async (req, _reply, payload) => {
    if (!req.url.startsWith(INBOUND_ROUTE_PREFIX)) return payload;
    const cap = config.mail.inboundMaxBytes;
    const chunks: Buffer[] = [];
    let kept = 0;
    let received = 0;
    for await (const chunk of payload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      received += buf.byteLength;
      if (kept < cap + 1) {
        const room = cap + 1 - kept;
        const slice = buf.byteLength <= room ? buf : buf.subarray(0, room);
        chunks.push(slice);
        kept += slice.byteLength;
      }
    }
    const raw = Buffer.concat(chunks);
    captured.set(req as unknown as object, { raw, receivedBytes: received, overCap: received > cap });
    // `content-length` MUST be rewritten to describe the replacement stream. Fastify's content-type
    // parser compares the bytes it actually read against this header and raises
    // "Request body size did not match Content-Length" otherwise — which surfaced as a 500 on every
    // inbound post until the corpus suite caught it. Rewriting (rather than deleting) the header keeps
    // Fastify's own length validation switched ON and passing, and it is also what makes the
    // 1 MiB global `bodyLimit` a non-issue: the limit is now measured against 2 bytes, so this route's
    // real cap is `MAIL_INBOUND_MAX_BYTES`, enforced above on the count of bytes genuinely received.
    req.headers["content-length"] = String(REPLACEMENT_BODY.length);
    // The parser downstream sees a valid, tiny JSON document; the controller reads `raw` instead.
    return Readable.from([REPLACEMENT_BODY]);
  });
}

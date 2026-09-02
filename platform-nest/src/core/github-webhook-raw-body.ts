// GH-07 (docs/blueprints/github-integration-foundation.md §4.5) — raw-body capture for
// `POST /api/webhooks/github`, ONLY. Same problem, same fix, as MAIL-13's
// `src/mail/inbound/raw-body.ts` (read, not modified): HMAC verification must run over the EXACT
// bytes GitHub sent. Nest hands a controller a parsed object, and `JSON.stringify` of that object is
// not byte-identical to what GitHub signed (key order, whitespace) — a signature computed over a
// re-serialization would fail against every real delivery.
//
// This endpoint is INTERNET-FACING and unauthenticated by design (the signature IS the
// authentication — see github-webhook.controller.ts). Verifying against a re-parsed/re-serialized
// body would be verifying against something an attacker could shape differently from what was
// actually signed, which is not a real signature check at all.
//
// ── LIVES OUTSIDE `core/github/` ON PURPOSE ────────────────────────────────────────────────────────
// Same reasoning `github-repos.controller.ts`'s own header gives for its placement: this ticket's
// scope boundary forbids MODIFYING specific files inside `core/github/` (GH-01/GH-02's credential/
// token/rate-limit/error-mapping surface, owned by other tickets in flight). This file never touches
// any of them — it is pure Fastify plumbing — but living as a sibling keeps it unambiguously outside
// that directory's edit surface rather than relying on "I only ADDED a file, I didn't modify one".
//
// HOW: a `preParsing` hook, URL-scoped exactly like MAIL-13's, drains the request stream itself
// (bounded — see below), stashes the bytes, and hands the JSON parser a tiny `{}` in their place.
// NOTHING outside `/api/webhooks/github` is affected — the global JSON parser is untouched.
//
// Memory is bounded at `config.githubWebhookMaxBytes + 1`: bytes past the cap are counted and
// discarded rather than buffered without limit. GitHub's own documented webhook payload cap is
// 25 MB; this defaults lower (see config.ts) because no event this receiver handles (push,
// pull_request, workflow_run, check_suite, repository, release, deployment_status — the exact 7 the
// App subscribes to) legitimately needs anywhere near that, and an oversized delivery is rejected
// with a clean 413 rather than accepted and half-processed.
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config";

export const GITHUB_WEBHOOK_ROUTE = "/api/webhooks/github";

/** Stand-in body handed to Fastify's JSON parser in place of the real one. MUST be a Buffer, not the
 *  string "{}" — see MAIL-13's raw-body.ts header for the exact failure mode (`Readable.from(["{}"])`
 *  yields a string chunk, and the parser's `Buffer.concat` throws `ERR_INVALID_ARG_TYPE` inside a
 *  stream callback — an unhandled rejection, not a clean error response, so the request hangs). Same
 *  fix here, pinned the same way. */
const REPLACEMENT_BODY = Buffer.from("{}", "utf8");

export interface CapturedGithubWebhookBody {
  /** The captured bytes, truncated at the cap when `overCap` is true. */
  raw: Buffer;
  receivedBytes: number;
  overCap: boolean;
}

/** WeakMap, not a `declare module "fastify"` augmentation — this route's private plumbing, entries
 *  die with the request object. Same choice as MAIL-13's raw-body.ts, for the same reason. */
const captured = new WeakMap<object, CapturedGithubWebhookBody>();

export function takeCapturedGithubWebhookBody(req: FastifyRequest): CapturedGithubWebhookBody | undefined {
  return captured.get(req as unknown as object);
}

/** Registered from `buildApp()`, alongside `registerInboundRawBodyCapture`. Idempotent per Fastify
 *  instance in practice (one app per process; one per test suite). */
export function registerGithubWebhookRawBodyCapture(instance: FastifyInstance): void {
  instance.addHook("preParsing", async (req, _reply, payload) => {
    if (req.url.split("?")[0] !== GITHUB_WEBHOOK_ROUTE) return payload;
    const cap = config.githubWebhookMaxBytes;
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
    // MUST rewrite content-length to describe the replacement stream — see MAIL-13's identical note:
    // Fastify's parser compares actual bytes read against this header and 500s otherwise, and
    // rewriting is also what makes the global 1 MiB bodyLimit a non-issue for this route (it now
    // measures against 2 bytes; the real cap is enforced above against bytes genuinely received).
    req.headers["content-length"] = String(REPLACEMENT_BODY.length);
    return Readable.from([REPLACEMENT_BODY]);
  });
}

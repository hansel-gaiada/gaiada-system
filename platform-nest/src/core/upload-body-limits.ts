// PV4-03b — per-route request-body limits for the routes that take a file INLINE as base64 JSON.
//
// THE DEFECT. `main.ts` never set a Fastify `bodyLimit`, so Fastify's 1 MiB default applied to every
// route. A base64 file inflates by 4/3, so any inline upload over ~700 KB was refused with Fastify's own
// `413 FST_ERR_CTP_BODY_TOO_LARGE` BEFORE the handler ran — which made the handlers' documented caps
// (10 MB payment proof, 10 MB-total conversation attachments) unreachable. Two features were broken by it.
//
// THE FIX IS PER ROUTE, NEVER APP-WIDE. The 1 MiB default is a deliberate defence for the other ~1,000
// routes (the body is buffered in memory, and for a guard-authenticated route it is buffered BEFORE the
// AuthGuard runs, so an unauthenticated caller pays nothing but we pay RAM). Raising it globally would
// hand every route a 14 MB buffer budget for the sake of six. So: one table of upload routes, each with
// the byte cap its own handler enforces, and an `onRoute` hook that sets `bodyLimit` on exactly those
// routes as Fastify registers them.
//
// EACH LIMIT DERIVES FROM THE ROUTE'S OWN CAP:  ceil(cap * 4 / 3)  +  JSON_ENVELOPE_ALLOWANCE_BYTES.
// The caps are imported from where the handlers define them (MAX_PROOF_BYTES, MAX_ATTACHMENT_TOTAL_BYTES),
// never restated here, so raising a cap raises its limit with it. The limit is deliberately a little
// LARGER than the handler's cap implies, never equal to it: an over-cap upload must reach the handler and
// be refused with the handler's own message, not be cut off by Fastify with an opaque 413.
//
// FAIL CLOSED ON DRIFT. A table entry is only protective if it matches a route. If a controller is
// renamed or moved, a stale entry would silently stop applying and the route would fall back to 1 MiB —
// the exact failure this file exists to fix, reintroduced with no error anywhere. So `assertAllMatched()`
// (called from `buildApp()` after `app.init()`) throws at boot unless every entry matched EXACTLY ONE
// registered route. `main.ts` is therefore also the thing that makes a rename a build failure.
//
// ORDER IS LOAD-BEARING. `installUploadBodyLimits` must run BEFORE `app.init()`: Fastify calls `onRoute`
// hooks as each route is registered, which is what `app.init()` triggers. A hook added after it would
// apply to no Nest route and fail silently (no route "matched" is indistinguishable from none needing it)
// — which is exactly what `assertAllMatched()` converts into a loud boot error.
import type { FastifyInstance } from "fastify";
import { MAX_ATTACHMENT_TOTAL_BYTES } from "./conversation-core";
import { MAX_PROOF_BYTES } from "./portal-commerce.controller";
import { MAX_BYTES as MAX_STAFF_FILE_BYTES } from "./files.controller";

/** Room for everything in the JSON request that is NOT file content: the message body (<= 10,000 chars,
 *  at most 3 UTF-8 bytes each = 30 KB), the subject (200 chars), up to 5 attachments' filename (<= 200
 *  chars) + contentType (<= 120) + JSON keys and quoting (~4 KB in all), ids and the payment form fields.
 *  That is ~35 KB at its worst realistic size; 64 KiB leaves a margin for JSON escaping (non-ASCII is not
 *  escaped by JSON.stringify, but a hand-built request may use \uXXXX at 6 bytes per unit) and for the
 *  base64 padding of 5 separately-encoded files (<= 8 bytes each). It is NOT a second file budget: a body
 *  that is large because of file content still fails on the handler's own cap. */
export const JSON_ENVELOPE_ALLOWANCE_BYTES = 64 * 1024;

/** Base64 encodes 3 bytes as 4 characters. */
export function base64EncodedBytes(rawBytes: number): number {
  return Math.ceil((rawBytes * 4) / 3);
}

/** The `bodyLimit` for a route whose handler accepts `capBytes` of decoded file content inline. */
export function inlineUploadBodyLimit(capBytes: number): number {
  return base64EncodedBytes(capBytes) + JSON_ENVELOPE_ALLOWANCE_BYTES;
}

export interface UploadRoute {
  readonly method: "POST";
  /** The path EXACTLY as Fastify registers it, which is what Nest hands the adapter:
   *  `@Controller("api")` + the route's path, params as `:name` — e.g. `/api/:tenantId/portal/conversation`.
   *  (Nest has no global prefix in this app: see the comment at the top of `buildApp()`.) */
  readonly url: string;
  /** The decoded-bytes cap the handler enforces for the file content carried by this route. */
  readonly capBytes: number;
  /** Human label for the boot log and the drift error. */
  readonly label: string;
}

/** Every route that takes a file inline as base64 JSON. Adding an inline-upload route means adding it
 *  here; forgetting is not silent for the OTHER direction (a stale entry fails boot), but a NEW route
 *  that is simply never listed stays at 1 MiB — which is a visible 413 on first use, not a security
 *  hole, and the safe direction to fail. */
export const UPLOAD_ROUTES: readonly UploadRoute[] = [
  { method: "POST", url: "/api/:tenantId/portal/invoices/:invoiceId/payments", capBytes: MAX_PROOF_BYTES, label: "portal payment proof" },
  { method: "POST", url: "/api/:tenantId/portal/conversation", capBytes: MAX_ATTACHMENT_TOTAL_BYTES, label: "portal conversation: open thread" },
  { method: "POST", url: "/api/:tenantId/portal/conversation/:threadId/messages", capBytes: MAX_ATTACHMENT_TOTAL_BYTES, label: "portal conversation: reply" },
  { method: "POST", url: "/api/:tenantId/conversation", capBytes: MAX_ATTACHMENT_TOTAL_BYTES, label: "staff conversation: open thread" },
  { method: "POST", url: "/api/:tenantId/conversation/:threadId/messages", capBytes: MAX_ATTACHMENT_TOTAL_BYTES, label: "staff conversation: reply" },
  // DW-8h (§45.2): the staff file upload takes `{content}` as base64 up to its own 25 MB cap; without this entry Fastify's 1 MiB
  // default 413'd any upload over ~750 KB before the handler ran.
  { method: "POST", url: "/api/:tenantId/files", capBytes: MAX_STAFF_FILE_BYTES, label: "staff file upload" },
];

/** One boot-log line per table entry: `POST /api/... (label): cap N B -> bodyLimit M B`. The match itself is
 *  proven by `assertAllMatched()`; this is the operator-readable record of what each route was given. */
export function describeUploadRoutes(table: readonly UploadRoute[] = UPLOAD_ROUTES): string[] {
  return table.map((e) => `${e.method} ${e.url} (${e.label}): cap ${e.capBytes} B -> bodyLimit ${inlineUploadBodyLimit(e.capBytes)} B`);
}

export interface UploadBodyLimitsHandle {
  /** One record per route the hook actually changed: what was matched and the limit it was given. */
  readonly applied: ReadonlyArray<{ readonly label: string; readonly method: string; readonly url: string; readonly bodyLimit: number }>;
  /** Throws unless every table entry matched exactly one registered route. Call AFTER `app.init()`. */
  assertAllMatched(): void;
}

const methodsOf = (m: unknown): string[] => (Array.isArray(m) ? m : [m]).map((x) => String(x).toUpperCase());

/** Install the `onRoute` hook. Must run before the routes are registered (before `app.init()`).
 *  `table` is injectable only so a test can prove the drift guard; production code passes nothing. */
export function installUploadBodyLimits(
  fastify: FastifyInstance,
  table: readonly UploadRoute[] = UPLOAD_ROUTES,
): UploadBodyLimitsHandle {
  const seen = new Set<string>();
  for (const e of table) {
    const key = `${e.method} ${e.url}`;
    if (seen.has(key)) throw new Error(`upload-body-limits: duplicate table entry ${key}`);
    seen.add(key);
    if (!Number.isInteger(e.capBytes) || e.capBytes <= 0) throw new Error(`upload-body-limits: ${key} has a non-positive cap`);
  }
  const matches = new Map<UploadRoute, number>(table.map((e) => [e, 0]));
  const applied: Array<{ label: string; method: string; url: string; bodyLimit: number }> = [];

  fastify.addHook("onRoute", (routeOptions) => {
    const methods = methodsOf(routeOptions.method);
    for (const entry of table) {
      if (routeOptions.url !== entry.url || !methods.includes(entry.method)) continue;
      const bodyLimit = inlineUploadBodyLimit(entry.capBytes);
      routeOptions.bodyLimit = bodyLimit;
      matches.set(entry, (matches.get(entry) ?? 0) + 1);
      applied.push({ label: entry.label, method: entry.method, url: entry.url, bodyLimit });
    }
  });

  return {
    applied,
    assertAllMatched() {
      const bad = table.filter((e) => matches.get(e) !== 1);
      if (bad.length === 0) return;
      const detail = bad
        .map((e) => `${e.method} ${e.url} (${e.label}) matched ${matches.get(e)} registered route(s), expected exactly 1`)
        .join("; ");
      throw new Error(
        `upload-body-limits: the upload-route table has drifted from the registered routes — ${detail}. ` +
          `Without a match the route falls back to Fastify's 1 MiB default and its uploads 413. ` +
          `Fix the entry in src/core/upload-body-limits.ts (or install the hook before app.init()).`,
      );
    },
  };
}

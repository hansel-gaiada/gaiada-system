// WSK-43a follow-up — every refusal of the public upload route (`POST|OPTIONS /v1/t/:tenantSlug/media/upload/:token`)
// answers `application/problem+json` with a stable `type` slug, instead of Nest's default {statusCode,message,error}.
//
// THE SHAPE is the one the control routes and the content commands already use (content-problem.ts:
// ControlProblemBody = {type: https://webdesk.gaiada.online/errors/<slug>, title, status, detail}); `type` is the
// stable contract a client maps on, `detail` is prose that may change. It is deliberately NOT the /v1 read
// envelope's variant with `instance` and `requestId`: this route's refusals must be byte-identical across causes
// (the no-oracle rule: every invalid-token cause is the same 404, whatever the slug or token), and a per-request id
// or a path would break that. Nothing here ever carries the token: the body holds only fixed texts and the
// refusal's own message (which is built from sizes, types and a scan signature, never from the URL).
//
// HOW IT IS WIRED. The refusals keep their Nest exception classes (so every status code is exactly as before and
// MediaService.screen, shared with the api-key route, still answers that route as it always did). A refusal on
// this route is TAGGED with its slug (`uploadRefusal`), and UploadProblemFilter, bound to the two upload handlers
// only, turns any exception into the problem body. An untagged exception falls back to a slug by status; a
// non-HTTP error is a 500 `internal-error` with a fixed detail (the real error is logged, never sent).
//
// CORS is the filter's job too, not only the handler's: an error raised before the handler runs (the content-type
// parser's 415, see media-upload-parser.ts) has had no CORS header set, and the browser must be able to read it.
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PROBLEM_TYPE_BASE } from "../control/content/content-problem";
import { allowedUploadOrigin } from "./upload-cors";

/** The slugs of this route, each with its title. The status is the exception's own (it differs per cause for a few). */
export const UPLOAD_PROBLEM_TITLES = {
  "upload-not-found": "Not found",
  "upload-busy": "Too many uploads in progress",
  "upload-type-not-allowed": "Content type not allowed",
  "upload-type-mismatch": "Content type does not match the file",
  "upload-too-large": "Upload too large",
  "upload-empty": "Empty upload",
  "upload-quota-exceeded": "Storage quota exceeded",
  "upload-infected": "Upload refused by the malware scan",
  "upload-scan-unavailable": "Malware scan unavailable",
  "upload-timeout": "Upload did not arrive in time",
  "upload-interrupted": "Upload interrupted",
  "invalid-request": "Invalid request",
  "internal-error": "Internal error",
} as const;
export type UploadProblemSlug = keyof typeof UPLOAD_PROBLEM_TITLES;

const TAG = "uploadSlug";

/** Marks an exception as the refusal `slug` of the upload route. Returns it, so `throw uploadRefusal(new X(m), "...")` reads in place. */
export function uploadRefusal<E extends HttpException>(exception: E, slug: UploadProblemSlug): E {
  Object.defineProperty(exception, TAG, { value: slug, enumerable: false });
  return exception;
}

/** Fixed texts: these causes never echo the exception's own message (a scanner error can name internals). */
const FIXED_DETAIL: Partial<Record<UploadProblemSlug, string>> = {
  "upload-not-found": "No such upload.",
  "upload-scan-unavailable": "The malware scan is unavailable, so the upload was refused. Retry shortly.",
  "internal-error": "The server could not complete this request.",
};

function slugOf(status: number, tagged: unknown): UploadProblemSlug {
  if (typeof tagged === "string" && tagged in UPLOAD_PROBLEM_TITLES) return tagged as UploadProblemSlug;
  switch (status) {
    case 404:
      return "upload-not-found";
    case 408:
      return "upload-timeout";
    case 413:
      return "upload-too-large";
    case 415:
      return "upload-type-not-allowed";
    case 400:
    case 403:
      return "invalid-request";
    default:
      return "internal-error";
  }
}

export interface UploadProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
}

/** The problem for any thrown value, plus whether it was an unexpected failure the caller should log. */
export function uploadProblemOf(exception: unknown): { body: UploadProblemBody; unexpected: boolean } {
  let status = 500;
  let message = "";
  let tagged: unknown;
  let unexpected = true;
  if (exception instanceof HttpException) {
    status = exception.getStatus();
    message = exception.message;
    tagged = (exception as unknown as Record<string, unknown>)[TAG];
    unexpected = status >= 500 && tagged === undefined;
  } else if (typeof exception === "object" && exception !== null && typeof (exception as { statusCode?: unknown }).statusCode === "number") {
    // A Fastify error raised before the handler ran (content-type parser, body parser).
    const e = exception as { statusCode: number; message?: unknown };
    status = e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    message = typeof e.message === "string" ? e.message : "";
    unexpected = status >= 500;
  }
  const slug = slugOf(status, tagged);
  const detail = FIXED_DETAIL[slug] ?? (message !== "" && status < 500 ? message : FIXED_DETAIL["internal-error"] as string);
  return { body: { type: `${PROBLEM_TYPE_BASE}/${slug}`, title: UPLOAD_PROBLEM_TITLES[slug], status, detail }, unexpected };
}

/**
 * Writes `body` as the route's answer: exactly `application/problem+json`, never cached, `Vary: Origin`, and the
 * CORS header for a configured origin only (the Origin alone decides: it tells a caller nothing about a token).
 * Headers the handler already set (`Retry-After`, `Connection: close`) are kept.
 */
export function sendUploadProblem(reply: FastifyReply, origin: string | undefined, body: UploadProblemBody): void {
  setUploadErrorHeaders(reply, origin);
  reply.status(body.status).header("content-type", "application/problem+json").send(JSON.stringify(body));
}

function setUploadErrorHeaders(reply: FastifyReply, origin: string | undefined): void {
  reply.header("cache-control", "no-store");
  reply.header("vary", "Origin");
  const allowed = allowedUploadOrigin(origin);
  if (allowed) reply.header("access-control-allow-origin", allowed);
}

/**
 * The last word on the route, for an error the filter never sees: Fastify refuses some requests BEFORE the handler
 * runs (a content type with no parser: 415; a malformed JSON body: 400), and answers them with its own body. Wired as
 * an `onSend` hook on the upload route only (media-upload-parser.ts), it rewrites any 4xx/5xx answer that is not
 * already problem+json into one, keeping the status. Returns the payload to send.
 */
export function finalizeUploadError(reply: FastifyReply, origin: string | undefined, payload: unknown): unknown {
  const status = reply.statusCode;
  if (status < 400) return payload;
  const type = String(reply.getHeader("content-type") ?? "");
  if (type.toLowerCase().startsWith("application/problem+json")) return payload;
  let message = "";
  try {
    const raw = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : "";
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    /* not JSON: the fixed text of the status stands */
  }
  const { body } = uploadProblemOf({ statusCode: status, message });
  setUploadErrorHeaders(reply, origin);
  reply.header("content-type", "application/problem+json");
  reply.removeHeader("content-length");
  return JSON.stringify(body);
}

@Catch()
export class UploadProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger("MediaUpload");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest>();
    const { body, unexpected } = uploadProblemOf(exception);
    // The request URL holds the token: log the failure, never the URL.
    if (unexpected) this.logger.error(`upload route failure: ${exception instanceof Error ? exception.stack ?? exception.message : String(exception)}`);
    const origin = req.headers.origin;
    sendUploadProblem(reply, typeof origin === "string" ? origin : undefined, body);
  }
}

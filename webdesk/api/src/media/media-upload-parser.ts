// WSK-43a — lets the Fastify instance hand the public upload route its RAW request stream.
//
// `POST /v1/t/:tenantSlug/media/upload/:token` takes the file as the request body with the file's own
// Content-Type (`fetch(url, { method: "POST", headers: { "content-type": file.type }, body: file })`), not
// base64 inside JSON: a browser sends a File as-is, and the route must be able to refuse an oversize body
// WHILE IT STREAMS rather than after Fastify has buffered it. Fastify refuses a body whose content type has
// no parser (415), so a parser has to exist for the types an upload may carry. This registers one for exactly
// the media types the upload allowlists admit, and it hands the handler the unread stream
// (media-upload.service.ts readBounded enforces the cap and the deadline).
//
// SCOPED, NOT GLOBAL. A Fastify parser is per instance, and the control plane shares this instance. For any
// path that is not the upload route the parser answers exactly what Fastify answers for an unknown content
// type (415 FST_ERR_CTP_INVALID_MEDIA_TYPE), so no other route starts accepting these types, and an
// unlisted type on the upload route is that same 415. JSON and everything else are untouched.
import { Injectable, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { UPLOADABLE_MIME_TYPES } from "./mime-allowlist";
import { isUploadPath } from "./media-upload-token";
import { finalizeUploadError } from "./upload-problem";

function unsupported(contentType: string | undefined): Error {
  return Object.assign(new Error(`Unsupported Media Type: ${contentType ?? ""}`), { statusCode: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" });
}

@Injectable()
export class MediaUploadParserRegistrar implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance() as FastifyInstance;
    fastify.addContentTypeParser([...UPLOADABLE_MIME_TYPES], (req: FastifyRequest, payload: unknown, done: (err: Error | null, body?: unknown) => void) => {
      const path = String(req.raw.url ?? "").split("?")[0];
      if (req.method !== "POST" || !isUploadPath(path)) return done(unsupported(req.headers["content-type"]));
      done(null, payload); // the unread request stream
    });

    // Refusals Fastify makes before the handler runs (an unlisted or missing content type: 415; a malformed JSON
    // body: 400) are answered in Fastify's own body. On the upload route only, turn them into problem+json too
    // (upload-problem.ts); every other route's answers are untouched, and a 2xx never reaches the rewrite.
    fastify.addHook("onSend", (req, reply, payload, done) => {
      const path = String(req.raw.url ?? "").split("?")[0];
      if ((req.method !== "POST" && req.method !== "OPTIONS") || !isUploadPath(path) || reply.statusCode < 400) return done(null, payload);
      const origin = req.headers.origin;
      done(null, finalizeUploadError(reply, typeof origin === "string" ? origin : undefined, payload) as typeof payload);
    });
  }
}

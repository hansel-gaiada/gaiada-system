// WSK M3 T1 (D4) — Fastify's own failures that happen BEFORE routing, answered in the frozen
// problem+json shape instead of Fastify's default `{"error":"Bad Request","code":"FST_ERR_BAD_URL"...}`.
//
// The one that matters: a URL whose path holds an undecodable escape (`/v1/t/x/%E0%A4%A`). Fastify
// rejects it in its router entry point, so neither the delivery route nor any Nest filter ever runs.
// Fastify 4's `frameworkErrors` option is the only hook that sees it. It is wired in createFastifyAdapter
// (app.ts) — the one place the api's FastifyAdapter is constructed.
//
// Written to the Node response directly, like delivery.gateway.ts and for the same reason: Fastify's
// serializer may append `; charset=utf-8` to a content-type the contract fixes as exactly
// `application/problem+json`.
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { problemDetails } from "./vocabulary/problem-details";
import { redactPreviewToken } from "./preview-token";

const logger = new Logger("FrameworkErrors");

export function frameworkErrorsHandler(error: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  const raw = req.raw;
  const rawUrl = String(raw.url ?? "/");
  // A draft-preview token is a bearer capability (WSK-46): it never goes into a log line or an error body.
  const instance = redactPreviewToken(rawUrl.split("?")[0]);
  const header = raw.headers["x-request-id"];
  const requestId = (Array.isArray(header) ? header[0] : header) || randomUUID();

  const badUrl = error.code === "FST_ERR_BAD_URL";
  if (!badUrl) logger.error(`unexpected framework error ${error.code ?? ""} on ${instance}: ${error.stack ?? error.message}`);
  const body = JSON.stringify(
    badUrl
      ? problemDetails({
          slug: "invalid-path-encoding",
          title: "Invalid path encoding",
          status: 400,
          detail: "The request path is not valid percent-encoding.",
          instance,
          requestId,
        })
      : problemDetails({
          slug: "internal-error",
          title: "Internal error",
          status: 500,
          detail: "The server could not complete this request.",
          instance,
          requestId,
        }),
  );
  const res = reply.raw;
  res.writeHead(badUrl ? 400 : 500, {
    "content-type": "application/problem+json",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

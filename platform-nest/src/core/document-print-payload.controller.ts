// PV5-07 — `GET /internal/documents/print-payload/:jobToken`, the session-less fetch behind platform-ui's
// `/print/invoices/:jobToken` and `/print/contracts/:jobToken` (rendered by the report-renderer sidecar's Chromium).
//
// The exact shape of TR-21's `internal/reports/print-payload` route (modules/reports/print-payload.controller.ts; its
// header is the full argument): no `/api` prefix, no AuthGuard, no tenant parameter, no identity header. The one-shot
// token in the path is the whole authorization. It is a Redis GETDEL, so an unknown, expired or already-used token all
// answer the same 401, and a token minted for document X can only ever yield document X: the payload IS the stored value,
// already built from the database by the job that minted it (document-render.ts). Nothing here re-reads anything.
import { Controller, Get, HttpCode, Param, UnauthorizedException } from "@nestjs/common";
import { burnDocumentPrintToken } from "./document-render";

@Controller("internal/documents/print-payload")
export class DocumentPrintPayloadController {
  @Get(":jobToken")
  @HttpCode(200)
  async getPrintPayload(@Param("jobToken") jobToken: string) {
    const payload = await burnDocumentPrintToken(jobToken);
    if (!payload) throw new UnauthorizedException("invalid or expired print job token");
    return payload;
  }
}

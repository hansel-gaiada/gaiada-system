// PV5-08 — the portal's Documents list: signed agreements, issued-invoice PDFs and payment receipts, newest first.
// BFF contract: docs/FRONTEND-BFF-CONTRACT.md §30b. Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md.
//
// BUILT ONLY FROM THE SHARED PREDICATES (plan trap 1). Every WHERE below is a `*InPortalScope` / `*ClientVisible` builder
// from portal-visibility.ts, so this list and the portal's own invoice, contract and payment reads cannot disagree about
// what a client may see. There is no row-visibility literal in this file, and `portal-visibility.test.ts` fails the build
// if one is added (this controller is on its SWITCHED list). The scope itself is `resolvePortalScope`: its known flaw
// (project scope flattened across a contact's clients, on the board under "Before real clients use the portal") is the
// kernel's to fix, and fixing it there fixes this list too; nothing here works around it.
//
// DOWNLOADS go through the existing portal file route (`GET :tenantId/portal/files/:fileId`), which re-checks ownership
// for every file; a file id outside the caller's scope answers 404 there. This route lists, it never streams.
import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope } from "./portal-scope";
import { contractInPortalScope, invoiceInPortalScope, invoicePaymentClientVisible } from "./portal-visibility";
import { loadDocuments, toPortalItem } from "./client-documents";

@Controller("api")
@UseGuards(AuthGuard)
export class PortalDocumentsController {
  /** `{ items: [{ id, kind, title, date, fileId, ready }] }`, newest first. Reads only; not gated on a module (a client
   *  who has documents must be able to read them whatever staff later toggled), like the invoice and contract reads. */
  @Get(":tenantId/portal/documents")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const items = await loadDocuments(c, {
        contractWhere: contractInPortalScope("k", { clients: 1, projects: 2 }),
        invoiceWhere: invoiceInPortalScope("i", { clients: 1 }),
        // A receipt is reached THROUGH its invoice, as the portal's own receipt download does.
        receiptWhere: `${invoiceInPortalScope("i", { clients: 1 })} AND ${invoicePaymentClientVisible("pp", "detail")}`,
        contractFlag: "TRUE", invoiceFlag: "TRUE", receiptFlag: "TRUE",
        contractParams: [scope.clientIds, scope.projectIds],
        invoiceParams: [scope.clientIds],
        receiptParams: [scope.clientIds],
      });
      return { items: items.map(toPortalItem) };
    });
  }
}

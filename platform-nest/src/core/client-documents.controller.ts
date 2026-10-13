// PV5-08 — the staff counterpart of the portal Documents list, for the client hub's Contracts & billing page.
// BFF contract: docs/FRONTEND-BFF-CONTRACT.md §30b. The same three kinds and the same SELECTs as the portal
// (client-documents.ts), over ALL of the client's rows, each carrying `clientVisible` computed from portal-visibility.ts
// (`staffClientVisible` over the row-state builders): "a client-wide contact of this client sees this row in the portal"
// (plan trap 9). `client-documents.db.test.ts` proves the flagged ids equal what the portal returns for the client.
//
// Authorization is the client's own `read` (the overview carries the same money items under it). A DOWNLOAD is a separate
// call, `/api/:tenantId/files/:fileId/content`, which authorizes on the file's parent entity (contract, invoice, payment).
import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { contractClientVisible, invoiceClientVisible, staffClientVisible, staffInvoicePaymentClientVisible } from "./portal-visibility";
import { loadDocuments } from "./client-documents";

@Controller("api")
@UseGuards(AuthGuard)
export class ClientDocumentsController {
  @Get(":tenantId/clients/:clientId/documents")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const exists = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
      if (!exists.rows[0]) throw new NotFoundException("client not found");
      const items = await loadDocuments(c, {
        contractWhere: `k.client_id = $1 AND k.deleted_at IS NULL`,
        invoiceWhere: `i.client_id = $1 AND i.deleted_at IS NULL`,
        receiptWhere: `pp.client_id = $1 AND pp.deleted_at IS NULL`,
        contractFlag: staffClientVisible("k", contractClientVisible("k")),
        invoiceFlag: staffClientVisible("i", invoiceClientVisible("i")),
        receiptFlag: staffInvoicePaymentClientVisible("pp", "i"),
        contractParams: [clientId], invoiceParams: [clientId], receiptParams: [clientId],
      });
      return { items };
    });
  }
}

// PV7-07 — publishing an account summary: RENDER the PDF first, store it as the report's own file, then publish, in one flow
// (BFF §56.3). Called by the PV7-04a publish route for `source = 'account_summary'` only; social and search reports keep the
// 04a behaviour (they publish at delivery, with the module's own file).
//
// ── ORDER ────────────────────────────────────────────────────────────────────────────────────────────
//   1. read the draft's snapshot and narrative (the PDF is built from exactly these);
//   2. build the `ReportDocument` (grain `client`) and render it: `mintPrintJobToken` + `renderPdfViaSidecar`, the print
//      pipeline social delivery uses. The caller has ALREADY authorized `publish` (this file takes no principal: mint after
//      authorizing, never before; report-pdf-export.ts requirement 3). A render failure is a 503 and the report stays a draft;
//   3. store the bytes under the report's own key (BEFORE the transaction: storage is not transactional);
//   4. one transaction: insert the role file, then flip the draft to published with a compare-and-swap on the state AND on the
//      narrative the PDF was rendered from. If a staff edit landed between step 1 and now, the swap finds no row and the
//      publish is a 409 `draft_changed` (nothing is published; the stored blob is discarded): the PDF a client downloads
//      always says what the report's narrative says.
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { emitEvent } from "../../../events/outbox.service";
import {
  CLIENT_REPORT_ENTITY, CLIENT_REPORT_FILE_ROLE, discardStoredReportFile, storeClientReportFile,
} from "../../../core/client-reports";
import { PdfRendererNotConfiguredError, mintPrintJobToken, renderPdfViaSidecar } from "../../reports/report-pdf-export";
import { buildAccountSummaryDocument, type SummaryNarrativeSource } from "./document";
import type { AccountSummarySnapshot } from "./snapshot";

export interface SummaryPublishInput {
  tenantId: string;
  reportId: string;
  clientId: string;
  projectId: string | null;
  /** The person who publishes (published_by is required once published). */
  actor: string;
}

interface DraftRow {
  snapshot: AccountSummarySnapshot;
  narrativeMd: string;
  narrativeSource: SummaryNarrativeSource;
  period: string;
}

/** Render the summary's PDF. 503 `pdf_render_not_configured` / `pdf_render_failed`; never returns anything but PDF bytes. */
export async function renderSummaryPdf(tenantId: string, clientId: string, row: DraftRow): Promise<Buffer> {
  const { url, token, platformUiInternalUrl, timeoutMs } = config.reportRenderer;
  if (!url || !token || !platformUiInternalUrl) throw new ServiceUnavailableException({ message: "pdf_render_not_configured" });
  const document = buildAccountSummaryDocument({
    tenantId, snapshot: row.snapshot, narrativeMd: row.narrativeMd, narrativeSource: row.narrativeSource,
  });
  let bytes: Buffer;
  try {
    const jobToken = await mintPrintJobToken({ tenantId, grain: "client", scopeRef: clientId, document });
    bytes = await renderPdfViaSidecar(jobToken, { rendererUrl: url, rendererToken: token, platformUiInternalUrl, timeoutMs });
  } catch (err) {
    if (err instanceof PdfRendererNotConfiguredError) throw new ServiceUnavailableException({ message: "pdf_render_not_configured" });
    throw new ServiceUnavailableException({ message: "pdf_render_failed" });
  }
  // Nothing but a PDF becomes the client's file: an error page or an empty body from a misbehaving sidecar is a failure.
  if (bytes.byteLength < 5 || bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new ServiceUnavailableException({ message: "pdf_render_failed" });
  }
  return bytes;
}

/** Render, store and publish. Returns `publishedAt`. The caller writes the activity row and the notice after it returns. */
export async function publishAccountSummary(input: SummaryPublishInput): Promise<string> {
  const { tenantId, reportId, clientId, projectId, actor } = input;
  const read = await withTenants([tenantId], (c) =>
    c.query<{ snapshot: AccountSummarySnapshot; narrativeMd: string; narrativeSource: SummaryNarrativeSource; period: string }>(
      `SELECT snapshot, narrative_md AS "narrativeMd", narrative_source AS "narrativeSource",
              to_char(period_start, 'YYYY-MM') AS period
         FROM client_reports WHERE id = $1 AND status = 'draft' AND source = 'account_summary'`,
      [reportId],
    ),
  );
  const row = read.rows[0];
  if (!row) throw new ConflictException("not_a_draft");

  const bytes = await renderSummaryPdf(tenantId, clientId, row);
  const filename = `account-summary-${row.period}.pdf`;
  const file = await storeClientReportFile(tenantId, bytes, filename, "application/pdf");

  try {
    return await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size,
                            storage_key, sha256, scrubbed, origin_site, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12)`,
        [file.fileId, tenantId, actor, CLIENT_REPORT_ENTITY, reportId, file.filename, file.contentType, file.byteSize,
         file.storageKey, file.sha256, config.originSite, CLIENT_REPORT_FILE_ROLE],
      );
      // Compare-and-swap on the state AND the narrative this PDF was rendered from (header, step 4).
      const u = await c.query<{ published_at: string }>(
        `UPDATE client_reports
            SET status = 'published', file_id = $2, published_at = now(), published_by = $3, updated_at = now()
          WHERE id = $1 AND status = 'draft' AND source = 'account_summary' AND narrative_md = $4
        RETURNING published_at`,
        [reportId, file.fileId, actor, row.narrativeMd],
      );
      if (!u.rows[0]) throw new ConflictException("draft_changed");
      await emitEvent(c, tenantId, CLIENT_REPORT_ENTITY, reportId, "client_report.published", {
        clientId, projectId, source: "account_summary",
      });
      return u.rows[0].published_at;
    });
  } catch (err) {
    // Nothing references the blob: remove it (best effort), then let the failure through.
    await discardStoredReportFile(file);
    throw err;
  }
}

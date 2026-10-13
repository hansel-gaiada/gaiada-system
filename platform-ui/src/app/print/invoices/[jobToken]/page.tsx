import type { Metadata } from "next";
import { DocumentPrintError, getDocumentPrintPayload, type InvoicePrintPayload } from "@/lib/documents-print-data";
import { DocumentRefusal } from "@/components/documents/print/DocumentRefusal";
import { DocumentTitle } from "@/components/documents/print/DocumentTitle";
import { InvoiceDocument } from "@/components/documents/print/InvoiceDocument";
import "../../documents.css";

// PV5-07 — the issued invoice's print route. platform-nest (core/document-render.ts) mints a one-shot token after
// `invoice.issued` and hands the report-renderer sidecar `PLATFORM_UI_INTERNAL_URL + /print/invoices/{token}`; the
// sidecar's Chromium opens it with no cookies. Outside the `(app)` group like TR-20's `/print/reports` (no shell, no
// providers), and exempt from the login redirect by `proxy.ts`'s existing `/print` prefix rule. The token is the only
// credential; the payload behind it is the invoice of record as platform-nest read it from the database.
export const metadata: Metadata = {
  title: "Invoice",
  robots: { index: false, follow: false },
};

export default async function PrintInvoicePage({ params }: { params: Promise<{ jobToken: string }> }) {
  const { jobToken } = await params;
  let payload: InvoicePrintPayload;
  try {
    const p = await getDocumentPrintPayload(jobToken);
    if (p.kind !== "invoice") throw new DocumentPrintError("malformed", "not an invoice payload");
    payload = p;
  } catch (e) {
    if (e instanceof DocumentPrintError) {
      console.error(`[print/invoices] refusing to render (${e.reason}): ${e.message}`);
      return <DocumentRefusal />;
    }
    throw e;
  }
  return (
    <>
      <DocumentTitle nonce={payload.renderNonce} />
      <InvoiceDocument payload={payload} />
    </>
  );
}

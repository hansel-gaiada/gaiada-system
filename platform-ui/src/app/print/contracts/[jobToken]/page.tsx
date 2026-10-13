import type { Metadata } from "next";
import { DocumentPrintError, getDocumentPrintPayload, type ContractPrintPayload } from "@/lib/documents-print-data";
import { DocumentRefusal } from "@/components/documents/print/DocumentRefusal";
import { DocumentTitle } from "@/components/documents/print/DocumentTitle";
import { ContractDocument } from "@/components/documents/print/ContractDocument";
import "../../documents.css";

// PV5-07 (PV-D25) — the signed contract's print route: the agreement's terms when they were written in the ERP, then
// the evidence page. platform-nest joins these pages after any attached agreement document and seals the result
// (core/document-jobs.ts). Same token-only, shell-less shape as `/print/invoices/[jobToken]`.
export const metadata: Metadata = {
  title: "Signed agreement",
  robots: { index: false, follow: false },
};

export default async function PrintContractPage({ params }: { params: Promise<{ jobToken: string }> }) {
  const { jobToken } = await params;
  let payload: ContractPrintPayload;
  try {
    const p = await getDocumentPrintPayload(jobToken);
    if (p.kind !== "contract") throw new DocumentPrintError("malformed", "not a contract payload");
    payload = p;
  } catch (e) {
    if (e instanceof DocumentPrintError) {
      console.error(`[print/contracts] refusing to render (${e.reason}): ${e.message}`);
      return <DocumentRefusal />;
    }
    throw e;
  }
  return (
    <>
      <DocumentTitle nonce={payload.renderNonce} />
      <ContractDocument payload={payload} />
    </>
  );
}

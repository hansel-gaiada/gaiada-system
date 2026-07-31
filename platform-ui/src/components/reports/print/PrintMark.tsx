import type { ReportHeader } from "@/lib/reports";
import { printProvenanceMark } from "@/lib/reports";

// TR-20 — the §6.3 / §15 provenance mark, rendered as page content (see `app/print/print.css`'s
// header comment for why this can't be Playwright's native `headerTemplate`/`footerTemplate` given
// TR-19's already-shipped, document-agnostic sidecar). Text is byte-identical to platform-nest's
// `report-export.ts::bannerText` via the shared wording in `lib/reports.ts::printProvenanceMark` —
// the PDF and the XLSX/CSV TR-18 ships must say the same thing about the same document.
export function PrintMark({
  header,
  sealHash,
  position,
}: {
  header: Pick<ReportHeader, "sealed" | "revision" | "generatedAt">;
  sealHash?: string;
  position: "top" | "bottom";
}) {
  const text = printProvenanceMark(header, sealHash);
  return (
    <div
      className={`tr20-mark tr20-mark--${position} ${header.sealed ? "tr20-mark--sealed" : "tr20-mark--adhoc"}`}
      role="note"
      aria-label="Document provenance"
    >
      {text}
    </div>
  );
}

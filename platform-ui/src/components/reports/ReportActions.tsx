"use client";
import { useState } from "react";
import type { ReportHeader } from "@/lib/reports";
import { createReportExport } from "@/lib/reportExportActions";
import {
  REPORT_EXPORT_FORMATS,
  SERVED_SLICE_EXPORT_NOTE,
  UNSEALED_EXPORT_NOTE,
  exportDownloadHref,
  exportRefusalMessage,
  exportRequestFor,
  filenameFromDisposition,
  type ReportExportFormat,
} from "@/lib/reportExport";
import { PrintButton } from "./PrintButton";

// DW-4k — Print and Export for ONE rendered report document. Mounted by `ReportPageClient` only, i.e. only
// when the page rendered the document: if you can read it you can export it, and the server re-checks both
// the export and every download (BFF 15a), so this gate is cosmetic and widens nothing.
//
// Export is two steps: the server action creates the job for exactly the document the page shows (its own
// header: grain, scope, period kind, start, end), then the browser fetches the download from the proxy route
// and saves it. It is fetched rather than navigated to so a refusal (403, 404, 422, 5xx) is shown HERE as
// sent, and a failed export never replaces the page and never looks like a download.
const LABEL: Record<ReportExportFormat, string> = { pdf: "PDF", xlsx: "XLSX", csv: "CSV" };

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ReportActions({ header }: { header: ReportHeader }) {
  const [busy, setBusy] = useState<ReportExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // A served-company slice is not what the export builds (the request has no servedTenant), so offering it would
  // hand over a different document than the one on screen.
  const slice = Boolean(header.providerView);

  async function run(format: ReportExportFormat) {
    setBusy(format);
    setError(null);
    setSaved(null);
    try {
      const created = await createReportExport(exportRequestFor(header, format));
      if (!created.ok) {
        setError(`Export failed (${created.status}): ${created.error}`);
        return;
      }
      const res = await fetch(exportDownloadHref(created.jobId), { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        let sentence: string | null = null;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body?.error === "string" && body.error) sentence = body.error;
        } catch { /* no JSON body: fall back to words */ }
        setError(`Export failed (${res.status}): ${sentence ?? exportRefusalMessage(res.status)}`);
        return;
      }
      const filename = filenameFromDisposition(res.headers.get("content-disposition")) ?? `report.${format}`;
      saveBlob(await res.blob(), filename);
      setSaved(filename);
    } catch {
      setError("Export failed: the platform could not be reached. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rp-actions rp-noprint">
      <div className="rp-actions__row">
        {!slice && (
          <div role="group" aria-label="Export this report" className="rp-actions__group">
            <span className="rp-actions__label" aria-hidden="true">Export</span>
            {REPORT_EXPORT_FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                className="lux-btn lux-btn--ghost lux-btn--sm"
                aria-label={`Export this report as ${LABEL[f]}`}
                aria-busy={busy === f}
                disabled={busy !== null}
                onClick={() => run(f)}
              >
                {busy === f ? "Preparing..." : LABEL[f]}
              </button>
            ))}
          </div>
        )}
        <PrintButton />
      </div>
      {slice && <p className="rp-actions__note">{SERVED_SLICE_EXPORT_NOTE}</p>}
      {!slice && !header.sealed && <p className="rp-actions__note">{UNSEALED_EXPORT_NOTE}</p>}
      <div role="status" aria-live="polite" className="rp-actions__status">{saved ? `Saved ${saved}.` : ""}</div>
      {error && <p role="alert" className="rp-actions__error">{error}</p>}
    </div>
  );
}

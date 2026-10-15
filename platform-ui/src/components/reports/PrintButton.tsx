"use client";

// DW-4k — Print for the report pages. The browser prints the page as shown, and `reports-print.css`
// (`@media print`) hides the shell and the controls and keeps the header, the figures and the charts.
// A client component only because `window.print()` needs the browser; the Team page is a server component.
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label="Print this report" onClick={() => window.print()}>
      {label}
    </button>
  );
}

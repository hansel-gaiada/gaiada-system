"use client";
import { useRouter } from "next/navigation";
import { markPortalReportRead } from "@/lib/portalActions";

// PV7-04b — a report's download link, which also marks the report read.
//
// The link is a plain `<a>` to the portal's OWN file route (`/api/:t/portal/files/:id`, the one Documents and Deliverables
// use, which re-checks the file against the caller's account and answers an attachment), so the browser's own navigation
// does the download and a failure of the read marker cannot break it. The marker is fired from the click, fire and forget:
// the click is not prevented, a rejected or failed marker is swallowed (the report simply stays "New"), and on success the
// page refreshes so the New marker and the Overview badge clear. No read marker is sent for a report already read.
export function PortalReportDownload({ tenant, reportId, fileId, label, title, isNew }: {
  tenant: string;
  reportId: string;
  fileId: string;
  label: string;
  title: string;
  isNew: boolean;
}) {
  const router = useRouter();
  const onClick = (): void => {
    if (!isNew) return;
    void markPortalReportRead(reportId)
      .then((r) => { if (r.ok) router.refresh(); })
      .catch(() => { /* never let the marker get in the way of the download */ });
  };
  return (
    <a
      href={`/api/${encodeURIComponent(tenant)}/portal/files/${encodeURIComponent(fileId)}`}
      download
      onClick={onClick}
      aria-label={`${label}: ${title}`}
      style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)", textDecoration: "none" }}
    >
      {label} →
    </a>
  );
}

import { fileDownloadHref } from "@/lib/fileDownload";
import "./billing.css";

// A stored file the staff reader may download: the contract's PDF, a payment's proof of payment.
//
// The href is the UI's own `/api/files/:id` (app/api/files/[fileId]/route.ts), which streams the platform's
// file through the caller's session as an attachment. It is a plain `<a>`, not next/link, so nothing
// prefetches a download. It opens in a new tab so that a REFUSAL (the route answers a refused or missing
// file with a sentence, not a 500) is read there without taking the person off the billing page; a file that
// does download just saves, and the new tab closes itself in most browsers.
//
// Whether the viewer may read the file is the platform's call (the link is shown wherever the row says a file
// exists). A refusal is therefore said in words by the route, never hidden by a missing link.
export function FileLink({ fileId, label }: { fileId: string; label: string }) {
  return (
    <a className="bl-filelink" href={fileDownloadHref(fileId)} target="_blank" rel="noopener noreferrer">
      {label} (download)
    </a>
  );
}

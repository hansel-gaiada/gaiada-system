import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { certifiedBadgeText, DOCUMENT_KIND_LABEL, documentStateNote, type StaffDocumentItem } from "@/lib/documents";
import { formatDate } from "@/lib/format";
import { ClientVisibilityMarker } from "../ClientVisibilityMarker";
import { FileLink } from "./FileLink";
import "@/components/signing/simulatedPsre.css";
import "./billing.css";

// PV5-08 — the hub's Documents section: this client's legal and money documents (signed agreements, issued-invoice
// PDFs, payment receipts), newest first. The same list the client sees under Documents in their portal, plus
// "Client sees this" / "Internal" on each row, from the backend's `clientVisible` only (trap 9): a receipt filed
// against a draft invoice reads Internal. Downloads go through the staff file route (`/api/files/:id`), which asks
// the platform whether THIS viewer may read the file; a refusal is said in words there.
export function ClientDocuments({ items }: { items: StaffDocumentItem[] }) {
  if (items.length === 0) {
    return <EmptyNote>No signed agreement, issued invoice or payment receipt exists for this client yet.</EmptyNote>;
  }
  return (
    <Card>
      <ul style={{ margin: 0, padding: 0 }}>
        {items.map((d) => {
          const note = documentStateNote(d);
          const badge = certifiedBadgeText(d);
          return (
            <li key={`${d.kind}-${d.id}`} className="bl-payment" style={{ listStyle: "none" }}>
              <div className="bl-payment__head">
                <p className="bl-payment__amount">
                  {d.title}
                  {badge && <> <span className="sp-cert-badge">{badge}</span></>}
                </p>
                <span className="bl-payment__meta">
                  {DOCUMENT_KIND_LABEL[d.kind]} · {formatDate(d.date)}
                  <ClientVisibilityMarker clientVisible={d.clientVisible} />
                </span>
              </div>
              <p className="bl-payment__meta">
                {d.fileId ? (
                  <FileLink fileId={d.fileId} label={d.ready ? `Download ${d.title}` : `Download the original of ${d.title} (not yet sealed)`} />
                ) : null}
                {d.certificateFileId ? <>{d.fileId ? " · " : null}<FileLink fileId={d.certificateFileId} label={`Certificate of ${d.title}`} /></> : null}
                {(d.fileId || d.certificateFileId) && note ? " · " : null}
                {note}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

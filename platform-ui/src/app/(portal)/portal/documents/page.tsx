import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { listPortalDocuments } from "@/lib/portal-data";
import { DOCUMENT_KIND_LABEL, documentLinkLabel, documentStateNote } from "@/lib/documents";
import { portalDate } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead } from "@/components/portal/PortalBits";

// PV5-08 — Documents: the legal and money documents between you and us, newest first. A signed agreement (the sealed
// copy), each issued invoice's PDF, and the receipts for payments you reported. Deliverables are not here: they stay
// under Projects.
//
// The list is the BACKEND's (`GET portal/documents`, BFF §30b), built from the same rules as the Contracts and
// Invoices pages, so nothing appears here that those pages would hide. Each download goes through the portal's own
// file route, which checks the file against your account again. A document still being prepared says so in words;
// a failed read says it could not load, and is never shown as "no documents".
export default async function PortalDocumentsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const items = await listPortalDocuments(userId, tenant);

  return (
    <>
      <PortalPageHead
        eyebrow="Your account"
        title="Documents"
        lead="Your signed agreements, invoices and payment receipts, newest first."
        actions={<PortalLive topics={["invoices", "contracts"]} />}
      />
      {items === null ? (
        <EmptyNote>Your documents could not be loaded just now. Please try again in a moment.</EmptyNote>
      ) : items.length === 0 ? (
        <EmptyNote>No documents yet. Signed agreements, issued invoices and payment receipts appear here.</EmptyNote>
      ) : (
        <Card title={`${items.length} ${items.length === 1 ? "document" : "documents"}`}>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 14 }}>
            {items.map((d) => {
              const note = documentStateNote(d);
              return (
                <li key={`${d.kind}-${d.id}`} style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0, flex: "1 1 240px" }}>
                    <div style={{ font: "500 14px/1.4 var(--font-body)", color: "var(--ink-strong)" }}>{d.title}</div>
                    <div style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
                      {DOCUMENT_KIND_LABEL[d.kind]} · {portalDate(d.date)}
                      {note && <span role="status"> · {note}</span>}
                    </div>
                  </div>
                  {d.fileId && (
                    <a
                      href={`/api/${tenant}/portal/files/${d.fileId}`}
                      aria-label={`${documentLinkLabel(d)}: ${d.title}`}
                      style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)", textDecoration: "none" }}
                    >
                      {documentLinkLabel(d)} →
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
